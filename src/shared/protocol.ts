export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
export const SENDER_PROTOCOL = "termdrop.v1";
export const SENDER_AUTH_PREFIX = "termdrop.auth.";

export type TransferState =
  | "CREATED"
  | "SENDER_CONNECTED"
  | "WAITING_FOR_RECEIVER"
  | "RECEIVER_CONNECTED"
  | "TRANSFERRING"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export type SenderMessage =
  | { type: "sender_ready" }
  | { type: "cancel" }
  | { type: "file_error"; message?: string }
  | { type: "ping" };

export type ServerMessage =
  | { type: "sender_connected"; expiresAt: string }
  | { type: "receiver_connected" }
  | { type: "transfer_started" }
  | { type: "chunk_accepted"; bytes: number }
  | { type: "completed"; bytes: number; durationMs: number }
  | { type: "cancelled"; reason: string }
  | { type: "failed"; reason: string }
  | { type: "expired" };

export interface CreateSessionRequest {
  filename: string;
  size: number;
  contentType?: string;
}

export interface CreateSessionResponse {
  id: string;
  senderSecret: string;
  downloadUrl: string;
  outputFilename: string;
  expiresAt: string;
}

export function isSenderMessage(value: unknown): value is SenderMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "sender_ready" || message.type === "cancel" || message.type === "ping") {
    return true;
  }
  return message.type === "file_error" &&
    (message.message === undefined || typeof message.message === "string");
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "sender_connected":
      return typeof message.expiresAt === "string";
    case "receiver_connected":
    case "transfer_started":
    case "expired":
      return true;
    case "chunk_accepted":
      return typeof message.bytes === "number";
    case "completed":
      return typeof message.bytes === "number" && typeof message.durationMs === "number";
    case "cancelled":
    case "failed":
      return typeof message.reason === "string";
    default:
      return false;
  }
}
