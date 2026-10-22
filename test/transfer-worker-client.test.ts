import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransferWorkerClient, type TransferWorkerClient } from "../src/frontend/transfer-worker-client";
import type { TransferWorkerMessage, TransferWorkerRequest } from "../src/frontend/transfer-worker-protocol";
import type { CreateSessionResponse } from "../src/shared/protocol";

class Endpoint extends EventTarget {
  sent: TransferWorkerRequest[] = [];
  postMessage(message: TransferWorkerRequest) { this.sent.push(message); }
  start = vi.fn();
  close = vi.fn();
  receive(message: TransferWorkerMessage) {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

class Shared extends EventTarget {
  static instances: Shared[] = [];
  port = new Endpoint();
  constructor() { super(); Shared.instances.push(this); }
}

class Dedicated extends Endpoint {
  static instances: Dedicated[] = [];
  terminate = vi.fn();
  constructor() { super(); Dedicated.instances.push(this); }
}

const session: CreateSessionResponse = {
  id: "test-session",
  senderSecret: "test-secret",
  downloadUrl: "https://termdrop.sh/d/test-session",
  outputFilename: "test.txt",
  expiresAt: "2026-09-19T12:00:00.000Z",
};
const source = { kind: "file", file: new File(["test"], "test.txt") } as const;
let clients: TransferWorkerClient[] = [];

function start() {
  const onEvent = vi.fn();
  const client = createTransferWorkerClient(onEvent);
  clients.push(client);
  client.start(session, source);
  return { client, onEvent };
}

beforeEach(() => {
  vi.useFakeTimers();
  Shared.instances = [];
  Dedicated.instances = [];
  vi.stubGlobal("SharedWorker", Shared);
  vi.stubGlobal("Worker", Dedicated);
});

afterEach(() => {
  for (const client of clients) client.close();
  clients = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("transfer worker startup", () => {
  it("waits for the worker handshake before sending the file and session", () => {
    const { onEvent } = start();
    const port = Shared.instances[0].port;
    expect(port.sent).toEqual([]);
    port.receive({ type: "ready" });
    expect(port.sent).toEqual([{ type: "start", session, source }]);
    const connected = { type: "server_message", sessionId: session.id,
      message: { type: "sender_connected", expiresAt: session.expiresAt } } as const;
    port.receive(connected);
    vi.advanceTimersByTime(30_000);
    expect(onEvent.mock.calls).toEqual([[connected]]);
    expect(Dedicated.instances).toHaveLength(0);
  });

  it("uses a dedicated worker when SharedWorker is unavailable", () => {
    vi.stubGlobal("SharedWorker", undefined);
    start();
    Dedicated.instances[0].receive({ type: "ready" });
    expect(Dedicated.instances[0].sent).toEqual([{ type: "start", session, source }]);
  });

  it("falls back when the shared worker constructor throws", () => {
    vi.stubGlobal("SharedWorker", class { constructor() { throw new Error("Blocked"); } });
    start();
    Dedicated.instances[0].receive({ type: "ready" });
    expect(Dedicated.instances[0].sent).toEqual([{ type: "start", session, source }]);
  });

  it("falls back after asynchronous shared worker loading failure", () => {
    const { onEvent } = start();
    Shared.instances[0].dispatchEvent(new Event("error"));
    expect(Shared.instances[0].port.close).toHaveBeenCalledOnce();
    Dedicated.instances[0].receive({ type: "ready" });
    expect(Dedicated.instances[0].sent).toEqual([{ type: "start", session, source }]);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("falls back when the shared worker silently never starts and ignores late messages", () => {
    start();
    const abandoned = Shared.instances[0].port;
    vi.advanceTimersByTime(5_000);
    abandoned.receive({ type: "ready" });
    Dedicated.instances[0].receive({ type: "ready" });
    expect(abandoned.sent).toEqual([]);
    expect(Dedicated.instances[0].sent).toEqual([{ type: "start", session, source }]);
  });

  it("shows an error when both workers fail to start", () => {
    const { onEvent } = start();
    vi.advanceTimersByTime(10_000);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "client_error", sessionId: session.id }));
    expect(Dedicated.instances[0].terminate).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("does not replay a start if a worker crashes after receiving the session", () => {
    const { onEvent } = start();
    Shared.instances[0].port.receive({ type: "ready" });
    Shared.instances[0].dispatchEvent(new Event("error"));
    expect(Dedicated.instances).toHaveLength(0);
    expect(Shared.instances[0].port.sent.at(-1)).toEqual({ type: "cancel", sessionId: session.id });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "client_error" }));
  });

  it("times out a relay connection that never acknowledges the sender", () => {
    const { onEvent } = start();
    Shared.instances[0].port.receive({ type: "ready" });
    vi.advanceTimersByTime(15_000);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "client_error", reason: expect.stringContaining("relay"),
    }));
    expect(Shared.instances[0].port.sent.at(-1)).toEqual({ type: "cancel", sessionId: session.id });
    expect(Dedicated.instances).toHaveLength(0);
  });

  it("cancels during startup without sending the source or spawning a fallback", () => {
    const { client, onEvent } = start();
    client.cancel(session.id);
    Shared.instances[0].port.receive({ type: "ready" });
    vi.advanceTimersByTime(30_000);
    expect(Shared.instances[0].port.sent).toEqual([]);
    expect(Dedicated.instances).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reports worker message decoding errors and closes the connection", () => {
    const { onEvent } = start();
    Shared.instances[0].port.receive({ type: "ready" });
    Shared.instances[0].port.dispatchEvent(new Event("messageerror"));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "client_error" }));
    expect(Shared.instances[0].port.close).toHaveBeenCalledOnce();
  });
});
