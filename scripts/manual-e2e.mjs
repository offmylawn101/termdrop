#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const options = parseArguments(process.argv.slice(2));
const sourcePath = resolve(options.file ?? "test/fixtures/hello.txt");
await access(sourcePath);
const sourceStat = await stat(sourcePath);
if (!sourceStat.isFile()) throw new Error(`${sourcePath} is not a regular file.`);

const sessionResponse = await fetch(`${options.base}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    filename: basename(sourcePath),
    size: sourceStat.size,
    contentType: "application/octet-stream",
  }),
});
const session = await sessionResponse.json();
if (!sessionResponse.ok) throw new Error(session.error ?? `Session creation failed: ${sessionResponse.status}`);

const websocketUrl = new URL(session.downloadUrl);
websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
websocketUrl.pathname = `/api/session/${session.id}/sender`;
const socket = new WebSocket(websocketUrl, ["termdrop.v1", `termdrop.auth.${session.senderSecret}`]);

const pendingAcks = [];
let curlPromise;
let destination;
let senderStarted = false;
let completed;
const completion = new Promise((resolveCompletion, rejectCompletion) => {
  completed = { resolve: resolveCompletion, reject: rejectCompletion };
});

socket.addEventListener("message", async (event) => {
  if (typeof event.data !== "string") return;
  const message = JSON.parse(event.data);
  if (message.type === "sender_connected") {
    const command = `curl -fL ${quote(session.downloadUrl)} -o ${quote(session.outputFilename)}`;
    if (options.auto) {
      const directory = await mkdtemp(join(tmpdir(), "termdrop-e2e-"));
      destination = join(directory, session.outputFilename);
      console.log(`Running curl receiver: ${destination}`);
      curlPromise = runCurl(session.downloadUrl, destination);
    } else {
      console.log("Paste this command in another terminal:");
      console.log(command);
    }
  } else if (message.type === "receiver_connected" && !senderStarted) {
    senderStarted = true;
    void streamSource();
  } else if (message.type === "chunk_accepted") {
    pendingAcks.shift()?.resolve();
    process.stdout.write(`\rRelayed ${message.bytes} / ${sourceStat.size} bytes`);
  } else if (message.type === "completed") {
    for (const pending of pendingAcks.splice(0)) pending.resolve();
    completed.resolve(message);
  } else if (message.type === "cancelled" || message.type === "failed" || message.type === "expired") {
    const reason = message.reason ?? "Session expired";
    for (const pending of pendingAcks.splice(0)) pending.reject(new Error(reason));
    completed.reject(new Error(reason));
  }
});

socket.addEventListener("error", () => completed.reject(new Error("WebSocket connection failed.")));
socket.addEventListener("close", () => {
  if (!senderStarted) completed.reject(new Error("WebSocket closed before the receiver connected."));
});

const result = await completion;
console.log(`\nRelay completed in ${result.durationMs} ms.`);
if (curlPromise) {
  await curlPromise;
  const [sourceHash, destinationHash] = await Promise.all([sha256File(sourcePath), sha256File(destination)]);
  if (sourceHash !== destinationHash) throw new Error("SHA-256 mismatch after curl completed.");
  console.log(`SHA-256 verified: ${sourceHash}`);
  console.log(`Received file: ${destination}`);
  const reused = await fetch(session.downloadUrl);
  if (reused.status !== 410) throw new Error(`Expected reused URL to return 410, received ${reused.status}.`);
  console.log("One-time URL verified: second request returned HTTP 410.");
}
socket.close(1000, "Done");

async function streamSource() {
  try {
    for await (const chunk of createReadStream(sourcePath, { highWaterMark: 256 * 1024 })) {
      const pending = deferred();
      pendingAcks.push(pending);
      socket.send(chunk);
      if (pendingAcks.length >= 8) await pendingAcks[0].promise;
    }
    while (pendingAcks.length > 0) {
      await pendingAcks[0].promise;
    }
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "file_error", message: error.message }));
    }
    completed.reject(error);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function runCurl(url, output) {
  return new Promise((resolveCurl, rejectCurl) => {
    const child = spawn("curl", ["--fail", "--location", "--show-error", "--remove-on-error", url, "--output", output], {
      stdio: "inherit",
    });
    child.once("error", rejectCurl);
    child.once("exit", (code) => {
      if (code === 0) resolveCurl();
      else rejectCurl(new Error(`curl exited with status ${code}`));
    });
  });
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
    input.resume();
  });
}

function quote(value) {
  return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
}

function parseArguments(arguments_) {
  const parsed = { base: "http://localhost:8787", file: undefined, auto: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--base") parsed.base = arguments_[++index].replace(/\/$/, "");
    else if (arguments_[index] === "--file") parsed.file = arguments_[++index];
    else if (arguments_[index] === "--auto") parsed.auto = true;
    else throw new Error(`Unknown argument: ${arguments_[index]}`);
  }
  return parsed;
}
