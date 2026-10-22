import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clipboardFilename, filesFromPasteData, imageFilesFromClipboard } from "./clipboard";
import { TakeoverAd } from "./takeover-ad";
import { curlCommand } from "./transfer-command";
import {
  createTransferWorkerClient,
  type TransferWorkerClient,
} from "./transfer-worker-client";
import { useScreenWakeLock } from "./use-screen-wake-lock";
import {
  combineTransferSelections,
  selectionFromDrop,
  selectionFromFiles,
  type TransferSelection,
} from "./transfer-selection";
import type { CreateSessionResponse } from "../shared/protocol";

type Phase =
  | "idle"
  | "creating"
  | "connecting"
  | "waiting"
  | "transferring"
  | "complete"
  | "error";

interface Progress {
  bytes: number;
  speed: number;
  elapsedMs: number;
}

const initialProgress: Progress = { bytes: 0, speed: 0, elapsedMs: 0 };
const MAX_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024;
const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// OpenPanel (panel.offmylawn.com/a.js) events per transfer phase. Call op directly: compilers
// turn `op?.()` into `op.call()`, which the SDK's Proxy doesn't support.
const PHASE_EVENTS: Partial<Record<Phase, string>> = {
  creating: "transfer_start",
  complete: "transfer_complete",
  error: "transfer_error",
};

function track(name: string) {
  const op = (window as { op?: (...args: unknown[]) => void }).op;
  try {
    if (typeof op === "function") op("track", name);
  } catch {
    // Analytics must never break a transfer.
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  useEffect(() => {
    const event = PHASE_EVENTS[phase];
    if (event) track(event);
  }, [phase]);
  const [selection, setSelection] = useState<TransferSelection | null>(null);
  const [session, setSession] = useState<CreateSessionResponse | null>(null);
  const [progress, setProgress] = useState<Progress>(initialProgress);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pasteNotice, setPasteNotice] = useState("");
  const [showNativePaste, setShowNativePaste] = useState(false);
  const [totalStreamedBytes, setTotalStreamedBytes] = useState<number | null>(null);

  const senderWorkerRef = useRef<TransferWorkerClient | null>(null);
  const phaseRef = useRef<Phase>(phase);
  const selectionRef = useRef<TransferSelection | null>(selection);
  const sessionRef = useRef<CreateSessionResponse | null>(session);
  const sampleRef = useRef<Array<{ at: number; bytes: number }>>([]);
  const startedAtRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useScreenWakeLock(!["idle", "complete", "error"].includes(phase));

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const fail = useCallback((message: string) => {
    phaseRef.current = "error";
    setError(message);
    setPhase("error");
  }, []);

  const updateProgress = useCallback((bytes: number) => {
    const now = performance.now();
    const samples = sampleRef.current;
    samples.push({ at: now, bytes });
    while (samples.length > 1 && samples[0].at < now - 4_000) samples.shift();
    const first = samples[0];
    const seconds = Math.max((now - first.at) / 1_000, 0.001);
    const speed = samples.length > 1 ? (bytes - first.bytes) / seconds : 0;
    setProgress({ bytes, speed, elapsedMs: now - startedAtRef.current });
  }, []);

  const refreshTotalStreamed = useCallback(() => {
    void fetchTotalStreamed().then((bytes) => {
      if (bytes !== null) setTotalStreamedBytes(bytes);
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    void fetchTotalStreamed().then((bytes) => {
      if (mounted && bytes !== null) setTotalStreamedBytes(bytes);
    });
    return () => { mounted = false; };
  }, []);

  const connectSender = useCallback((selected: TransferSelection, created: CreateSessionResponse) => {
    senderWorkerRef.current?.close();
    const client = createTransferWorkerClient((event) => {
      if (event.sessionId !== sessionRef.current?.id) return;
      if (event.type === "client_error") {
        fail(event.reason);
        return;
      }

      const message = event.message;
      switch (message.type) {
        case "sender_connected":
          phaseRef.current = "waiting";
          setPhase("waiting");
          break;
        case "receiver_connected":
          startedAtRef.current = performance.now();
          sampleRef.current = [{ at: startedAtRef.current, bytes: 0 }];
          phaseRef.current = "transferring";
          setPhase("transferring");
          break;
        case "transfer_started":
          phaseRef.current = "transferring";
          setPhase("transferring");
          break;
        case "chunk_accepted":
          updateProgress(message.bytes);
          break;
        case "completed":
          updateProgress(message.bytes);
          phaseRef.current = "complete";
          setPhase("complete");
          void refreshTotalStreamed();
          break;
        case "cancelled":
        case "failed":
          fail(message.reason);
          break;
        case "expired":
          fail("Session expired. Create a new transfer.");
          break;
      }
    });
    senderWorkerRef.current = client;
    client.start(created, selected.source);
  }, [fail, refreshTotalStreamed, updateProgress]);

  const startLiveTransfer = useCallback(async (selected: TransferSelection) => {
    if (phaseRef.current !== "idle" && phaseRef.current !== "waiting") return;
    const previousSession = sessionRef.current;
    if (previousSession) senderWorkerRef.current?.cancel(previousSession.id);
    sessionRef.current = null;
    setSession(null);
    setPhase("creating");
    phaseRef.current = "creating";
    setError("");
    setCopied(false);
    setProgress(initialProgress);

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: selected.outputFilename,
          size: selected.streamBytes,
          contentType: selected.contentType,
        }),
      });
      const body = await response.json() as CreateSessionResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || `Session creation failed (${response.status}).`);
      sessionRef.current = body;
      setSession(body);
      phaseRef.current = "connecting";
      setPhase("connecting");
      void autoCopyCommand(curlCommand(body, selected)).then((didCopy) => {
        if (!didCopy) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
      });
      connectSender(selected, body);
    } catch (reason) {
      fail(reason instanceof Error && reason.name === "TimeoutError"
        ? "Creating the transfer took too long. Check your connection and try again."
        : reason instanceof Error ? reason.message : "Could not create a transfer session.");
    }
  }, [connectSender, fail]);

  const chooseSelection = useCallback((selected: TransferSelection | null) => {
    if (!selected || (phaseRef.current !== "idle" && phaseRef.current !== "waiting")) return;
    const nextSelection = phaseRef.current === "waiting" && selectionRef.current
      ? combineTransferSelections(selectionRef.current, selected)
      : selected;
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    setError("");
    setPasteNotice("");
    setShowNativePaste(false);
    setCopied(false);
    setProgress(initialProgress);
    void startLiveTransfer(nextSelection);
  }, [startLiveTransfer]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (phaseRef.current !== "idle" && phaseRef.current !== "waiting") return;
      const clipboardFiles = filesFromPasteData(event.clipboardData);
      if (clipboardFiles.length === 0) {
        if (event.target instanceof Element && event.target.closest(".native-paste-target")) {
          event.preventDefault();
          setPasteNotice("That clipboard item still is not an image. Copy the image itself, or choose it from Photos.");
        }
        return;
      }
      event.preventDefault();
      try {
        const names = clipboardFiles.map((file) => clipboardFilename(file));
        chooseSelection(selectionFromFiles(clipboardFiles, { names }));
      } catch (reason) {
        fail(reason instanceof Error ? reason.message : "Could not read the pasted files.");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [chooseSelection, fail]);

  const pasteImage = async () => {
    setPasteNotice("");
    setShowNativePaste(false);
    if (phaseRef.current !== "idle" && phaseRef.current !== "waiting") return;
    if (!window.isSecureContext || typeof navigator.clipboard?.read !== "function") {
      setPasteNotice("Press and hold below, then choose Paste.");
      setShowNativePaste(true);
      return;
    }

    try {
      const files = await imageFilesFromClipboard(await navigator.clipboard.read());
      if (files.length === 0) {
        setPasteNotice("This browser did not expose that image directly. Press and hold below, then choose Paste.");
        setShowNativePaste(true);
        return;
      }
      chooseSelection(selectionFromFiles(files));
    } catch (reason) {
      const denied = reason instanceof DOMException && reason.name === "NotAllowedError";
      setPasteNotice(denied
        ? "Clipboard access was not allowed. Press and hold below, then choose Paste."
        : "This browser could not read that image directly. Press and hold below, then choose Paste.");
      setShowNativePaste(true);
    }
  };

  useEffect(() => {
    if (["idle", "complete", "error"].includes(phase)) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [phase]);

  useEffect(() => () => {
    senderWorkerRef.current?.close();
    senderWorkerRef.current = null;
  }, []);

  const command = useMemo(() => {
    if (!session || !selection) return "";
    return curlCommand(session, selection);
  }, [selection, session]);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const reset = () => {
    if (sessionRef.current) senderWorkerRef.current?.cancel(sessionRef.current.id);
    senderWorkerRef.current?.close();
    senderWorkerRef.current = null;
    sampleRef.current = [];
    selectionRef.current = null;
    sessionRef.current = null;
    setSelection(null);
    setSession(null);
    setProgress(initialProgress);
    setError("");
    setCopied(false);
    phaseRef.current = "idle";
    setPhase("idle");
  };

  const percent = selection && selection.streamBytes > 0
    ? Math.min(100, (progress.bytes / selection.streamBytes) * 100)
    : 100;
  const eta = progress.speed > 0 && selection
    ? (selection.streamBytes - progress.bytes) / progress.speed
    : 0;

  return (
    <main className="shell">
      <input
        ref={fileInputRef}
        className="global-file-input"
        type="file"
        multiple
        onChange={(event) => {
          try {
            chooseSelection(selectionFromFiles(Array.from(event.target.files ?? [])));
          } catch (reason) {
            fail(reason instanceof Error ? reason.message : "Could not read the selected files.");
          } finally {
            event.target.value = "";
          }
        }}
      />
      <section className="panel" aria-live="polite">
        {phase === "idle" ? (
          <div
            className={`drop-zone ${dragging ? "is-dragging" : ""}`}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input, textarea")) return;
              fileInputRef.current?.click();
            }}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void selectionFromDrop(event.dataTransfer)
                .then(chooseSelection)
                .catch((reason: unknown) => {
                  fail(reason instanceof Error ? reason.message : "Could not read the dropped files.");
                });
            }}
          >
            <button
              className="keyboard-file-picker"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                fileInputRef.current?.click();
              }}
            >
              Choose files
            </button>
            <span className="drop-icon" aria-hidden="true">↓</span>
            <h1>
              <span className="desktop-copy">Drop files or folders</span>
              <span className="mobile-copy">Choose or paste files</span>
            </h1>
            <span className="desktop-copy">or click anywhere to browse</span>
            <span className="mobile-copy">Tap anywhere to choose from Photos or Files</span>
            <button
              className="paste-picker"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void pasteImage();
              }}
            >
              Paste image
            </button>
            <span className="paste-hint"><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>V</kbd> to paste</span>
            <span className="drop-description">Send files to any SSH server with one curl command. Nothing is stored.</span>
            {pasteNotice && <span className="paste-notice" role="status">{pasteNotice}</span>}
            {showNativePaste && (
              <textarea
                className="native-paste-target"
                aria-label="Image paste target"
                inputMode="none"
                rows={1}
                placeholder="Press and hold here, then tap Paste"
                value=""
                onChange={() => undefined}
                onClick={(event) => event.stopPropagation()}
              />
            )}
          </div>
        ) : (
          <TransferView
            phase={phase}
            selection={selection}
            session={session}
            command={command}
            copied={copied}
            progress={progress}
            percent={percent}
            eta={eta}
            error={error}
            onCopy={() => void copyCommand()}
            onReset={reset}
            onBrowseMore={() => fileInputRef.current?.click()}
            onPasteMore={() => void pasteImage()}
            onDropMore={(dataTransfer) => {
              void selectionFromDrop(dataTransfer)
                .then(chooseSelection)
                .catch((reason: unknown) => {
                  fail(reason instanceof Error ? reason.message : "Could not read the dropped files.");
                });
            }}
            dragging={dragging}
            setDragging={setDragging}
            pasteNotice={pasteNotice}
            showNativePaste={showNativePaste}
          />
        )}
      </section>

      <TakeoverAd />

      <footer>
        {totalStreamedBytes !== null && (
          <>
            <span className="streamed-total" aria-label={`${formatAccessibleBytes(totalStreamedBytes)} streamed through TermDrop`}>
              {formatPublicTotal(totalStreamedBytes)} streamed
            </span>
            <span className="footer-separator" aria-hidden="true">·</span>
          </>
        )}
        <a href="https://github.com/offmylawn101/termdrop" target="_blank" rel="noreferrer">Open source</a>
        <span className="footer-separator" aria-hidden="true">·</span>
        <span>Buy me a&nbsp;<a href="https://ko-fi.com/offmylawn_" target="_blank" rel="noreferrer">cold brew</a></span>
      </footer>
    </main>
  );
}

interface TransferViewProps {
  phase: Phase;
  selection: TransferSelection | null;
  session: CreateSessionResponse | null;
  command: string;
  copied: boolean;
  progress: Progress;
  percent: number;
  eta: number;
  error: string;
  onCopy: () => void;
  onReset: () => void;
  onBrowseMore: () => void;
  onPasteMore: () => void;
  onDropMore: (dataTransfer: DataTransfer) => void;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
  pasteNotice: string;
  showNativePaste: boolean;
}

function TransferView(props: TransferViewProps) {
  const {
    phase, selection, session, command, copied, progress, percent, eta, error,
    onCopy, onReset, onBrowseMore, onPasteMore, onDropMore, dragging, setDragging,
    pasteNotice, showNativePaste,
  } = props;

  if (phase === "error") {
    return (
      <div className="status-view">
        <span className="status-icon error-icon">×</span>
        <h1>Transfer stopped</h1>
        <p className="error-copy">{error}</p>
        <button className="secondary-button" type="button" onClick={onReset}>Create a new transfer</button>
      </div>
    );
  }

  if (phase === "complete") {
    return (
      <div className="status-view complete-view">
        <FilePreview
          file={selection?.previewFile ?? null}
          filename={selection?.displayName ?? "transfer"}
          fallbackLabel={selectionPreviewLabel(selection)}
          completed
        />
        <h1>Transfer complete</h1>
        <p className="success-copy">{completionMessage(selection)}</p>
        <p className="muted">{formatBytes(progress.bytes)} sent directly to the destination. No copy was stored.</p>
        <button className="secondary-button" type="button" onClick={onReset}>Send something else</button>
      </div>
    );
  }

  return (
    <div
      className={`transfer-view ${phase === "waiting" && dragging ? "is-adding-files" : ""}`}
      onDragEnter={(event) => {
        if (phase !== "waiting") return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (phase === "waiting") event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (phase === "waiting" && event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (phase !== "waiting") return;
        event.preventDefault();
        setDragging(false);
        onDropMore(event.dataTransfer);
      }}
    >
      <div className={`selected-file ${session && phase === "waiting" ? "can-add-files" : ""}`}>
        <FilePreview
          file={selection?.previewFile ?? null}
          filename={selection?.displayName ?? "transfer"}
          fallbackLabel={selectionPreviewLabel(selection)}
        />
        <div className="selected-file-details">
          <h1>{selection?.displayName}</h1>
          <p>{selectionDetails(selection)}</p>
        </div>
        {session && phase === "waiting" && (
          <div
            className="add-files-note"
            role="button"
            tabIndex={0}
            aria-label="Add more files to this transfer"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input, textarea")) return;
              onBrowseMore();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              onBrowseMore();
            }}
          >
            <span className="add-files-symbol" aria-hidden="true">+</span>
            <span className="add-files-copy">
              <strong>Sending more?</strong>
              <span>Paste or drop files here. The curl command updates.</span>
            </span>
            <button className="paste-picker add-files-paste" type="button" onClick={onPasteMore}>Paste image</button>
          </div>
        )}
      </div>

      {(phase === "creating" || phase === "connecting") && (
        <div className="waiting"><span className="spinner" /> Creating secure transfer…</div>
      )}

      {session && phase === "waiting" && (
        <>
          <div className="command-section">
            <label>Paste this into your SSH session</label>
            <code>{command}</code>
            <button className="copy-button" type="button" onClick={onCopy}>{copied ? "Copied" : "Copy command"}</button>
            {pasteNotice && <span className="paste-notice add-files-paste-notice" role="status">{pasteNotice}</span>}
            {showNativePaste && (
              <textarea
                className="native-paste-target add-files-paste-target"
                aria-label="Image paste target"
                inputMode="none"
                rows={1}
                placeholder="Press and hold here, then tap Paste"
                value=""
                onChange={() => undefined}
              />
            )}
            <KeepOpenNote waiting />
          </div>
        </>
      )}

      {phase === "transferring" && selection && (
        <div className="progress-section">
          <div className="connected"><span className="privacy-dot" /> Server connected</div>
          <div className="progress-labels">
            <span>{formatBytes(progress.bytes)} / {formatBytes(selection.streamBytes)}</span>
            <strong>{percent.toFixed(percent < 10 ? 1 : 0)}%</strong>
          </div>
          <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="metrics">
            <span><small>Speed</small>{progress.speed > 0 ? `${formatBytes(progress.speed)}/s` : "Starting…"}</span>
            <span><small>Elapsed</small>{formatDuration(progress.elapsedMs / 1_000)}</span>
            <span><small>Remaining</small>{eta > 0 ? formatDuration(eta) : "Calculating…"}</span>
          </div>
          <KeepOpenNote />
        </div>
      )}
    </div>
  );
}

function KeepOpenNote({ waiting = false }: { waiting?: boolean }) {
  return (
    <div className="keep-open" role="note">
      <span className="desktop-copy">
        <strong>You can switch tabs.</strong> Keep at least one TermDrop tab open until {waiting ? "the command runs" : "the transfer finishes"}.
      </span>
      <span className="mobile-copy">
        {waiting ? (
          <><strong>You can switch browser tabs.</strong> Keep TermDrop open while you run the command.</>
        ) : (
          <><strong>Keep TermDrop open.</strong> Locking the screen or closing every TermDrop tab may cancel the transfer.</>
        )}
      </span>
    </div>
  );
}

function FilePreview({
  file,
  filename,
  fallbackLabel,
  completed = false,
}: {
  file: File | null;
  filename: string;
  fallbackLabel?: string;
  completed?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const previewUrl = useMemo(() => {
    if (!file || file.size > MAX_IMAGE_PREVIEW_BYTES || !PREVIEWABLE_IMAGE_TYPES.has(file.type)) return null;
    return URL.createObjectURL(file);
  }, [file]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const previewSource = previewUrl && failedUrl !== previewUrl ? previewUrl : null;

  return (
    <div className={`file-preview ${previewSource ? "has-image" : ""}`}>
      <div className="file-preview-media">
        {previewSource ? (
          <img src={previewSource} alt={`Preview of ${filename}`} onError={() => setFailedUrl(previewSource)} />
        ) : (
          <span className="preview-extension" aria-hidden="true">{fallbackLabel ?? fileExtension(filename)}</span>
        )}
      </div>
      {completed && <span className="completion-check" aria-hidden="true">✓</span>}
    </div>
  );
}

function fileExtension(filename: string): string {
  const extension = filename.includes(".") ? filename.split(".").pop()?.trim() : "";
  return extension ? extension.slice(0, 6).toUpperCase() : "FILE";
}

function selectionPreviewLabel(selection: TransferSelection | null): string {
  if (!selection) return "FILE";
  if (selection.kind === "folder") return "FOLDER";
  if (selection.kind === "files") return `${selection.fileCount} FILES`;
  return fileExtension(selection.outputFilename);
}

function selectionDetails(selection: TransferSelection | null): string {
  if (!selection) return "";
  if (selection.kind === "file") {
    const type = selection.previewFile?.type;
    return `${formatBytes(selection.sourceBytes)}${type ? ` · ${type}` : ""}`;
  }
  const count = `${selection.fileCount} ${selection.fileCount === 1 ? "file" : "files"}`;
  return `${count} · ${formatBytes(selection.sourceBytes)} · streamed as TAR`;
}

function completionMessage(selection: TransferSelection | null) {
  if (!selection) return <>The transfer completed successfully.</>;
  if (selection.kind === "files") {
    const noun = selection.fileCount === 1 ? "file" : "files";
    const verb = selection.fileCount === 1 ? "was" : "were";
    return <><strong>{selection.fileCount} {noun}</strong> {verb} successfully transferred.</>;
  }
  return <><strong>{selection.displayName}</strong> was successfully transferred.</>;
}

async function autoCopyCommand(command: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText || !window.isSecureContext) return false;
  try {
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 || value >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatPublicTotal(bytes: number): string {
  if (bytes === 0) return "0 GB";
  const units = ["MB", "GB", "TB", "PB"];
  const decimalBytes = [1e6, 1e9, 1e12, 1e15];
  let index = decimalBytes.findLastIndex((size) => bytes >= size);
  if (index < 0) return "<0.1 MB";
  index = Math.min(index, units.length - 1);
  const value = bytes / decimalBytes[index];
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatAccessibleBytes(bytes: number): string {
  return formatPublicTotal(bytes)
    .replace("MB", "megabytes")
    .replace("GB", "gigabytes")
    .replace("TB", "terabytes")
    .replace("PB", "petabytes");
}

async function fetchTotalStreamed(): Promise<number | null> {
  try {
    const response = await fetch("/api/stats", { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { totalBytes?: unknown };
    return typeof body.totalBytes === "number" &&
      Number.isSafeInteger(body.totalBytes) &&
      body.totalBytes >= 0
      ? body.totalBytes
      : null;
  } catch {
    // The transfer flow must remain independent of this optional aggregate.
    return null;
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "N/A";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}
