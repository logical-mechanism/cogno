"use client";

// ProposalPreview — the governance-action tag under a poll: the CIP-1694 action-type pill, plus the
// ON-DEMAND inline reader for the linked CIP-108 proposal. It owns the WHOLE tag block so the host
// PollCard can drop it in and stay presentational.
//
// One external link, not two. When the anchor is fetchable in-browser (https, or ipfs:// → a gateway)
// the block shows a "Preview proposal" expander; the only link out to the raw doc — "View source ↗" —
// lives INSIDE the opened panel, next to the unverified caveat. When the anchor CAN'T be previewed
// (http mixed-content, data:, …) there is no expander, so a single "View proposal ↗" link takes its
// place. The two are mutually exclusive: the viewer never sees the same URL linked twice.
//
// The proposal TITLE reads out at a glance (before any click) so a viewer can tell one Treasury withdrawal
// from the next — but only for anchors on a NEUTRAL host (`isNeutralProposalHost`: GitHub / IPFS gateways),
// where fetching on render can't leak the reader's IP back to the poll author. That eager fetch is LAZY
// (fires when the poll scrolls into view) and shares the very same `resolveProposal` result the panel uses,
// so opening the preview afterwards is instant. An anchor on an author-controlled host stays fully
// on-demand: nothing is fetched until the viewer explicitly opens the panel.
//
// Self-contained: it touches NO session / chain reader (only a plain `fetch` to the off-chain doc). The
// content is UNVERIFIED off-chain text (cogno pins no hash) — the panel says so, and every string is
// hardened + capped in `proposalMeta`.

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./ProposalPreview.module.css";
import { Spinner } from "./icons";
import {
  resolveProposal,
  proposalHttpUrl,
  isNeutralProposalHost,
  type ProposalMeta,
} from "@/lib/cardano/proposalMeta";
import type { GovActionView } from "@/lib/types";

type Status = "idle" | "loading" | "loaded" | "empty";

/** The prose fields, in reading order (the title renders as a heading above these). */
const BLOCK_FIELDS = [
  { key: "abstract", label: "Abstract" },
  { key: "motivation", label: "Motivation" },
  { key: "rationale", label: "Rationale" },
] as const;

export function ProposalPreview({
  action,
  typeLabel,
  openUrl,
}: {
  action: GovActionView;
  /** Human label for the CIP-1694 action type (e.g. "Treasury withdrawal"), shown as the pill. */
  typeLabel: string;
  /** A browsable http(s) URL for the anchor, or null — the FALLBACK link when inline preview isn't possible. */
  openUrl: string | null;
}) {
  // In-browser fetchable/browsable anchor (https, or ipfs:// → gateway). When set, we offer the inline
  // reader and the raw doc is reached via the panel's "View source ↗". When null, only the fallback link
  // (openUrl) stands.
  const href = proposalHttpUrl(action.anchorUrl);
  // Eager-title anchors: fetchable AND on a neutral host, so we can read out the title on render.
  const eager = href != null && isNeutralProposalHost(action.anchorUrl);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [meta, setMeta] = useState<ProposalMeta | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The one fetch, shared by the eager (viewport) prefetch and the explicit Preview click: it resolves once
  // (guarded on `idle`) and the panel + glance-title both read the same `meta`. Cached module-side too, so a
  // second poll linking the same doc — or re-opening this one — never refetches.
  const load = useCallback(() => {
    if (status !== "idle" || !href) return;
    setStatus("loading");
    resolveProposal(action.anchorUrl)
      .then((m) => {
        setMeta(m);
        setStatus(m ? "loaded" : "empty");
      })
      .catch(() => setStatus("empty"));
  }, [status, href, action.anchorUrl]);

  const toggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // this lives inside a clickable post card — don't open the post
      setOpen((o) => !o);
      load(); // no-op once resolved (e.g. an eager prefetch already ran) → opening is then instant
    },
    [load],
  );

  // Eager, LAZY title fetch for neutral-host anchors: resolve when the poll nears the viewport (not on mount,
  // so a feed of many polls doesn't fan out fetches for cards nobody scrolls to). `load` self-guards on
  // status, so this runs at most once; a stable ref keeps the effect from re-subscribing as status changes.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!eager) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      loadRef.current(); // no observer support → just fetch
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          loadRef.current();
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

  const sourceLink = (label: string, url: string) => (
    <a
      className={styles.link}
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );

  return (
    <div className={styles.block} ref={rootRef}>
      <div className={styles.row}>
        <span className={styles.type}>{typeLabel}</span>
        {href ? (
          <button type="button" className={styles.toggle} aria-expanded={open} onClick={toggle}>
            <span className={`${styles.caret} ${open ? styles.caretOpen : ""}`} aria-hidden>
              ▸
            </span>
            {open ? "Hide proposal" : "Preview proposal"}
          </button>
        ) : openUrl ? (
          // No inline preview for this anchor — a single link out is the whole tag's affordance.
          sourceLink("View proposal ↗", openUrl)
        ) : null}
      </div>

      {/* The glanceable proposal title — so a viewer tells one Treasury withdrawal from the next without
          opening anything. Only present once resolved (an eager neutral-host fetch, or a prior open); hidden
          while the panel is open, where the title already heads the content. Clamped to two lines. */}
      {!open && meta?.title && (
        <p className={styles.glanceTitle} dir="auto">
          {meta.title}
        </p>
      )}

      {open && href && (
        // Swallow clicks inside the panel (text selection, the source link) so they don't bubble up to the
        // clickable post card and navigate away mid-read.
        <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
          {status === "loading" && (
            <p className={styles.status}>
              <Spinner size="sm" /> Loading proposal…
            </p>
          )}

          {status === "empty" && (
            <p className={styles.status}>
              Couldn&apos;t load the proposal. {sourceLink("View source ↗", href)}
            </p>
          )}

          {status === "loaded" && meta && (
            <>
              {meta.title && (
                <p className={styles.propTitle} dir="auto">
                  {meta.title}
                </p>
              )}
              {BLOCK_FIELDS.map(({ key, label }) => {
                const value = meta[key];
                if (!value) return null;
                return (
                  <div key={key} className={styles.field}>
                    <span className={styles.fieldLabel}>{label}</span>
                    <p className={styles.fieldBody} dir="auto">
                      {value}
                    </p>
                  </div>
                );
              })}
              <p className={styles.caveat}>
                Unverified · fetched off-chain, may have changed since the poll was created.{" "}
                {sourceLink("View source ↗", href)}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ProposalPreview;
