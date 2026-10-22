#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const baseUrl = option("--base") ?? "http://127.0.0.1:8787";
const chromePath = await findChrome();
const workDirectory = await mkdtemp(join(tmpdir(), "termdrop-browser-e2e-"));
const debugPort = await availablePort();
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${join(workDirectory, "chrome-profile")}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeErrors = "";
chrome.stderr.on("data", (chunk) => { chromeErrors += chunk; });
const pages = [];

try {
  await waitForChrome(debugPort);
  const firstSource = join(workDirectory, "first-a.txt");
  const addedSource = join(workDirectory, "first-b.txt");
  const secondSource = join(workDirectory, "second.txt");
  const firstOutput = join(workDirectory, "first.tar");
  const secondOutput = join(workDirectory, "second.out");
  await Promise.all([
    writeFile(firstSource, "first background transfer\n".repeat(1_024)),
    writeFile(addedSource, "added without a refresh\n".repeat(1_536)),
    writeFile(secondSource, "second independent transfer\n".repeat(2_048)),
  ]);

  const [first, second] = await Promise.all([
    createTransferPage(debugPort, firstSource),
    createTransferPage(debugPort, secondSource),
  ]);
  pages.push(first, second);
  await verifyAddFilesPanel(first);

  const supersededUrl = first.downloadUrl;
  await addFileToPage(first, addedSource);
  const superseded = await fetch(supersededUrl, { signal: AbortSignal.timeout(5_000) });
  if (superseded.status !== 410) {
    throw new Error(`The superseded curl URL returned ${superseded.status} instead of 410.`);
  }

  // Chrome's frozen lifecycle reproduces the production failure more strongly
  // than merely activating another tab. The SharedWorker must keep both senders
  // alive even while neither owning document can run JavaScript callbacks.
  await Promise.all([
    first.call("Page.setWebLifecycleState", { state: "frozen" }),
    second.call("Page.setWebLifecycleState", { state: "frozen" }),
  ]);
  await Promise.all([
    runCurl(first.downloadUrl, firstOutput),
    runCurl(second.downloadUrl, secondOutput),
  ]);

  const [firstExpected, addedExpected, secondExpected, secondActual] = await Promise.all([
    readFile(firstSource, "utf8"),
    readFile(addedSource, "utf8"),
    readFile(secondSource),
    readFile(secondOutput),
  ]);
  const { stdout: listing } = await execFileAsync("tar", ["-tf", firstOutput]);
  const firstPath = listing.split("\n").find((path) => path.endsWith("/first-a.txt"));
  const addedPath = listing.split("\n").find((path) => path.endsWith("/first-b.txt"));
  if (!firstPath || !addedPath) throw new Error("The sequential files were not both present in the TAR stream.");
  const [{ stdout: firstActual }, { stdout: addedActual }] = await Promise.all([
    execFileAsync("tar", ["-xOf", firstOutput, firstPath], { encoding: "utf8", maxBuffer: 2_000_000 }),
    execFileAsync("tar", ["-xOf", firstOutput, addedPath], { encoding: "utf8", maxBuffer: 2_000_000 }),
  ]);
  if (firstExpected !== firstActual || addedExpected !== addedActual || !secondExpected.equals(secondActual)) {
    throw new Error("A background transfer did not preserve the exact source bytes.");
  }

  console.log(`Sequential additions and two frozen-tab transfers completed concurrently through ${baseUrl}.`);
} finally {
  for (const page of pages) page.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => chrome.once("close", resolve));
  await rm(workDirectory, { recursive: true, force: true });
}

async function createTransferPage(port, sourcePath) {
  const target = await fetchJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await Promise.all([
    cdp.call("Page.enable"),
    cdp.call("Runtime.enable"),
    cdp.call("DOM.enable"),
  ]);
  await cdp.call("Page.navigate", { url: `${baseUrl.replace(/\/$/, "")}/` });
  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: 'document.readyState === "complete" && document.querySelector("input[type=file]") !== null',
    });
    return result.result.value === true;
  }, "TermDrop did not become ready in Chrome.");

  const document = await cdp.call("DOM.getDocument");
  const input = await cdp.call("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "input[type=file]",
  });
  if (!input.nodeId) throw new Error("TermDrop's file input was not found.");
  await cdp.call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [sourcePath] });

  let command = "";
  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: 'document.querySelector(".command-section code")?.textContent || document.querySelector(".error-copy")?.textContent || ""',
    });
    command = result.result.value ?? "";
    return command.length > 0;
  }, "TermDrop did not create a curl command.");
  if (!command.startsWith("curl ")) throw new Error(`TermDrop reported: ${command}`);
  const downloadUrl = command.match(/https?:[^" ]+/)?.[0];
  if (!downloadUrl) throw new Error(`Could not read the download URL from: ${command}`);
  return { ...cdp, downloadUrl };
}

async function addFileToPage(page, sourcePath) {
  const previousUrl = page.downloadUrl;
  const document = await page.call("DOM.getDocument");
  const input = await page.call("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "input[type=file]",
  });
  if (!input.nodeId) throw new Error("TermDrop's add-files input was not found.");
  await page.call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [sourcePath] });
  await waitFor(async () => {
    const result = await page.call("Runtime.evaluate", {
      expression: 'document.querySelector(".command-section code")?.textContent || document.querySelector(".error-copy")?.textContent || ""',
    });
    const command = result.result.value ?? "";
    const nextUrl = command.match(/https?:[^" ]+/)?.[0];
    if (!nextUrl || nextUrl === previousUrl) return false;
    page.downloadUrl = nextUrl;
    return true;
  }, "TermDrop did not replace the curl command after another file was added.");
}

async function verifyAddFilesPanel(page) {
  const result = await page.call("Runtime.evaluate", {
    expression: `(() => {
      const panel = document.querySelector(".add-files-note");
      const input = document.querySelector("input[type=file]");
      const paste = panel?.querySelector(".paste-picker");
      if (!(panel instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return null;
      let browseTriggered = false;
      const originalClick = input.click;
      input.click = () => { browseTriggered = true; };
      panel.click();
      input.click = originalClick;
      return {
        browseTriggered,
        hasAddFilesButton: Array.from(panel.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Add files"),
        pasteUsesHomepageStyle: paste instanceof HTMLButtonElement,
      };
    })()`,
    returnByValue: true,
  });
  const check = result.result.value;
  if (!check?.browseTriggered || check.hasAddFilesButton || !check.pasteUsesHomepageStyle) {
    throw new Error("The Sending More panel does not match the homepage-style interaction.");
  }
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let requestId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function runCurl(url, outputPath) {
  const curl = spawn("curl", [
    "--http1.1",
    "-fsSL",
    "--max-time", "30",
    url,
    "-o", outputPath,
  ], { stdio: "inherit" });
  return new Promise((resolve, reject) => {
    curl.once("error", reject);
    curl.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl exited with status ${code}.`));
    });
  });
}

async function waitForChrome(port) {
  await waitFor(async () => {
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited before startup.\n${chromeErrors.slice(-2_000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, "Chrome's debugging endpoint did not start.");
}

async function waitFor(check, errorMessage, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(errorMessage);
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional browser path.
    }
  }
  throw new Error("Set CHROME_BIN to a Chrome or Chromium executable.");
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local debugging port."));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  return response.json();
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
