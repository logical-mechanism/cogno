"use client";

// GovernanceResult — the "make it real" readout for an action-tagged governance poll. Instead of a plain
// weighted bar, it shows, for each body that ACTUALLY decides this CIP-1694 action type, the cogno sample's
// Yes/(Yes+No) approval against the REAL ratification threshold (a live protocol parameter), plus how much
// of Cardano's active stake that sample covers — and the Constitutional Committee as a reference gate cogno
// can't tally.
//
// Honesty: cogno only sees the SPOs/dReps who are ON cogno (a self-selected sample) and can't observe the
// CC, so the threshold is a REFERENCE marker and the coverage line sits next to it — this is a temperature
// check, never the binding on-chain result. Self-contained: it fetches Blockfrost params itself (best-
// effort, degrades to a shipped snapshot) and touches no session/chain reader.

import { useEffect, useState } from "react";
import styles from "./GovernanceResult.module.css";
import { formatWeight } from "@/lib/format";
import {
  actionChambers,
  approvalRatio,
  chamberVote,
  FALLBACK_THRESHOLDS,
  type Threshold,
} from "@/lib/cardano/governance";
import { resolveGovParams, type GovParams } from "@/lib/cardano/govParams";
import type { PollView, GovActionView } from "@/lib/types";

const pctOf = (f: number) => Math.round(f * 100);
const thresholdLabel = (t: Threshold) =>
  t.min === t.max ? `${pctOf(t.min)}%` : `${pctOf(t.min)}–${pctOf(t.max)}%`;

/** `n` participating stake-holders of a chamber, pluralized. */
const voters = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function ChamberRow({
  poll,
  body,
  threshold,
  advisory,
  totalActiveStake,
}: {
  poll: PollView;
  body: "spo" | "drep";
  threshold: Threshold | null;
  advisory: boolean;
  totalActiveStake: bigint | null;
}) {
  const v = chamberVote(poll.options, body);
  const unit = body === "spo" ? "pool" : "dRep";
  const title = body === "spo" ? "SPO chamber" : "dRep chamber";
  const ratio = approvalRatio(v.yes, v.no); // Yes/(Yes+No), abstain excluded — null if none cast
  const showBar = !advisory && threshold != null;
  // Compare the DISPLAYED (rounded) percentages, not the raw ratio, so the readout is self-consistent — an
  // exact 0.505 shown as "51% Yes" must never read "below 51%".
  const meets = ratio != null && threshold != null && pctOf(ratio) >= pctOf(threshold.min);
  // Coverage: participating chamber stake as a share of total active stake (best-effort, 2 dp).
  const coverage =
    totalActiveStake && totalActiveStake > 0n
      ? Number((v.total * 10000n) / totalActiveStake) / 100
      : null;

  return (
    <div className={styles.chamber}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        {v.total === 0n ? (
          <span className={styles.novote}>no {unit}s voted</span>
        ) : ratio == null ? (
          <span className={styles.novote}>only abstains</span>
        ) : advisory ? (
          <span className={styles.approval}>{pctOf(ratio)}% Yes</span>
        ) : (
          <span className={meets ? styles.meets : styles.below}>
            {pctOf(ratio)}% Yes · {meets ? "meets" : "below"} {thresholdLabel(threshold!)}
          </span>
        )}
      </div>

      {showBar && (
        <div
          className={styles.track}
          role="img"
          aria-label={
            ratio == null
              ? `${title}: no Yes/No votes; needs ${thresholdLabel(threshold!)} to ratify`
              : `${title}: ${pctOf(ratio)} percent Yes, ${meets ? "meets" : "below"} the ${thresholdLabel(threshold!)} ratification bar`
          }
        >
          <span
            className={`${styles.fill} ${meets ? styles.fillMeets : styles.fillBelow}`}
            style={{ width: `${pctOf(ratio ?? 0)}%` }}
          />
          {threshold!.min !== threshold!.max && (
            <span
              className={styles.band}
              style={{
                left: `${pctOf(threshold!.min)}%`,
                width: `${pctOf(threshold!.max) - pctOf(threshold!.min)}%`,
              }}
              aria-hidden
            />
          )}
          <span className={styles.marker} style={{ left: `${pctOf(threshold!.min)}%` }} aria-hidden />
        </div>
      )}

      <div className={styles.meta}>
        {v.total > 0n ? `${formatWeight(v.total)} ₳` : "no stake"}
        {coverage != null && v.total > 0n && <> · {coverage}% of active stake</>}
        {" · "}
        {voters(v.voters, unit)}
        {v.abstain > 0n && <> · {formatWeight(v.abstain)} ₳ abstained</>}
      </div>
    </div>
  );
}

export function GovernanceResult({ poll, action }: { poll: PollView; action: GovActionView }) {
  // Start on the shipped snapshot so the readout paints immediately; refine when the live read lands.
  const [params, setParams] = useState<GovParams>({
    thresholds: FALLBACK_THRESHOLDS,
    totalActiveStake: null,
    live: false,
  });
  useEffect(() => {
    let alive = true;
    resolveGovParams().then((p) => {
      if (alive) setParams(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const chambers = actionChambers(action.actionType, params.thresholds);

  return (
    <div className={styles.gov}>
      {chambers.tallied.map((ch) => (
        <ChamberRow
          key={ch.body}
          poll={poll}
          body={ch.body}
          threshold={ch.threshold}
          advisory={chambers.advisory}
          totalActiveStake={params.totalActiveStake}
        />
      ))}
    </div>
  );
}

export default GovernanceResult;
