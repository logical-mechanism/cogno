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
//   • "No title provided"  — the doc loaded but carries no title
//   • "Couldn't load proposal"  — the fetch/parse failed (bad metadata)
//   • "Open to view proposal"  — a host we won't auto-fetch (author-controlled / not fetchable)
// Both the resolved title and the `fallback` are already hardened + capped upstream, so both are safe to render.

import { useEffect, useRef, useState } from "react";
import { resolveProposal, proposalHttpUrl, isNeutralProposalHost } from "@/lib/cardano/proposalMeta";

type State =
  | { kind: "gated" } // author-controlled / not fetchable / no anchor — title only after opening the poll
  | { kind: "loading" }
  | { kind: "title"; text: string }
  | { kind: "no-title" } // doc loaded, no title field
  | { kind: "failed" }; // fetch / parse failed

const DEFAULT_TEXT: Record<Exclude<State["kind"], "title">, string> = {
  gated: "Open to view proposal",
  loading: "Loading proposal…",
  "no-title": "No title provided",
  failed: "Couldn't load proposal",
};

export function ProposalTitle({
  anchorUrl,
  className,
  fallback,
}: {
  anchorUrl?: string;
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
      // Eager path: refuse redirects so a neutral gateway can't be bounced to an author-controlled host and
      // leak this reader's IP on scroll (see resolveProposal / proposalMeta).
      resolveProposal(anchorUrl, { noRedirect: true })
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

  const isTitle = state.kind === "title";
  // Precedence: a resolved title (primary) → the poll's own question (muted) → a muted state default.
  const fallbackText = fallback?.trim();
  const shown = isTitle ? state.text : (fallbackText || DEFAULT_TEXT[state.kind]);
  return (
    <p ref={ref} className={className} dir="auto" data-muted={isTitle ? undefined : true}>
      {shown}
    </p>
  );
}

export default ProposalTitle;
