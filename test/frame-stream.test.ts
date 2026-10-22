import { describe, expect, it } from "vitest";
import { streamFixedFrames } from "../src/frontend/frame-stream";

describe("streamFixedFrames", () => {
  it("coalesces browser-sized reads into full 256 KiB frames and a final remainder", async () => {
    const source = Uint8Array.from(
      { length: 256 * 1024 * 2 + 17 },
      (_, index) => index % 251,
    );
    const readSizes = [64 * 1024, 37, 64 * 1024 - 37, 91 * 1024, 165 * 1024, 17];
    let sourceOffset = 0;
    let readIndex = 0;
    const frames: Uint8Array[] = [];

    await streamFixedFrames(
      {
        async read() {
          if (sourceOffset >= source.byteLength) return { done: true, value: undefined };
          const requested = readSizes[readIndex] ?? source.byteLength;
          readIndex += 1;
          const value = source.slice(sourceOffset, Math.min(sourceOffset + requested, source.byteLength));
          sourceOffset += value.byteLength;
          return { done: false, value };
        },
      },
      256 * 1024,
      async (frame) => {
        frames.push(frame.slice());
      },
    );

    expect(frames.map((frame) => frame.byteLength)).toEqual([256 * 1024, 256 * 1024, 17]);
    const received = new Uint8Array(frames.reduce((total, frame) => total + frame.byteLength, 0));
    let receivedOffset = 0;
    for (const frame of frames) {
      received.set(frame, receivedOffset);
      receivedOffset += frame.byteLength;
    }
    expect(received).toEqual(source);
  });

  it("does not emit empty frames", async () => {
    const frames: Uint8Array[] = [];
    let reads = 0;
    await streamFixedFrames(
      {
        async read() {
          reads += 1;
          if (reads === 1) return { done: false, value: new Uint8Array() };
          return { done: true, value: undefined };
        },
      },
      256 * 1024,
      async (frame) => { frames.push(frame); },
    );
    expect(frames).toEqual([]);
  });
});
