import { describe, expect, it, vi } from "vitest";
import { sendAdBidderNotification, sendAdReviewNotification } from "../src/worker/resend";

const submission = {
  id: "A".repeat(24),
  creativeUrl: `/api/ad/creative/${"A".repeat(24)}`,
  targetUrl: "https://example.com/?offer=<sale>",
  advertiserDomain: "example.com",
  altText: "Example <sponsor>",
  bidCents: 1_250,
  width: 1_200,
  height: 160,
  contentType: "image/webp",
  sizeBytes: 42_000,
  customerEmail: "buyer@example.com",
  createdAt: 1_787_700_000_000,
};

describe("Resend ad review notifications", () => {
  it("sends an idempotent review email with safe submission details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email_example" }));
    await sendAdReviewNotification({
      apiKey: "re_example",
      eventId: "evt_example",
      from: "TermDrop <notifications@fister.fun>",
      to: "nate@maxbid.biz",
      publicBaseUrl: "https://termdrop.sh",
      submission,
    }, fetcher);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("termdrop-ad-evt_example");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: "TermDrop <notifications@fister.fun>",
      to: ["nate@maxbid.biz"],
      subject: "New TermDrop sponsor bid: $12.50 from example.com",
    });
    expect(body.text).toContain(`npm run ad:admin -- approve ${submission.id}`);
    expect(body.html).toContain("Example &lt;sponsor&gt;");
    expect(body.html).not.toContain("Example <sponsor>");
  });

  it("fails retryably when Resend rejects the request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 503 }));
    await expect(sendAdReviewNotification({
      apiKey: "re_example",
      eventId: "evt_example",
      from: "TermDrop <notifications@fister.fun>",
      to: "nate@maxbid.biz",
      publicBaseUrl: "https://termdrop.sh",
      submission,
    }, fetcher)).rejects.toThrow("Resend returned HTTP 503.");
  });

  it("sends idempotent bidder lifecycle messages from the configured sender", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email_bidder" }));
    await sendAdBidderNotification({
      apiKey: "re_example",
      from: "TermDrop <notifications@fister.fun>",
      to: "buyer@example.com",
      publicBaseUrl: "https://termdrop.sh",
      submissionId: submission.id,
      bidCents: 1_250,
      kind: "outbid",
    }, fetcher);

    const [, init] = fetcher.mock.calls[0];
    expect(new Headers(init?.headers).get("Idempotency-Key"))
      .toBe(`termdrop-bidder-outbid-${submission.id}`);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: "TermDrop <notifications@fister.fun>",
      to: ["buyer@example.com"],
      subject: "Your TermDrop sponsor bid was outbid",
    });
    expect(body.text).toContain("will not charge it");
    expect(body.text).toContain("$12.50");
  });
});
