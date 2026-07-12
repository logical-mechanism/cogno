"use client";

// NoPostingPowerNotice — the honest "you can't post yet" banner for a bound account with setup still
// incomplete. It covers the two required post-register steps, IN ORDER:
//   (0) the stake key not linked → "add voting power" (the mandatory step BEFORE the lock; routes to
//       /welcome to finish). Shown even when ADA is already locked (an existing, never-staked account).
//   (a) stake linked, NO lock in flight → the block is permanent until ADA is locked, so nag to lock
//       (distinct from RateLimitNotice's "try again shortly"); (b) a lock IS crediting → show the timed
//       pending state (usePendingCapacity) instead — telling a user who JUST locked to "lock ADA" again
//       is wrong. A bound account with zero locked ADA has zero talk-capacity so CheckCapacity refuses
//       every post; a never-stake-bound account is likewise treated as setup-incomplete (a FRONTEND
//       policy — stake is not a pool gate).
//
// Self-contained (reads the shared session + useHeads + useCapacity), mirroring CapacityMeter, so it
// can sit in the Composer notice area on EVERY surface (inline / modal / cold page / thread) without
// each surface re-wiring a capacity subscription. Advisory only — CheckCapacity is the authority.

import Link from "next/link";
import styles from "./NoPostingPowerNotice.module.css";
import { useSession } from "./Providers";
import { useHeads } from "@/hooks/useHeads";
import { useCapacity } from "@/hooks/useCapacity";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { pendingLockActions } from "@/lib/pendingLockStore";
import { PendingCapacityNotice } from "./PendingCapacityNotice";

export function NoPostingPowerNotice() {
  const { api, client, viewer, identity } = useSession();
  const heads = useHeads(client);
  const ss58 = viewer.address ?? null;
  const { view } = useCapacity(api, ss58, heads.best?.number ?? null);
  const pending = usePendingCapacity(api, ss58, view?.weight ?? null);

  // Only for a ready (identity-bound) account.
  if (viewer.status !== "ready") return null;

  // Stake is the MANDATORY step BEFORE the lock — surface it first (only once the read resolves to a
  // real `false`, so a returning stake-bound account never flashes it). Shown even when ADA is already
  // locked, to backfill an existing account that registered before stake became required.
  if (identity.stakeBound === false) {
    return (
      <div className={styles.notice} role="status">
        <span className={styles.glyph} aria-hidden>
          🗳
        </span>
        <span className={styles.text}>Add voting power to finish setting up your account.</span>
        <Link href="/welcome/" className={styles.action}>
          Finish setup
        </Link>
      </div>
    );
  }

  // A lock is crediting → show the explained, timed pending state (not "lock ADA" again).
  if (pending.kind !== "none") {
    return (
      <PendingCapacityNotice
        status={pending}
        variant="inline"
        onDismiss={ss58 ? () => pendingLockActions.clear(ss58) : undefined}
      />
    );
  }

  // No lock in flight: only nag to lock once the weight read resolves to a real 0 (avoid flashing).
  if (!view || view.weight > 0n) return null;

  return (
    <div className={styles.notice} role="status">
      <span className={styles.glyph} aria-hidden>
        🔒
      </span>
      <span className={styles.text}>You don&apos;t have posting power yet. Lock ADA to post.</span>
      <Link href="/settings#vault" className={styles.action}>
        Lock ADA
      </Link>
    </div>
  );
}

export default NoPostingPowerNotice;
