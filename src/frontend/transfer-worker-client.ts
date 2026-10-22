import type { CreateSessionResponse } from "../shared/protocol";
import type { TransferSource } from "./transfer-selection";
import type { TransferWorkerEvent, TransferWorkerMessage, TransferWorkerRequest } from "./transfer-worker-protocol";

interface WorkerEndpoint extends EventTarget {
  postMessage(message: TransferWorkerRequest): void;
}

export interface TransferWorkerClient {
  start(session: CreateSessionResponse, source: TransferSource): void;
  cancel(sessionId: string): void;
  close(): void;
}

const WORKER_START_TIMEOUT_MS = 5_000;
const RELAY_CONNECT_TIMEOUT_MS = 15_000;

export function createTransferWorkerClient(
  onEvent: (event: TransferWorkerEvent) => void,
): TransferWorkerClient {
  let endpoint: WorkerEndpoint | null = null;
  let dispose: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Extract<TransferWorkerRequest, { type: "start" }> | null = null;
  let sessionId: string | null = null;
  let closed = false;

  function disconnect(): void {
    clearTimeout(timer);
    dispose?.();
    dispose = null;
    endpoint = null;
  }

  function fail(reason: string): void {
    if (closed || !sessionId) return;
    const failedSessionId = sessionId;
    // Cancel any sender that may already own this one-time session.
    if (!pending) {
      try { endpoint?.postMessage({ type: "cancel", sessionId }); } catch { /* Worker already failed. */ }
    }
    close();
    onEvent({ type: "client_error", sessionId: failedSessionId, reason });
  }

  function close(): void {
    closed = true;
    pending = null;
    disconnect();
  }

  function connect(shared: boolean): void {
    disconnect();
    if (closed) return;

    const startupFailed = () => {
      // Never replay a start: the relay only accepts one sender per session.
      if (shared && pending) connect(false);
      else fail("Could not start the transfer. Please try again or use another browser.");
    };

    try {
      const worker = shared
        ? new SharedWorker(new URL("./transfer-worker.ts", import.meta.url), {
          type: "module",
          name: "termdrop-transfers-v2",
        })
        : new Worker(new URL("./transfer-worker.ts", import.meta.url), {
          type: "module",
          name: "termdrop-transfer",
        });
      const port = "port" in worker ? worker.port : worker;
      endpoint = port;

      const onMessage = (event: Event) => {
        if (closed || endpoint !== port) return;
        const message = (event as MessageEvent<TransferWorkerMessage>).data;
        if (message.type === "ready") {
          if (!pending) return;
          clearTimeout(timer);
          const request = pending;
          try {
            port.postMessage(request);
            pending = null;
            timer = setTimeout(() => {
              fail("Could not connect to the transfer relay. Check your connection and try again.");
            }, RELAY_CONNECT_TIMEOUT_MS);
          } catch {
            startupFailed();
          }
          return;
        }
        if (message.sessionId !== sessionId) return;
        clearTimeout(timer);
        if (message.type === "client_error") fail(message.reason);
        else onEvent(message);
      };
      const onError = (event: Event) => {
        if (closed || endpoint !== port) return;
        event.preventDefault();
        startupFailed();
      };
      port.addEventListener("message", onMessage);
      port.addEventListener("messageerror", onError);
      worker.addEventListener("error", onError);
      dispose = () => {
        port.removeEventListener("message", onMessage);
        port.removeEventListener("messageerror", onError);
        worker.removeEventListener("error", onError);
        if ("port" in worker) worker.port.close();
        else worker.terminate();
      };
      timer = setTimeout(startupFailed, WORKER_START_TIMEOUT_MS);
      if ("port" in worker) worker.port.start();
    } catch {
      startupFailed();
    }
  }

  return {
    start(session, source) {
      if (closed || sessionId) return;
      sessionId = session.id;
      pending = { type: "start", session, source };
      connect(typeof SharedWorker === "function");
    },
    cancel(cancelledSessionId) {
      if (cancelledSessionId !== sessionId || closed) return;
      if (!pending) {
        try { endpoint?.postMessage({ type: "cancel", sessionId: cancelledSessionId }); } catch { /* Worker already failed. */ }
      }
      close();
    },
    close,
  };
}
