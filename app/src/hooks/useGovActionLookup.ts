"use client";

// useGovActionLookup — turn a pasted CIP-129 governance action id into a resolved action, and then
// check that the document behind it really is the one Cardano committed to.
//
// TWO STEPS, AND THE SECOND IS THE POINT. Resolving is a convenience: it saves the author leaving cogno
// to hunt down a proposal's raw document link and pick its type out of a dropdown by hand. The CHECK is
// what makes the tag trustworthy. Cardano records a blake2b-256 of the proposal document alongside the
// action, and cogno pins a blake2b-256 of whatever the composer fetched. Those are the same hash over
// the same bytes, so comparing them answers a question nothing in the app could ask before: is the
// document at this link the document the on-chain proposal actually committed to?
//
// WHY THE COMPOSER STILL PINS ITS OWN HASH. Storing the ledger's hash instead would be more
// authoritative and less useful. A pin only means something because `hashProposalDoc` proved a reader
// could reproduce it, fetching no-redirect and uncached exactly as the reader will (see the section
// header in proposalMeta.ts). The ledger's hash exists for anchors whose host sends no CORS header, for
// hosts that redirect, and for documents that are not CIP-108 JSON at all — all of which CIP-100
// permits. Pinning those would hand readers a permanent "could not check" on a poll whose author did
// nothing wrong. So the ledger hash is the oracle, not the record.
//
// The check therefore costs one extra fetch of the document at paste time, and that is deliberate:
// compose time is the only moment a mismatch can still be fixed.
//
// Never throws. Every failure lands in a state the UI renders as prose, and every one of them leaves
// the manual type-and-link fields usable, so a reader with no Blockfrost id configured is never worse
// off than before this existed.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseGovActionId,
  resolveGovAction,
  forgetGovAction,
  govActionLookupAvailable,
  type ResolvedGovAction,
} from "@/lib/cardano/govAction";
import { hashProposalDoc } from "@/lib/cardano/proposalMeta";

/** Whether the document at the resolved anchor is the one the ledger pinned. */
export type DocCheck =
  | { kind: "checking" }
  /** Fetched, hashed, and it matches the ledger's anchor hash. */
  | { kind: "match" }
  /** Fetched and hashed, and it does NOT match. Evidence, and the author can still act on it. */
  | { kind: "mismatch" }
  /** Could not be fetched or hashed from this browser. Says nothing either way. */
  | { kind: "unreadable" };

export type GovLookup =
  /** Nothing typed, or not enough to be an id yet. */
  | { kind: "idle" }
  /** Typed something that is not a well-formed id. Held back until the field is long enough to judge. */
  | { kind: "malformed" }
  | { kind: "resolving" }
  /** Parsed, but Blockfrost had no such action — including a real id from a different network. */
  | { kind: "notfound" }
  /** No project id configured, or one for the wrong network. The manual fields are the way through. */
  | { kind: "unavailable" }
  | { kind: "resolved"; action: ResolvedGovAction; check: DocCheck };

/**
 * The shortest input worth calling malformed. Below this the author is still typing, and reddening a
 * field mid-paste is noise rather than help.
 */
const MIN_JUDGE_LEN = 12;

export interface UseGovActionLookup {
  state: GovLookup;
  /** Drop the cached answer and try again. For a transport failure the author can act on. */
  retry: () => void;
}

export function useGovActionLookup(rawId: string | undefined): UseGovActionLookup {
  const [state, setState] = useState<GovLookup>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);
  const id = (rawId ?? "").trim();

  const retry = useCallback(() => {
    if (id) forgetGovAction(id);
    setNonce((n) => n + 1);
  }, [id]);

  // The resolve. Keyed on the id itself, so re-rendering for any other reason never re-fetches, and a
  // corrected paste supersedes the previous one through the `alive` guard rather than racing it.
  useEffect(() => {
    if (id.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    // Parse first, and locally. A typo is answered instantly, without spending a request and without
    // telling anyone what the author is about to poll on.
    if (!parseGovActionId(id)) {
      setState(id.length < MIN_JUDGE_LEN ? { kind: "idle" } : { kind: "malformed" });
      return;
    }
    // Asked BEFORE spending a request, because it decides whether a null answer means "no such action"
    // or "this browser cannot ask". `resolveGovAction` collapses both to null and the two need opposite
    // copy: one tells the author to check the id, the other must not, since the id may be perfect and
    // the fix is in Settings.
    if (!govActionLookupAvailable()) {
      setState({ kind: "unavailable" });
      return;
    }
    let alive = true;
    setState({ kind: "resolving" });
    resolveGovAction(id)
      .then((action) => {
        if (!alive) return;
        if (!action) {
          setState({ kind: "notfound" });
          return;
        }
        setState({ kind: "resolved", action, check: { kind: "checking" } });
      })
      .catch(() => {
        if (alive) setState({ kind: "notfound" });
      });
    return () => {
      alive = false;
    };
  }, [id, nonce]);

  // The cross-check, once an action has resolved. Split from the resolve so a slow or unreachable
  // document host never delays the prefill: the author gets their type and link filled in immediately,
  // and the verdict arrives underneath when it can.
  const checkedFor = useRef<string | null>(null);
  const resolvedAction = state.kind === "resolved" ? state.action : null;
  useEffect(() => {
    if (!resolvedAction) {
      checkedFor.current = null;
      return;
    }
    const key = `${resolvedAction.id}|${nonce}`;
    if (checkedFor.current === key) return; // already checked this one; do not re-fetch on re-render
    checkedFor.current = key;
    let alive = true;
    hashProposalDoc(resolvedAction.anchorUrl)
      .then((h) => {
        if (!alive) return;
        const check: DocCheck =
          h.kind !== "ok"
            ? { kind: "unreadable" }
            : h.hash.toLowerCase() === resolvedAction.anchorHash.toLowerCase()
              ? { kind: "match" }
              : { kind: "mismatch" };
        // Guard on identity, not on `state`: a second paste may have superseded this action while the
        // document was in flight, and the stale verdict must not be written over the new one.
        setState((cur) =>
          cur.kind === "resolved" && cur.action.id === resolvedAction.id ? { ...cur, check } : cur,
        );
      })
      .catch(() => {
        if (!alive) return;
        setState((cur) =>
          cur.kind === "resolved" && cur.action.id === resolvedAction.id
            ? { ...cur, check: { kind: "unreadable" } }
            : cur,
        );
      });
    return () => {
      alive = false;
    };
  }, [resolvedAction, nonce]);

  return { state, retry };
}

export default useGovActionLookup;
