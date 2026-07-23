"use client";

// ProposalPreview — the ON-DEMAND inline reader for a governance-poll's CIP-108 proposal, so the linked
// action reads out IN the poll instead of being only a "View proposal ↗" link out. Collapsed by default;
// on first expand it fetches the anchor doc (via `resolveProposal`), then renders the title + abstract /
// motivation / rationale (all sanitized). On-demand is deliberate — nothing is fetched until the viewer
// opens it, so we never leak their IP to an arbitrary host just by rendering a timeline.
//
// Self-contained: it touches NO session / chain reader (only a plain `fetch` to the off-chain doc), so
// PollCard can drop it in and stay presentational. The content is UNVERIFIED off-chain text (cogno pins no
// hash) — the panel says so, and every string is hardened + capped in `proposalMeta`.

import { useCallback, useState } from "react";
import styles from "./ProposalPreview.module.css";
import { Spinner } from "./icons";
import { resolveProposal, proposalHttpUrl, type ProposalMeta } from "@/lib/cardano/proposalMeta";
import type { GovActionView } from "@/lib/types";

type Status = "idle" | "loading" | "loaded" | "empty";

/** The prose fields, in reading order (the title renders as a heading above these). */
const BLOCK_FIELDS = [
  { key: "abstract", label: "Abstract" },
  { key: "motivation", label: "Motivation" },
  { key: "rationale", label: "Rationale" },
] as const;

export function ProposalPreview({ action }: { action: GovActionView }) {
  // Only offer the inline reader when the anchor is fetchable in-browser (https, or ipfs:// → a gateway).
  // For an unfetchable scheme (http mixed-content, data:, …) the parent's "View proposal ↗" link still stands.
  const href = proposalHttpUrl(action.anchorUrl);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [meta, setMeta] = useState<ProposalMeta | null>(null);

  const toggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // this lives inside a clickable post card — don't open the post
      const next = !open;
      setOpen(next);
      // Fetch once, on first expand (idle) — re-opening reuses the resolved result (also cached in the module).
      if (next && status === "idle") {
        setStatus("loading");
        resolveProposal(action.anchorUrl)
          .then((m) => {
            setMeta(m);
            setStatus(m ? "loaded" : "empty");
          })
          .catch(() => setStatus("empty"));
      }
    },
    [open, status, action.anchorUrl],
  );

  if (!href) return null;

  const sourceLink = (label: string) => (
    <a
      className={styles.link}
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={toggle}>
        <span className={`${styles.caret} ${open ? styles.caretOpen : ""}`} aria-hidden>
          ▸
        </span>
        {open ? "Hide proposal" : "Preview proposal"}
      </button>

      {open && (
        // Swallow clicks inside the panel (text selection, the source link) so they don't bubble up to the
        // clickable post card and navigate away mid-read.
        <div className={styles.panel} onClick={(e) => e.stopPropagation()}>

          {status === "loading" && (
            <p className={styles.status}>
              <Spinner size="sm" /> Loading proposal…
            </p>
          )}

          {status === "empty" && (
            <p className={styles.status}>Couldn&apos;t load the proposal. {sourceLink("Open the source ↗")}</p>
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
                {sourceLink("View source ↗")}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ProposalPreview;
