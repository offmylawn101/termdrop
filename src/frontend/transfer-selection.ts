import { sanitizeFilename } from "../shared/filename";
import { DEFAULTS } from "../shared/config";
import { createTarStream, tarArchiveSize, type TarEntry } from "./tar-stream";

export type SelectionKind = "file" | "files" | "folder";

export type TransferSource =
  | { kind: "file"; file: File }
  | { kind: "archive"; entries: TarEntry[] };

export interface TransferSelection {
  kind: SelectionKind;
  displayName: string;
  outputFilename: string;
  contentType: string;
  streamBytes: number;
  sourceBytes: number;
  fileCount: number;
  previewFile: File | null;
  source: TransferSource;
  createStream: () => ReadableStream<Uint8Array>;
}

interface RawEntry {
  path: string;
  file: File | null;
}

const MAX_ARCHIVE_ENTRIES = DEFAULTS.MAX_ARCHIVE_ENTRIES;

export function selectionFromFiles(
  files: readonly File[],
  options: { forceArchive?: boolean; names?: readonly string[]; now?: Date } = {},
): TransferSelection | null {
  if (files.length === 0) return null;
  const names = options.names ?? files.map((file) => file.webkitRelativePath || file.name);
  if (files.length === 1 && !options.forceArchive) {
    const file = files[0];
    const filename = sanitizeFilename(names[0] || file.name);
    return {
      kind: "file",
      displayName: filename,
      outputFilename: filename,
      contentType: file.type || "application/octet-stream",
      streamBytes: file.size,
      sourceBytes: file.size,
      fileCount: 1,
      previewFile: file,
      source: { kind: "file", file },
      createStream: () => file.stream(),
    };
  }

  const roots = names.map((name) => name.split("/")[0]).filter(Boolean);
  const hasRelativeRoot = Boolean(
    options.forceArchive &&
    names.every((name) => name.includes("/")) &&
    new Set(roots).size === 1,
  );
  const commonRoot = hasRelativeRoot ? safeSegment(names[0].split("/")[0], "folder") : null;
  const now = options.now ?? new Date();
  const wrapper = commonRoot ?? `termdrop-files-${compactTimestamp(now)}`;
  const rawEntries: RawEntry[] = files.map((file, index) => ({
    path: hasRelativeRoot ? names[index] : `${wrapper}/${names[index] || file.name}`,
    file,
  }));
  return archiveSelection(rawEntries, commonRoot ? "folder" : "files", wrapper);
}

export async function selectionFromDrop(dataTransfer: DataTransfer): Promise<TransferSelection | null> {
  const roots = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (roots.length === 0) return selectionFromFiles(Array.from(dataTransfer.files));

  const rawEntries: RawEntry[] = [];
  for (const root of roots) await walkLegacyEntry(root, root.name, rawEntries, 0);
  const containsDirectory = roots.some((entry) => entry.isDirectory);
  const files = rawEntries.filter((entry) => entry.file !== null);
  if (!containsDirectory && files.length === 1 && roots.length === 1) {
    return selectionFromFiles([files[0].file!], { names: [roots[0].name] });
  }

  if (roots.length === 1 && roots[0].isDirectory) {
    const rootName = safeSegment(roots[0].name, "folder");
    return archiveSelection(rawEntries, "folder", rootName);
  }

  const wrapper = `termdrop-files-${compactTimestamp(new Date())}`;
  return archiveSelection(
    rawEntries.map((entry) => ({ ...entry, path: `${wrapper}/${entry.path}` })),
    "files",
    wrapper,
  );
}

function archiveSelection(rawEntries: readonly RawEntry[], kind: "files" | "folder", displayName: string): TransferSelection {
  const entries = normalizeArchiveEntries(rawEntries);
  const files = entries.filter((entry) => entry.file !== null);
  const sourceBytes = files.reduce((total, entry) => safeAdd(total, entry.file!.size), 0);
  const streamBytes = tarArchiveSize(entries);
  const outputBase = sanitizeFilename(displayName).replace(/\.tar$/i, "") || "termdrop-files";
  return {
    kind,
    displayName: kind === "folder" ? outputBase : `${files.length} files`,
    outputFilename: `${outputBase}.tar`,
    contentType: "application/x-tar",
    streamBytes,
    sourceBytes,
    fileCount: files.length,
    previewFile: null,
    source: { kind: "archive", entries },
    createStream: () => createTarStream(entries),
  };
}

export function streamFromTransferSource(source: TransferSource): ReadableStream<Uint8Array> {
  return source.kind === "file" ? source.file.stream() : createTarStream(source.entries);
}

export function combineTransferSelections(
  existing: TransferSelection,
  incoming: TransferSelection,
  now = new Date(),
): TransferSelection {
  const wrapper = `termdrop-files-${compactTimestamp(now)}`;
  const rawEntries = [existing, incoming].flatMap((selection) =>
    unwrappedEntries(selection).map((entry) => ({
      path: `${wrapper}/${entry.path}`,
      file: entry.file,
    })),
  );
  return archiveSelection(rawEntries, "files", wrapper);
}

function unwrappedEntries(selection: TransferSelection): RawEntry[] {
  if (selection.source.kind === "file") {
    return [{ path: selection.outputFilename, file: selection.source.file }];
  }

  const entries = selection.source.entries;
  if (selection.kind !== "files") return entries.map((entry) => ({ ...entry }));
  const root = selection.outputFilename.replace(/\.tar$/i, "");
  return entries.flatMap((entry) => {
    if (entry.path === root && entry.file === null) return [];
    const prefix = `${root}/`;
    return [{
      path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
      file: entry.file,
    }];
  });
}

function normalizeArchiveEntries(rawEntries: readonly RawEntry[]): TarEntry[] {
  if (rawEntries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Folders are limited to ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries.`);
  }

  const used = new Set<string>();
  const directories = new Set<string>();
  const output: TarEntry[] = [];

  const addDirectory = (path: string) => {
    if (!path || directories.has(path)) return;
    if (used.has(path)) throw new Error(`A file and folder resolve to the same safe archive path: ${path}`);
    if (output.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Folders are limited to ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries.`);
    }
    validateTarPath(path);
    directories.add(path);
    used.add(path);
    output.push({ path, file: null });
  };

  for (const raw of rawEntries) {
    const normalized = normalizePath(raw.path);
    const segments = normalized.split("/");
    const parentSegments = raw.file === null ? segments : segments.slice(0, -1);
    for (let index = 1; index <= parentSegments.length; index += 1) {
      addDirectory(parentSegments.slice(0, index).join("/"));
    }
    if (raw.file === null) {
      addDirectory(normalized);
      continue;
    }
    const path = uniquePath(normalized, used);
    if (output.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Folders are limited to ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries.`);
    }
    validateTarPath(path);
    used.add(path);
    output.push({ path, file: raw.file });
  }
  return output;
}

async function walkLegacyEntry(
  entry: FileSystemEntry,
  path: string,
  output: RawEntry[],
  depth: number,
): Promise<void> {
  if (depth > 64) throw new Error("This folder is nested too deeply to transfer safely.");
  if (output.length >= MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Folders are limited to ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries.`);
  }
  if (entry.isFile) {
    output.push({ path, file: await legacyFile(entry as FileSystemFileEntry) });
    return;
  }
  if (!entry.isDirectory) return;
  output.push({ path, file: null });
  const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
  for (const child of children) await walkLegacyEntry(child, `${path}/${child.name}`, output, depth + 1);
}

function legacyFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const output: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return output;
    output.push(...batch);
    if (output.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Folders are limited to ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries.`);
    }
  }
}

function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length === 0) return "download.bin";
  return segments.map((segment, index) => safeSegment(segment, index === segments.length - 1 ? "file" : "folder")).join("/");
}

function safeSegment(segment: string, fallback: string): string {
  const cleaned = sanitizeFilename(segment);
  return cleaned === "download.bin" && !/download\.bin/i.test(segment) ? fallback : cleaned;
}

function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) return path;
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let counter = 2; counter < 100_000; counter += 1) {
    const candidate = `${directory}${stem} (${counter})${extension}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Too many files have the same sanitized name.");
}

function validateTarPath(path: string): void {
  const bytes = new TextEncoder().encode(path);
  if (bytes.byteLength <= 100) return;
  const slash = path.lastIndexOf("/");
  if (slash > 0 && new TextEncoder().encode(path.slice(0, slash)).byteLength <= 155 &&
      new TextEncoder().encode(path.slice(slash + 1)).byteLength <= 100) return;
  throw new Error(`A folder path is too long to archive safely: ${path}`);
}

function compactTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("Selection is too large for this browser.");
  return total;
}
