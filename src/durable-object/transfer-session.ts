import { DurableObject } from "cloudflare:workers";
import { currentTransferIdleTimeout, DEFAULTS, positiveInteger } from "../shared/config";
import {
  isSenderMessage,
  SENDER_AUTH_PREFIX,
  SENDER_PROTOCOL,
  type ServerMessage,
  type TransferState,
} from "../shared/protocol";
import type { Env } from "../worker/env";
import { transferStatsStub } from "./transfer-stats";

interface SessionRecord {
  state: TransferState;
  senderSecretHash: string;
  outputFilename: string;
  contentType: string;
  expectedBytes: number;
  bytesTransferred: number;
  createdAt: number;
  expiresAt: number;
  transferStartedAt?: number;
  transferDeadline?: number;
  terminalAt?: number;
  purgeAt?: number;
  quotaKey: string;
  quotaSessionId: string;
  quotaReleased: boolean;
  sessionTag: string;
}

type InitRequest = Omit<SessionRecord, "state" | "bytesTransferred" | "quotaReleased">;

type ChannelItem =
  | { type: "chunk"; data: ArrayBuffer }
  | { type: "error"; reason: string; terminal: "CANCELLED" | "FAILED" };

class RendezvousChannel {
  private waiting: ((item: ChannelItem) => void) | null = null;
  private queued: ChannelItem[] = [];
  private terminal: Extract<ChannelItem, { type: "error" }> | null = null;

  take(): Promise<ChannelItem> {
    if (this.terminal) return Promise.resolve(this.terminal);
    const item = this.queued.shift();
    if (item) {
      return Promise.resolve(item);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  offer(item: ChannelItem): boolean {
    if (item.type === "error") {
      this.queued = [];
      this.terminal = item;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(item);
      }
      return true;
    }
    if (this.terminal || this.queued.length >= DEFAULTS.MAX_IN_FLIGHT_CHUNKS) return false;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
      return true;
    }
    this.queued.push(item);
    return true;
  }
}

const TERMINAL_STATES = new Set<TransferState>(["COMPLETED", "EXPIRED", "CANCELLED", "FAILED"]);

export class TransferSession extends DurableObject<Env> {
  private record: SessionRecord | null = null;
  private channel: RendezvousChannel | null = null;
  private receiving = false;
  private chunksInFlight = 0;
  private bytesInFlight = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.record = (await ctx.storage.get<SessionRecord>("session")) ?? null;
      if (
        this.record &&
        (this.record.state === "RECEIVER_CONNECTED" || this.record.state === "TRANSFERRING")
      ) {
        // An active response stream cannot survive isolate reconstruction.
        await this.finishTerminal("FAILED", "The relay restarted during transfer.");
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /init":
        return this.initialize(request);
      case "GET /sender":
        return this.connectSender(request);
      case "GET /receiver":
        return this.connectReceiver(request);
      case "GET /status":
        return this.statusResponse();
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    if (!this.record) return;
    const now = Date.now();

    if (TERMINAL_STATES.has(this.record.state)) {
      if (!this.record.quotaReleased) {
        await this.releaseQuota();
        await this.save();
      }
      if (this.record.purgeAt && this.record.purgeAt <= now) {
        await this.ctx.storage.deleteAll();
        this.record = null;
      } else if (this.record.purgeAt) {
        await this.ctx.storage.setAlarm(this.record.purgeAt);
      }
      return;
    }

    if (
      (this.record.state === "RECEIVER_CONNECTED" || this.record.state === "TRANSFERRING") &&
      this.record.transferDeadline &&
      this.record.transferDeadline <= now
    ) {
      if (this.channel) {
        this.channel.offer({ type: "error", reason: "Maximum transfer duration exceeded.", terminal: "FAILED" });
      } else {
        await this.finishTerminal("FAILED", "Maximum transfer duration exceeded.");
      }
      return;
    }

    if (this.record.expiresAt <= now) {
      if (this.channel) {
        this.channel.offer({ type: "error", reason: "Session expired.", terminal: "FAILED" });
      } else {
        await this.finishTerminal("EXPIRED", "Session expired.");
      }
      return;
    }

    await this.scheduleRelevantAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.record || TERMINAL_STATES.has(this.record.state)) return;
    if (!this.isSenderSocket(ws)) {
      ws.close(1008, "Invalid sender socket");
      return;
    }

    if (typeof message === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        await this.protocolFailure("Invalid control message.");
        return;
      }
      if (!isSenderMessage(parsed)) {
        await this.protocolFailure("Invalid control message.");
        return;
      }
      if (parsed.type === "cancel") {
        await this.cancelActiveTransfer("The sender cancelled the transfer.", "CANCELLED");
      } else if (parsed.type === "file_error") {
        await this.cancelActiveTransfer("The browser could not read the selected file.", "FAILED");
      }
      return;
    }

    if (!this.channel || !this.receiving) {
      await this.protocolFailure("File bytes arrived before a receiver was ready.");
      return;
    }
    if (this.chunksInFlight >= DEFAULTS.MAX_IN_FLIGHT_CHUNKS) {
      await this.protocolFailure("Sender exceeded its transfer credit.");
      return;
    }
    if (message.byteLength === 0 || message.byteLength > DEFAULTS.CHUNK_SIZE_BYTES) {
      await this.protocolFailure("Invalid chunk size.");
      return;
    }
    const remaining = this.record.expectedBytes - this.record.bytesTransferred - this.bytesInFlight;
    if (message.byteLength > remaining) {
      await this.protocolFailure("Sender exceeded the declared file size.");
      return;
    }

    this.lastActivityAt = Date.now();
    if (!this.channel.offer({ type: "chunk", data: message })) {
      await this.protocolFailure("Relay queue exceeded its bounded capacity.");
      return;
    }
    this.chunksInFlight += 1;
    this.bytesInFlight += message.byteLength;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (!this.isSenderSocket(ws) || !this.record || TERMINAL_STATES.has(this.record.state)) return;
    if (this.receiving && this.channel) {
      this.channel.offer({
        type: "error",
        reason: "The browser connection was closed.",
        terminal: "FAILED",
      });
      return;
    }
    await this.finishTerminal("CANCELLED", "The browser connection was closed.");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.record) return new Response("Already initialized", { status: 409 });
    const input = await request.json<InitRequest>();
    if (!this.validInit(input)) return new Response("Bad Request", { status: 400 });

    this.record = {
      ...input,
      state: "CREATED",
      bytesTransferred: 0,
      quotaReleased: false,
    };
    await this.save();
    await this.ctx.storage.setAlarm(input.expiresAt);
    return Response.json({ ok: true });
  }

  private async connectSender(request: Request): Promise<Response> {
    if (!this.record) return new Response("Session not found", { status: 404 });
    if (this.isExpired()) {
      await this.finishTerminal("EXPIRED", "Session expired.");
      return new Response("Session expired", { status: 410 });
    }
    if (TERMINAL_STATES.has(this.record.state)) return new Response("Session is no longer available", { status: 410 });
    if (this.record.state !== "CREATED" || this.ctx.getWebSockets("sender").length > 0) {
      return new Response("A sender is already connected", { status: 409 });
    }

    const secret = this.senderSecretFromProtocol(request.headers.get("Sec-WebSocket-Protocol"));
    if (!secret || !(await this.matchesSecret(secret))) {
      return new Response("Invalid sender credentials", { status: 401 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({ role: "sender" });
    this.ctx.acceptWebSocket(server, ["sender"]);

    this.record.state = "SENDER_CONNECTED";
    await this.save();
    this.record.state = "WAITING_FOR_RECEIVER";
    await this.save();
    this.log("sender_connected");
    this.sendToSender({ type: "sender_connected", expiresAt: new Date(this.record.expiresAt).toISOString() });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": SENDER_PROTOCOL },
    });
  }

  private async connectReceiver(request: Request): Promise<Response> {
    if (!this.record) return new Response("Session not found", { status: 404 });
    if (this.isExpired()) {
      await this.finishTerminal("EXPIRED", "Session expired.");
      return new Response("Session expired", { status: 410 });
    }
    if (TERMINAL_STATES.has(this.record.state)) return new Response("Session is no longer available", { status: 410 });
    if (this.record.state === "RECEIVER_CONNECTED" || this.record.state === "TRANSFERRING") {
      return new Response("A receiver is already connected", { status: 409 });
    }
    if (this.record.state !== "WAITING_FOR_RECEIVER" || this.ctx.getWebSockets("sender").length !== 1) {
      return new Response("Sender is not connected", { status: 409 });
    }
    if (request.headers.has("Range") || request.headers.has("If-Range")) {
      return new Response("Range requests are not supported", { status: 416 });
    }

    const now = Date.now();
    this.record.state = "RECEIVER_CONNECTED";
    this.record.transferDeadline = now + positiveInteger(
      this.env.MAX_TRANSFER_DURATION_MS,
      DEFAULTS.MAX_TRANSFER_DURATION_MS,
    );
    await this.save();
    await this.ctx.storage.setAlarm(this.record.transferDeadline);

    this.channel = new RendezvousChannel();
    this.receiving = true;
    this.chunksInFlight = 0;
    this.bytesInFlight = 0;
    this.log("receiver_connected");
    this.sendToSender({ type: "receiver_connected" });

    const fixed = new FixedLengthStream(this.record.expectedBytes);
    const writer = fixed.writable.getWriter();
    const pump = this.pumpReceiver(writer);
    this.ctx.waitUntil(pump);
    request.signal.addEventListener(
      "abort",
      () => this.channel?.offer({ type: "error", reason: "The receiving connection was closed.", terminal: "CANCELLED" }),
      { once: true },
    );

    return new Response(fixed.readable, {
      headers: {
        "Content-Type": this.record.contentType,
        "Content-Length": String(this.record.expectedBytes),
        "Content-Disposition": `attachment; filename="${this.record.outputFilename}"`,
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  }

  private async pumpReceiver(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    if (!this.record || !this.channel) return;
    const startedAt = Date.now();
    this.startIdleMonitor();
    const receiverClosed = writer.closed.then<ChannelItem, ChannelItem>(
      () => ({ type: "error", reason: "The receiving connection closed early.", terminal: "CANCELLED" }),
      () => ({ type: "error", reason: "The receiving connection was closed.", terminal: "CANCELLED" }),
    );

    try {
      if (this.record.expectedBytes === 0) {
        await writer.close();
        await this.complete(startedAt);
        return;
      }

      while (this.record.bytesTransferred < this.record.expectedBytes) {
        const item = await Promise.race([this.channel.take(), receiverClosed]);
        if (item.type === "error") throw Object.assign(new Error(item.reason), { terminal: item.terminal });

        if (this.record.state === "RECEIVER_CONNECTED") {
          this.record.state = "TRANSFERRING";
          this.record.transferStartedAt = Date.now();
          await this.save();
          this.log("transfer_started");
          this.sendToSender({ type: "transfer_started" });
        }

        await writer.write(new Uint8Array(item.data));
        this.record.bytesTransferred += item.data.byteLength;
        this.chunksInFlight -= 1;
        this.bytesInFlight -= item.data.byteLength;
        this.lastActivityAt = Date.now();
        this.sendToSender({ type: "chunk_accepted", bytes: this.record.bytesTransferred });
      }

      await writer.close();
      await this.complete(startedAt);
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {
        // The receiver may already have cancelled its side of the stream.
      }
      const value = error as Error & { terminal?: "CANCELLED" | "FAILED" };
      await this.finishTerminal(value.terminal ?? "CANCELLED", value.message || "The receiving connection was closed.");
    } finally {
      this.clearIdleTimer();
      this.receiving = false;
      this.channel = null;
      this.chunksInFlight = 0;
      this.bytesInFlight = 0;
    }
  }

  private async complete(startedAt: number): Promise<void> {
    if (!this.record) return;
    const durationMs = Date.now() - (this.record.transferStartedAt ?? startedAt);
    await this.finishTerminal("COMPLETED", "Transfer complete.", false);
    await this.recordCompletedBytes();
    this.sendToSender({ type: "completed", bytes: this.record.expectedBytes, durationMs });
    this.log("transfer_completed", { bytes: this.record.expectedBytes, durationMs });
    this.closeSender(1000, "Transfer complete");
  }

  private async recordCompletedBytes(): Promise<void> {
    if (!this.record) return;
    try {
      const response = await transferStatsStub(this.env).fetch("https://stats.internal/record", {
        method: "POST",
        body: JSON.stringify({
          sessionTag: this.record.sessionTag,
          bytes: this.record.expectedBytes,
        }),
      });
      if (!response.ok) throw new Error(`Stats returned ${response.status}`);
    } catch (error) {
      this.log("transfer_stats_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async protocolFailure(reason: string): Promise<void> {
    if (this.receiving && this.channel) {
      this.channel.offer({ type: "error", reason, terminal: "FAILED" });
    } else {
      await this.finishTerminal("FAILED", reason);
    }
  }

  private async cancelActiveTransfer(reason: string, terminal: "CANCELLED" | "FAILED"): Promise<void> {
    if (this.receiving && this.channel) {
      this.channel.offer({ type: "error", reason, terminal });
    } else {
      await this.finishTerminal(terminal, reason);
    }
  }

  private async finishTerminal(
    state: "COMPLETED" | "EXPIRED" | "CANCELLED" | "FAILED",
    reason: string,
    notify = true,
  ): Promise<void> {
    if (!this.record || TERMINAL_STATES.has(this.record.state)) return;
    this.record.state = state;
    this.record.terminalAt = Date.now();
    this.record.purgeAt = this.record.terminalAt + positiveInteger(
      this.env.TOMBSTONE_TTL_MS,
      DEFAULTS.TOMBSTONE_TTL_MS,
    );
    this.clearIdleTimer();
    await this.save();
    await this.ctx.storage.setAlarm(this.record.purgeAt);
    await this.releaseQuota();
    await this.save();

    if (notify) {
      if (state === "EXPIRED") this.sendToSender({ type: "expired" });
      else if (state === "CANCELLED") this.sendToSender({ type: "cancelled", reason });
      else if (state === "FAILED") this.sendToSender({ type: "failed", reason });
      this.closeSender(state === "CANCELLED" ? 1000 : 1011, reason.slice(0, 100));
    }
    if (state === "EXPIRED") this.log("session_expired");
    else if (state !== "COMPLETED") this.log("transfer_failed", { state, reason });
  }

  private async releaseQuota(): Promise<void> {
    if (!this.record || this.record.quotaReleased) return;
    const stub = this.env.IP_LIMITERS.getByName(this.record.quotaKey);
    try {
      const response = await stub.fetch("https://limiter.internal/release", {
        method: "POST",
        body: JSON.stringify({ sessionId: this.record.quotaSessionId }),
      });
      if (!response.ok) throw new Error(`Limiter returned ${response.status}`);
      this.record.quotaReleased = true;
    } catch (error) {
      this.log("quota_release_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }

  private async scheduleRelevantAlarm(): Promise<void> {
    if (!this.record) return;
    const target = this.record.transferDeadline ?? this.record.expiresAt;
    await this.ctx.storage.setAlarm(target);
  }

  private statusResponse(): Response {
    if (!this.record) return new Response("Not Found", { status: 404 });
    return Response.json({
      state: this.record.state,
      expectedBytes: this.record.expectedBytes,
      bytesTransferred: this.record.bytesTransferred,
      expiresAt: this.record.expiresAt,
    });
  }

  private validInit(input: InitRequest): boolean {
    return Boolean(
      input &&
      typeof input.senderSecretHash === "string" &&
      typeof input.outputFilename === "string" &&
      typeof input.contentType === "string" &&
      Number.isSafeInteger(input.expectedBytes) &&
      input.expectedBytes >= 0 &&
      Number.isSafeInteger(input.createdAt) &&
      Number.isSafeInteger(input.expiresAt) &&
      typeof input.quotaKey === "string" &&
      typeof input.quotaSessionId === "string" &&
      typeof input.sessionTag === "string",
    );
  }

  private senderSecretFromProtocol(header: string | null): string | null {
    if (!header) return null;
    const protocols = header.split(",").map((value) => value.trim());
    if (!protocols.includes(SENDER_PROTOCOL)) return null;
    const auth = protocols.find((value) => value.startsWith(SENDER_AUTH_PREFIX));
    return auth?.slice(SENDER_AUTH_PREFIX.length) || null;
  }

  private async matchesSecret(secret: string): Promise<boolean> {
    if (!this.record || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const actual = this.base64Url(new Uint8Array(hash));
    const expected = this.record.senderSecretHash;
    if (actual.length !== expected.length) return false;
    let different = 0;
    for (let index = 0; index < actual.length; index += 1) {
      different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    return different === 0;
  }

  private sendToSender(message: ServerMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets("sender")) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }

  private closeSender(code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets("sender")) {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    }
  }

  private isSenderSocket(ws: WebSocket): boolean {
    const attachment = ws.deserializeAttachment() as { role?: string } | null;
    return attachment?.role === "sender";
  }

  private isExpired(): boolean {
    return Boolean(this.record && this.record.expiresAt <= Date.now());
  }

  private startIdleMonitor(): void {
    this.clearIdleTimer();
    const receiverStartTimeout = positiveInteger(
      this.env.RECEIVER_START_TIMEOUT_MS,
      DEFAULTS.RECEIVER_START_TIMEOUT_MS,
    );
    const transferIdleTimeout = positiveInteger(
      this.env.TRANSFER_IDLE_TIMEOUT_MS,
      DEFAULTS.TRANSFER_IDLE_TIMEOUT_MS,
    );
    this.lastActivityAt = Date.now();
    const interval = Math.max(
      100,
      Math.min(1_000, Math.floor(Math.min(receiverStartTimeout, transferIdleTimeout) / 4)),
    );
    this.idleTimer = setInterval(() => {
      const waitingForFirstChunk = this.record?.state === "RECEIVER_CONNECTED";
      const timeout = currentTransferIdleTimeout(
        waitingForFirstChunk,
        receiverStartTimeout,
        transferIdleTimeout,
      );
      if (Date.now() - this.lastActivityAt >= timeout) {
        this.channel?.offer({
          type: "error",
          reason: waitingForFirstChunk
            ? "The browser did not start sending in time. Return to TermDrop and try again."
            : "Transfer stalled.",
          terminal: "FAILED",
        });
      }
    }, interval);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private async save(): Promise<void> {
    if (this.record) await this.ctx.storage.put("session", this.record);
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ event, session: this.record?.sessionTag, ...fields }));
  }

  private base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
}
