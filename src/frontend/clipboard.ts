export interface ReadableClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

interface PasteData {
  readonly files: ArrayLike<File>;
  readonly items: ArrayLike<Pick<DataTransferItem, "kind" | "getAsFile">>;
}

export function filesFromPasteData(data: PasteData | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files);
  if (files.length > 0) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export async function imageFilesFromClipboard(
  items: readonly ReadableClipboardItem[],
  now = new Date(),
): Promise<File[]> {
  const files: File[] = [];
  for (const item of items) {
    const type = preferredImageType(item.types);
    if (!type) continue;
    const blob = await item.getType(type);
    const mimeType = blob.type.startsWith("image/") ? blob.type : type;
    files.push(new File([blob], screenshotFilename(mimeType, now, files.length), {
      type: mimeType,
      lastModified: now.getTime(),
    }));
  }
  return files;
}

export function clipboardFilename(file: Pick<File, "name" | "type">, now = new Date()): string {
  if (file.name && !/^image\.(png|jpe?g|webp)$/i.test(file.name)) return file.name;
  return screenshotFilename(file.type || "image/png", now);
}

function preferredImageType(types: readonly string[]): string | null {
  return types.find((type) => type.toLowerCase() === "image/png")
    ?? types.find((type) => type.toLowerCase().startsWith("image/"))
    ?? null;
}

function screenshotFilename(mimeType: string, now: Date, index = 0): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const subtype = mimeType.split("/")[1]?.split(/[;+]/)[0]?.toLowerCase() || "png";
  const extension = subtype === "jpeg" ? "jpg" : subtype === "svg+xml" ? "svg" : subtype;
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `screenshot-${stamp}${suffix}.${extension}`;
}
