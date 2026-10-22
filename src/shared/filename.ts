const MAX_FILENAME_LENGTH = 180;

export function sanitizeFilename(input: string): string {
  const basename = input.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = basename
    .normalize("NFKC")
    // These are deliberately removed rather than escaped into a shell command.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();

  const fallback = "download.bin";
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;

  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`;
}

export function safeContentType(input: string | undefined): string {
  if (!input) return "application/octet-stream";
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(input)
    ? input.slice(0, 127)
    : "application/octet-stream";
}

export function shellDoubleQuote(input: string): string {
  return `"${input.replace(/[\\"$`]/g, "\\$&")}"`;
}
