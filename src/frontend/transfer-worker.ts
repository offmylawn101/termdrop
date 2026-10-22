import { DEFAULTS } from "../shared/config";
import {
  isServerMessage,
  SENDER_AUTH_PREFIX,
  SENDER_PROTOCOL,
  type CreateSessionResponse,
} from "../shared/protocol";
import { streamFixedFrames } from "./frame-stream";
import { streamFromTransferSource, type TransferSource } from "./transfer-selection";
import type { TransferWorkerEvent, TransferWorkerMessage, TransferWorkerRequest } from "./transfer-worker-protocol";

interface WorkerPort {
  postMessage(message: TransferWorkerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<TransferWorkerRequest>) => void): void;
  start?: () => void;
}

interface PendingAck {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const senders = new Map<string, TransferSender>();

class TransferSender {
  private readonly listeners = new Set<WorkerPort>();
  private readonly socket: WebSocket;
  private readonly pendingAcks: PendingAck[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private transferStarted = false;
  private terminal = false;

  constructor(
    private readonly session: CreateSessionResponse,
    private readonly source: TransferSource,
    owner: WorkerPort,
  ) {
    this.listeners.add(owner);
    const endpoint = new URL(session.downloadUrl);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    endpoint.pathname = `/api/session/${session.id}/sender`;
    endpoint.search = "";
    endpoint.hash = "";

    this.socket = new WebSocket(endpoint, [SENDER_PROTOCOL, `${SENDER_AUTH_PREFIX}${session.senderSecret}`]);
    this.socket.binaryType = "arraybuffer";
    this.socket.onmessage = (event) => this.onSocketMessage(event);
    this.socket.onerror = () => this.fail("Could not maintain the relay connection.");
    this.socket.onclose = () => {
      if (!this.terminal) this.fail("The relay connection closed before the transfer completed.");
    };
  }

  addListener(port: WorkerPort): void {
    this.listeners.add(port);
  }

  cancel(): void {
    if (this.terminal) return;
    this.terminal = true;
    const error = new Error("The sender cancelled the transfer.");
    for (const pending of this.pendingAcks.splice(0)) pending.reject(error);
    void this.reader?.cancel(error).catch(() => undefined);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "cancel" }));
    }
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, "Transfer cancelled");
    }
    senders.delete(this.session.id);
  }

  private onSocketMessage(event: MessageEvent): void {
    if (typeof event.data !== "string" || this.terminal) return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      this.fail("The relay sent an invalid message.");
      return;
    }
    if (!isServerMessage(value)) {
      this.fail("The relay sent an invalid message.");
      return;
    }

    this.emit({ type: "server_message", sessionId: this.session.id, message: value });
    switch (value.type) {
      case "receiver_connected":
        void this.sendSource();
        break;
      case "chunk_accepted":
        this.pendingAcks.shift()?.resolve();
        break;
      case "completed":
        for (const pending of this.pendingAcks.splice(0)) pending.resolve();
        this.finish();
        break;
      case "cancelled":
      case "failed":
        this.finish(new Error(value.reason));
        break;
      case "expired":
        this.finish(new Error("Session expired."));
        break;
      default:
        break;
    }
  }

  private async sendSource(): Promise<void> {
    if (this.transferStarted || this.terminal) return;
    this.transferStarted = true;
    const reader = streamFromTransferSource(this.source).getReader();
    this.reader = reader;

    try {
      await streamFixedFrames(reader, DEFAULTS.CHUNK_SIZE_BYTES, async (chunk) => {
        if (this.terminal || this.socket.readyState !== WebSocket.OPEN) {
          throw new Error("The relay connection was closed.");
        }

        const pending = deferredAck();
        this.pendingAcks.push(pending);
        this.socket.send(chunk);
        if (this.pendingAcks.length >= DEFAULTS.MAX_IN_FLIGHT_CHUNKS) {
          await this.pendingAcks[0].promise;
        }
      });

      while (this.pendingAcks.length > 0) await this.pendingAcks[0].promise;
    } catch (reason) {
      if (!this.terminal) {
        const message = reason instanceof Error ? reason.message : "The browser could not read the file.";
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "file_error", message }));
        }
        this.fail(message);
      }
    } finally {
      reader.releaseLock();
      this.reader = null;
    }
  }

  private fail(reason: string): void {
    if (this.terminal) return;
    this.emit({ type: "client_error", sessionId: this.session.id, reason });
    this.finish(new Error(reason));
  }

  private finish(error?: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const pending of this.pendingAcks.splice(0)) {
      if (error) pending.reject(error);
      else pending.resolve();
    }
    void this.reader?.cancel(error).catch(() => undefined);
    senders.delete(this.session.id);
  }

  private emit(event: TransferWorkerEvent): void {
    for (const listener of this.listeners) listener.postMessage(event);
  }
}

function connectPort(port: WorkerPort): void {
  port.addEventListener("message", (event) => {
    const request = event.data;
    if (request.type === "start") {
      const existing = senders.get(request.session.id);
      if (existing) {
        existing.addListener(port);
        return;
      }
      try {
        senders.set(request.session.id, new TransferSender(request.session, request.source, port));
      } catch {
        port.postMessage({
          type: "client_error",
          sessionId: request.session.id,
          reason: "Could not connect to the transfer relay. Please try again.",
        });
      }
      return;
    }
    senders.get(request.sessionId)?.cancel();
  });
  port.start?.();
  port.postMessage({ type: "ready" });
}

type DualWorkerScope = typeof globalThis & {
  onconnect?: (event: MessageEvent) => void;
  postMessage?: (message: TransferWorkerMessage) => void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TransferWorkerRequest>) => void,
  ): void;
};

const workerScope = globalThis as DualWorkerScope;
if (typeof workerScope.onconnect !== "undefined") {
  workerScope.onconnect = (event) => {
    const port = event.ports[0] as WorkerPort | undefined;
    if (port) connectPort(port);
  };
} else {
  connectPort(workerScope as WorkerPort);
}

function deferredAck(): PendingAck {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
