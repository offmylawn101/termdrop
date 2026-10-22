import { env as runtimeEnv, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { selectionFromFiles } from "../src/frontend/transfer-selection";
import {
  SENDER_AUTH_PREFIX,
  SENDER_PROTOCOL,
  type CreateSessionResponse,
  type ServerMessage,
} from "../src/shared/protocol";

const env = runtimeEnv as unknown as Env;
const origin = "https://example.test";
let clientNumber = 1;

describe("TermDrop Worker and Durable Object relay", () => {
  it("counts completed bytes once in the public aggregate", async () => {
    const beforeResponse = await exports.default.fetch(`${origin}/api/stats`);
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json<{ totalBytes: number }>();

    const source = new Uint8Array([9, 8, 7, 6, 5]);
    const session = await createSession("counted.bin", source.byteLength);
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const response = await exports.default.fetch(session.downloadUrl);
    const received = response.arrayBuffer();
    await sender.next("receiver_connected");
    sender.socket.send(source);
    await sender.next("chunk_accepted");
    await sender.next("completed");
    await received;

    const after = await (await exports.default.fetch(`${origin}/api/stats`))
      .json<{ totalBytes: number }>();
    expect(after.totalBytes - before.totalBytes).toBe(source.byteLength);

    const stats = env.TRANSFER_STATS.getByName("global");
    const duplicate = await stats.fetch("https://stats.internal/record", {
      method: "POST",
      body: JSON.stringify({ sessionTag: await sessionTag(session.id), bytes: source.byteLength }),
    });
    expect(await duplicate.json()).toMatchObject({ ok: true, counted: false });
    const unchanged = await (await exports.default.fetch(`${origin}/api/stats`))
      .json<{ totalBytes: number }>();
    expect(unchanged.totalBytes).toBe(after.totalBytes);
  });

  it("creates a cryptographically separated session", async () => {
    const session = await createSession("photo.png", 123, "image/png");
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(session.senderSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.senderSecret).not.toContain(session.id);
    expect(session.downloadUrl).toBe(`${origin}/d/${session.id}`);
    expect(session.outputFilename).toBe("photo.png");
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("streams exact bytes with Content-Length and makes the URL one-time", async () => {
    const source = new TextEncoder().encode("known bytes: \u0000\u0001\u00ff");
    const session = await createSession("known.bin", source.byteLength);
    const sender = await connectSender(session);
    await sender.next("sender_connected");

    const response = await exports.default.fetch(session.downloadUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(source.byteLength));
    expect(response.headers.get("Content-Disposition")).toContain("known.bin");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
    const received = response.arrayBuffer();
    await sender.next("receiver_connected");

    sender.socket.send(source);
    const accepted = await sender.next("chunk_accepted");
    expect(accepted.type === "chunk_accepted" && accepted.bytes).toBe(source.byteLength);
    await sender.next("completed");
    expect(new Uint8Array(await received)).toEqual(source);

    const reused = await exports.default.fetch(session.downloadUrl);
    expect(reused.status).toBe(410);
  });

  it("relays a generated folder archive with exact length and byte order", async () => {
    const selection = selectionFromFiles([
      new File(["alpha"], "alpha.txt"),
      new File([Uint8Array.from([0, 1, 2, 3])], "beta.bin"),
    ], {
      forceArchive: true,
      names: ["sample/alpha.txt", "sample/nested/beta.bin"],
    })!;
    const expected = await readByteStream(selection.createStream());
    const session = await createSession(
      selection.outputFilename,
      selection.streamBytes,
      selection.contentType,
    );
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const response = await exports.default.fetch(session.downloadUrl);
    expect(response.headers.get("Content-Length")).toBe(String(selection.streamBytes));
    expect(response.headers.get("Content-Type")).toBe("application/x-tar");
    const received = response.arrayBuffer();
    await sender.next("receiver_connected");

    for await (const chunk of selection.createStream()) {
      sender.socket.send(chunk);
      await sender.next("chunk_accepted");
    }
    await sender.next("completed");
    expect(new Uint8Array(await received)).toEqual(expected);
  });

  it("pipelines a bounded window of chunks without changing byte order", async () => {
    const chunks = Array.from({ length: 8 }, (_, chunkIndex) =>
      Uint8Array.from({ length: 1_024 }, (_, byteIndex) => (chunkIndex * 31 + byteIndex) % 256)
    );
    const expected = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      expected.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const session = await createSession("pipeline.bin", expected.byteLength);
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const response = await exports.default.fetch(session.downloadUrl);
    const received = response.arrayBuffer();
    await sender.next("receiver_connected");

    for (const chunk of chunks) sender.socket.send(chunk);
    for (let index = 0; index < chunks.length; index += 1) {
      const accepted = await sender.next("chunk_accepted");
      expect(accepted.bytes).toBe((index + 1) * chunks[index].byteLength);
    }
    await sender.next("completed");
    expect(new Uint8Array(await received)).toEqual(expected);
  });

  it("rejects a duplicate receiver without disturbing the first", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const session = await createSession("one.bin", source.byteLength);
    const sender = await connectSender(session);
    await sender.next("sender_connected");

    const first = await exports.default.fetch(session.downloadUrl);
    const firstBody = first.arrayBuffer();
    await sender.next("receiver_connected");
    const duplicate = await exports.default.fetch(session.downloadUrl);
    expect(duplicate.status).toBe(409);

    sender.socket.send(source);
    await sender.next("chunk_accepted");
    await sender.next("completed");
    expect(new Uint8Array(await firstBody)).toEqual(source);
  });

  it("rejects nonexistent and invalidly-authenticated sessions", async () => {
    expect((await exports.default.fetch(`${origin}/d/${"A".repeat(24)}`)).status).toBe(404);
    expect((await exports.default.fetch(`${origin}/d/not-valid`)).status).toBe(404);

    const session = await createSession("secret.bin", 1);
    const changedFirstCharacter = session.senderSecret[0] === "A" ? "B" : "A";
    const response = await websocketResponse(session, `${changedFirstCharacter}${session.senderSecret.slice(1)}`);
    expect(response.status).toBe(401);
  });

  it("rejects duplicate senders", async () => {
    const session = await createSession("sender.bin", 1);
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const duplicate = await websocketResponse(session, session.senderSecret);
    expect(duplicate.status).toBe(409);
    sender.socket.close(1000, "done");
  });

  it("invalidates the session when the sender disconnects while waiting", async () => {
    const session = await createSession("gone.bin", 8);
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    sender.socket.close(1000, "leaving");
    await waitFor(async () => (await status(session.id)).state === "CANCELLED");
    expect((await exports.default.fetch(session.downloadUrl)).status).toBe(410);
  });

  it("notifies the sender when the receiver disconnects", async () => {
    const session = await createSession("cancel.bin", 100);
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const response = await exports.default.fetch(session.downloadUrl);
    await sender.next("receiver_connected");
    await response.body?.cancel("test receiver closed");
    // The fixed-length writer observes downstream cancellation on its next write.
    sender.socket.send(new Uint8Array([1]));
    const cancelled = await sender.nextAny(["cancelled", "failed"]);
    expect(["cancelled", "failed"]).toContain(cancelled.type);
    expect((await status(session.id)).state).toBe("CANCELLED");
  });

  it("aborts the fixed-length curl body when the sender disconnects mid-transfer", async () => {
    const session = await createSession("partial.bin", 10);
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const response = await exports.default.fetch(session.downloadUrl);
    const body = response.arrayBuffer();
    await sender.next("receiver_connected");
    sender.socket.send(new Uint8Array([1, 2, 3]));
    await sender.next("chunk_accepted");
    sender.socket.close(1000, "browser closed");
    await expect(body).rejects.toThrow();
    await waitFor(async () => (await status(session.id)).state === "FAILED");
  });

  it("transfers a zero-byte file without waiting for a chunk", async () => {
    const session = await createSession("empty.txt", 0, "text/plain");
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    const response = await exports.default.fetch(session.downloadUrl);
    expect(response.headers.get("Content-Length")).toBe("0");
    await sender.next("receiver_connected");
    await sender.next("completed");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("returns 410 for an expired session", async () => {
    const id = "E".repeat(24);
    const stub = env.TRANSFER_SESSIONS.getByName(id);
    await stub.fetch("https://session.internal/init", {
      method: "POST",
      body: JSON.stringify({
        senderSecretHash: "x".repeat(43),
        outputFilename: "expired.bin",
        contentType: "application/octet-stream",
        expectedBytes: 1,
        createdAt: Date.now() - 2_000,
        expiresAt: Date.now() - 1_000,
        quotaKey: "expired-ip",
        quotaSessionId: "expired-session",
        sessionTag: "expired",
      }),
    });
    expect((await exports.default.fetch(`${origin}/d/${id}`)).status).toBe(410);
  });

  it("rejects oversized files and unsafe request variants", async () => {
    const oversized = await exports.default.fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "huge.bin", size: 5 * 1024 ** 3 + 1 }),
    });
    expect(oversized.status).toBe(413);

    const session = await createSession("range.bin", 1);
    expect((await exports.default.fetch(session.downloadUrl, { method: "HEAD" })).status).toBe(405);
    expect((await exports.default.fetch(session.downloadUrl, { headers: { Range: "bytes=0-0" } })).status).toBe(416);
  });

  it("bounds chunked session metadata without relying on Content-Length", async () => {
    const oversizedMetadata = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"filename":"${"x".repeat(9_000)}","size":1}`));
        controller.close();
      },
    });
    const response = await exports.default.fetch(new Request(`${origin}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: oversizedMetadata,
    }));
    expect(response.status).toBe(413);
  });

  it("keeps concurrent sessions isolated", async () => {
    const [a, b] = await Promise.all([
      createSession("a.bin", 3),
      createSession("b.bin", 4),
    ]);
    const [senderA, senderB] = await Promise.all([connectSender(a), connectSender(b)]);
    await Promise.all([senderA.next("sender_connected"), senderB.next("sender_connected")]);
    const [responseA, responseB] = await Promise.all([
      exports.default.fetch(a.downloadUrl),
      exports.default.fetch(b.downloadUrl),
    ]);
    const bodyA = responseA.arrayBuffer();
    const bodyB = responseB.arrayBuffer();
    await Promise.all([senderA.next("receiver_connected"), senderB.next("receiver_connected")]);

    senderA.socket.send(new Uint8Array([1, 1, 1]));
    senderB.socket.send(new Uint8Array([2, 2, 2, 2]));
    await Promise.all([
      senderA.next("chunk_accepted"), senderB.next("chunk_accepted"),
      senderA.next("completed"), senderB.next("completed"),
    ]);
    expect(new Uint8Array(await bodyA)).toEqual(new Uint8Array([1, 1, 1]));
    expect(new Uint8Array(await bodyB)).toEqual(new Uint8Array([2, 2, 2, 2]));
  });

  it("persists state transitions and metadata only, never chunks", async () => {
    const source = new TextEncoder().encode("TOP SECRET PAYLOAD");
    const session = await createSession("../../secret.txt", source.byteLength, "text/plain");
    expect(session.outputFilename).toBe("secret.txt");
    const sender = await connectSender(session);
    await sender.next("sender_connected");
    expect((await status(session.id)).state).toBe("WAITING_FOR_RECEIVER");

    const response = await exports.default.fetch(session.downloadUrl);
    const body = response.arrayBuffer();
    await sender.next("receiver_connected");
    expect((await status(session.id)).state).toBe("RECEIVER_CONNECTED");

    sender.socket.send(source.subarray(0, 4));
    await sender.next("chunk_accepted");
    expect((await status(session.id)).state).toBe("TRANSFERRING");
    sender.socket.send(source.subarray(4));
    await sender.next("chunk_accepted");
    await sender.next("completed");
    expect(new TextDecoder().decode(await body)).toBe("TOP SECRET PAYLOAD");
    expect((await status(session.id)).state).toBe("COMPLETED");

    const stub = env.TRANSFER_SESSIONS.getByName(session.id);
    const stored = await runInDurableObject(stub, async (_instance, state) => state.storage.get("session"));
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("TOP SECRET PAYLOAD");
    expect(serialized).not.toContain("ArrayBuffer");
    expect(serialized).not.toContain("chunk");
    expect(serialized).not.toContain("../../secret.txt");
  });
});

async function createSession(
  filename: string,
  size: number,
  contentType = "application/octet-stream",
): Promise<CreateSessionResponse> {
  const response = await exports.default.fetch(`${origin}/api/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": `192.0.2.${clientNumber++}`,
    },
    body: JSON.stringify({ filename, size, contentType }),
  });
  expect(response.status).toBe(201);
  return response.json<CreateSessionResponse>();
}

async function websocketResponse(session: CreateSessionResponse, secret: string): Promise<Response> {
  const request = new Request(`${origin}/api/session/${session.id}/sender`, {
    headers: {
      Upgrade: "websocket",
      Origin: origin,
      "Sec-WebSocket-Protocol": `${SENDER_PROTOCOL}, ${SENDER_AUTH_PREFIX}${secret}`,
    },
  });
  return exports.default.fetch(request);
}

async function connectSender(session: CreateSessionResponse): Promise<MessageInbox> {
  const response = await websocketResponse(session, session.senderSecret);
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const inbox = new MessageInbox(response.webSocket!);
  response.webSocket!.accept();
  return inbox;
}

async function status(id: string): Promise<{ state: string; bytesTransferred: number }> {
  const response = await env.TRANSFER_SESSIONS.getByName(id).fetch("https://session.internal/status");
  return response.json();
}

class MessageInbox {
  readonly socket: WebSocket;
  private messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      this.messages.push(JSON.parse(event.data) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  next<T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    return this.nextAny([type]) as Promise<Extract<ServerMessage, { type: T }>>;
  }

  async nextAny(types: ServerMessage["type"][]): Promise<ServerMessage> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((message) => types.includes(message.type));
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(`Timed out waiting for ${types.join(" or ")}. Received: ${this.messages.map((m) => m.type).join(", ")}`);
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function sessionTag(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 12);
}

async function readByteStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
