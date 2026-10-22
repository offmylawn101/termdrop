# TermDrop

> Transfer files or folders from your browser into any SSH server with one command, without installing anything and without storing the transfer.

TermDrop is a Cloudflare-native, one-time live relay. Drop or paste files or a folder in the browser, copy the generated command into an SSH shell, and the browser starts reading only after curl connects.

## What it does

- Uses one Durable Object per transfer to coordinate a single browser and a single curl receiver.
- Accepts desktop paste events and provides a touch-only **Paste image** action; mobile browsers retain their native clipboard confirmation, with Photos/Files as the fallback.
- Streams one file directly. Multiple files and folders are encoded as an incremental USTAR stream in the browser and extracted by the receiver; the browser never builds a whole archive Blob.
- Moves file reads and sender WebSockets into one origin-wide `SharedWorker`, so each recently opened TermDrop tab can keep an independent pending transfer alive while another tab is active. A startup handshake checks that the shared worker is usable; unavailable, blocked, or unresponsive shared workers fall back to a dedicated worker before opening the sender connection. Session creation and sender connection timeouts show a retryable error instead of an indefinite spinner.
- Lets a pending transfer accept more pasted, picked, or dropped files. TermDrop cancels the superseded one-time URL, builds one streamed TAR selection, and displays a replacement one-curl command without reloading the page.
- Coalesces arbitrary `File.stream()` reads into binary 256 KiB WebSocket frames, with only the final frame smaller; the live path never Base64- or JSON-encodes file bytes.
- Uses an explicit eight-chunk sliding credit window. The browser can keep the connection busy, but cannot read more than 2 MiB ahead of the receiver-owned stream pump.
- Returns a `FixedLengthStream` to curl, so premature disconnects produce a truncated fixed-length response and a nonzero curl exit.
- Keeps waiting sender WebSockets hibernatable to avoid billed active duration while no receiver is present.
- Stores only transfer lifecycle metadata and short-lived terminal tombstones in Durable Object storage. It never stores a transferred-file chunk.
- Maintains one aggregate completed-byte counter for the public “streamed” total. It stores no filename or per-transfer byte history.
- Includes one optional sponsor slot. Sponsor creatives are the only files stored by the project, in a dedicated R2 bucket that is not reachable from the transfer relay.

## Architecture

```text
Browser tab
   │
   │ structured-cloned File references
   ▼
Shared transfer worker
   │
   │ File.stream() -> bounded binary WebSocket frames
   ▼
Cloudflare Worker -> Transfer Durable Object
                         │
                         │ receiver-owned FixedLengthStream
                         ▼
                    curl on SSH server
```

Each session has two independent credentials:

- A 144-bit random public session ID in the one-time download URL.
- A 256-bit random sender secret, passed in a WebSocket subprotocol and never included in the curl URL.

The browser WebSocket only delivers plain `ArrayBuffer` chunks to a bounded eight-frame queue. A cumulative acknowledgement releases one browser-side credit only after the corresponding chunk has been accepted by curl's response stream. The response-stream pump is created in curl's Durable Object request context and remains the only code that touches the `FixedLengthStream` writer. This matters because Cloudflare forbids using an I/O object from a different request context. Current compatibility behavior schedules the pump's promise continuation back into its original live request context.

An ordinary browser HTTP upload is deliberately not used. Cloudflare currently limits incoming request bodies by zone plan (100 MB on Free/Pro, 200 MB Business, and 500 MB default Enterprise), which conflicts with a multi-GB design. WebSocket input uses bounded frames; Worker response bodies have no enforced size limit.

Relevant current Cloudflare documentation:

- [Workers request, response, memory, and duration limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cross-request I/O restriction](https://developers.cloudflare.com/workers/observability/errors/#cannot-perform-io-on-behalf-of-a-different-request)
- [Cross-request promise continuation compatibility behavior](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#handle-cross-request-promise-resolution-correctly)
- [`FixedLengthStream`](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream)
- [Durable Object WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Streaming a ReadableStream from a Durable Object](https://developers.cloudflare.com/durable-objects/examples/readable-stream/)

Folder drag-and-drop uses the browser File and Directory Entries API, including repeated directory-reader calls required for directories containing more than one returned batch, as specified by the current [WICG File and Directory Entries draft](https://wicg.github.io/entries-api/).

## Files and folders

- A single file keeps the original `curl -o "filename"` path.
- Multiple loose files are placed inside a timestamped top-level directory and streamed as TAR.
- More files can be added while the command is waiting. The previous unused URL becomes invalid and the updated command extracts all accumulated files in one curl invocation.
- A selected or dropped folder retains its safe relative hierarchy, including empty directories when the drag-and-drop API exposes them.
- Folder and multi-file commands use `curl -fL "…" | tar -xk`. The `-k` flag prevents overwriting an existing same-named file. This path requires the standard `tar` utility already present on typical Linux and BSD servers; no TermDrop software is installed.
- Archive paths are relative, ASCII-normalized, traversal-free USTAR names. Symbolic links and special filesystem entries are never created because browsers expose selected contents as ordinary files.
- Selections are limited to 10,000 archive entries and the configured total transfer-size limit. Individual paths that cannot safely fit USTAR are rejected before session creation.

## Privacy model

Transferred file contents are streamed live from the browser to the receiver and are never persisted by TermDrop. The relay data path has no R2, KV, D1, cache, filesystem, analytics-content, or external-fetch path. Its code never calls the sponsor bucket.

Durable Object SQLite storage contains only bounded coordination metadata: the sender-secret hash, sanitized output filename, content type, expected byte count, state, timestamps, and a hashed-IP quota lease reference. Terminal tombstones are retained for 24 hours by default so a completed URL stays invalid across isolate eviction, then are deleted. A separate stats object stores one cumulative completed-byte total plus SHA-256-derived idempotency tags that expire after 48 hours; it never stores filenames, content, or per-transfer byte counts. Operational logs contain a short SHA-256-derived session tag, event, byte count, duration, status, and safe error reason; they do not contain content or original filenames.

The public homepage loads Google Analytics 4 property `G-D0NC5D1Y6M` for ordinary site-usage measurement. The analytics tag does not run on `/d/:sessionId` receiver responses or API responses, and TermDrop does not send filenames, file contents, clipboard contents, or transfer chunks to Google Analytics.

The sponsor system is deliberately separate. An advertiser explicitly uploads a maximum 1 MB static PNG, JPG, or WebP creative to the `AD_SPONSOR_CREATIVES` R2 binding. Only approved creatives can be displayed. Rejected and outbid challenger creatives are deleted when their uncaptured Stripe authorization is cancelled. This does not change the privacy model for files dropped into the transfer interface.

## Sponsor takeover

The large rectangle below the drop zone displays the current sponsor. The built-in fallback is `public/sponsor-banner.png`, linked directly to [fister.fun](https://fister.fun/). The adjacent button opens bidding at $1.

The placement has a persistent runtime switch. When disabled, both the banner and bid button are removed from the page and new checkouts are rejected, while the current winner and auction history remain intact. It does not require a deployment:

```bash
npm run ad:admin -- status
npm run ad:admin -- disable
npm run ad:admin -- enable
```

- A bid must be at least $1 above the current winner or the next whole-dollar 10% increase, whichever is greater.
- Stripe Checkout places a manual-capture card authorization for the bid. Checkout does not immediately charge the bidder.
- Multiple advertisers may check out concurrently. The global auction Durable Object serializes completed authorizations, keeps only the highest qualifying challenger, and returns idempotent cancellation jobs for displaced or stale bids.
- Cancelling an uncaptured authorization releases the hold. TermDrop captures only the highest approved challenger when its banner becomes active.
- Every leading creative waits for manual review. A winner is guaranteed its first hour, but bidding remains open during that hour. An approved challenger is scheduled for the lock boundary and becomes the new permanent winner unless a higher authorization replaces it first.
- Checkout reservations last 31 minutes. A ten-minute webhook grace period handles delivery latency, while completed Stripe events remain idempotent.
- Resend emails the configured reviewer when a new leading bid needs review. Bidders receive transactional messages when their authorization is received, outbid or rejected, approved and scheduled, made live, or replaced.
- Rejected, outbid, failed-checkout, and superseded creatives are deleted. Active sponsor artwork is retained only while it is displayed.
- Targets must be direct HTTPS URLs. The backend never fetches or previews the advertiser's URL, so the feature cannot become a proxy or SSRF endpoint.
- Banner validation checks file signatures, dimensions, animation flags, MIME type, aspect ratio, and byte size before storage.

## State machine

```text
CREATED
  -> SENDER_CONNECTED
  -> WAITING_FOR_RECEIVER
  -> RECEIVER_CONNECTED
  -> TRANSFERRING
  -> COMPLETED

Terminal: EXPIRED | CANCELLED | FAILED
```

- A receiver before the sender gets `409` without consuming the URL.
- A second active receiver gets `409`.
- A terminal/used session gets `410` while its tombstone exists.
- A nonexistent or malformed session gets `404`.
- Sender reconnection is intentionally unsupported in V1. The shared worker keeps pending senders independent of tab visibility, but closing every TermDrop tab permanently cancels them.
- The 10-minute TTL is the receiver connection deadline. After curl connects, the browser gets a 90-second first-chunk grace period for same-device mobile app switching; an active transfer then uses the 30-second idle timeout and configurable six-hour hard deadline.

## Local development

Requirements: Node.js 22 or newer and curl for the end-to-end check.

```bash
npm install
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). `npm run dev` builds the Vite frontend and starts the Worker, the transfer, quota, and aggregate-stats Durable Objects, SQLite metadata storage, alarms, WebSockets, and static assets in local workerd.

For frontend-only styling work, `npm run dev:ui` starts Vite, but its API calls require a separately running Worker or a proxy. The complete product path is `npm run dev`.

Optional local secret in `.dev.vars`:

```dotenv
IP_HASH_SECRET=replace-with-a-long-random-development-secret
```

Without it, local development uses a documented non-secret fallback. Production should always set the secret.

Ad checkout remains disabled locally unless the three Stripe/admin secrets are deliberately supplied. Do not put a live key in a committed file.

## Configuration

All limits are centralized in `src/shared/config.ts` and exposed as Wrangler string variables.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PUBLIC_BASE_URL` | request origin | Canonical public origin used in curl commands |
| `MAX_FILE_SIZE_BYTES` | 5 GiB | Declared file-size limit |
| `SESSION_TTL_MS` | 600,000 | Time allowed for curl to connect |
| `RECEIVER_START_TIMEOUT_MS` | 90,000 | Time allowed for the browser to return and send the first chunk after curl connects |
| `TRANSFER_IDLE_TIMEOUT_MS` | 30,000 | Maximum time without an accepted file chunk |
| `MAX_TRANSFER_DURATION_MS` | 21,600,000 | Hard six-hour transfer deadline |
| `TOMBSTONE_TTL_MS` | 86,400,000 | Terminal metadata retention |
| `MAX_ACTIVE_TRANSFERS_PER_IP` | 5 | Exact active lease limit per HMAC-hashed IP |
| `SESSION_RATE_LIMIT` | 10 | Session creations per rate window |
| `SESSION_RATE_WINDOW_MS` | 60,000 | Creation-rate window |
| `IP_HASH_SECRET` | none | Wrangler secret used to HMAC-SHA-256 quota keys |
| `STRIPE_SECRET_KEY` | none | Live Stripe secret key used for Checkout authorization, capture, and cancellation |
| `STRIPE_WEBHOOK_SECRET` | none | Signing secret for `/api/ad/stripe/webhook` |
| `AD_ADMIN_SECRET` | none | Bearer secret for the private review endpoints |
| `RESEND_API_KEY` | none | Resend API key used for reviewer and bidder transaction emails |
| `AD_NOTIFICATION_TO` | none | Recipient for sponsor-review alerts |
| `AD_NOTIFICATION_FROM` | none | Sender on a Resend-verified domain for reviewer and bidder messages |

The `AD_SPONSOR_CREATIVES` binding points to the `termdrop-ad-creatives` R2 bucket and contains sponsor banners only.

`PUBLIC_BASE_URL` should be the final HTTPS origin without a trailing slash. Avoid redirects on `/d/*`; a redirecting receiver can interact badly with one-time semantics.

## Testing

Run the complete local gate:

```bash
npm run check
```

Individual commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The Workers Vitest integration runs the real Worker, R2 binding, and Durable Objects under local workerd. Tests cover session creation, sender authentication, exact byte transfer, fixed content length, 256 KiB frame coalescing, streamed USTAR headers/content/checksums, archive traversal protection, duplicate archive names, duplicate/reused receivers, expiry, both-side disconnects, oversize rejection, hostile filenames, state transitions, concurrent isolation, aggregate counter idempotency, persisted-storage inspection for accidental chunks, sponsor validation, Stripe signature verification, manual-capture Checkout parameters, simultaneous sponsor checkouts, stale and displaced authorization cancellation, protected-hour scheduling, review, rejection, capture, and permanent activation.

### Actual curl end-to-end check

Start the Worker in terminal one:

```bash
npm run dev
```

Then run a fully automatic sender + actual curl receiver in terminal two:

```bash
npm run e2e:sender -- --auto
```

The browser lifecycle regression check opens two Chrome tabs, freezes both page
event loops, starts both generated curl commands concurrently, and compares the
received bytes with both source files:

```bash
npm run e2e:browser-background
```

The script creates an isolated temporary output directory, streams `test/fixtures/hello.txt`, runs the generated curl transfer, and compares source and destination SHA-256 hashes.

For the manual two-terminal flow with any file:

```bash
npm run e2e:sender -- --file /absolute/path/to/test.png
```

Copy the printed curl command into another shell. To target another deployment, add `--base https://your-domain.example`.

## Deployment

Authenticate Wrangler, create the sponsor-only bucket, and set production secrets:

```bash
npx wrangler login
npx wrangler r2 bucket create termdrop-ad-creatives
openssl rand -base64 32 | npx wrangler secret put IP_HASH_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
install -d -m 700 ~/.config/termdrop
openssl rand -hex 32 > ~/.config/termdrop/ad-admin-secret
chmod 600 ~/.config/termdrop/ad-admin-secret
npx wrangler secret put AD_ADMIN_SECRET < ~/.config/termdrop/ad-admin-secret
```

Create a live Stripe webhook endpoint for `https://termdrop.sh/api/ad/stripe/webhook` subscribed to `checkout.session.completed` and `checkout.session.expired`, then store its `whsec_…` signing secret:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Stripe's current references for this flow are [placing a manual-capture hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method), [Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create), [PaymentIntent capture](https://docs.stripe.com/api/payment_intents/capture), [PaymentIntent cancellation](https://docs.stripe.com/api/payment_intents/cancel), and [webhook signature verification](https://docs.stripe.com/webhooks/signature).

Set `PUBLIC_BASE_URL` in `wrangler.jsonc`, then deploy:

```bash
npm run deploy
```

Wrangler applies the SQLite Durable Object migrations and publishes the built Vite assets with the Worker. After deployment, run the end-to-end script against the final domain:

```bash
npm run e2e:sender -- --base https://your-domain.example --auto
```

This deployed smoke test is required before calling the service production-ready. It verifies that the deployed edge preserves fixed content length across Worker-to-Durable-Object forwarding and that curl cancellation propagates on the selected Cloudflare plan/runtime.

### Reviewing paid banners

The admin helper reads `TERMDROP_AD_ADMIN_SECRET` or `~/.config/termdrop/ad-admin-secret` and never prints the secret:

```bash
npm run ad:admin -- status
npm run ad:admin -- enable
npm run ad:admin -- disable
npm run ad:admin -- list
npm run ad:admin -- approve SUBMISSION_ID
npm run ad:admin -- reject SUBMISSION_ID "Reason for rejection"
```

Review the stored creative, destination, description, bid, and customer email before approval. Rejection idempotently cancels the uncaptured authorization and deletes the creative. Approval captures immediately when no protected winner exists; otherwise it schedules automatic capture and activation for the current winner's lock boundary.

## Security notes

- Transfer traffic is limited to the fixed `/api/session`, authenticated sender WebSocket, and `/d/:id` routes. The sponsor endpoints accept only validated creative uploads, fixed Stripe operations, and direct click-through URLs; there is no arbitrary fetch, URL forwarding, or proxy endpoint.
- Session IDs and secrets come from `crypto.getRandomValues()`.
- Sender secrets are stored only as SHA-256 hashes and compared without an early-exit byte comparison.
- WebSocket secrets use a subprotocol instead of a query string, keeping them out of URLs and normal access logs.
- Filenames are reduced to a bounded basename with traversal separators, control characters, shell metacharacters, and leading dots removed or replaced. The browser never supplies a destination path.
- `HEAD`, `Range`, conditional range, duplicate sender, and duplicate receiver behavior is explicit.
- Session creation is same-origin checked. Static assets have CSP, no-referrer, no-sniff, frame, permissions, and cache headers.
- Per-IP admission is coordinated by a separate Durable Object keyed by a secret-derived IP hash, providing an exact active-session cap rather than a per-colo approximation.

## Known limitations and deliberate V1 choices

- Transfers are not resumable. Sender loss, receiver loss, a deployment, or a rare Cloudflare runtime restart aborts the transfer; no chunks exist to resume from.
- Once HTTP 200 headers reach curl, a midstream failure cannot become HTTP 5xx. The fixed `Content-Length` makes curl return nonzero for a truncated response, but the short, broadly compatible command can leave a partial output file. curl 7.83 or newer users can add `--remove-on-error` if they prefer automatic cleanup.
- “Complete” means every declared byte was accepted by the receiver response stream and the stream closed. It does not prove the remote filesystem fsynced the file.
- V1 verifies declared length, not cryptographic integrity in the browser. WebCrypto has no native incremental SHA-256 API; a production-quality worker-based incremental hasher is a follow-up rather than a second full file read on the main thread.
- The eight-chunk credit window bounds relay read-ahead to 2 MiB. It removes per-chunk stop-and-wait latency, but final throughput still depends on the browser uplink, receiver downlink, and Cloudflare route.
- Folder selection is drag-and-drop only; clicking the drop area opens the simpler multi-file picker. Folder transfer uses USTAR, so browser-selected symlinks are dereferenced as ordinary files and Unix permission bits are not preserved. Empty folders are preserved when drag-and-drop exposes directory entries.
- Immediate folder extraction depends on the destination's standard `tar` command. A receiver without `tar` can replace the pipe with `-o "folder.tar"` and extract the resulting archive elsewhere.
- The generated receiver URL is displayed as text, never a clickable link. Chat previews, security scanners, and browser prefetchers can consume any one-time GET URL they visit.
- Mobile clipboard reads require a direct tap and browser approval. If iOS returns no image representation, TermDrop exposes an editable target for Safari's native press-and-hold Paste action. In-app browsers may still refuse clipboard access, in which case the normal Photos/Files picker remains available.
- Switching browser tabs is supported while at least one TermDrop tab remains open. Mobile operating systems may still suspend or terminate the entire browser after switching apps or locking the screen, and browsers without `SharedWorker` fall back to a worker owned by the original tab.
- Switching networks can break the sender WebSocket. Transfers remain intentionally non-resumable because TermDrop stores no file chunks.
- The public streamed total begins with the deployment that introduces the aggregate stats object; it does not reconstruct earlier transfers from logs.
- Sponsor creative review remains manual in V1. Card authorization windows are finite, so review should happen promptly; TermDrop's normal one-hour winner lock is well inside Stripe's typical online-card authorization window, but an authorization can expire if review is left unattended for several days.

## Contributing and security

Issues and pull requests are welcome at [github.com/offmylawn101/termdrop](https://github.com/offmylawn101/termdrop). Run `npm run check` before opening a pull request.

Report security issues privately to nate@maxbid.biz rather than in a public issue.

## License

[MIT](LICENSE) © [offmylawn.com](https://offmylawn.com)
