export const MAX_AD_CREATIVE_BYTES = 1024 * 1024;
export const MIN_AD_WIDTH = 500;
export const MIN_AD_HEIGHT = 80;
export const MAX_AD_WIDTH = 8_000;
export const MAX_AD_HEIGHT = 2_000;
export const MIN_AD_ASPECT_RATIO = 4;
export const MAX_AD_ASPECT_RATIO = 10;

export interface CreativeInfo {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

export function parseUsdCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [dollars, fraction = ""] = normalized.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 100 && cents <= 10_000_000 ? cents : null;
}

export function validateAdTarget(value: string): { url: string; hostname: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  if (parsed.hash) parsed.hash = "";
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || isBlockedHostname(hostname)) return null;
  parsed.hostname = hostname;
  return { url: parsed.toString(), hostname };
}

export function inspectAdCreative(bytes: Uint8Array, declaredContentType: string): CreativeInfo | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AD_CREATIVE_BYTES) return null;
  const png = inspectPng(bytes);
  if (png && declaredContentType === "image/png") return validDimensions(png) ? png : null;
  const jpeg = inspectJpeg(bytes);
  if (jpeg && declaredContentType === "image/jpeg") return validDimensions(jpeg) ? jpeg : null;
  const webp = inspectWebp(bytes);
  if (webp && declaredContentType === "image/webp") return validDimensions(webp) ? webp : null;
  return null;
}

function validDimensions(info: CreativeInfo): boolean {
  const ratio = info.width / info.height;
  return (
    info.width >= MIN_AD_WIDTH &&
    info.height >= MIN_AD_HEIGHT &&
    info.width <= MAX_AD_WIDTH &&
    info.height <= MAX_AD_HEIGHT &&
    ratio >= MIN_AD_ASPECT_RATIO &&
    ratio <= MAX_AD_ASPECT_RATIO
  );
}

function inspectPng(bytes: Uint8Array): CreativeInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  // Animated PNGs are intentionally excluded from the quiet single-slot format.
  if (containsAscii(bytes, "acTL")) return null;
  return {
    contentType: "image/png",
    width: readUint32Be(bytes, 16),
    height: readUint32Be(bytes, 20),
  };
}

function inspectJpeg(bytes: Uint8Array): CreativeInfo | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if (startOfFrameMarkers.has(marker) && length >= 7) {
      return {
        contentType: "image/jpeg",
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): CreativeInfo | null {
  if (
    bytes.byteLength < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    if ((bytes[20] & 0x02) !== 0) return null;
    return {
      contentType: "image/webp",
      width: 1 + readUint24Le(bytes, 24),
      height: 1 + readUint24Le(bytes, 27),
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return {
      contentType: "image/webp",
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    };
  }
  if (
    chunk === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      contentType: "image/webp",
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  return null;
}

function isBlockedHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".onion")
  ) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.includes(":")) return true;
  return new Set([
    "bit.ly", "buff.ly", "cutt.ly", "goo.gl", "is.gd", "rb.gy", "rebrand.ly",
    "shorturl.at", "t.co", "tiny.cc", "tinyurl.com",
  ]).has(hostname);
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const encoded = new TextEncoder().encode(needle);
  outer: for (let index = 0; index <= bytes.byteLength - encoded.byteLength; index += 1) {
    for (let offset = 0; offset < encoded.byteLength; offset += 1) {
      if (bytes[index + offset] !== encoded[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
