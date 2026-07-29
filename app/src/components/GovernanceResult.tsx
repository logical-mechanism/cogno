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
  ratificationVerdict,
  FALLBACK_THRESHOLDS,
  type Threshold,
} from "@/lib/cardano/governance";
import { resolveGovParams, type GovParams } from "@/lib/cardano/govParams";
import { lensVoters, lensVoterUnit } from "@/lib/poll";
import type { PollView, GovActionView } from "@/lib/types";

const pctOf = (f: number) => Math.round(f * 100);
const thresholdLabel = (t: Threshold) =>
  t.min === t.max ? `${pctOf(t.min)}%` : `${pctOf(t.min)}–${pctOf(t.max)}%`;

/** The chamber-title-side pill style + label word for each ratification verdict. `partial` (a range the
 *  poll sits inside) is deliberately NOT the green "meets" — it reads "within" so it never over-signals. */
const VERDICT_STYLE = { meets: styles.meets, partial: styles.partial, below: styles.below } as const;
const VERDICT_WORD = { meets: "meets", partial: "within", below: "below" } as const;

function ChamberRow({
  poll,
  body,
  threshold,
  advisory,
  totalActiveStake,
  paramsResolved,
}: {
  poll: PollView;
  body: "spo" | "drep";
  threshold: Threshold | null;
  advisory: boolean;
  totalActiveStake: bigint | null;
  /** The live-params read has settled (either way). Gates the "unknown" copy so it can't flash on the
   *  first paint, when `totalActiveStake` is null merely because the fetch has not returned yet. */
  paramsResolved: boolean;
}) {
  const v = chamberVote(poll.options, body);
  const unit = lensVoterUnit(body);
  const title = body === "spo" ? "SPOs" : "dReps";
  const ratio = approvalRatio(v.yes, v.no); // Yes/(Yes+No), abstain excluded — null if none cast
  const showBar = !advisory && threshold != null;
  // meets / partial / below vs the threshold (a RANGE for ParamChange → "partial" when inside it, so a poll
  // between the loosest and strictest group bar is never mislabeled a flat "meets"). null unless there's a
  // real threshold + a cast ratio to judge; the head only renders it in that branch.
  const verdict = ratio != null && threshold != null ? ratificationVerdict(ratio, threshold) : null;
  const meets = verdict === "meets";
  // Gauge fill mirrors the verdict — accent for a true "meets", amber while "partial" (inside a range),
  // muted otherwise — so the bar never disagrees with the pill/label above it (a null ratio → 0-width).
  const fillClass =
    verdict === "meets" ? styles.fillMeets : verdict === "partial" ? styles.fillPartial : styles.fillBelow;
  // Coverage: participating chamber stake as a share of total active stake (best-effort, 2 dp).
  const coverage =
    totalActiveStake && totalActiveStake > 0n
      ? Number((v.total * 10000n) / totalActiveStake) / 100
      : null;
  // PARTICIPATION AND WEIGHT ARE DIFFERENT QUESTIONS, and every claim below now reads the one it means.
  // This whole readout used to branch on `v.total === 0n` — a STAKE sum — to say "no dReps voted", a
  // PARTICIPATION claim. They come apart exactly when a role votes carrying no counted stake, which is not
  // rare: Cardano makes a delegation effective the epoch after its certificate and the observer reads the
  // previous epoch's snapshot, so a newly delegated dRep weighs 0 for up to two epochs. The surface then
  // told a dRep who had just voted that no dReps had voted, while `PollVotes` held their vote and the
  // voter roster listed them by name. `voters` is the participation fact (a distinct-role count the
  // runtime tallies alongside the weight); `total` is only ever the stake.
  const nobodyVoted = v.voters === 0;
  const votedWithoutWeight = v.voters > 0 && v.total === 0n;

  return (
    <div className={styles.chamber}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        {nobodyVoted ? (
          <span className={styles.novote}>no {unit}s voted</span>
        ) : votedWithoutWeight ? (
          // Voted, but carrying no stake this snapshot can price. Says what happened rather than
          // collapsing to "nobody voted" (false) or showing "0% Yes" (which reads as a rejection).
          <span className={styles.novote}>
            {lensVoters(v.voters, body)} voted, no stake counted yet
          </span>
        ) : ratio == null ? (
          <span className={styles.novote}>all abstained</span>
        ) : advisory ? (
          <span className={styles.approval}>{pctOf(ratio)}% Yes</span>
        ) : (
          <span className={VERDICT_STYLE[verdict!]}>
            {pctOf(ratio)}% Yes · {VERDICT_WORD[verdict!]} {thresholdLabel(threshold!)}
          </span>
        )}
      </div>

      {showBar && (
        <div
          className={styles.track}
          role="img"
          aria-label={
            ratio == null
              ? `${title}: no Yes or No votes, needs ${thresholdLabel(threshold!)} to pass`
              : verdict === "partial"
                ? `${title}: ${pctOf(ratio)} percent Yes, enough for some parameter groups but not all`
                : `${title}: ${pctOf(ratio)} percent Yes, ${meets ? "meets" : "below"} the ${thresholdLabel(threshold!)} needed to pass`
          }
        >
          <span
            className={`${styles.fill} ${fillClass}`}
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
        {/* "no stake" ONLY when nobody voted. With voters and no weight the reason is the epoch snapshot,
            not an absence of delegation, and a bare "no stake" reads as the latter. */}
        {v.total > 0n
          ? `${formatWeight(v.total)} ₳`
          : votedWithoutWeight
            ? "no stake counted yet"
            : "no stake"}
        {/* The denominator is NAMED rather than called "active stake", because the two chambers do not
            stand in the same relation to it. Blockfrost's `stake.active` is the sum of pool-delegated
            stake, so for the SPO row it is exactly the right whole and the numerator nests inside it.
            For the dRep row it is not: dRep voting power and pool stake OVERLAP without nesting (stake
            delegated to a pool but no dRep is in the denominator only; stake delegated to a dRep but no
            pool is in the numerator only), and total dRep power is materially smaller than total pool
            stake, so read as dRep turnout the figure understates several-fold. This line sits directly
            under a chamber-relative pill ("58% Yes · below 67%"), which primes exactly that misreading.
            Naming the denominator closes it in one string. Substituting a real dRep denominator would
            be the wrong fix even if we could fetch one, because it would inflate how representative a
            handful of voters looks. */}
        {coverage != null && v.total > 0n && <> · {coverage}% of all stake delegated to pools</>}
        {/* Coverage needs a denominator we could not always read. Silently dropping the share made an
            unreadable total look identical to a poll nobody had voted in, which is the one thing this
            readout must never do: a share of an unknown whole is not a small share, it is no answer. */}
        {coverage == null && v.total > 0n && paramsResolved && (
          <> · share of delegated stake unknown</>
        )}
        {" · "}
        {lensVoters(v.voters, body)}
        {v.abstain > 0n && <> · {formatWeight(v.abstain)} ₳ abstained</>}
      </div>
      {/* The reason, once, on the row it applies to. Without it "no stake counted yet" is an unexplained
          dead end for the one reader most likely to be looking: the {unit} who just voted and cannot see
          their own weight. Named epochs rather than a date, because the wait is measured in them. */}
      {votedWithoutWeight && (
        <p className={styles.pending}>
          Cardano starts counting a delegation in the epoch after it is made, and this reads the epoch
          before last. A new {unit} can take up to two epochs, about 10 days, to carry weight here.
        </p>
      )}
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
  // Tracked apart from `params.live` because the two mean different things and the initial state can't
  // distinguish them: `live: false` is both "not read yet" and "read failed, using the snapshot". Only
  // the second is worth telling a reader about, so the caveat waits for the read to settle.
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    let alive = true;
    resolveGovParams().then((p) => {
      if (alive) {
        setParams(p);
        setResolved(true);
      }
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
          paramsResolved={resolved}
        />
      ))}
      {/* The gap between this poll and the real vote, stated once rather than implied.

          Cogno prices a temperature check against the REAL ratification bar, which is the thing that
          makes it more than an opinion poll. The cost of that is a reader who sees "meets 67%" and
          concludes the action would pass. It would not follow, because on Cardano a chamber member who
          does not vote is generally counted as a No, while this poll counts only the people who showed
          up here. A sample that clears the bar tells you nothing about whether the population would.

          "usually" is load-bearing. Non-voters default to No under every post-bootstrap action type,
          but stake delegated to an always-abstain dRep leaves the denominator instead, so a flat
          "always counts as No" would be affirmatively false. We do not spell that out: the caveat only
          has to stop the over-read, and the full rule is a paragraph nobody would finish.

          Only where there is a bar to over-read. An advisory (Info) poll has no threshold. */}
      {!chambers.advisory && (
        <p className={styles.caveat}>
          On Cardano, a member who does not vote is usually counted the same as voting No. This poll
          counts only the SPOs and dReps who voted here, so a result above the bar does not mean the
          action would pass on Cardano.
        </p>
      )}

      {/* The bar every percentage above is judged against is itself a Cardano protocol parameter, and
          governance can move it. When the live read fails we fall back to a shipped snapshot and keep
          rendering a verdict, which is the right call (a stale bar beats no bar) but only if the reader
          is told. Advisory polls carry no threshold, so there is nothing to caveat. */}
      {resolved && !params.live && !chambers.advisory && (
        <p className={styles.stale}>
          Ratification thresholds are from a stored snapshot. The live Cardano values could not be read,
          so a verdict here may not match the current bar.
        </p>
      )}
    </div>
  );
}

export default GovernanceResult;
