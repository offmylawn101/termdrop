import { env as runtimeEnv, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PublicAdState } from "../src/shared/ad-protocol";
import type { Env } from "../src/worker/env";

const env = runtimeEnv as unknown as Env;
const origin = "https://termdrop.sh";

describe("TermDrop sponsor auction", () => {
  it("serves the supplied Fister placement as the default", async () => {
    const response = await exports.default.fetch(`${origin}/api/ad`);
    expect(response.status).toBe(200);
    expect(await response.json<PublicAdState>()).toMatchObject({
      enabled: true,
      id: "default-fister",
      creativeUrl: "/sponsor-banner.png",
      targetUrl: "https://fister.fun/",
      advertiserDomain: "fister.fun",
      minimumBidCents: 100,
      isDefault: true,
    });
  });

  it("can hide the placement and atomically pause new bids", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-visibility-switch");
    expect(await (await stub.fetch("https://ad.internal/admin/enabled")).json()).toEqual({
      enabled: true,
    });

    const disabled = await stub.fetch("https://ad.internal/admin/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    expect(await disabled.json()).toEqual({ ok: true, enabled: false });
    expect(await (await stub.fetch("https://ad.internal/state")).json()).toMatchObject({
      enabled: false,
    });
    const blocked = await reserve(stub, "K".repeat(24), 100, Date.now(), "K");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "Sponsor bidding is currently paused." });

    const enabled = await stub.fetch("https://ad.internal/admin/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    expect(await enabled.json()).toEqual({ ok: true, enabled: true });
    expect((await reserve(stub, "L".repeat(24), 100, Date.now(), "L")).status).toBe(200);
  });

  it("authorizes, reviews, captures, and permanently activates a winner", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-capture");
    const id = "A".repeat(24);
    const now = Date.now();
    await storeCreative(id);
    expect((await reserve(stub, id, 100, now, "A")).status).toBe(200);
    expect((await recordCheckout(stub, id)).status).toBe(200);

    const mismatch = await authorize(stub, id, 101, now + 1_000);
    expect(mismatch.status).toBe(409);
    const authorized = await authorize(stub, id, 100, now + 1_000);
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      accepted: true,
      notifyReviewer: true,
      bidderStatus: "AUTHORIZED_PENDING_REVIEW",
      cancellations: [],
    });
    const duplicate = await authorize(stub, id, 100, now + 1_000);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true, accepted: true });

    const pending = await stub.fetch("https://ad.internal/admin/pending");
    expect(await pending.json()).toMatchObject({
      submissions: [{ id, bidCents: 100, customerEmail: `${id}@example.com` }],
    });
    const approval = await stub.fetch("https://ad.internal/admin/approve", {
      method: "POST",
      body: JSON.stringify({ id, now: now + 2_000 }),
    });
    expect(await approval.json()).toMatchObject({
      action: "capture",
      capture: { id, paymentIntentId: paymentIntentId(id), bidCents: 100 },
    });
    const activation = await stub.fetch("https://ad.internal/stripe/captured", {
      method: "POST",
      body: JSON.stringify({
        id,
        paymentIntentId: paymentIntentId(id),
        amountReceived: 100,
        now: now + 3_000,
      }),
    });
    expect(activation.status).toBe(200);
    const state = await (await stub.fetch("https://ad.internal/state")).json<PublicAdState>();
    expect(state).toMatchObject({
      id,
      creativeUrl: `/api/ad/creative/${id}`,
      currentBidCents: 100,
      minimumBidCents: 200,
      expiresAt: null,
      isDefault: false,
    });
    expect(state.lockedUntil).toBe(now + 3_000 + 60 * 60 * 1_000);
    expect((await env.AD_SPONSOR_CREATIVES.get(`ads/${id}`))?.size).toBe(3);
  });

  it("keeps bidding open during the protected hour and only keeps the highest challenger", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-challengers");
    const first = "B".repeat(24);
    const second = "C".repeat(24);
    const third = "D".repeat(24);
    const now = Date.now();

    await storeCreative(first);
    await reserve(stub, first, 100, now, "B");
    await recordCheckout(stub, first);
    await authorize(stub, first, 100, now + 100);
    await stub.fetch("https://ad.internal/admin/approve", {
      method: "POST",
      body: JSON.stringify({ id: first, now: now + 200 }),
    });
    await stub.fetch("https://ad.internal/stripe/captured", {
      method: "POST",
      body: JSON.stringify({
        id: first,
        paymentIntentId: paymentIntentId(first),
        amountReceived: 100,
        now: now + 300,
      }),
    });

    await storeCreative(second);
    expect((await reserve(stub, second, 200, now + 400, "C")).status).toBe(200);
    await recordCheckout(stub, second);
    expect((await authorize(stub, second, 200, now + 500)).status).toBe(200);
    const scheduled = await stub.fetch("https://ad.internal/admin/approve", {
      method: "POST",
      body: JSON.stringify({ id: second, now: now + 600 }),
    });
    expect(await scheduled.json()).toMatchObject({
      action: "scheduled",
      activatesAt: now + 300 + 60 * 60 * 1_000,
    });

    await storeCreative(third);
    expect((await reserve(stub, third, 300, now + 700, "D")).status).toBe(200);
    await recordCheckout(stub, third);
    const higher = await authorize(stub, third, 300, now + 800);
    expect(await higher.json()).toMatchObject({
      accepted: true,
      cancellations: [{
        id: second,
        paymentIntentId: paymentIntentId(second),
        outcome: "OUTBID",
      }],
    });
    expect(await env.AD_SPONSOR_CREATIVES.get(`ads/${second}`)).toBeNull();
    expect((await env.AD_SPONSOR_CREATIVES.get(`ads/${first}`))?.size).toBe(3);

    const released = await stub.fetch("https://ad.internal/stripe/cancelled", {
      method: "POST",
      body: JSON.stringify({ id: second, paymentIntentId: paymentIntentId(second), now: now + 900 }),
    });
    expect(await released.json()).toMatchObject({ ok: true, outcome: "OUTBID", bidCents: 200 });
    expect(await (await stub.fetch("https://ad.internal/admin/pending")).json()).toMatchObject({
      submissions: [{ id: third, bidCents: 300 }],
    });
    expect(await (await stub.fetch("https://ad.internal/state")).json()).toMatchObject({
      id: first,
      currentBidCents: 100,
      minimumBidCents: 400,
    });
  });

  it("cancels a stale lower checkout without disturbing the leading bid", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-stale-checkout");
    const lower = "E".repeat(24);
    const higher = "F".repeat(24);
    const now = Date.now();
    await Promise.all([storeCreative(lower), storeCreative(higher)]);
    expect((await reserve(stub, lower, 100, now, "E")).status).toBe(200);
    expect((await reserve(stub, higher, 500, now + 1, "F")).status).toBe(200);
    await Promise.all([recordCheckout(stub, lower), recordCheckout(stub, higher)]);
    expect((await authorize(stub, higher, 500, now + 2)).status).toBe(200);
    const stale = await authorize(stub, lower, 100, now + 3);
    expect(await stale.json()).toMatchObject({
      accepted: false,
      bidderStatus: "CANCEL_PENDING",
      cancellations: [{ id: lower, paymentIntentId: paymentIntentId(lower) }],
    });
    expect(await env.AD_SPONSOR_CREATIVES.get(`ads/${lower}`)).toBeNull();
    expect(await (await stub.fetch("https://ad.internal/state")).json()).toMatchObject({
      minimumBidCents: 600,
    });
  });

  it("releases an authorization that arrives after its checkout expired", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-expired-authorization");
    const id = "J".repeat(24);
    const now = Date.now();
    await storeCreative(id);
    await reserve(stub, id, 100, now, "J");
    await recordCheckout(stub, id);
    const expired = await stub.fetch("https://ad.internal/stripe/expired", {
      method: "POST",
      body: JSON.stringify({
        eventId: `evt_expired_${id}`,
        checkoutId: checkoutId(id),
        now: now + 1,
      }),
    });
    expect(expired.status).toBe(200);
    const late = await authorize(stub, id, 100, now + 2);
    expect(await late.json()).toMatchObject({
      accepted: false,
      bidderStatus: "CANCEL_PENDING",
      cancellations: [{ id, paymentIntentId: paymentIntentId(id) }],
    });
    expect(await (await stub.fetch("https://ad.internal/state")).json()).toMatchObject({
      id: "default-fister",
      minimumBidCents: 100,
    });
  });

  it("schedules an approved challenger, then captures it after the lock", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-scheduled-capture");
    const current = "G".repeat(24);
    const challenger = "H".repeat(24);
    const now = Date.now();
    await storeCreative(current);
    await reserve(stub, current, 100, now, "G");
    await recordCheckout(stub, current);
    await authorize(stub, current, 100, now + 1);
    await stub.fetch("https://ad.internal/admin/approve", {
      method: "POST",
      body: JSON.stringify({ id: current, now: now + 2 }),
    });
    const firstActivatedAt = now + 3;
    await stub.fetch("https://ad.internal/stripe/captured", {
      method: "POST",
      body: JSON.stringify({
        id: current,
        paymentIntentId: paymentIntentId(current),
        amountReceived: 100,
        now: firstActivatedAt,
      }),
    });
    await storeCreative(challenger);
    await reserve(stub, challenger, 200, now + 4, "H");
    await recordCheckout(stub, challenger);
    await authorize(stub, challenger, 200, now + 5);
    const beforeLock = await stub.fetch("https://ad.internal/admin/approve", {
      method: "POST",
      body: JSON.stringify({ id: challenger, now: now + 6 }),
    });
    expect((await beforeLock.json<{ action: string }>()).action).toBe("scheduled");

    const lockEnd = firstActivatedAt + 60 * 60 * 1_000;
    const afterLock = await stub.fetch("https://ad.internal/admin/approve", {
      method: "POST",
      body: JSON.stringify({ id: challenger, now: lockEnd + 1 }),
    });
    expect((await afterLock.json<{ action: string }>()).action).toBe("capture");
    const captured = await stub.fetch("https://ad.internal/stripe/captured", {
      method: "POST",
      body: JSON.stringify({
        id: challenger,
        paymentIntentId: paymentIntentId(challenger),
        amountReceived: 200,
        now: lockEnd + 2,
      }),
    });
    expect(captured.status).toBe(200);
    expect(await (await stub.fetch("https://ad.internal/state")).json()).toMatchObject({
      id: challenger,
      currentBidCents: 200,
      minimumBidCents: 300,
      expiresAt: null,
    });
    expect(await env.AD_SPONSOR_CREATIVES.get(`ads/${current}`)).toBeNull();
  });

  it("releases rejected bids instead of capturing or refunding them", async () => {
    const stub = env.AD_AUCTION.getByName("test-auction-rejection");
    const id = "I".repeat(24);
    const now = Date.now();
    await storeCreative(id);
    await reserve(stub, id, 100, now, "I");
    await recordCheckout(stub, id);
    await authorize(stub, id, 100, now + 1);
    const rejection = await stub.fetch("https://ad.internal/admin/rejection-info", {
      method: "POST",
      body: JSON.stringify({ id, reason: "Not suitable", now: now + 2 }),
    });
    expect(await rejection.json()).toMatchObject({
      paymentIntentId: paymentIntentId(id),
      customerEmail: `${id}@example.com`,
    });
    const cancelled = await stub.fetch("https://ad.internal/stripe/cancelled", {
      method: "POST",
      body: JSON.stringify({ id, paymentIntentId: paymentIntentId(id), now: now + 3 }),
    });
    expect(await cancelled.json()).toMatchObject({ ok: true, outcome: "REJECTED" });
    expect(await env.AD_SPONSOR_CREATIVES.get(`ads/${id}`)).toBeNull();
    expect(await (await stub.fetch("https://ad.internal/admin/pending")).json()).toEqual({ submissions: [] });
  });

  it("keeps admin actions private and ad checkout disabled without a live secret", async () => {
    expect((await exports.default.fetch(`${origin}/api/ad/admin/pending`)).status).toBe(401);
    expect((await exports.default.fetch(`${origin}/api/ad/admin/enabled`)).status).toBe(401);
    const checkout = await exports.default.fetch(`${origin}/api/ad/checkout`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(checkout.status).toBe(503);
  });
});

async function storeCreative(id: string): Promise<void> {
  await env.AD_SPONSOR_CREATIVES.put(`ads/${id}`, new Uint8Array([1, 2, 3]), {
    httpMetadata: { contentType: "image/png" },
  });
}

async function reserve(
  stub: DurableObjectStub,
  id: string,
  bidCents: number,
  now: number,
  hashCharacter: string,
): Promise<Response> {
  return stub.fetch("https://ad.internal/reserve", {
    method: "POST",
    body: JSON.stringify({
      id,
      targetUrl: `https://example.com/${id}`,
      advertiserDomain: "example.com",
      altText: "Example sponsor",
      contentType: "image/png",
      sizeBytes: 3,
      width: 500,
      height: 90,
      bidCents,
      clientHash: hashCharacter.repeat(43),
      publicBaseUrl: origin,
      now,
    }),
  });
}

function recordCheckout(stub: DurableObjectStub, id: string): Promise<Response> {
  return stub.fetch("https://ad.internal/checkout-created", {
    method: "POST",
    body: JSON.stringify({ id, checkoutId: checkoutId(id) }),
  });
}

function authorize(
  stub: DurableObjectStub,
  id: string,
  amountTotal: number,
  now: number,
): Promise<Response> {
  return stub.fetch("https://ad.internal/stripe/authorized", {
    method: "POST",
    body: JSON.stringify({
      eventId: eventId(id),
      submissionId: id,
      checkoutId: checkoutId(id),
      paymentIntentId: paymentIntentId(id),
      amountTotal,
      currency: "usd",
      customerEmail: `${id}@example.com`,
      now,
    }),
  });
}

function checkoutId(id: string): string {
  return `cs_${id}`;
}

function paymentIntentId(id: string): string {
  return `pi_${id}`;
}

function eventId(id: string): string {
  return `evt_${id}`;
}
