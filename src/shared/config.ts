export const DEFAULTS = {
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024 * 1024,
  SESSION_TTL_MS: 10 * 60 * 1000,
  RECEIVER_START_TIMEOUT_MS: 90 * 1000,
  TRANSFER_IDLE_TIMEOUT_MS: 30 * 1000,
  MAX_TRANSFER_DURATION_MS: 6 * 60 * 60 * 1000,
  TOMBSTONE_TTL_MS: 24 * 60 * 60 * 1000,
  MAX_ACTIVE_TRANSFERS_PER_IP: 5,
  SESSION_RATE_LIMIT: 10,
  SESSION_RATE_WINDOW_MS: 60 * 1000,
  CHUNK_SIZE_BYTES: 256 * 1024,
  MAX_IN_FLIGHT_CHUNKS: 8,
  MAX_ARCHIVE_ENTRIES: 10_000,
  MAX_METADATA_BODY_BYTES: 8 * 1024,
} as const;

export function currentTransferIdleTimeout(
  waitingForFirstChunk: boolean,
  receiverStartTimeoutMs: number,
  transferIdleTimeoutMs: number,
): number {
  return waitingForFirstChunk ? receiverStartTimeoutMs : transferIdleTimeoutMs;
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
