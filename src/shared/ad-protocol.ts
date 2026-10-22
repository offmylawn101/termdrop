export interface PublicAdState {
  enabled: boolean;
  id: string;
  creativeUrl: string;
  targetUrl: string;
  altText: string;
  advertiserDomain: string;
  currentBidCents: number;
  minimumBidCents: number;
  lockedUntil: number | null;
  expiresAt: number | null;
  isDefault: boolean;
}

export interface AdCheckoutResponse {
  checkoutUrl: string;
}

export interface PendingAdSubmission {
  id: string;
  creativeUrl: string;
  targetUrl: string;
  advertiserDomain: string;
  altText: string;
  bidCents: number;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  customerEmail: string | null;
  createdAt: number;
}

export const AD_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
