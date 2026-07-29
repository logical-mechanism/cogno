"use client";

// NoPostingPowerNotice — the honest "you can't post yet" banner for a bound account with no posting
// power. There is exactly ONE required post-register step, and this covers both of its states:
//   (a) NO lock in flight → the block is permanent until ADA is locked, so nag to lock (distinct from
//       RateLimitNotice's "try again shortly"); (b) a lock IS crediting → show the timed pending state
//       (usePendingCapacity) instead — telling a user who JUST locked to "lock ADA" again is wrong.
//   A bound account with zero locked ADA has zero talk-capacity, so CheckCapacity refuses every post.
//
// It used to carry a THIRD, leading branch ("Add voting power to post.") for `stakeBound === false`.
// That was removed with the write gate it belonged to: the stake bind writes `TalkStake::VotingPower`
// and nothing else, so "add voting power to post" was a false statement about the chain, rendered on
// every composer on every surface. A stake-less account posts normally; only its VOTE WEIGHT is zero,
// which the vote call sites disclose.
//
// Self-contained (reads the shared session + useHeads + useCapacity), mirroring CapacityMeter, so it
// can sit in the Composer notice area on EVERY surface (inline / modal / cold page / thread) without
// each surface re-wiring a capacity subscription. Advisory only — CheckCapacity is the authority.

import Link from "next/link";
import styles from "./NoPostingPowerNotice.module.css";
import { useSession, useBestBlock } from "./Providers";
import { useCapacity } from "@/hooks/useCapacity";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { useObserverHealth } from "@/hooks/useObserverHealth";
import { pendingLockActions } from "@/lib/pendingLockStore";
import { PendingCapacityNotice } from "./PendingCapacityNotice";
import { viewerBucket } from "@/lib/viewerBucket";

export function NoPostingPowerNotice() {
  const { api, viewer } = useSession();
  // useBestBlock (the shared, visibility-frozen head), not a private useHeads subscription: a
  // second subscription re-renders on every block even while the tab is hidden, which is exactly
  // what freezing the shared one is for.
  const bestBlock = useBestBlock();
  const ss58 = viewerBucket(viewer);
  const { view } = useCapacity(api, ss58, bestBlock);
  const pending = usePendingCapacity(api, ss58, view?.weight ?? null);
  // Whether the SOLE writer of posting power is still running. Everything below is a statement about
  // why this account cannot post, and every one of them is wrong in a different way if it has stopped.
  const observer = useObserverHealth(api, bestBlock);

  // Only for a ready (identity-bound) account.
  if (viewer.status !== "ready") return null;

  // Already funded → this notice has nothing to say. It sits ABOVE the pending branch on purpose:
  // `usePendingCapacity` now keeps a record alive while a stale-positive weight from a PRIOR lock is
  // still on chain (that is the whole point of the exit-then-relock fix), and a reader who can post
  // does not need to be told about a top-up that is still crediting.
  if (view && view.weight > 0n) return null;

  // A lock is crediting → show the explained, timed pending state (not "lock ADA" again). The observer
  // is threaded through because a stall makes every timing statement in there untrue.
  if (pending.kind !== "none") {
    return (
      <PendingCapacityNotice
        status={pending}
        observer={observer}
        variant="inline"
        onDismiss={ss58 ? () => pendingLockActions.clear(ss58) : undefined}
      />
    );
  }

  // No lock in flight: only nag to lock once the weight read resolves to a real 0. `view` stays null
  // until BOTH capacity reads answer (useCapacity), so this can no longer fire on a synthetic zero.
  if (!view) return null;

  // Telling someone to go and lock ADA while the observer is frozen sends them to spend a Cardano
  // transaction fee on something that provably cannot credit until it resumes. Say so instead, and
  // keep the Lock action available: the lock itself still works and is still safe, it just waits.
  if (observer.kind === "stalled") {
    return (
      <div className={styles.notice} role="status">
        <span className={styles.glyph} aria-hidden>
          ⏸️
        </span>
        <span className={styles.text}>
          Posting power is paused. cogno has stopped reading Cardano, so a new lock will not be
          credited until it resumes.
        </span>
        <Link href="/settings#vault" className={styles.action}>
          Lock ADA
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.notice} role="status">
      <span className={styles.glyph} aria-hidden>
        🔒
      </span>
      <span className={styles.text}>You don&apos;t have posting power yet.</span>
      <Link href="/settings#vault" className={styles.action}>
        Lock ADA
      </Link>
    </div>
  );
}

export default NoPostingPowerNotice;
