import { describe, expect, it } from "vitest";
import {
  inspectAdCreative,
  parseUsdCents,
  validateAdTarget,
} from "../src/shared/ad-validation";
import { verifyStripeWebhook } from "../src/worker/stripe";

describe("ad submission validation", () => {
  it("parses bounded USD amounts without floating-point rounding", () => {
    expect(parseUsdCents("1")).toBe(100);
    expect(parseUsdCents("12.34")).toBe(1_234);
    expect(parseUsdCents("0.99")).toBeNull();
    expect(parseUsdCents("1.001")).toBeNull();
    expect(parseUsdCents("1e3")).toBeNull();
    expect(parseUsdCents("100000.01")).toBeNull();
  });

  it("accepts direct HTTPS targets and rejects risky destinations", () => {
    expect(validateAdTarget("https://example.com/offer#tracking")).toEqual({
      url: "https://example.com/offer",
      hostname: "example.com",
    });
    expect(validateAdTarget("http://example.com")).toBeNull();
    expect(validateAdTarget("https://user:pass@example.com")).toBeNull();
    expect(validateAdTarget("https://localhost/page")).toBeNull();
    expect(validateAdTarget("https://127.0.0.1/page")).toBeNull();
    expect(validateAdTarget("https://tinyurl.com/example")).toBeNull();
  });

  it("accepts a static banner-sized PNG and rejects animation or bad dimensions", () => {
    expect(inspectAdCreative(pngHeader(500, 90), "image/png")).toEqual({
      contentType: "image/png",
      width: 500,
      height: 90,
    });
    expect(inspectAdCreative(pngHeader(200, 90), "image/png")).toBeNull();
    expect(inspectAdCreative(pngHeader(500, 90, "acTL"), "image/png")).toBeNull();
    expect(inspectAdCreative(pngHeader(500, 90), "image/jpeg")).toBeNull();
  });

  it("verifies the raw Stripe webhook signature and timestamp", async () => {
    const payload = JSON.stringify({ id: "evt_test" });
    const secret = "whsec_test_secret";
    const timestamp = 1_800_000_000;
    const signature = await hmacHex(secret, `${timestamp}.${payload}`);
    expect(await verifyStripeWebhook(payload, `t=${timestamp},v1=${signature}`, secret, timestamp)).toBe(true);
    expect(await verifyStripeWebhook(`${payload} `, `t=${timestamp},v1=${signature}`, secret, timestamp)).toBe(false);
    expect(await verifyStripeWebhook(payload, `t=${timestamp - 301},v1=${signature}`, secret, timestamp)).toBe(false);
  });
});

function pngHeader(width: number, height: number, suffix = ""): Uint8Array {
  const bytes = new Uint8Array(32 + suffix.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  bytes.set(new TextEncoder().encode(suffix), 28);
  return bytes;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  ));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
