"use client";

// <CapacityBattery> — the signature widget (L5 §9.4). A horizontal segmented charge meter
// fed VERBATIM by the client capacity replay (advisory; the runtime is the authority). This
// is the one place the verdigris accent carries identity (patina = permanence). Every state
// is color + a TEXT label + shape (WCAG 1.4.1 — color is never the sole carrier). Segment
// count + rate are derived from PAPI metadata constants, never hardcoded.

import { useMemo } from "react";
import {
  draftStatus,
  postCost,
  postsOf,
  type CapacityConsts,
  type CapacityView,
} from "@/lib/chain/capacity";
import styles from "./CapacityBattery.module.css";

const SEGMENTS = 20;
const BLOCK_SECS = 6; // chain default; used only for an approximate "~Ns" hint

export interface CapacityBatteryProps {
  view: CapacityView | null;
  consts: CapacityConsts | null;
  /** byte length of the current draft, for the need-marker + eligibility. */
  draftLen: number;
}

function fmtPosts(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 1 : 0);
}

export function CapacityBattery({ view, consts, draftLen }: CapacityBatteryProps) {
  const model = useMemo(() => {
    if (!view || !consts) return null;
    const cap = view.cap;
    const have = view.have;
    const need = postCost(draftLen, consts);
    const status = draftStatus(view, draftLen, consts);
    const capN = Number(cap);
    const haveFrac = capN > 0 ? Math.min(1, Number(have) / capN) : 0;
    const needFrac = capN > 0 ? Math.min(1, Number(need) / capN) : draftLen > 0 ? 1 : 0;
    return {
      cap,
      have,
      need,
      status,
      haveFrac,
      needFrac,
      ratePerBlock: view.ratePerBlock,
      noWeight: view.weight === 0n,
      charging: view.bucket === null && view.weight > 0n,
      havePosts: postsOf(have, consts),
      capPosts: postsOf(cap, consts),
      ratePosts: consts.baseCost > 0n ? Number(view.ratePerBlock) / Number(consts.baseCost) : 0,
    };
  }, [view, consts, draftLen]);

  if (!model) {
    return (
      <div className={styles.battery} aria-label="talk capacity">
        <div className={styles.headRow}>
          <span className={styles.label}>talk capacity</span>
          <span className={styles.readout}>connecting…</span>
        </div>
        <div className={`${styles.bar} ${styles.barMuted}`} aria-hidden="true" />
      </div>
    );
  }

  const filled = Math.round(model.haveFrac * SEGMENTS);
  const tone = model.noWeight
    ? styles.toneEmpty
    : model.charging
      ? styles.toneCharging
      : styles.toneFull;
  const tooLong = model.status.kind === "too_long";

  // The honest status line — color-redundant, edge-state aware (L5 §8.5 order).
  const statusLine = (() => {
    switch (model.status.kind) {
      case "ok":
        return { text: "ready to post", cls: styles.stOk };
      case "no_weight":
        return {
          text: "no talk capacity yet — lock ADA in the vault (the Stake panel) to earn it; an empty battery means no Cardano-sourced weight yet",
          cls: styles.stEmpty,
        };
      case "too_long":
        return { text: "too long for your capacity — shorten the post", cls: styles.stToolong };
      case "charging": {
        const s = Math.round(model.status.blocks * BLOCK_SECS);
        return { text: `charging from empty — first post in ~${model.status.blocks} blocks (~${s}s)`, cls: styles.stWait };
      }
      case "wait": {
        const s = Math.round(model.status.blocks * BLOCK_SECS);
        return { text: `over budget — post in ~${model.status.blocks} blocks (~${s}s)`, cls: styles.stWait };
      }
    }
  })();

  return (
    <div className={styles.battery} aria-label="talk capacity">
      <div className={styles.headRow}>
        <span className={styles.label}>talk capacity</span>
        <span className={styles.readout}>
          {model.noWeight ? (
            <span className={styles.mutedNum}>0</span>
          ) : (
            <>
              <span className={styles.haveNum}>{fmtPosts(model.havePosts)}</span>
              <span className={styles.slash}> / </span>
              <span className={styles.capNum}>{fmtPosts(model.capPosts)}</span>
              <span className={styles.unit}> posts</span>
            </>
          )}
          {!model.noWeight && model.ratePosts > 0 && (
            <span className={styles.rate}>
              {" · +"}
              {model.ratePosts >= 1 ? model.ratePosts.toFixed(1) : model.ratePosts.toFixed(2)}/block
            </span>
          )}
        </span>
      </div>

      <div className={styles.barWrap}>
        <div
          className={styles.bar}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={Math.round(Number(model.cap))}
          aria-valuenow={Math.round(Number(model.have))}
          aria-label={`talk capacity ${fmtPosts(model.havePosts)} of ${fmtPosts(model.capPosts)} posts`}
        >
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span
              key={i}
              className={`${styles.seg} ${i < filled ? `${styles.segFilled} ${tone}` : styles.segEmpty}`}
              aria-hidden="true"
            />
          ))}
          {/* draft need-marker: where this draft's cost lands on the bar */}
          {draftLen > 0 && (
            <span
              className={`${styles.needMark} ${tooLong ? styles.needMarkOver : ""}`}
              style={{ left: `${Math.min(100, model.needFrac * 100)}%` }}
              aria-hidden="true"
              title={`this draft needs ${fmtPosts(postsOf(model.need, consts!))} posts of capacity`}
            />
          )}
        </div>
      </div>

      <div className={`${styles.status} ${statusLine.cls}`} aria-live="polite">
        {statusLine.text}
      </div>
    </div>
  );
}

export default CapacityBattery;
