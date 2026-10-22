import { DurableObject } from "cloudflare:workers";
import { DEFAULTS, positiveInteger } from "../shared/config";
import type { Env } from "../worker/env";

interface QuotaRecord {
  sessions: Record<string, number>;
  creations: number[];
}

interface ReserveRequest {
  sessionId: string;
  leaseExpiresAt: number;
  now: number;
}

export class IpLimiter extends DurableObject<Env> {
  private quota: QuotaRecord = { sessions: {}, creations: [] };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.quota = (await ctx.storage.get<QuotaRecord>("quota")) ?? this.quota;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    if (path === "/reserve") {
      const input = await request.json<ReserveRequest>();
      return this.reserve(input);
    }

    if (path === "/release") {
      const { sessionId } = await request.json<{ sessionId: string }>();
      if (typeof sessionId !== "string") return new Response("Bad Request", { status: 400 });
      delete this.quota.sessions[sessionId];
      this.prune(Date.now());
      await this.persistAndSchedule();
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    this.prune(Date.now());
    await this.persistAndSchedule();
  }

  private async reserve(input: ReserveRequest): Promise<Response> {
    if (
      !input ||
      typeof input.sessionId !== "string" ||
      !Number.isSafeInteger(input.leaseExpiresAt) ||
      !Number.isSafeInteger(input.now)
    ) {
      return new Response("Bad Request", { status: 400 });
    }

    const activeLimit = positiveInteger(
      this.env.MAX_ACTIVE_TRANSFERS_PER_IP,
      DEFAULTS.MAX_ACTIVE_TRANSFERS_PER_IP,
    );
    const rateLimit = positiveInteger(this.env.SESSION_RATE_LIMIT, DEFAULTS.SESSION_RATE_LIMIT);

    this.prune(input.now);

    if (Object.keys(this.quota.sessions).length >= activeLimit) {
      await this.persistAndSchedule();
      return Response.json({ ok: false, reason: "active_limit" }, { status: 429 });
    }
    if (this.quota.creations.length >= rateLimit) {
      await this.persistAndSchedule();
      return Response.json({ ok: false, reason: "rate_limit" }, { status: 429 });
    }

    this.quota.sessions[input.sessionId] = input.leaseExpiresAt;
    this.quota.creations.push(input.now);
    await this.persistAndSchedule();
    return Response.json({ ok: true });
  }

  private prune(now: number): void {
    const rateWindow = positiveInteger(
      this.env.SESSION_RATE_WINDOW_MS,
      DEFAULTS.SESSION_RATE_WINDOW_MS,
    );
    this.quota.sessions = Object.fromEntries(
      Object.entries(this.quota.sessions).filter(([, expiry]) => expiry > now),
    );
    this.quota.creations = this.quota.creations.filter((createdAt) => createdAt > now - rateWindow);
  }

  private async persistAndSchedule(): Promise<void> {
    const sessionExpiries = Object.values(this.quota.sessions);
    const rateWindow = positiveInteger(
      this.env.SESSION_RATE_WINDOW_MS,
      DEFAULTS.SESSION_RATE_WINDOW_MS,
    );
    const creationExpiries = this.quota.creations.map((createdAt) => createdAt + rateWindow);
    const expiries = [...sessionExpiries, ...creationExpiries];
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put("quota", this.quota);
    await this.ctx.storage.setAlarm(Math.min(...expiries));
  }
}
