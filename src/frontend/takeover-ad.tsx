import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { AdCheckoutResponse, PublicAdState } from "../shared/ad-protocol";
import { BANNER_HEIGHT, BANNER_WIDTH, prepareBannerImage } from "./banner-image";

const DEFAULT_AD: PublicAdState = {
  enabled: false,
  id: "default-fister",
  creativeUrl: "/sponsor-banner.png",
  targetUrl: "https://fister.fun/",
  altText: "Fister: Play free now",
  advertiserDomain: "fister.fun",
  currentBidCents: 0,
  minimumBidCents: 100,
  lockedUntil: null,
  expiresAt: null,
  isDefault: true,
};

function formatDollars(cents: number): string {
  if (!Number.isFinite(cents)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function paymentResultFromUrl(): "success" | "cancelled" | null {
  const payment = new URLSearchParams(window.location.search).get("ad_payment");
  return payment === "success" || payment === "cancelled" ? payment : null;
}

export function TakeoverAd() {
  const initialPaymentNotice = paymentResultFromUrl();
  const [ad, setAd] = useState<PublicAdState>(DEFAULT_AD);
  const [detailsOpen, setDetailsOpen] = useState(initialPaymentNotice !== null);
  const [creative, setCreative] = useState<File | null>(null);
  const [targetUrl, setTargetUrl] = useState("https://");
  const [altText, setAltText] = useState("");
  const [bidDollars, setBidDollars] = useState("1");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [processingCreative, setProcessingCreative] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<"success" | "cancelled" | null>(initialPaymentNotice);
  const titleId = useId();
  const creativeInputId = useId();
  const creativeSelection = useRef(0);
  const previewUrl = useMemo(() => creative ? URL.createObjectURL(creative) : null, [creative]);
  const locked = ad.lockedUntil !== null && ad.lockedUntil > Date.now();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ad", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the current placement.");
        return response.json<PublicAdState>();
      })
      .then((current) => {
        setAd(current);
        setBidDollars((previous) => {
          const priorCents = Math.round(Number(previous) * 100);
          return priorCents >= current.minimumBidCents
            ? previous
            : String(current.minimumBidCents / 100);
        });
      })
      .catch((fetchError: unknown) => {
        if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) {
          console.warn("Ad placement state was unavailable.");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (!detailsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  });

  function closeModal() {
    setDetailsOpen(false);
    setError(null);
    if (paymentNotice) {
      setPaymentNotice(null);
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!creative) {
      setError("Choose a banner image first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.set("creative", creative);
    form.set("targetUrl", targetUrl);
    form.set("altText", altText);
    form.set("bidDollars", bidDollars);
    form.set("acceptedTerms", acceptedTerms ? "yes" : "no");
    try {
      const response = await fetch("/api/ad/checkout", { method: "POST", body: form });
      const output = await response.json<AdCheckoutResponse & { error?: string }>();
      if (!response.ok || !output.checkoutUrl) {
        throw new Error(output.error || "Could not start checkout.");
      }
      window.location.assign(output.checkoutUrl);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not start checkout.");
      setSubmitting(false);
    }
  }

  async function selectCreative(file: File | null) {
    const selection = ++creativeSelection.current;
    setCreative(null);
    setError(null);
    if (!file) return;
    setProcessingCreative(true);
    try {
      const prepared = await prepareBannerImage(file);
      if (selection === creativeSelection.current) setCreative(prepared);
    } catch (preparationError) {
      if (selection === creativeSelection.current) {
        setError(preparationError instanceof Error
          ? preparationError.message
          : "The selected image could not be prepared.");
      }
    } finally {
      if (selection === creativeSelection.current) setProcessingCreative(false);
    }
  }

  if (!ad.enabled) return null;

  return (
    <>
      <aside className="takeover-row" aria-label="Sponsor placement">
        <a
          className={`takeover-creative${ad.isDefault ? " is-default" : ""}`}
          href={ad.targetUrl}
          target="_blank"
          rel="sponsored nofollow noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label={`${ad.altText}. Opens ${ad.advertiserDomain} in a new tab.`}
        >
          <img
            src={ad.creativeUrl}
            alt={ad.altText}
            onError={(event) => {
              if (!event.currentTarget.src.endsWith(DEFAULT_AD.creativeUrl)) {
                event.currentTarget.src = DEFAULT_AD.creativeUrl;
              }
            }}
          />
          <span className="takeover-label">Sponsor</span>
        </a>

        <button className="takeover-bid" type="button" onClick={() => setDetailsOpen(true)}>
          <span className="takeover-bid-copy">
            <span>Take over</span>
            <strong>{formatDollars(ad.minimumBidCents)}+</strong>
          </span>
        </button>
      </aside>

      {detailsOpen && (
        <div className="takeover-modal-backdrop" role="presentation" onMouseDown={closeModal}>
          <section
            className="takeover-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="takeover-modal-close" type="button" onClick={closeModal} aria-label="Close">
              ×
            </button>
            <span className="takeover-modal-eyebrow">TermDrop sponsor</span>

            {paymentNotice === "success" ? (
              <div className="takeover-notice takeover-notice-success">
                <h2 id={titleId}>Bid submitted</h2>
                <p>
                  Your card may show a temporary hold, but it has not been charged. We’ll email your current bid
                  status and every review update. Only the approved winning bid is captured.
                </p>
                <button className="takeover-modal-action" type="button" onClick={closeModal}>Done</button>
              </div>
            ) : paymentNotice === "cancelled" ? (
              <div className="takeover-notice">
                <h2 id={titleId}>Checkout cancelled</h2>
                <p>No placement was purchased. You can revise your banner and try again.</p>
                <button className="takeover-modal-action" type="button" onClick={() => setPaymentNotice(null)}>Try again</button>
              </div>
            ) : (
              <>
                <h2 id={titleId}>Take over this spot</h2>
                <p>
                  Authorize at least {formatDollars(ad.minimumBidCents)} to challenge the current sponsor.
                  Only the approved winning bid is charged, and its banner stays up until it is outbid.
                </p>

                {locked && (
                  <div className="takeover-locked">
                    The current sponsor is guaranteed until {new Date(ad.lockedUntil!).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}. Bidding is open now; the highest approved challenger takes over afterward.
                  </div>
                )}
                <form className="takeover-form" onSubmit={submit}>
                    <label htmlFor={creativeInputId}>
                      Banner image
                      <span>Recommended: {BANNER_WIDTH} × {BANNER_HEIGHT} px (7.5:1)</span>
                    </label>
                    <input
                      id={creativeInputId}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
                      required
                      onChange={(event) => void selectCreative(event.target.files?.[0] ?? null)}
                    />
                    <small className="takeover-resize-note">
                      Any normal image size works. TermDrop fits the entire image, resizes it, and optimizes it automatically.
                    </small>

                    {processingCreative ? (
                      <div className="takeover-processing">Preparing banner preview…</div>
                    ) : previewUrl && (
                      <div className="takeover-preview-wrap">
                        <span>Published banner preview</span>
                        <div className="takeover-upload-preview">
                          <img src={previewUrl} alt="Processed banner preview" />
                          <small>Sponsor</small>
                        </div>
                      </div>
                    )}

                    <label>
                      Destination URL
                      <span>Direct HTTPS link; no shorteners</span>
                      <input
                        type="url"
                        inputMode="url"
                        value={targetUrl}
                        onChange={(event) => setTargetUrl(event.target.value)}
                        placeholder="https://example.com/"
                        required
                      />
                    </label>

                    <label>
                      Banner description
                      <span>Used as accessible image text</span>
                      <input
                        type="text"
                        value={altText}
                        onChange={(event) => setAltText(event.target.value)}
                        minLength={3}
                        maxLength={120}
                        placeholder="What does your banner advertise?"
                        required
                      />
                    </label>

                    <label>
                      Your bid
                      <span>Minimum {formatDollars(ad.minimumBidCents)} USD</span>
                      <span className="takeover-money-input">
                        <b>$</b>
                        <input
                          type="number"
                          value={bidDollars}
                          onChange={(event) => setBidDollars(event.target.value)}
                          min={ad.minimumBidCents / 100}
                          max={100_000}
                          step="0.01"
                          required
                        />
                      </span>
                    </label>

                    <label className="takeover-terms">
                      <input
                        type="checkbox"
                        checked={acceptedTerms}
                        onChange={(event) => setAcceptedTerms(event.target.checked)}
                        required
                      />
                      <span>
                        I own or may use this creative. No malware, phishing, adult content, hate, scams,
                        illegal offers, or deceptive downloads. Rejected and outbid authorizations are released.
                      </span>
                    </label>

                    {error && <div className="takeover-error" role="alert">{error}</div>}
                    <button
                      className="takeover-modal-action"
                      type="submit"
                      disabled={submitting || processingCreative || !creative}
                    >
                      {submitting ? "Opening Stripe…" : `Authorize ${formatDollars(Math.round(Number(bidDollars || 0) * 100))} bid`}
                    </button>
                    <small className="takeover-checkout-note">
                      Secure authorization by Stripe. A temporary card hold may appear; only a winning bid is captured.
                    </small>
                  </form>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
