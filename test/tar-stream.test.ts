import { describe, expect, it } from "vitest";
import { curlCommand } from "../src/frontend/transfer-command";
import {
  combineTransferSelections,
  selectionFromFiles,
} from "../src/frontend/transfer-selection";

describe("streaming transfer selections", () => {
  it("keeps a single file on the direct streaming path", async () => {
    const file = new File([Uint8Array.from([1, 2, 3])], "hello.txt", { type: "text/plain" });
    const selection = selectionFromFiles([file]);
    expect(selection).toMatchObject({
      kind: "file",
      displayName: "hello.txt",
      outputFilename: "hello.txt",
      contentType: "text/plain",
      streamBytes: 3,
      sourceBytes: 3,
      fileCount: 1,
    });
    expect(await readStream(selection!.createStream())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("creates an exact, extractable USTAR stream for a folder", async () => {
    const first = new File(["hello"], "hello.txt", { lastModified: 1_700_000_000_000 });
    const secondBytes = Uint8Array.from({ length: 700 }, (_, index) => index % 251);
    const second = new File([secondBytes], "data.bin", { lastModified: 1_700_000_001_000 });
    const selection = selectionFromFiles([first, second], {
      forceArchive: true,
      names: ["project/hello.txt", "project/nested/data.bin"],
    });

    expect(selection).toMatchObject({
      kind: "folder",
      displayName: "project",
      outputFilename: "project.tar",
      contentType: "application/x-tar",
      sourceBytes: 705,
      fileCount: 2,
    });
    const archive = await readStream(selection!.createStream());
    expect(archive.byteLength).toBe(selection!.streamBytes);
    expect(await readStream(selection!.createStream())).toEqual(archive);
    const entries = parseTar(archive);
    expect(entries.map(({ path, type }) => ({ path, type }))).toEqual([
      { path: "project", type: "directory" },
      { path: "project/hello.txt", type: "file" },
      { path: "project/nested", type: "directory" },
      { path: "project/nested/data.bin", type: "file" },
    ]);
    expect(new TextDecoder().decode(entries[1].content)).toBe("hello");
    expect(entries[3].content).toEqual(secondBytes);
    expect(archive.slice(-1_024)).toEqual(new Uint8Array(1_024));
  });

  it("wraps multiple loose files and prevents traversal or duplicate output paths", async () => {
    const one = new File(["one"], "same.txt");
    const two = new File(["two"], "same.txt");
    const selection = selectionFromFiles([one, two], {
      names: ["../../../same.txt", "same.txt"],
      now: new Date(2026, 7, 26, 12, 34, 56),
    });
    const entries = parseTar(await readStream(selection!.createStream()));
    const paths = entries.map((entry) => entry.path);
    expect(paths.every((path) => !path.startsWith("/") && !path.split("/").includes(".."))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => path.startsWith("termdrop-files-20260826-123456"))).toBe(true);
  });

  it("combines sequential selections into one flat streamed archive", async () => {
    const initial = selectionFromFiles([
      new File(["one"], "one.txt"),
      new File(["two"], "two.txt"),
    ], { now: new Date(2026, 7, 26, 12, 0, 0) })!;
    const added = selectionFromFiles([new File(["three"], "three.txt")])!;
    const combined = combineTransferSelections(
      initial,
      added,
      new Date(2026, 7, 26, 12, 34, 56),
    );

    expect(combined).toMatchObject({
      kind: "files",
      displayName: "3 files",
      outputFilename: "termdrop-files-20260826-123456.tar",
      sourceBytes: 11,
      fileCount: 3,
    });
    expect(parseTar(await readStream(combined.createStream())).map((entry) => entry.path)).toEqual([
      "termdrop-files-20260826-123456",
      "termdrop-files-20260826-123456/one.txt",
      "termdrop-files-20260826-123456/two.txt",
      "termdrop-files-20260826-123456/three.txt",
    ]);
  });

  it("uses the USTAR prefix field for long nested paths and rejects unrepresentable ones", async () => {
    const directory = `project/${"a".repeat(80)}`;
    const filename = `${"b".repeat(40)}.txt`;
    const selection = selectionFromFiles([new File(["long"], filename)], {
      forceArchive: true,
      names: [`${directory}/${filename}`],
    });
    expect(parseTar(await readStream(selection!.createStream())).at(-1)?.path).toBe(`${directory}/${filename}`);

    expect(() => selectionFromFiles([new File(["x"], "x.txt")], {
      forceArchive: true,
      names: [`root/${"nested/".repeat(30)}x.txt`],
    })).toThrow(/path is too long/i);
  });
});

describe("generated shell commands", () => {
  it("extracts streamed folders without overwriting existing files", () => {
    const selection = selectionFromFiles([new File(["x"], "x.txt")], {
      forceArchive: true,
      names: ["folder/x.txt"],
    })!;
    expect(curlCommand({
      id: "A".repeat(24),
      senderSecret: "secret",
      downloadUrl: "https://termdrop.sh/d/example",
      outputFilename: "folder.tar",
      expiresAt: new Date().toISOString(),
    }, selection)).toBe('curl -fL "https://termdrop.sh/d/example" | tar -xk');
  });
});

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseTar(bytes: Uint8Array): Array<{ path: string; type: "file" | "directory"; content: Uint8Array }> {
  const entries: Array<{ path: string; type: "file" | "directory"; content: Uint8Array }> = [];
  for (let offset = 0; offset + 512 <= bytes.byteLength;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarText(header.subarray(0, 100));
    const prefix = readTarText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarText(header.subarray(124, 136)).trim() || "0", 8);
    const checksum = Number.parseInt(readTarText(header.subarray(148, 154)).trim(), 8);
    const checksumHeader = header.slice();
    checksumHeader.fill(0x20, 148, 156);
    expect(checksumHeader.reduce((total, byte) => total + byte, 0)).toBe(checksum);
    const contentStart = offset + 512;
    entries.push({
      path: path.replace(/\/$/, ""),
      type: header[156] === 0x35 ? "directory" : "file",
      content: bytes.slice(contentStart, contentStart + size),
    });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
}
