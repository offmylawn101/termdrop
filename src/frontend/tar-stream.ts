const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const encoder = new TextEncoder();

export interface TarEntry {
  path: string;
  file: File | null;
}

export function tarArchiveSize(entries: readonly TarEntry[]): number {
  let bytes = TAR_END_BYTES;
  for (const entry of entries) {
    const fileBytes = entry.file?.size ?? 0;
    bytes = safeAdd(bytes, TAR_BLOCK_BYTES);
    bytes = safeAdd(bytes, fileBytes);
    bytes = safeAdd(bytes, paddingFor(fileBytes));
  }
  return bytes;
}

export function createTarStream(entries: readonly TarEntry[]): ReadableStream<Uint8Array> {
  const directoryModifiedAt = entries.reduce(
    (latest, entry) => Math.max(latest, entry.file?.lastModified ?? 0),
    0,
  );
  const iterator = tarChunks(entries, directoryModifiedAt);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return(reason);
    },
  });
}

async function* tarChunks(
  entries: readonly TarEntry[],
  directoryModifiedAt: number,
): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    const directory = entry.file === null;
    yield tarHeader(entry.path, entry.file, directory, directoryModifiedAt);
    if (directory) continue;
    const file = entry.file;
    if (!file) throw new Error("Archive entry lost its file source.");

    const reader = file.stream().getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > 0) yield chunk.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    const padding = paddingFor(file.size);
    if (padding > 0) yield new Uint8Array(padding);
  }
  yield new Uint8Array(TAR_END_BYTES);
}

function tarHeader(path: string, file: File | null, directory: boolean, directoryModifiedAt: number): Uint8Array {
  const normalizedPath = directory ? path.replace(/\/+$/, "") : path;
  const { name, prefix } = splitUstarPath(normalizedPath);
  const header = new Uint8Array(TAR_BLOCK_BYTES);

  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, directory ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file?.size ?? 0);
  writeOctal(header, 136, 12, Math.max(0, Math.floor((file?.lastModified ?? directoryModifiedAt) / 1_000)));
  header.fill(0x20, 148, 156);
  header[156] = directory ? 0x35 : 0x30;
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "termdrop");
  writeText(header, 297, 32, "termdrop");
  writeText(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeText(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).byteLength <= 100) return { name: path, prefix: "" };

  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (encoder.encode(prefix).byteLength <= 155 && encoder.encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Archive path is too long: ${path}`);
}

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error("TAR field exceeds its fixed width.");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("TAR numeric field is invalid.");
  const encoded = value.toString(8);
  if (encoded.length > length - 1) throw new Error("TAR numeric field exceeds its fixed width.");
  writeText(target, offset, length, `${encoded.padStart(length - 1, "0")}\0`);
}

function paddingFor(bytes: number): number {
  return (TAR_BLOCK_BYTES - (bytes % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("Archive is too large for this browser.");
  return total;
}
