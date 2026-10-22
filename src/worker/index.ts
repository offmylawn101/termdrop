import { AdAuction, adAuctionStub } from "../durable-object/ad-auction";
import { IpLimiter } from "../durable-object/ip-limiter";
import { TransferSession } from "../durable-object/transfer-session";
import { TransferStats, transferStatsStub } from "../durable-object/transfer-stats";
import { DEFAULTS, positiveInteger } from "../shared/config";
import { inspectAdCreative, MAX_AD_CREATIVE_BYTES, parseUsdCents, validateAdTarget } from "../shared/ad-validation";
import {
  AD_ID_PATTERN,
  type AdCheckoutResponse,
  type PendingAdSubmission,
  type PublicAdState,
} from "../shared/ad-protocol";
import { safeContentType, sanitizeFilename } from "../shared/filename";
import {
  SESSION_ID_PATTERN,
  type CreateSessionRequest,
  type CreateSessionResponse,
} from "../shared/protocol";
import type { Env } from "./env";
import { addSecurityHeaders, jsonResponse, textResponse } from "./http";
import { sendAdBidderNotification, sendAdReviewNotification } from "./resend";
import {
  cancelStripePayment,
  captureStripePayment,
  createStripeCheckout,
  isStripeEvent,
  retrieveStripePaymentIntent,
  verifyStripeWebhook,
} from "./stripe";

export { AdAuction, IpLimiter, TransferSession, TransferStats };

const encoder = new TextEncoder();
const MAX_AD_CHECKOUT_BODY_BYTES = MAX_AD_CREATIVE_BYTES + 64 * 1024;
const MAX_STRIPE_WEBHOOK_BYTES = 512 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/session") {
      if (request.method !== "POST") return textResponse("Method Not Allowed", 405, { Allow: "POST" });
      if (!sameOrigin(request, env)) return jsonResponse({ error: "Cross-origin requests are not allowed." }, 403);
      return createSession(request, env);
    }

    if (url.pathname === "/api/stats") {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405, { Allow: "GET" });
      return transferStatsStub(env).fetch("https://stats.internal/total");
    }

    if (url.pathname === "/api/ad") {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405, { Allow: "GET" });
      return adAuctionStub(env).fetch("https://ad.internal/state");
    }

    if (url.pathname === "/api/ad/checkout") {
      if (request.method !== "POST") return textResponse("Method Not Allowed", 405, { Allow: "POST" });
      if (!sameOrigin(request, env)) return jsonResponse({ error: "Cross-origin requests are not allowed." }, 403);
      return createAdCheckout(request, env);
    }

    if (url.pathname === "/api/ad/stripe/webhook") {
      if (request.method !== "POST") return textResponse("Method Not Allowed", 405, { Allow: "POST" });
      return handleStripeWebhook(request, env);
    }

    const creativeMatch = url.pathname.match(/^\/api\/ad\/creative\/([^/]+)$/);
    if (creativeMatch) {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405, { Allow: "GET" });
      return serveAdCreative(creativeMatch[1], env);
    }

    if (url.pathname === "/api/ad/admin/pending") {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405, { Allow: "GET" });
      if (!adminAuthorized(request, env)) return textResponse("Unauthorized", 401);
      return adAuctionStub(env).fetch("https://ad.internal/admin/pending");
    }

    if (url.pathname === "/api/ad/admin/enabled") {
      if (!adminAuthorized(request, env)) return textResponse("Unauthorized", 401);
      if (request.method === "GET") {
        return adAuctionStub(env).fetch("https://ad.internal/admin/enabled");
      }
      if (request.method !== "POST") {
        return textResponse("Method Not Allowed", 405, { Allow: "GET, POST" });
      }
      let input: unknown;
      try {
        input = await readBoundedJson(request, 128);
      } catch {
        return jsonResponse({ error: "Expected an enabled boolean." }, 400);
      }
      if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).enabled !== "boolean") {
        return jsonResponse({ error: "Expected an enabled boolean." }, 400);
      }
      return adAuctionStub(env).fetch("https://ad.internal/admin/enabled", {
        method: "POST",
        body: JSON.stringify({ enabled: (input as { enabled: boolean }).enabled }),
      });
    }

    if (url.pathname === "/api/ad/admin/approve") {
      if (request.method !== "POST") return textResponse("Method Not Allowed", 405, { Allow: "POST" });
      if (!adminAuthorized(request, env)) return textResponse("Unauthorized", 401);
      const body = await readSmallAdminBody(request);
      if (!body) return jsonResponse({ error: "A valid submission ID is required." }, 400);
      return approveAdSubmission(body.id, env);
    }

    if (url.pathname === "/api/ad/admin/reject") {
      if (request.method !== "POST") return textResponse("Method Not Allowed", 405, { Allow: "POST" });
      if (!adminAuthorized(request, env)) return textResponse("Unauthorized", 401);
      return rejectAdSubmission(request, env);
    }

    const senderMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{24})\/sender$/);
    if (senderMatch) {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405, { Allow: "GET" });
      if (!sameOrigin(request, env)) return textResponse("Cross-origin requests are not allowed", 403);
      return forwardSender(request, env, senderMatch[1]);
    }

    const downloadMatch = url.pathname.match(/^\/d\/([^/]+)$/);
    if (downloadMatch) {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405, { Allow: "GET" });
      if (!SESSION_ID_PATTERN.test(downloadMatch[1])) return textResponse("Transfer not found", 404);
      if (request.headers.has("Range") || request.headers.has("If-Range")) {
        return textResponse("Range requests are not supported", 416);
      }
      return forwardReceiver(request, env, downloadMatch[1]);
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/d/")) {
      return textResponse("Not Found", 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env): Promise<Response> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > DEFAULTS.MAX_METADATA_BODY_BYTES) {
    return jsonResponse({ error: "Session metadata is too large." }, 413);
  }

  let input: unknown;
  try {
    input = await readBoundedJson(request, DEFAULTS.MAX_METADATA_BODY_BYTES);
  } catch (error) {
    if (error instanceof MetadataTooLargeError) {
      return jsonResponse({ error: "Session metadata is too large." }, 413);
    }
    return jsonResponse({ error: "Expected a JSON request body." }, 400);
  }
  if (!isCreateSessionRequest(input)) {
    return jsonResponse({ error: "A valid filename and non-negative integer size are required." }, 400);
  }

  const maximumSize = positiveInteger(env.MAX_FILE_SIZE_BYTES, DEFAULTS.MAX_FILE_SIZE_BYTES);
  if (input.size > maximumSize) {
    return jsonResponse({ error: `File exceeds the configured ${maximumSize}-byte limit.` }, 413);
  }

  const now = Date.now();
  const sessionTtl = positiveInteger(env.SESSION_TTL_MS, DEFAULTS.SESSION_TTL_MS);
  const maxTransferDuration = positiveInteger(
    env.MAX_TRANSFER_DURATION_MS,
    DEFAULTS.MAX_TRANSFER_DURATION_MS,
  );
  const id = randomToken(18);
  const senderSecret = randomToken(32);
  const senderSecretHash = await sha256(senderSecret);
  const sessionTag = (await sha256(id)).slice(0, 12);
  const quotaKey = await clientQuotaKey(request, env);
  const quotaSessionId = sessionTag;
  const expiresAt = now + sessionTtl;
  const quotaStub = env.IP_LIMITERS.getByName(quotaKey);

  const reservation = await quotaStub.fetch("https://limiter.internal/reserve", {
    method: "POST",
    body: JSON.stringify({
      sessionId: quotaSessionId,
      now,
      leaseExpiresAt: expiresAt + maxTransferDuration,
    }),
  });
  if (!reservation.ok) {
    const detail = (await reservation.json<{ reason?: string }>()).reason;
    const error = detail === "active_limit"
      ? "Too many active transfers from this network."
      : "Too many sessions were created recently. Try again shortly.";
    return jsonResponse({ error }, 429);
  }

  const outputFilename = sanitizeFilename(input.filename);
  const session = env.TRANSFER_SESSIONS.getByName(id);
  try {
    const initialized = await session.fetch("https://session.internal/init", {
      method: "POST",
      body: JSON.stringify({
        senderSecretHash,
        outputFilename,
        contentType: safeContentType(input.contentType),
        expectedBytes: input.size,
        createdAt: now,
        expiresAt,
        quotaKey,
        quotaSessionId,
        sessionTag,
      }),
    });
    if (!initialized.ok) throw new Error(`Session initialization returned ${initialized.status}`);
  } catch (error) {
    await quotaStub.fetch("https://limiter.internal/release", {
      method: "POST",
      body: JSON.stringify({ sessionId: quotaSessionId }),
    });
    console.error(JSON.stringify({
      event: "session_creation_failed",
      session: sessionTag,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Could not create a transfer session." }, 503);
  }

  const baseUrl = publicBaseUrl(request, env);
  const response: CreateSessionResponse = {
    id,
    senderSecret,
    downloadUrl: `${baseUrl}/d/${id}`,
    outputFilename,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  console.log(JSON.stringify({ event: "session_created", session: sessionTag }));
  return jsonResponse(response, 201);
}

async function createAdCheckout(request: Request, env: Env): Promise<Response> {
  const auction = adAuctionStub(env);
  try {
    const stateResponse = await auction.fetch("https://ad.internal/state");
    if (!stateResponse.ok) throw new Error(`Sponsor state returned ${stateResponse.status}`);
    const state = await stateResponse.json<PublicAdState>();
    if (!state.enabled) {
      return jsonResponse({ error: "Sponsor bidding is currently paused." }, 409);
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "ad_state_unavailable",
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Sponsor bidding is temporarily unavailable." }, 503);
  }
  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    return jsonResponse({ error: "Ad checkout is not configured yet." }, 503);
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AD_CHECKOUT_BODY_BYTES) {
    return jsonResponse({ error: "Banner upload is too large." }, 413);
  }

  let form: FormData;
  try {
    const bytes = await readBoundedBytes(request, MAX_AD_CHECKOUT_BODY_BYTES);
    const contentType = request.headers.get("Content-Type");
    if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) throw new Error("Expected multipart form data.");
    form = await new Request("https://form.internal", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: bytes,
    }).formData();
  } catch (error) {
    if (error instanceof MetadataTooLargeError) return jsonResponse({ error: "Banner upload is too large." }, 413);
    return jsonResponse({ error: "The ad submission form was invalid." }, 400);
  }

  const targetValue = form.get("targetUrl");
  const altValue = form.get("altText");
  const bidValue = form.get("bidDollars");
  const creative = form.get("creative");
  const acceptedTerms = form.get("acceptedTerms");
  if (
    typeof targetValue !== "string" ||
    typeof altValue !== "string" ||
    typeof bidValue !== "string" ||
    !(creative instanceof File) ||
    acceptedTerms !== "yes"
  ) return jsonResponse({ error: "Complete every ad field and accept the placement rules." }, 400);

  const target = validateAdTarget(targetValue);
  if (!target) return jsonResponse({ error: "Use a direct HTTPS website URL without a shortener or IP address." }, 400);
  const altText = altValue.trim();
  if (altText.length < 3 || altText.length > 120) {
    return jsonResponse({ error: "Banner description must be between 3 and 120 characters." }, 400);
  }
  const bidCents = parseUsdCents(bidValue);
  if (bidCents === null) return jsonResponse({ error: "Enter a valid bid of at least $1." }, 400);
  if (creative.size > MAX_AD_CREATIVE_BYTES) return jsonResponse({ error: "Banner must be 1 MB or smaller." }, 413);

  const creativeBytes = new Uint8Array(await creative.arrayBuffer());
  const info = inspectAdCreative(creativeBytes, creative.type);
  if (!info) {
    return jsonResponse({
      error: "Use a static PNG, JPG, or WebP banner between 4:1 and 10:1, at least 500×80, and no larger than 1 MB.",
    }, 400);
  }

  const id = randomToken(18);
  const objectKey = `ads/${id}`;
  const now = Date.now();
  const clientHash = await clientQuotaKey(request, env);
  try {
    await env.AD_SPONSOR_CREATIVES.put(objectKey, creativeBytes, {
      httpMetadata: { contentType: info.contentType },
      customMetadata: { width: String(info.width), height: String(info.height) },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "ad_creative_storage_failed",
      submission: id,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Could not store the sponsor banner. Try again." }, 503);
  }

  let reservation: Response;
  try {
    reservation = await auction.fetch("https://ad.internal/reserve", {
      method: "POST",
      body: JSON.stringify({
        id,
        targetUrl: target.url,
        advertiserDomain: target.hostname,
        altText,
        contentType: info.contentType,
        sizeBytes: creativeBytes.byteLength,
        width: info.width,
        height: info.height,
        bidCents,
        clientHash,
        publicBaseUrl: publicBaseUrl(request, env),
        now,
      }),
    });
  } catch (error) {
    await env.AD_SPONSOR_CREATIVES.delete(objectKey);
    console.error(JSON.stringify({
      event: "ad_reservation_failed",
      submission: id,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Could not reserve the sponsor slot. Try again." }, 503);
  }
  if (!reservation.ok) {
    await env.AD_SPONSOR_CREATIVES.delete(objectKey);
    const detail = await reservation.json<Record<string, unknown>>().catch(() => ({ error: "The ad slot is not available." }));
    return jsonResponse(detail, reservation.status);
  }
  const { checkoutExpiresAt } = await reservation.json<{ checkoutExpiresAt: number }>();

  try {
    const baseUrl = publicBaseUrl(request, env);
    const checkout = await createStripeCheckout({
      secretKey: env.STRIPE_SECRET_KEY,
      submissionId: id,
      bidCents,
      successUrl: `${baseUrl}/?ad_payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/?ad_payment=cancelled`,
      expiresAt: checkoutExpiresAt,
    });
    const recorded = await auction.fetch("https://ad.internal/checkout-created", {
      method: "POST",
      body: JSON.stringify({ id, checkoutId: checkout.id }),
    });
    if (!recorded.ok) throw new Error("The auction reservation expired during checkout creation.");
    const output: AdCheckoutResponse = { checkoutUrl: checkout.url! };
    return jsonResponse(output, 201);
  } catch (error) {
    await auction.fetch("https://ad.internal/checkout-failed", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    console.error(JSON.stringify({
      event: "ad_checkout_failed",
      submission: id,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Could not start secure checkout. Try again." }, 503);
  }
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    return textResponse("Webhook is not configured", 503);
  }
  const signature = request.headers.get("Stripe-Signature");
  if (!signature) return textResponse("Missing Stripe signature", 400);
  let rawBody: string;
  try {
    rawBody = new TextDecoder().decode(await readBoundedBytes(request, MAX_STRIPE_WEBHOOK_BYTES));
  } catch {
    return textResponse("Webhook body is too large", 413);
  }
  if (!await verifyStripeWebhook(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)) {
    return textResponse("Invalid Stripe signature", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return textResponse("Invalid JSON", 400);
  }
  if (!isStripeEvent(value) || !value.livemode) return textResponse("Invalid Stripe event", 400);

  const session = value.data.object;
  const auction = adAuctionStub(env);
  if (value.type === "checkout.session.completed") {
    const submissionId = session.metadata?.ad_submission_id;
    if (
      typeof session.id !== "string" ||
      typeof submissionId !== "string" ||
      typeof session.payment_intent !== "string" ||
      typeof session.amount_total !== "number" ||
      typeof session.currency !== "string"
    ) return textResponse("Checkout event is missing required fields", 400);
    const payment = await retrieveStripePaymentIntent(env.STRIPE_SECRET_KEY, session.payment_intent);
    if (
      payment.id !== session.payment_intent ||
      payment.capture_method !== "manual" ||
      !["requires_capture", "canceled", "succeeded"].includes(payment.status) ||
      payment.amount !== session.amount_total ||
      payment.currency.toLowerCase() !== session.currency.toLowerCase() ||
      payment.metadata?.ad_submission_id !== submissionId
    ) return textResponse("Payment authorization did not match checkout", 400);

    const response = await auction.fetch("https://ad.internal/stripe/authorized", {
      method: "POST",
      body: JSON.stringify({
        eventId: value.id,
        submissionId,
        checkoutId: session.id,
        paymentIntentId: session.payment_intent,
        amountTotal: session.amount_total,
        currency: session.currency,
        customerEmail: typeof session.customer_details?.email === "string"
          ? session.customer_details.email.slice(0, 320)
          : null,
        now: Date.now(),
      }),
    });
    if (!response.ok) return textResponse("Could not record authorization", 500);
    const result = await response.json<AuthorizationResult>();
    try {
      await releaseAuthorizations(result.cancellations, auction, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "ad_authorization_release_failed",
        submission: submissionId,
        error: error instanceof Error ? error.message : "unknown",
      }));
      return textResponse("Could not release displaced authorization", 500);
    }

    const bidderKind = result.accepted
      ? "authorized"
      : ["CANCEL_PENDING", "OUTBID"].includes(result.bidderStatus ?? "") ? "outbid" : null;
    if (bidderKind && result.customerEmail && typeof result.bidCents === "number") {
      await notifyBidder(env, {
        to: result.customerEmail,
        submissionId,
        bidCents: result.bidCents,
        kind: bidderKind,
      });
    }

    if (
      result.notifyReviewer && env.RESEND_API_KEY &&
      env.AD_NOTIFICATION_TO && env.AD_NOTIFICATION_FROM
    ) {
      const pendingResponse = await auction.fetch("https://ad.internal/admin/pending");
      if (!pendingResponse.ok) return textResponse("Could not load authorized submission", 500);
      const pending = await pendingResponse.json<{ submissions: PendingAdSubmission[] }>();
      const submission = pending.submissions.find((candidate) => candidate.id === submissionId);
      if (submission) {
        try {
          await sendAdReviewNotification({
            apiKey: env.RESEND_API_KEY,
            eventId: value.id,
            from: env.AD_NOTIFICATION_FROM,
            to: env.AD_NOTIFICATION_TO,
            publicBaseUrl: publicBaseUrl(request, env),
            submission,
          });
          console.log(JSON.stringify({ event: "ad_review_notification_sent", submission: submissionId }));
        } catch (error) {
          console.error(JSON.stringify({
            event: "ad_review_notification_failed",
            submission: submissionId,
            error: error instanceof Error ? error.message : "unknown",
          }));
          return textResponse("Authorization recorded; notification failed", 500);
        }
      }
    }
    return textResponse("ok", 200);
  }
  if (value.type === "checkout.session.expired") {
    if (typeof session.id !== "string") return textResponse("Checkout event is missing its ID", 400);
    const response = await auction.fetch("https://ad.internal/stripe/expired", {
      method: "POST",
      body: JSON.stringify({ eventId: value.id, checkoutId: session.id, now: Date.now() }),
    });
    return response.ok ? textResponse("ok", 200) : textResponse("Could not expire checkout", 500);
  }
  return textResponse("ignored", 200);
}

async function serveAdCreative(id: string, env: Env): Promise<Response> {
  if (!AD_ID_PATTERN.test(id)) return textResponse("Not Found", 404);
  const object = await env.AD_SPONSOR_CREATIVES.get(`ads/${id}`);
  if (!object) return textResponse("Not Found", 404);
  const contentType = object.httpMetadata?.contentType;
  if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return textResponse("Invalid creative", 500);
  }
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(object.size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  addSecurityHeaders(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function rejectAdSubmission(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) return jsonResponse({ error: "Stripe is not configured." }, 503);
  const body = await readSmallAdminBody(request);
  if (!body) return jsonResponse({ error: "A valid submission ID is required." }, 400);
  const auction = adAuctionStub(env);
  const infoResponse = await auction.fetch("https://ad.internal/admin/rejection-info", {
    method: "POST",
    body: JSON.stringify({ id: body.id, reason: body.reason }),
  });
  if (!infoResponse.ok) return textResponse("Submission not found", 404);
  const info = await infoResponse.json<{
    paymentIntentId: string;
    customerEmail: string | null;
  }>();
  try {
    const cancelled = await cancelStripePayment(env.STRIPE_SECRET_KEY, info.paymentIntentId, body.id);
    if (cancelled.status !== "canceled") throw new Error(`Stripe returned ${cancelled.status}.`);
    const result = await auction.fetch("https://ad.internal/stripe/cancelled", {
      method: "POST",
      body: JSON.stringify({ id: body.id, paymentIntentId: info.paymentIntentId }),
    });
    if (!result.ok) return result;
    const completion = await result.json<{ customerEmail?: string | null; bidCents?: number }>();
    const customerEmail = completion.customerEmail ?? info.customerEmail;
    if (customerEmail && typeof completion.bidCents === "number") {
      await notifyBidder(env, {
        to: customerEmail,
        submissionId: body.id,
        bidCents: completion.bidCents,
        kind: "rejected",
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({
      event: "ad_authorization_release_failed",
      submission: body.id,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Stripe could not release this authorization." }, 502);
  }
}

interface AuthorizationResult {
  accepted: boolean;
  notifyReviewer: boolean;
  bidderStatus: string | null;
  customerEmail: string | null;
  bidCents: number | null;
  cancellations: Array<{
    id: string;
    paymentIntentId: string;
    outcome: "OUTBID" | "REJECTED";
    customerEmail: string | null;
    bidCents: number;
  }>;
}

async function releaseAuthorizations(
  jobs: AuthorizationResult["cancellations"],
  auction: DurableObjectStub<AdAuction>,
  env: Env,
): Promise<void> {
  await Promise.all(jobs.map(async (job) => {
    const payment = await cancelStripePayment(env.STRIPE_SECRET_KEY!, job.paymentIntentId, job.id);
    if (payment.status !== "canceled") throw new Error(`Stripe returned ${payment.status}.`);
    const acknowledged = await auction.fetch("https://ad.internal/stripe/cancelled", {
      method: "POST",
      body: JSON.stringify({ id: job.id, paymentIntentId: job.paymentIntentId }),
    });
    if (!acknowledged.ok) throw new Error(`Cancellation acknowledgement returned ${acknowledged.status}.`);
    if (job.customerEmail) {
      await notifyBidder(env, {
        to: job.customerEmail,
        submissionId: job.id,
        bidCents: job.bidCents,
        kind: job.outcome === "REJECTED" ? "rejected" : "outbid",
      });
    }
  }));
}

async function approveAdSubmission(id: string, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    return jsonResponse({ error: "Stripe is not configured." }, 503);
  }
  const auction = adAuctionStub(env);
  const prepared = await auction.fetch("https://ad.internal/admin/approve", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  if (!prepared.ok) return prepared;
  const decision = await prepared.json<{
    action: "scheduled" | "capture";
    activatesAt?: number;
    customerEmail?: string | null;
    bidCents?: number;
    capture?: {
      id: string;
      paymentIntentId: string;
      bidCents: number;
      customerEmail: string | null;
    };
  }>();
  if (decision.action === "scheduled") {
    if (decision.customerEmail && typeof decision.bidCents === "number") {
      await notifyBidder(env, {
        to: decision.customerEmail,
        submissionId: id,
        bidCents: decision.bidCents,
        kind: "scheduled",
        activatesAt: decision.activatesAt,
      });
    }
    return Response.json({ ok: true, scheduled: true, activatesAt: decision.activatesAt });
  }
  if (!decision.capture) return jsonResponse({ error: "Auction did not return a capture job." }, 500);
  try {
    const payment = await captureStripePayment(
      env.STRIPE_SECRET_KEY,
      decision.capture.paymentIntentId,
      decision.capture.id,
    );
    if (payment.status !== "succeeded" || payment.amount_received !== decision.capture.bidCents) {
      throw new Error(`Stripe capture returned ${payment.status}.`);
    }
    const activated = await auction.fetch("https://ad.internal/stripe/captured", {
      method: "POST",
      body: JSON.stringify({
        id: decision.capture.id,
        paymentIntentId: decision.capture.paymentIntentId,
        amountReceived: payment.amount_received,
      }),
    });
    if (!activated.ok) return activated;
    return activated;
  } catch (error) {
    await auction.fetch("https://ad.internal/stripe/capture-failed", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    console.error(JSON.stringify({
      event: "ad_capture_failed",
      submission: id,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return jsonResponse({ error: "Stripe could not capture the winning bid. It will be retried." }, 502);
  }
}

async function notifyBidder(
  env: Env,
  input: {
    to: string;
    submissionId: string;
    bidCents: number;
    kind: "authorized" | "outbid" | "scheduled" | "live" | "replaced" | "rejected";
    activatesAt?: number;
  },
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.AD_NOTIFICATION_FROM) return;
  try {
    await sendAdBidderNotification({
      apiKey: env.RESEND_API_KEY,
      from: env.AD_NOTIFICATION_FROM,
      publicBaseUrl: env.PUBLIC_BASE_URL ?? "https://termdrop.sh",
      ...input,
    });
    console.log(JSON.stringify({
      event: "ad_bidder_notification_sent",
      submission: input.submissionId,
      notification: input.kind,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "ad_bidder_notification_failed",
      submission: input.submissionId,
      notification: input.kind,
      error: error instanceof Error ? error.message : "unknown",
    }));
  }
}

async function readSmallAdminBody(request: Request): Promise<{ id: string; reason?: string } | null> {
  try {
    const value = await readBoundedJson(request, 2_048);
    if (!value || typeof value !== "object") return null;
    const input = value as Record<string, unknown>;
    if (typeof input.id !== "string" || !AD_ID_PATTERN.test(input.id)) return null;
    return {
      id: input.id,
      reason: typeof input.reason === "string" ? input.reason.slice(0, 500) : undefined,
    };
  } catch {
    return null;
  }
}

function adminAuthorized(request: Request, env: Env): boolean {
  if (!env.AD_ADMIN_SECRET || env.AD_ADMIN_SECRET.length < 32) return false;
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  return timingSafeStringEqual(authorization.slice(7), env.AD_ADMIN_SECRET);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

async function forwardSender(request: Request, env: Env, id: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return textResponse("Expected WebSocket", 426);
  }
  try {
    const session = env.TRANSFER_SESSIONS.getByName(id);
    return await session.fetch(new Request("https://session.internal/sender", request));
  } catch (error) {
    console.error(JSON.stringify({
      event: "sender_connection_failed",
      error: error instanceof Error ? error.message : "unknown",
    }));
    return textResponse("Could not connect to transfer session", 503);
  }
}

async function forwardReceiver(request: Request, env: Env, id: string): Promise<Response> {
  try {
    const session = env.TRANSFER_SESSIONS.getByName(id);
    // Return this response verbatim so FixedLengthStream identity and cancellation propagate.
    return await session.fetch(new Request("https://session.internal/receiver", request));
  } catch (error) {
    console.error(JSON.stringify({
      event: "receiver_connection_failed",
      error: error instanceof Error ? error.message : "unknown",
    }));
    return textResponse("The transfer relay is unavailable", 503);
  }
}

function isCreateSessionRequest(value: unknown): value is CreateSessionRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.filename === "string" &&
    input.filename.length > 0 &&
    input.filename.length <= 1024 &&
    typeof input.size === "number" &&
    Number.isSafeInteger(input.size) &&
    input.size >= 0 &&
    (input.contentType === undefined ||
      (typeof input.contentType === "string" && input.contentType.length <= 256))
  );
}

function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(publicBaseUrl(request, env)).origin;
  } catch {
    return false;
  }
}

function publicBaseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

async function clientQuotaKey(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local-development";
  if (!env.IP_HASH_SECRET) return sha256(`termdrop-local-only\0${ip}`);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.IP_HASH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return base64Url(new Uint8Array(signature));
}

function randomToken(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

class MetadataTooLargeError extends Error {}

async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(request, maximumBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readBoundedBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) throw new SyntaxError("Missing body");
  const reader = request.body.getReader();
  const buffer = new Uint8Array(new ArrayBuffer(maximumBytes));
  let length = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maximumBytes) {
        await reader.cancel("Request body is too large");
        throw new MetadataTooLargeError();
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return buffer.slice(0, length);
}
