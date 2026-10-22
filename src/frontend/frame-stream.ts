interface ByteStreamReader {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
}

/**
 * Coalesces arbitrary File.stream() reads into fixed-size frames while keeping
 * memory bounded to one frame. Only the final frame may be smaller.
 */
export async function streamFixedFrames(
  reader: ByteStreamReader,
  frameSize: number,
  send: (frame: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(frameSize) || frameSize <= 0) {
    throw new RangeError("frameSize must be a positive integer");
  }

  let pending = new Uint8Array(frameSize);
  let pendingBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength === 0) continue;

    let offset = 0;
    while (offset < value.byteLength) {
      const remaining = value.byteLength - offset;

      // Avoid a copy when the browser already supplied one or more full frames.
      if (pendingBytes === 0 && remaining >= frameSize) {
        await send(value.subarray(offset, offset + frameSize));
        offset += frameSize;
        continue;
      }

      const copied = Math.min(frameSize - pendingBytes, remaining);
      pending.set(value.subarray(offset, offset + copied), pendingBytes);
      pendingBytes += copied;
      offset += copied;

      if (pendingBytes === frameSize) {
        await send(pending);
        pending = new Uint8Array(frameSize);
        pendingBytes = 0;
      }
    }
  }

  if (pendingBytes > 0) {
    await send(pending.subarray(0, pendingBytes));
  }
}
