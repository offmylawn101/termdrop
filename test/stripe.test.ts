import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelStripePayment,
  captureStripePayment,
  createStripeCheckout,
  retrieveStripePaymentIntent,
} from "../src/worker/stripe";

describe("Stripe manual-capture operations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates card-only Checkout with manual capture", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      id: "cs_example",
      url: "https://checkout.stripe.com/example",
    }));
    await createStripeCheckout({
      secretKey: "sk_live_example",
      submissionId: "A".repeat(24),
      bidCents: 1_500,
      successUrl: "https://termdrop.sh/?ad_payment=success",
      cancelUrl: "https://termdrop.sh/?ad_payment=cancelled",
      expiresAt: 1_800_000_000_000,
    });
    const [url, init] = fetcher.mock.calls[0];
    const body = new URLSearchParams(String(init?.body));
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(body.get("payment_intent_data[capture_method]")).toBe("manual");
    expect(body.get("payment_method_types[0]")).toBe("card");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("1500");
  });

  it("retrieves, captures, and cancels the exact PaymentIntent idempotently", async () => {
    const payment = {
      id: "pi_example",
      amount: 1_500,
      amount_capturable: 1_500,
      amount_received: 0,
      capture_method: "manual",
      currency: "usd",
      status: "requires_capture",
      metadata: { ad_submission_id: "A".repeat(24) },
    };
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(Response.json(payment)));
    await retrieveStripePaymentIntent("sk_live_example", "pi_example");
    await captureStripePayment("sk_live_example", "pi_example", "A".repeat(24));
    await cancelStripePayment("sk_live_example", "pi_example", "A".repeat(24));

    expect(fetcher.mock.calls[0][0]).toBe("https://api.stripe.com/v1/payment_intents/pi_example");
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
    expect(fetcher.mock.calls[1][0]).toBe("https://api.stripe.com/v1/payment_intents/pi_example/capture");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Idempotency-Key"))
      .toBe(`termdrop-capture-${"A".repeat(24)}`);
    expect(fetcher.mock.calls[2][0]).toBe("https://api.stripe.com/v1/payment_intents/pi_example/cancel");
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get("Idempotency-Key"))
      .toBe(`termdrop-cancel-${"A".repeat(24)}`);
  });
});
