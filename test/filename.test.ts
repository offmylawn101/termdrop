import { describe, expect, it } from "vitest";
import { safeContentType, sanitizeFilename, shellDoubleQuote } from "../src/shared/filename";

describe("filename safety", () => {
  it("removes paths, traversal, controls, and shell metacharacters", () => {
    expect(sanitizeFilename("../../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\evil$(touch /tmp/x).txt\u0000")).toBe("x_.txt");
    expect(sanitizeFilename("...")).toBe("download.bin");
  });

  it("preserves useful extensions while bounding length", () => {
    const result = sanitizeFilename(`${"a".repeat(300)}.tar.gz`);
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith(".gz")).toBe(true);
  });

  it("quotes every POSIX double-quote expansion character", () => {
    expect(shellDoubleQuote("a $HOME `id` \\ \" b")).toBe("\"a \\$HOME \\`id\\` \\\\ \\\" b\"");
  });

  it("rejects malformed content types", () => {
    expect(safeContentType("image/png")).toBe("image/png");
    expect(safeContentType("text/plain\r\nX-Bad: yes")).toBe("application/octet-stream");
  });
});
