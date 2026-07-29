"use client";

// ProposalTitle — the glanceable CIP-108 proposal title for a governance-feed row, in place of the raw
// poll post-text. It answers "which proposal is this?" at a glance.
//
// PRIVACY: the title is fetched ONLY for a browser-fetchable anchor on a NEUTRAL host (proposalHttpUrl +
// isNeutralProposalHost — GitHub / IPFS gateways). An author-controlled host is NEVER auto-fetched here: a
// feed that eagerly hit every author's URL on render would leak the viewer's IP to each poll author. Those
// anchors stay gated — their title shows only after the viewer opens the poll (ProposalPreview, on demand).
// The eager fetch is LAZY (fires on scroll-in via IntersectionObserver, like ProposalPreview) and shares
// resolveProposal's module cache, so opening the poll afterwards is instant.
//
// It renders one line: the resolved title when we have it, otherwise the poll's own `fallback` question
// (muted, so it can't masquerade as a resolved title) so two rows stay distinguishable. Only when the poll
// has NO question either (an empty chamber poll) does it drop to a muted default describing the state —
//   • "Untitled proposal"  — the doc loaded but carries no title
//   • "Couldn't load proposal"  — the fetch/parse failed (bad metadata)
//   • "Open the poll to see the proposal"  — a host we won't auto-fetch (author-controlled / not fetchable)
// Both the resolved title and the `fallback` are already hardened + capped upstream, so both are safe to render.
//
// A resolved title is NEVER shown once the pinned hash says the document was swapped or deleted; the row
// says so instead. Hardening the poll's own card (ProposalPreview) and not this one would have left the
// whole mechanism defeated on the surface where it matters most, since a reader scans a list of rows and
// opens none of them. See the SUBSTITUTION CHECK note below.

import { useEffect, useRef, useState } from "react";
import {
  resolveProposal,
  proposalHttpUrl,
  isNeutralProposalHost,
  anchorVerdict,
  readAnchorOutcome,
} from "@/lib/cardano/proposalMeta";

type State =
  | { kind: "gated" } // author-controlled / not fetchable / no anchor — title only after opening the poll
  | { kind: "loading" }
  | { kind: "title"; text: string }
  | { kind: "no-title" } // doc loaded, no title field
  | { kind: "failed" }; // fetch / parse failed

const DEFAULT_TEXT: Record<Exclude<State["kind"], "title">, string> = {
  gated: "Open the poll to see the proposal",
  loading: "Loading proposal…",
  "no-title": "Untitled proposal",
  failed: "Couldn't load proposal",
};

/**
 * What the row says INSTEAD of a title when the pinned document no longer matches. Shorter than
 * ProposalPreview's VERDICT_COPY on purpose: this is one clamped line in a dense list, and its job is
 * to stop the substituted text being read as the row's name and send the reader into the poll, where
 * the full verdict and the source link live.
 */
const SWAPPED_TEXT = {
  changed: "The pinned proposal has changed. Open the poll.",
  missing: "The pinned proposal is no longer readable. Open the poll.",
} as const;

export function ProposalTitle({
  anchorUrl,
  anchorHash,
  className,
  fallback,
}: {
  anchorUrl?: string;
  /** The hash the poll pinned for that document, when it pinned one. Drives the substitution check. */
  anchorHash?: string;
  className?: string;
  /** The poll's own (sanitized) question — shown, muted, whenever a resolved title isn't available, so
   *  unresolved rows stay distinguishable instead of collapsing to an identical state string. */
  fallback?: string;
}) {
  // Fetchable AND neutral-host ⇒ we may read the title on scroll-in; anything else stays gated.
  const eager =
    anchorUrl != null && proposalHttpUrl(anchorUrl) != null && isNeutralProposalHost(anchorUrl);
  const [state, setState] = useState<State>(eager ? { kind: "loading" } : { kind: "gated" });
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!eager || !anchorUrl) return;
    let cancelled = false;
    const run = () => {
      // Eager path: no opts, because refusing redirects is now the DEFAULT. A neutral gateway must not be
      // followable to an author-controlled host that would then hold this reader's IP (see proposalMeta).
      resolveProposal(anchorUrl)
        .then((m) => {
          if (cancelled) return;
          setState(!m ? { kind: "failed" } : m.title ? { kind: "title", text: m.title } : { kind: "no-title" });
        })
        .catch(() => {
          if (!cancelled) setState({ kind: "failed" });
        });
    };
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      run(); // no observer support → just fetch
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          run();
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [eager, anchorUrl]);

  // THE SUBSTITUTION CHECK, on the scanning surface. The poll's own card hides a swapped title behind
  // ProposalPreview's alarm, but a /governance reader takes in dozens of rows and opens none of them, so
  // an author who swaps the document after the votes are in would get their new title read as the row
  // headline by everyone who never clicked. Recomputed each render off the module-level outcome cache
  // that the fetch effect above fills; no extra request, and none is added — the eager fetch stays gated
  // to neutral hosts for the privacy reason in the header.
  //
  // ONLY `changed` and `missing` suppress. `unpinned` is every poll created before pinning shipped and
  // `unchecked` is every author-controlled host (never fetched here, by design), so suppressing on
  // anything short of a positive mismatch would blank almost every title on the page.
  const verdict = anchorUrl ? anchorVerdict(anchorHash, readAnchorOutcome(anchorUrl)) : "unpinned";
  const swapped = verdict === "changed" || verdict === "missing";
  const isTitle = state.kind === "title" && !swapped;
  // Precedence: the substitution warning → a resolved title (primary) → the poll's own question (muted)
  // → a muted state default. The warning is FIRST: `DEFAULT_TEXT` has no "title" key, so letting a
  // suppressed title fall through to it would render the string "undefined".
  const fallbackText = fallback?.trim();
  const shown = swapped
    ? SWAPPED_TEXT[verdict]
    : state.kind === "title"
      ? state.text
      : (fallbackText || DEFAULT_TEXT[state.kind]);
  return (
    <p
      ref={ref}
      className={className}
      dir="auto"
      data-muted={isTitle ? undefined : true}
      // Marked so the surface can style it as the warning it is. Without this it would render in the
      // same muted grey as "Loading proposal…", which is the wrong register for the one line on the row
      // that says the document behind it does not match what the poll committed to.
      data-alarm={swapped ? true : undefined}
    >
      {shown}
    </p>
  );
}

export default ProposalTitle;
