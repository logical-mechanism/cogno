"use client";

// useComposerGate — the pre-flight capacity gate every composing surface shows BEFORE submit: disable
// the CTA and show the inline RateLimitNotice, rather than letting the user post and surfacing the
// rejection as a failure toast afterwards.
//
// This was written out three times, byte-identically (Home, ModalRouteHost, ComposePage) — and a fourth
// surface, ThreadView's reply composer (the highest-volume reply path in the app), never computed it at
// all, so it was the one composer that could never show a rate-limit notice.
//
// It takes exactly ONE argument, and that argument is the SERIALIZED body. That is the point. Home used
// to measure its DISPLAY text: a mention renders as `@alice` (6 bytes) but posts as `@<48-char ss58>`,
// so "hi @alice @bob" measured 14 bytes, sailed through the gate, and was rejected on-chain at ~110.
// Every other surface already passed the serialized text. With one narrowly-typed input there is no
// second thing a caller can accidentally hand it.

import { useMemo } from "react";
import { useSession } from "@/components/Providers";
import { useCapacity } from "./useCapacity";
import { draftStatus, SECS_PER_BLOCK } from "@/lib/chain/capacity";

export interface ComposerGate {
  /** The draft cannot be posted right now (bucket exhausted / charging) → disable the CTA + notice. */
  rateLimited: boolean;
  /** Ready account with zero locked-ADA weight → the honest "lock ADA to post" gate, NOT a rate limit. */
  noPostingPower: boolean;
  /**
   * Seconds until THIS draft becomes postable — the countdown in the inline RateLimitNotice.
   *
   * `undefined` unless the number is TRUE, which is narrower than it looks:
   *
   *   - Only when `gateText` is non-empty. An uncontrolled composer (reply/quote/ThreadView) passes "",
   *     and the empty branch deliberately probes the BASE cost — so `blocks` there is the wait for a
   *     MINIMUM post, not for the reply the user is actually typing. Rendering it would promise "you can
   *     post again in ~12s", expire, re-enable the CTA, and have the 200-byte reply rejected anyway. A
   *     vague-but-true "try again shortly" beats a precise lie.
   *   - Only for the `wait` / `charging` kinds. They are the only ones that carry `blocks`. `too_long` is
   *     never postable at that length (no amount of waiting helps — the honest copy is "trim it"), and
   *     the rate==0 `no_weight` edge has no timer either.
   */
  retryInSeconds?: number;
}

/**
 * @param gateText the SERIALIZED post body (never the display text), or a poll's question. Pass "" for
 *   an uncontrolled composer (reply/quote): the empty case deliberately probes the BASE cost, so a
 *   fully-exhausted bucket still disables the CTA on an empty draft. That branch is load-bearing, not
 *   a degenerate case.
 */
export function useComposerGate(gateText: string): ComposerGate {
  const { api, viewer, bestBlock } = useSession();
  const { view, consts } = useCapacity(api, viewer.address ?? null, bestBlock);

  const rateLimited = useMemo(() => {
    if (viewer.status !== "ready" || !view || !consts) return false;
    const byteLen = new TextEncoder().encode(gateText).length;
    if (byteLen === 0) {
      // Probe the minimum post (base cost) so a fully-exhausted bucket still disables the CTA.
      const probe = draftStatus(view, 0, consts);
      return probe.kind === "charging" || probe.kind === "wait";
    }
    // Zero locked ADA (weight 0) is surfaced separately as "lock ADA to post", NOT as a rate limit.
    // Any OTHER non-ok kind — including the weight>0 / rate==0 `no_weight` edge — still gates here.
    // `k !== "ok"` alone would double-surface the lock-ADA case; `k !== "ok" && k !== "no_weight"`
    // would leave that rate==0 edge ungated. The carve-out has to be exactly this shape.
    const k = draftStatus(view, byteLen, consts).kind;
    return k !== "ok" && !(k === "no_weight" && view.weight === 0n);
  }, [viewer.status, view, consts, gateText]);

  const noPostingPower = viewer.status === "ready" && !!view && view.weight === 0n;

  // The countdown, only where it can be truthful (see the doc on ComposerGate.retryInSeconds).
  const retryInSeconds = useMemo(() => {
    if (viewer.status !== "ready" || !view || !consts) return undefined;
    const byteLen = new TextEncoder().encode(gateText).length;
    if (byteLen === 0) return undefined; // base-cost probe — the number would not be this draft's
    const st = draftStatus(view, byteLen, consts);
    if (st.kind !== "wait" && st.kind !== "charging") return undefined; // the only kinds with `blocks`
    return st.blocks * SECS_PER_BLOCK;
  }, [viewer.status, view, consts, gateText]);

  return { rateLimited, noPostingPower, retryInSeconds };
}
