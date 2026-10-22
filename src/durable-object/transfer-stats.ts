import { DurableObject } from "cloudflare:workers";
import { DEFAULTS } from "../shared/config";
import type { Env } from "../worker/env";

interface RecordTransferRequest {
  sessionTag: string;
  bytes: number;
}

interface TotalRow extends Record<string, SqlStorageValue> {
  totalBytes: number;
  updatedAt: number;
}

const STATS_OBJECT_NAME = "global";
const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000;

export class TransferStats extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS transfer_totals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        total_bytes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counted_sessions (
        session_tag TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS counted_sessions_expiry ON counted_sessions (expires_at)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO transfer_totals (singleton, total_bytes, updated_at) VALUES (1, 0, 0)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/total") {
      const total = this.ctx.storage.sql
        .exec<TotalRow>(
          "SELECT total_bytes AS totalBytes, updated_at AS updatedAt FROM transfer_totals WHERE singleton = 1",
        )
        .one();
      return Response.json(total, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (request.method === "POST" && url.pathname === "/record") {
      const input = await request.json<RecordTransferRequest>();
      if (!this.isValidRecord(input)) return new Response("Bad Request", { status: 400 });

      const now = Date.now();
      let counted = false;
      this.ctx.storage.transactionSync(() => {
        // Idempotency markers contain no filename, content, or public session ID,
        // and are kept only long enough to outlive the source session tombstone.
        this.ctx.storage.sql.exec(
          `DELETE FROM counted_sessions WHERE session_tag IN (
            SELECT session_tag FROM counted_sessions WHERE expires_at <= ? LIMIT 100
          )`,
          now,
        );
        const inserted = this.ctx.storage.sql.exec<{ sessionTag: string }>(
          `INSERT OR IGNORE INTO counted_sessions (session_tag, expires_at)
           VALUES (?, ?)
           RETURNING session_tag AS sessionTag`,
          input.sessionTag,
          now + IDEMPOTENCY_TTL_MS,
        );
        if (inserted.toArray().length !== 1) return;

        this.ctx.storage.sql.exec(
          "UPDATE transfer_totals SET total_bytes = total_bytes + ?, updated_at = ? WHERE singleton = 1",
          input.bytes,
          now,
        );
        counted = true;
      });

      return Response.json({ ok: true, counted });
    }

    return new Response("Not Found", { status: 404 });
  }

  private isValidRecord(input: RecordTransferRequest): boolean {
    return Boolean(
      input &&
      typeof input.sessionTag === "string" &&
      /^[A-Za-z0-9_-]{12}$/.test(input.sessionTag) &&
      Number.isSafeInteger(input.bytes) &&
      input.bytes >= 0 &&
      input.bytes <= DEFAULTS.MAX_FILE_SIZE_BYTES,
    );
  }
}

export function transferStatsStub(env: Env): DurableObjectStub<TransferStats> {
  return env.TRANSFER_STATS.getByName(STATS_OBJECT_NAME);
}
