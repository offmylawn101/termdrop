import { DurableObject } from "cloudflare:workers";
import type { PendingAdSubmission, PublicAdState } from "../shared/ad-protocol";
import { AD_ID_PATTERN } from "../shared/ad-protocol";
import type { Env } from "../worker/env";
import { sendAdBidderNotification } from "../worker/resend";
import { captureStripePayment } from "../worker/stripe";

interface AuctionStateRow extends Record<string, SqlStorageValue> {
  sponsorEnabled: number;
  currentId: string | null;
  currentBidCents: number;
  activatedAt: number | null;
  lockedUntil: number | null;
  expiresAt: number | null;
  publicBaseUrl: string | null;
  version: number;
}

interface SubmissionRow extends Record<string, SqlStorageValue> {
  id: string;
  status: string;
  targetUrl: string;
  advertiserDomain: string;
  altText: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  bidCents: number;
  stripeCheckoutId: string | null;
  stripePaymentIntentId: string | null;
  customerEmail: string | null;
  rejectionReason: string | null;
  createdAt: number;
  checkoutExpiresAt: number;
}

interface ReserveSubmissionRequest {
  id: string;
  targetUrl: string;
  advertiserDomain: string;
  altText: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  bidCents: number;
  clientHash: string;
  publicBaseUrl: string;
  now: number;
}

interface StripeAuthorizedRequest {
  eventId: string;
  submissionId: string;
  checkoutId: string;
  paymentIntentId: string;
  amountTotal: number;
  currency: string;
  customerEmail: string | null;
  now: number;
}

interface CancellationJob {
  id: string;
  paymentIntentId: string;
  outcome: "OUTBID" | "REJECTED";
  customerEmail: string | null;
  bidCents: number;
}

interface CaptureJob {
  id: string;
  paymentIntentId: string;
  bidCents: number;
  customerEmail: string | null;
}

const AUCTION_OBJECT_NAME = "global";
const DEFAULT_AD_ID = "default-fister";
const DEFAULT_TARGET_URL = "https://fister.fun/";
const DEFAULT_CREATIVE_URL = "/sponsor-banner.png";
const DEFAULT_ALT_TEXT = "Fister: Play free now";
const OPENING_BID_CENTS = 100;
// Stripe requires Checkout Sessions to expire at least 30 minutes in the future.
// The extra minute keeps the value valid despite request and clock latency.
const CHECKOUT_RESERVATION_MS = 31 * 60 * 1000;
const CHECKOUT_WEBHOOK_GRACE_MS = 10 * 60 * 1000;
const WINNER_LOCK_MS = 60 * 60 * 1000;
const CAPTURE_RETRY_MS = 5 * 60 * 1000;
const SUBMISSION_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 10;
const CHALLENGER_STATUSES = "'AUTHORIZED_PENDING_REVIEW', 'AUTHORIZED_APPROVED', 'CAPTURE_PENDING'";

export class AdAuction extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS auction_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), current_id TEXT,
        current_bid_cents INTEGER NOT NULL DEFAULT 0, activated_at INTEGER,
        locked_until INTEGER, expires_at INTEGER, public_base_url TEXT,
        sponsor_enabled INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 0,
        impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0
      )
    `);
    const auctionColumns = this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(auction_state)",
    ).toArray();
    if (!auctionColumns.some((column) => column.name === "public_base_url")) {
      this.ctx.storage.sql.exec("ALTER TABLE auction_state ADD COLUMN public_base_url TEXT");
    }
    if (!auctionColumns.some((column) => column.name === "sponsor_enabled")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE auction_state ADD COLUMN sponsor_enabled INTEGER NOT NULL DEFAULT 1",
      );
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ad_submissions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, target_url TEXT NOT NULL,
        advertiser_domain TEXT NOT NULL, alt_text TEXT NOT NULL, content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        bid_cents INTEGER NOT NULL, client_hash TEXT NOT NULL, stripe_checkout_id TEXT UNIQUE,
        stripe_payment_intent_id TEXT, customer_email TEXT, refund_id TEXT,
        rejection_reason TEXT, created_at INTEGER NOT NULL, checkout_expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS ad_submission_status ON ad_submissions (status, created_at)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ad_webhook_events (
        event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ad_submission_rates (
        client_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS ad_submission_rate_time ON ad_submission_rates (client_hash, created_at)",
    );
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO auction_state (
        singleton, current_id, current_bid_cents, version, impressions, clicks
      ) VALUES (1, NULL, 0, 0, 0, 0)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/state") {
      await this.cleanupExpired(Date.now());
      return Response.json(this.publicState(), { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/reserve") {
      return this.reserve(await request.json<ReserveSubmissionRequest>());
    }
    if (request.method === "POST" && url.pathname === "/checkout-created") {
      const input = await request.json<{ id: string; checkoutId: string }>();
      if (!AD_ID_PATTERN.test(input.id) || !input.checkoutId.startsWith("cs_")) return badRequest();
      const updated = this.ctx.storage.sql.exec(
        `UPDATE ad_submissions SET stripe_checkout_id = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING_PAYMENT' AND stripe_checkout_id IS NULL RETURNING id`,
        input.checkoutId, Date.now(), input.id,
      ).toArray();
      return updated.length === 1 ? Response.json({ ok: true }) : conflict("Reservation is no longer active.");
    }
    if (request.method === "POST" && url.pathname === "/checkout-failed") {
      const input = await request.json<{ id: string }>();
      if (!AD_ID_PATTERN.test(input.id)) return badRequest();
      const row = this.submission(input.id);
      if (row?.status === "PENDING_PAYMENT") {
        this.ctx.storage.sql.exec(
          "UPDATE ad_submissions SET status = 'CHECKOUT_FAILED', updated_at = ? WHERE id = ?",
          Date.now(), input.id,
        );
        await this.deleteCreative(row.id);
      }
      await this.scheduleNextAlarm();
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/stripe/authorized") {
      return this.stripeAuthorized(await request.json<StripeAuthorizedRequest>());
    }
    if (request.method === "POST" && url.pathname === "/stripe/cancelled") {
      const input = await request.json<{ id: string; paymentIntentId: string; now?: number }>();
      return this.cancellationCompleted(input.id, input.paymentIntentId, input.now ?? Date.now());
    }
    if (request.method === "POST" && url.pathname === "/stripe/captured") {
      const input = await request.json<{
        id: string; paymentIntentId: string; amountReceived: number; now?: number;
      }>();
      return this.captureCompleted(input.id, input.paymentIntentId, input.amountReceived, input.now ?? Date.now());
    }
    if (request.method === "POST" && url.pathname === "/stripe/capture-failed") {
      const input = await request.json<{ id: string; now?: number }>();
      return this.captureFailed(input.id, input.now ?? Date.now());
    }
    if (request.method === "POST" && url.pathname === "/stripe/expired") {
      return this.stripeExpired(await request.json<{ eventId: string; checkoutId: string; now: number }>());
    }
    if (request.method === "GET" && url.pathname === "/admin/pending") {
      await this.cleanupExpired(Date.now());
      return Response.json({ submissions: this.pendingSubmissions() });
    }
    if (request.method === "GET" && url.pathname === "/admin/enabled") {
      return Response.json({ enabled: this.sponsorEnabled() });
    }
    if (request.method === "POST" && url.pathname === "/admin/enabled") {
      const input = await request.json<{ enabled?: unknown }>();
      if (typeof input.enabled !== "boolean") return badRequest();
      this.ctx.storage.sql.exec(
        `UPDATE auction_state SET sponsor_enabled = ?, version = version + 1
         WHERE singleton = 1`,
        input.enabled ? 1 : 0,
      );
      console.log(JSON.stringify({
        event: input.enabled ? "sponsor_enabled" : "sponsor_disabled",
      }));
      return Response.json({ ok: true, enabled: input.enabled });
    }
    if (request.method === "POST" && url.pathname === "/admin/approve") {
      const input = await request.json<{ id: string; now?: number }>();
      return this.approve(input.id, input.now ?? Date.now());
    }
    if (request.method === "POST" && url.pathname === "/admin/rejection-info") {
      const input = await request.json<{ id: string; reason?: string; now?: number }>();
      return this.prepareRejection(input.id, input.reason ?? "Creative was not approved.", input.now ?? Date.now());
    }
    if (request.method === "POST" && url.pathname === "/event") {
      const input = await request.json<{ id: string; type: "impression" | "click" }>();
      const state = this.state();
      if (state.sponsorEnabled !== 1) return new Response(null, { status: 204 });
      if (input.id !== (state.currentId ?? DEFAULT_AD_ID)) return conflict("Placement changed.");
      const column = input.type === "click" ? "clicks" : input.type === "impression" ? "impressions" : null;
      if (!column) return badRequest();
      this.ctx.storage.sql.exec(`UPDATE auction_state SET ${column} = ${column} + 1 WHERE singleton = 1`);
      return new Response(null, { status: 204 });
    }
    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.cleanupExpired(now);
    const capture = this.prepareDueCapture(now);
    if (capture) {
      try {
        if (!this.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
          throw new Error("Stripe is not configured for scheduled capture.");
        }
        const payment = await captureStripePayment(
          this.env.STRIPE_SECRET_KEY, capture.paymentIntentId, capture.id,
        );
        if (payment.status !== "succeeded" || payment.amount_received !== capture.bidCents) {
          throw new Error(`Stripe capture returned ${payment.status}.`);
        }
        await this.captureCompleted(capture.id, capture.paymentIntentId, payment.amount_received, Date.now());
      } catch (error) {
        await this.captureFailed(capture.id, Date.now());
        await this.ctx.storage.setAlarm(Date.now() + CAPTURE_RETRY_MS);
        console.error(JSON.stringify({
          event: "ad_capture_retry_scheduled", submission: capture.id,
          error: error instanceof Error ? error.message : "unknown",
        }));
        return;
      }
    }
    await this.scheduleNextAlarm();
  }

  private async reserve(input: ReserveSubmissionRequest): Promise<Response> {
    if (!this.validReservation(input)) return badRequest();
    await this.cleanupExpired(input.now);
    if (!this.sponsorEnabled()) return conflict("Sponsor bidding is currently paused.");
    this.ctx.storage.sql.exec(
      "DELETE FROM ad_submission_rates WHERE created_at <= ?", input.now - SUBMISSION_RATE_WINDOW_MS,
    );
    const recent = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ad_submission_rates WHERE client_hash = ?", input.clientHash,
    ).one().count;
    if (recent >= MAX_SUBMISSIONS_PER_WINDOW) {
      return Response.json({ error: "Too many ad submissions. Try again later." }, { status: 429 });
    }
    if (this.leadingSubmission()?.status === "CAPTURE_PENDING") {
      return conflict("The winning bid is being finalized. Try again in a moment.");
    }
    const minimumBidCents = this.minimumBidCents();
    if (input.bidCents < minimumBidCents) {
      return conflict("The bid is below the current minimum.", { minimumBidCents });
    }
    const checkoutExpiresAt = input.now + CHECKOUT_RESERVATION_MS;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO ad_submissions (
          id, status, target_url, advertiser_domain, alt_text, content_type,
          size_bytes, width, height, bid_cents, client_hash, created_at,
          checkout_expires_at, updated_at
        ) VALUES (?, 'PENDING_PAYMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id, input.targetUrl, input.advertiserDomain, input.altText, input.contentType,
        input.sizeBytes, input.width, input.height, input.bidCents, input.clientHash,
        input.now, checkoutExpiresAt, input.now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ad_submission_rates (client_hash, created_at) VALUES (?, ?)",
        input.clientHash, input.now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE auction_state SET public_base_url = ? WHERE singleton = 1",
        input.publicBaseUrl,
      );
    });
    await this.scheduleNextAlarm();
    return Response.json({ ok: true, checkoutExpiresAt });
  }

  private async stripeAuthorized(input: StripeAuthorizedRequest): Promise<Response> {
    if (
      !input.eventId.startsWith("evt_") || !AD_ID_PATTERN.test(input.submissionId) ||
      !input.checkoutId.startsWith("cs_") || !input.paymentIntentId.startsWith("pi_") ||
      !Number.isSafeInteger(input.amountTotal) || input.currency.toLowerCase() !== "usd" ||
      !Number.isSafeInteger(input.now)
    ) return badRequest();
    const existingEvent = this.ctx.storage.sql.exec<{ eventId: string }>(
      "SELECT event_id AS eventId FROM ad_webhook_events WHERE event_id = ? LIMIT 1", input.eventId,
    ).toArray()[0];
    if (existingEvent) return Response.json(this.authorizationResult(input.submissionId, true));
    const row = this.submission(input.submissionId);
    if (
      !row || !["PENDING_PAYMENT", "EXPIRED"].includes(row.status) ||
      row.stripeCheckoutId !== input.checkoutId || row.bidCents !== input.amountTotal
    ) return conflict("Stripe authorization did not match the reservation.");

    const currentLeader = this.leadingSubmission();
    const minimumBidCents = nextBidCents(Math.max(this.state().currentBidCents, currentLeader?.bidCents ?? 0));
    const accepted = row.status === "PENDING_PAYMENT" &&
      currentLeader?.status !== "CAPTURE_PENDING" &&
      row.bidCents >= minimumBidCents;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO ad_webhook_events (event_id, created_at) VALUES (?, ?)", input.eventId, input.now,
      );
      if (accepted) {
        this.ctx.storage.sql.exec(
          `UPDATE ad_submissions SET status = 'CANCEL_PENDING', updated_at = ?
           WHERE status IN ('AUTHORIZED_PENDING_REVIEW', 'AUTHORIZED_APPROVED')`, input.now,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE ad_submissions SET status = ?, stripe_payment_intent_id = ?,
           customer_email = ?, updated_at = ? WHERE id = ?`,
        accepted ? "AUTHORIZED_PENDING_REVIEW" : "CANCEL_PENDING",
        input.paymentIntentId, input.customerEmail, input.now, input.submissionId,
      );
    });
    const displaced = this.pendingCancellations().filter((job) => job.id !== input.submissionId);
    await Promise.all(displaced.map((job) => this.deleteCreative(job.id)));
    if (!accepted) await this.deleteCreative(input.submissionId);
    await this.scheduleNextAlarm();
    console.log(JSON.stringify({
      event: accepted ? "ad_bid_authorized" : "ad_bid_outbid",
      submission: input.submissionId, bidCents: input.amountTotal,
    }));
    return Response.json(this.authorizationResult(input.submissionId, false));
  }

  private authorizationResult(submissionId: string, duplicate: boolean): Record<string, unknown> {
    const row = this.submission(submissionId);
    return {
      ok: true, duplicate,
      accepted: Boolean(row && [
        "AUTHORIZED_PENDING_REVIEW", "AUTHORIZED_APPROVED", "CAPTURE_PENDING", "ACTIVE",
      ].includes(row.status)),
      notifyReviewer: row?.status === "AUTHORIZED_PENDING_REVIEW",
      bidderStatus: row?.status ?? null,
      customerEmail: row?.customerEmail ?? null,
      bidCents: row?.bidCents ?? null,
      cancellations: this.pendingCancellations(),
    };
  }

  private async stripeExpired(input: { eventId: string; checkoutId: string; now: number }): Promise<Response> {
    if (!input.eventId.startsWith("evt_") || !input.checkoutId.startsWith("cs_")) return badRequest();
    const inserted = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO ad_webhook_events (event_id, created_at) VALUES (?, ?) RETURNING event_id",
      input.eventId, input.now,
    ).toArray();
    if (inserted.length === 0) return Response.json({ ok: true, duplicate: true });
    const row = this.ctx.storage.sql.exec<SubmissionRow>(
      `${submissionSelect()} WHERE stripe_checkout_id = ? LIMIT 1`, input.checkoutId,
    ).toArray()[0];
    if (row?.status === "PENDING_PAYMENT") {
      this.ctx.storage.sql.exec(
        "UPDATE ad_submissions SET status = 'EXPIRED', updated_at = ? WHERE id = ?", input.now, row.id,
      );
      await this.deleteCreative(row.id);
    }
    await this.scheduleNextAlarm();
    return Response.json({ ok: true });
  }

  private async approve(id: string, now: number): Promise<Response> {
    if (!AD_ID_PATTERN.test(id) || !Number.isSafeInteger(now)) return badRequest();
    await this.cleanupExpired(now);
    const row = this.submission(id);
    if (!row || !["AUTHORIZED_PENDING_REVIEW", "AUTHORIZED_APPROVED", "CAPTURE_PENDING"].includes(row.status)) {
      return new Response("Not Found", { status: 404 });
    }
    const leader = this.leadingSubmission();
    if (leader?.id !== id || !row.stripePaymentIntentId) {
      return conflict("This bid is no longer the leading authorized challenger.");
    }
    const state = this.state();
    if (row.status !== "CAPTURE_PENDING" && state.lockedUntil && state.lockedUntil > now) {
      this.ctx.storage.sql.exec(
        "UPDATE ad_submissions SET status = 'AUTHORIZED_APPROVED', updated_at = ? WHERE id = ?", now, id,
      );
      await this.scheduleNextAlarm();
      console.log(JSON.stringify({ event: "ad_bid_approved", submission: id, activatesAt: state.lockedUntil }));
      return Response.json({
        ok: true,
        action: "scheduled",
        activatesAt: state.lockedUntil,
        customerEmail: row.customerEmail,
        bidCents: row.bidCents,
      });
    }
    if (row.status !== "CAPTURE_PENDING") {
      this.ctx.storage.sql.exec(
        "UPDATE ad_submissions SET status = 'CAPTURE_PENDING', updated_at = ? WHERE id = ?", now, id,
      );
    }
    await this.scheduleNextAlarm();
    return Response.json({
      ok: true, action: "capture",
      capture: {
        id: row.id,
        paymentIntentId: row.stripePaymentIntentId,
        bidCents: row.bidCents,
        customerEmail: row.customerEmail,
      },
    });
  }

  private prepareDueCapture(now: number): CaptureJob | null {
    const leader = this.leadingSubmission();
    if (!leader?.stripePaymentIntentId) return null;
    if (leader.status === "CAPTURE_PENDING") {
      return {
        id: leader.id,
        paymentIntentId: leader.stripePaymentIntentId,
        bidCents: leader.bidCents,
        customerEmail: leader.customerEmail,
      };
    }
    if (leader.status !== "AUTHORIZED_APPROVED") return null;
    const state = this.state();
    if (state.lockedUntil && state.lockedUntil > now) return null;
    this.ctx.storage.sql.exec(
      "UPDATE ad_submissions SET status = 'CAPTURE_PENDING', updated_at = ? WHERE id = ?", now, leader.id,
    );
    return {
      id: leader.id,
      paymentIntentId: leader.stripePaymentIntentId,
      bidCents: leader.bidCents,
      customerEmail: leader.customerEmail,
    };
  }

  private async captureCompleted(
    id: string, paymentIntentId: string, amountReceived: number, now: number,
  ): Promise<Response> {
    if (
      !AD_ID_PATTERN.test(id) || !paymentIntentId.startsWith("pi_") ||
      !Number.isSafeInteger(amountReceived) || !Number.isSafeInteger(now)
    ) return badRequest();
    const row = this.submission(id);
    if (row?.status === "ACTIVE" && row.stripePaymentIntentId === paymentIntentId) {
      return Response.json({ ok: true, duplicate: true, state: this.publicState() });
    }
    if (
      !row || row.status !== "CAPTURE_PENDING" || row.stripePaymentIntentId !== paymentIntentId ||
      row.bidCents !== amountReceived
    ) return conflict("Captured payment did not match the leading bid.");
    const state = this.state();
    const previousId = state.currentId;
    const previous = previousId ? this.submission(previousId) : null;
    const lockedUntil = now + WINNER_LOCK_MS;
    this.ctx.storage.transactionSync(() => {
      if (previousId) {
        this.ctx.storage.sql.exec(
          "UPDATE ad_submissions SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'",
          now, previousId,
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE ad_submissions SET status = 'ACTIVE', updated_at = ? WHERE id = ?", now, id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE auction_state SET current_id = ?, current_bid_cents = ?, activated_at = ?,
           locked_until = ?, expires_at = ?, version = version + 1, impressions = 0, clicks = 0
         WHERE singleton = 1`, id, row.bidCents, now, lockedUntil, null,
      );
    });
    if (previousId) await this.deleteCreative(previousId);
    await this.scheduleNextAlarm();
    await Promise.all([
      this.notifyBidder(row.customerEmail, row.id, row.bidCents, "live"),
      previous
        ? this.notifyBidder(previous.customerEmail, previous.id, previous.bidCents, "replaced")
        : Promise.resolve(),
    ]);
    console.log(JSON.stringify({ event: "ad_activated", submission: id, bidCents: row.bidCents }));
    return Response.json({
      ok: true,
      state: this.publicState(),
      customerEmail: row.customerEmail,
      bidCents: row.bidCents,
    });
  }

  private async captureFailed(id: string, now: number): Promise<Response> {
    if (!AD_ID_PATTERN.test(id) || !Number.isSafeInteger(now)) return badRequest();
    this.ctx.storage.sql.exec(
      `UPDATE ad_submissions SET status = 'AUTHORIZED_APPROVED', updated_at = ?
       WHERE id = ? AND status = 'CAPTURE_PENDING'`, now, id,
    );
    await this.scheduleNextAlarm();
    return Response.json({ ok: true });
  }

  private async prepareRejection(id: string, reason: string, now: number): Promise<Response> {
    if (!AD_ID_PATTERN.test(id) || !Number.isSafeInteger(now)) return badRequest();
    const row = this.submission(id);
    if (!row || !row.stripePaymentIntentId) return new Response("Not Found", { status: 404 });
    if (row.status === "CAPTURE_PENDING") return conflict("This bid is already being captured.");
    if (!["AUTHORIZED_PENDING_REVIEW", "AUTHORIZED_APPROVED", "CANCEL_PENDING"].includes(row.status)) {
      return new Response("Not Found", { status: 404 });
    }
    if (row.status !== "CANCEL_PENDING") {
      this.ctx.storage.sql.exec(
        `UPDATE ad_submissions SET status = 'CANCEL_PENDING', rejection_reason = ?, updated_at = ? WHERE id = ?`,
        reason.slice(0, 500), now, id,
      );
      await this.deleteCreative(row.id);
    }
    await this.scheduleNextAlarm();
    return Response.json({ paymentIntentId: row.stripePaymentIntentId, customerEmail: row.customerEmail });
  }

  private async cancellationCompleted(id: string, paymentIntentId: string, now: number): Promise<Response> {
    if (!AD_ID_PATTERN.test(id) || !paymentIntentId.startsWith("pi_") || !Number.isSafeInteger(now)) {
      return badRequest();
    }
    const row = this.submission(id);
    if (row && ["OUTBID", "REJECTED"].includes(row.status) && row.stripePaymentIntentId === paymentIntentId) {
      return Response.json({ ok: true, duplicate: true });
    }
    if (!row || row.status !== "CANCEL_PENDING" || row.stripePaymentIntentId !== paymentIntentId) {
      return conflict("Cancelled authorization did not match a pending cancellation.");
    }
    const outcome = row.rejectionReason ? "REJECTED" : "OUTBID";
    this.ctx.storage.sql.exec(
      "UPDATE ad_submissions SET status = ?, refund_id = ?, updated_at = ? WHERE id = ?",
      outcome, paymentIntentId, now, id,
    );
    await this.deleteCreative(id);
    await this.scheduleNextAlarm();
    console.log(JSON.stringify({
      event: outcome === "REJECTED" ? "ad_rejected" : "ad_authorization_released", submission: id,
    }));
    return Response.json({ ok: true, outcome, customerEmail: row.customerEmail, bidCents: row.bidCents });
  }

  private async cleanupExpired(now: number): Promise<void> {
    const creativeIdsToDelete = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM ad_submissions
       WHERE status = 'PENDING_PAYMENT' AND checkout_expires_at + ? <= ?`,
      CHECKOUT_WEBHOOK_GRACE_MS, now,
    ).toArray().map((row) => row.id);
    this.ctx.storage.sql.exec(
      `UPDATE ad_submissions SET status = 'EXPIRED', updated_at = ?
       WHERE status = 'PENDING_PAYMENT' AND checkout_expires_at + ? <= ?`,
      now, CHECKOUT_WEBHOOK_GRACE_MS, now,
    );
    await Promise.all(creativeIdsToDelete.map((id) => this.deleteCreative(id)));
  }

  private publicState(): PublicAdState {
    const state = this.state();
    if (!state.currentId) {
      return {
        enabled: state.sponsorEnabled === 1,
        id: DEFAULT_AD_ID, creativeUrl: DEFAULT_CREATIVE_URL, targetUrl: DEFAULT_TARGET_URL,
        altText: DEFAULT_ALT_TEXT, advertiserDomain: "fister.fun", currentBidCents: 0,
        minimumBidCents: this.minimumBidCents(), lockedUntil: null, expiresAt: null, isDefault: true,
      };
    }
    const row = this.submission(state.currentId);
    if (!row) throw new Error("Active ad submission is missing.");
    return {
      enabled: state.sponsorEnabled === 1,
      id: row.id, creativeUrl: `/api/ad/creative/${row.id}`, targetUrl: row.targetUrl,
      altText: row.altText, advertiserDomain: row.advertiserDomain,
      currentBidCents: state.currentBidCents, minimumBidCents: this.minimumBidCents(),
      lockedUntil: state.lockedUntil, expiresAt: state.expiresAt, isDefault: false,
    };
  }

  private pendingSubmissions(): PendingAdSubmission[] {
    return this.ctx.storage.sql.exec<SubmissionRow>(
      `${submissionSelect()} WHERE status = 'AUTHORIZED_PENDING_REVIEW' ORDER BY created_at ASC`,
    ).toArray().map((row) => ({
      id: row.id, creativeUrl: `/api/ad/creative/${row.id}`, targetUrl: row.targetUrl,
      advertiserDomain: row.advertiserDomain, altText: row.altText, bidCents: row.bidCents,
      width: row.width, height: row.height, contentType: row.contentType,
      sizeBytes: row.sizeBytes, customerEmail: row.customerEmail, createdAt: row.createdAt,
    }));
  }

  private pendingCancellations(): CancellationJob[] {
    return this.ctx.storage.sql.exec<SubmissionRow>(
      `${submissionSelect()} WHERE status = 'CANCEL_PENDING' AND stripe_payment_intent_id IS NOT NULL ORDER BY created_at ASC`,
    ).toArray().map((row) => ({
      id: row.id,
      paymentIntentId: row.stripePaymentIntentId!,
      outcome: row.rejectionReason ? "REJECTED" : "OUTBID",
      customerEmail: row.customerEmail,
      bidCents: row.bidCents,
    }));
  }

  private leadingSubmission(): SubmissionRow | null {
    return this.ctx.storage.sql.exec<SubmissionRow>(
      `${submissionSelect()} WHERE status IN (${CHALLENGER_STATUSES}) ORDER BY bid_cents DESC, created_at ASC LIMIT 1`,
    ).toArray()[0] ?? null;
  }

  private minimumBidCents(): number {
    const state = this.state();
    const leader = this.leadingSubmission();
    return nextBidCents(Math.max(state.currentBidCents, leader?.bidCents ?? 0));
  }

  private submission(id: string): SubmissionRow | null {
    if (!AD_ID_PATTERN.test(id)) return null;
    return this.ctx.storage.sql.exec<SubmissionRow>(
      `${submissionSelect()} WHERE id = ? LIMIT 1`, id,
    ).toArray()[0] ?? null;
  }

  private state(): AuctionStateRow {
    return this.ctx.storage.sql.exec<AuctionStateRow>(`
      SELECT sponsor_enabled AS sponsorEnabled,
        current_id AS currentId, current_bid_cents AS currentBidCents,
        activated_at AS activatedAt, locked_until AS lockedUntil,
        expires_at AS expiresAt, public_base_url AS publicBaseUrl,
        version FROM auction_state WHERE singleton = 1
    `).one();
  }

  private sponsorEnabled(): boolean {
    return this.state().sponsorEnabled === 1;
  }

  private validReservation(input: ReserveSubmissionRequest): boolean {
    return Boolean(
      input && AD_ID_PATTERN.test(input.id) && /^https:\/\//.test(input.targetUrl) &&
      typeof input.advertiserDomain === "string" && input.advertiserDomain.length <= 253 &&
      typeof input.altText === "string" && input.altText.length >= 3 && input.altText.length <= 120 &&
      ["image/jpeg", "image/png", "image/webp"].includes(input.contentType) &&
      Number.isSafeInteger(input.sizeBytes) && input.sizeBytes > 0 && input.sizeBytes <= 1024 * 1024 &&
      Number.isSafeInteger(input.width) && input.width >= 500 &&
      Number.isSafeInteger(input.height) && input.height >= 80 &&
      Number.isSafeInteger(input.bidCents) && input.bidCents >= OPENING_BID_CENTS &&
      typeof input.clientHash === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.clientHash) &&
      typeof input.publicBaseUrl === "string" && /^https?:\/\/[^/]+$/.test(input.publicBaseUrl) &&
      Number.isSafeInteger(input.now)
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    const pending = this.ctx.storage.sql.exec<{ expiry: number | null }>(
      "SELECT MIN(checkout_expires_at) AS expiry FROM ad_submissions WHERE status = 'PENDING_PAYMENT'",
    ).toArray()[0]?.expiry;
    const pendingCleanup = typeof pending === "number" && Number.isSafeInteger(pending)
      ? pending + CHECKOUT_WEBHOOK_GRACE_MS : null;
    const leader = this.leadingSubmission();
    const state = this.state();
    const activation = leader?.status === "AUTHORIZED_APPROVED"
      ? Math.max(state.lockedUntil ?? Date.now(), Date.now() + 1_000)
      : leader?.status === "CAPTURE_PENDING" ? Date.now() + 1_000 : null;
    const expiries = [pendingCleanup, activation]
      .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
    if (expiries.length > 0) await this.ctx.storage.setAlarm(Math.min(...expiries));
    else await this.ctx.storage.deleteAlarm();
  }

  private async notifyBidder(
    customerEmail: string | null,
    submissionId: string,
    bidCents: number,
    kind: "live" | "replaced",
  ): Promise<void> {
    if (!customerEmail || !this.env.RESEND_API_KEY || !this.env.AD_NOTIFICATION_FROM) return;
    const publicBaseUrl = this.state().publicBaseUrl;
    if (!publicBaseUrl) return;
    try {
      await sendAdBidderNotification({
        apiKey: this.env.RESEND_API_KEY,
        from: this.env.AD_NOTIFICATION_FROM,
        to: customerEmail,
        publicBaseUrl,
        submissionId,
        bidCents,
        kind,
      });
      console.log(JSON.stringify({ event: "ad_bidder_notification_sent", submission: submissionId, notification: kind }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "ad_bidder_notification_failed",
        submission: submissionId,
        notification: kind,
        error: error instanceof Error ? error.message : "unknown",
      }));
    }
  }

  private async deleteCreative(id: string): Promise<void> {
    await this.env.AD_SPONSOR_CREATIVES.delete(`ads/${id}`);
  }
}

function submissionSelect(): string {
  return `SELECT id, status, target_url AS targetUrl, advertiser_domain AS advertiserDomain,
    alt_text AS altText, content_type AS contentType, size_bytes AS sizeBytes, width, height,
    bid_cents AS bidCents, stripe_checkout_id AS stripeCheckoutId,
    stripe_payment_intent_id AS stripePaymentIntentId, customer_email AS customerEmail,
    rejection_reason AS rejectionReason, created_at AS createdAt,
    checkout_expires_at AS checkoutExpiresAt FROM ad_submissions`;
}

function nextBidCents(currentBidCents: number): number {
  if (currentBidCents <= 0) return OPENING_BID_CENTS;
  return Math.max(currentBidCents + 100, Math.ceil(currentBidCents * 1.1 / 100) * 100);
}

function badRequest(): Response {
  return new Response("Bad Request", { status: 400 });
}

function conflict(message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status: 409 });
}

export function adAuctionStub(env: Env): DurableObjectStub<AdAuction> {
  return env.AD_AUCTION.getByName(AUCTION_OBJECT_NAME);
}
