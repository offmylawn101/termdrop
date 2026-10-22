import type { CreateSessionResponse, ServerMessage } from "../shared/protocol";
import type { TransferSource } from "./transfer-selection";

export type TransferWorkerRequest =
  | {
    type: "start";
    session: CreateSessionResponse;
    source: TransferSource;
  }
  | { type: "cancel"; sessionId: string };

export type TransferWorkerEvent =
  | { type: "server_message"; sessionId: string; message: ServerMessage }
  | { type: "client_error"; sessionId: string; reason: string };

export type TransferWorkerMessage = TransferWorkerEvent | { type: "ready" };
