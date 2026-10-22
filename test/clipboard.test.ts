import { describe, expect, it } from "vitest";
import {
  clipboardFilename,
  filesFromPasteData,
  imageFilesFromClipboard,
} from "../src/frontend/clipboard";

describe("clipboard images", () => {
  const now = new Date(2026, 7, 27, 8, 5, 12);

  it("turns clipboard image blobs into timestamped files without reading their bytes", async () => {
    const png = new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" });
    const jpeg = new Blob([Uint8Array.from([4, 5])], { type: "image/jpeg" });
    const files = await imageFilesFromClipboard([
      { types: ["text/plain", "image/png"], getType: async () => png },
      { types: ["image/jpeg"], getType: async () => jpeg },
    ], now);

    expect(files.map(({ name, type, size }) => ({ name, type, size }))).toEqual([
      { name: "screenshot-20260827-080512.png", type: "image/png", size: 3 },
      { name: "screenshot-20260827-080512-2.jpg", type: "image/jpeg", size: 2 },
    ]);
  });

  it("ignores clipboard items that are not images", async () => {
    const files = await imageFilesFromClipboard([
      { types: ["text/plain"], getType: async () => new Blob(["not an image"]) },
    ], now);
    expect(files).toEqual([]);
  });

  it("preserves useful clipboard filenames and replaces generic image names", () => {
    expect(clipboardFilename({ name: "photo from phone.heic", type: "image/heic" }, now))
      .toBe("photo from phone.heic");
    expect(clipboardFilename({ name: "image.png", type: "image/png" }, now))
      .toBe("screenshot-20260827-080512.png");
  });

  it("uses DataTransfer items when iOS leaves the pasted files list empty", () => {
    const image = new File([Uint8Array.from([1, 2, 3])], "photo.jpeg", { type: "image/jpeg" });
    const files = filesFromPasteData({
      files: [],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => image },
      ],
    });
    expect(files).toEqual([image]);
  });
});
