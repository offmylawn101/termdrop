import type { AdAuction } from "../durable-object/ad-auction";
import type { IpLimiter } from "../durable-object/ip-limiter";
import type { TransferSession } from "../durable-object/transfer-session";
import type { TransferStats } from "../durable-object/transfer-stats";

export interface Env {
  AD_AUCTION: DurableObjectNamespace<AdAuction>;
  AD_SPONSOR_CREATIVES: R2Bucket;
  TRANSFER_SESSIONS: DurableObjectNamespace<TransferSession>;
  IP_LIMITERS: DurableObjectNamespace<IpLimiter>;
  TRANSFER_STATS: DurableObjectNamespace<TransferStats>;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL?: string;
  IP_HASH_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AD_ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;
  AD_NOTIFICATION_TO?: string;
  AD_NOTIFICATION_FROM?: string;
  MAX_FILE_SIZE_BYTES?: string;
  SESSION_TTL_MS?: string;
  RECEIVER_START_TIMEOUT_MS?: string;
  TRANSFER_IDLE_TIMEOUT_MS?: string;
  MAX_TRANSFER_DURATION_MS?: string;
  TOMBSTONE_TTL_MS?: string;
  MAX_ACTIVE_TRANSFERS_PER_IP?: string;
  SESSION_RATE_LIMIT?: string;
  SESSION_RATE_WINDOW_MS?: string;
}
