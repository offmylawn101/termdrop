import type { PendingAdSubmission } from "../shared/ad-protocol";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

interface AdReviewNotificationInput {
  apiKey: string;
  eventId: string;
  from: string;
  to: string;
  publicBaseUrl: string;
  submission: PendingAdSubmission;
}

type BidderNotificationKind = "authorized" | "outbid" | "scheduled" | "live" | "replaced" | "rejected";

interface AdBidderNotificationInput {
  apiKey: string;
  from: string;
  to: string;
  publicBaseUrl: string;
  submissionId: string;
  bidCents: number;
  kind: BidderNotificationKind;
  activatesAt?: number;
}

export async function sendAdReviewNotification(
  input: AdReviewNotificationInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const bid = formatUsd(input.submission.bidCents);
  const creativeUrl = new URL(input.submission.creativeUrl, input.publicBaseUrl).toString();
  const approveCommand = `npm run ad:admin -- approve ${input.submission.id}`;
  const rejectCommand = `npm run ad:admin -- reject ${input.submission.id} "reason"`;
  const buyer = input.submission.customerEmail ?? "Not provided";
  const subject = `New TermDrop sponsor bid: ${bid} from ${input.submission.advertiserDomain}`;

  const response = await fetcher(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `termdrop-ad-${input.eventId}`,
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject,
      text: [
        "An authorized TermDrop sponsor bid is ready for review.",
        "",
        `Bid: ${bid}`,
        `Advertiser: ${input.submission.advertiserDomain}`,
        `Buyer: ${buyer}`,
        `Destination: ${input.submission.targetUrl}`,
        `Description: ${input.submission.altText}`,
        `Creative: ${creativeUrl}`,
        `Dimensions: ${input.submission.width} x ${input.submission.height}`,
        "",
        "Approve:",
        approveCommand,
        "",
        "Reject and release the card hold:",
        rejectCommand,
      ].join("\n"),
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;color:#111827">
          <h1 style="font-size:24px;margin:0 0 8px">New TermDrop sponsor bid</h1>
          <p style="font-size:18px;margin:0 0 24px"><strong>${escapeHtml(bid)}</strong> from ${escapeHtml(input.submission.advertiserDomain)}</p>
          <img src="${escapeHtml(creativeUrl)}" alt="${escapeHtml(input.submission.altText)}" width="600" style="display:block;width:100%;height:auto;max-height:160px;object-fit:contain;background:#111419;border-radius:12px" />
          <table style="width:100%;margin:24px 0;border-collapse:collapse;font-size:14px">
            ${detailRow("Buyer", buyer)}
            ${detailRow("Destination", input.submission.targetUrl)}
            ${detailRow("Description", input.submission.altText)}
            ${detailRow("Dimensions", `${input.submission.width} x ${input.submission.height}`)}
            ${detailRow("Submission", input.submission.id)}
          </table>
          <p style="margin:0 0 8px;font-weight:700">Approve</p>
          <pre style="padding:12px;overflow:auto;background:#f3f4f6;border-radius:8px">${escapeHtml(approveCommand)}</pre>
          <p style="margin:20px 0 8px;font-weight:700">Reject and release the card hold</p>
          <pre style="padding:12px;overflow:auto;background:#f3f4f6;border-radius:8px">${escapeHtml(rejectCommand)}</pre>
        </div>
      `,
      tags: [
        { name: "event", value: "ad_authorization" },
        { name: "submission", value: input.submission.id },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend returned HTTP ${response.status}.`);
  }
}

export async function sendAdBidderNotification(
  input: AdBidderNotificationInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const bid = formatUsd(input.bidCents);
  const content = bidderMessage(input.kind, bid, input.activatesAt);
  const response = await fetcher(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `termdrop-bidder-${input.kind}-${input.submissionId}`,
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: content.subject,
      text: [
        content.heading,
        "",
        content.body,
        "",
        `Bid: ${bid}`,
        `TermDrop: ${input.publicBaseUrl}`,
        "",
        "This is a transactional message about your TermDrop sponsor bid.",
      ].join("\n"),
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:620px;margin:0 auto;color:#111827">
          <h1 style="font-size:24px;margin:0 0 12px">${escapeHtml(content.heading)}</h1>
          <p style="font-size:16px;line-height:1.55;margin:0 0 18px">${escapeHtml(content.body)}</p>
          <p style="font-size:18px;margin:0 0 24px"><strong>Bid: ${escapeHtml(bid)}</strong></p>
          <a href="${escapeHtml(input.publicBaseUrl)}" style="display:inline-block;padding:11px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:8px">Open TermDrop</a>
          <p style="font-size:12px;color:#6b7280;margin:28px 0 0">This is a transactional message about your TermDrop sponsor bid.</p>
        </div>
      `,
      tags: [
        { name: "event", value: `bid_${input.kind}` },
        { name: "submission", value: input.submissionId },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}.`);
}

function bidderMessage(
  kind: BidderNotificationKind,
  bid: string,
  activatesAt?: number,
): { subject: string; heading: string; body: string } {
  if (kind === "authorized") {
    return {
      subject: `TermDrop received your ${bid} sponsor bid`,
      heading: "Your sponsor bid is authorized",
      body: "Your card has a temporary authorization hold, but it has not been charged. Your banner is now awaiting review. Only the approved winning bid is captured.",
    };
  }
  if (kind === "outbid") {
    return {
      subject: "Your TermDrop sponsor bid was outbid",
      heading: "You were outbid",
      body: "Your bid did not keep the challenger position, usually because a higher authorization arrived first. TermDrop cancelled your authorization and will not charge it. Your bank may take a short time to remove the pending hold.",
    };
  }
  if (kind === "scheduled") {
    const timing = activatesAt
      ? ` It is scheduled to take over around ${new Date(activatesAt).toISOString()}.`
      : " It is scheduled to take over when the current sponsor's protected hour ends.";
    return {
      subject: "Your TermDrop sponsor banner was approved",
      heading: "Your banner was approved",
      body: `Your bid is the approved challenger.${timing} You will only be charged when the banner goes live, unless a higher bid replaces it first.`,
    };
  }
  if (kind === "live") {
    return {
      subject: "Your TermDrop sponsor banner is live",
      heading: "Your banner is now live",
      body: "TermDrop captured your winning bid and published your banner. It has a guaranteed first hour and then stays up until another approved bidder outbids it.",
    };
  }
  if (kind === "replaced") {
    return {
      subject: "Your TermDrop sponsor banner was outbid",
      heading: "Your banner was replaced",
      body: "A higher approved bid has taken over the TermDrop sponsor slot. Your completed winning bid is unchanged; this message confirms that your banner is no longer live.",
    };
  }
  return {
    subject: "Your TermDrop sponsor bid was not approved",
    heading: "Your banner was not approved",
    body: "TermDrop cancelled your authorization and will not charge it. Your bank may take a short time to remove the pending hold.",
  };
}

function detailRow(label: string, value: string): string {
  return `<tr><th style="padding:8px 12px 8px 0;text-align:left;vertical-align:top;color:#6b7280">${escapeHtml(label)}</th><td style="padding:8px 0;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`;
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[character]!);
}
