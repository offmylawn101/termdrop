const STRIPE_API_BASE = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

interface StripeCheckoutInput {
  secretKey: string;
  submissionId: string;
  bidCents: number;
  successUrl: string;
  cancelUrl: string;
  expiresAt: number;
}

interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

export interface StripePaymentIntent {
  id: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  capture_method: string;
  currency: string;
  status: string;
  metadata?: Record<string, string> | null;
}

interface StripeErrorResponse {
  error?: { message?: string };
}

export interface StripeCheckoutEventObject {
  id?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
  payment_status?: unknown;
  customer_details?: { email?: unknown } | null;
  metadata?: Record<string, unknown> | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: StripeCheckoutEventObject };
}

export async function createStripeCheckout(input: StripeCheckoutInput): Promise<StripeCheckoutSession> {
  const body = new URLSearchParams({
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: String(Math.floor(input.expiresAt / 1_000)),
    "payment_method_types[0]": "card",
    "payment_intent_data[capture_method]": "manual",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(input.bidCents),
    "line_items[0][price_data][product_data][name]": "TermDrop banner takeover",
    "line_items[0][price_data][product_data][description]": "One reviewed placement in the TermDrop banner slot",
    "metadata[ad_submission_id]": input.submissionId,
    "payment_intent_data[metadata][ad_submission_id]": input.submissionId,
    customer_creation: "always",
  });
  const response = await stripeRequest<StripeCheckoutSession>(
    input.secretKey,
    "/checkout/sessions",
    body,
    `termdrop-checkout-${input.submissionId}`,
  );
  if (!response.url) throw new Error("Stripe did not return a Checkout URL.");
  return response;
}

export async function retrieveStripePaymentIntent(
  secretKey: string,
  paymentIntentId: string,
): Promise<StripePaymentIntent> {
  return stripeGet<StripePaymentIntent>(secretKey, `/payment_intents/${encodeURIComponent(paymentIntentId)}`);
}

export async function captureStripePayment(
  secretKey: string,
  paymentIntentId: string,
  submissionId: string,
): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    secretKey,
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
    new URLSearchParams({
      "metadata[ad_submission_id]": submissionId,
      "metadata[termdrop_result]": "winner",
    }),
    `termdrop-capture-${submissionId}`,
  );
}

export async function cancelStripePayment(
  secretKey: string,
  paymentIntentId: string,
  submissionId: string,
): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    secretKey,
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
    new URLSearchParams({ cancellation_reason: "abandoned" }),
    `termdrop-cancel-${submissionId}`,
  );
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  const entries = signatureHeader.split(",").map((entry) => entry.trim().split("=", 2));
  const timestampText = entries.find(([key]) => key === "t")?.[1];
  const signatures = entries.filter(([key]) => key === "v1").map(([, value]) => value);
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
  return signatures.some((signature) => {
    const candidate = hexBytes(signature);
    return candidate !== null && timingSafeEqual(expected, candidate);
  });
}

export function isStripeEvent(value: unknown): value is StripeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.livemode !== "boolean" ||
    !event.data || typeof event.data !== "object"
  ) return false;
  const data = event.data as Record<string, unknown>;
  return Boolean(data.object && typeof data.object === "object");
}

async function stripeRequest<T>(
  secretKey: string,
  path: string,
  body: URLSearchParams,
  idempotencyKey: string,
): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body,
  });
  const output = await response.json<T & StripeErrorResponse>();
  if (!response.ok) throw new Error(output.error?.message || `Stripe returned HTTP ${response.status}.`);
  return output;
}

async function stripeGet<T>(secretKey: string, path: string): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const output = await response.json<T & StripeErrorResponse>();
  if (!response.ok) throw new Error(output.error?.message || `Stripe returned HTTP ${response.status}.`);
  return output;
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
