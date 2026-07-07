"use client";

// NoPostingPowerNotice — the honest "you can't post yet" banner. A bound account with ZERO locked ADA
// has zero talk-capacity, so every post is refused by the runtime's CheckCapacity. There are TWO cases,
// and conflating them was a real defect: (a) NO lock in flight → the block is permanent until ADA is
// locked, so nag to lock (distinct from RateLimitNotice's "try again shortly"); (b) a lock IS crediting
// → show the timed pending state (usePendingCapacity) instead — telling a user who JUST locked to "lock
// ADA" again is wrong.
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
  const { api, client, viewer } = useSession();
  const heads = useHeads(client);
  const ss58 = viewer.address ?? null;
  const { view } = useCapacity(api, ss58, heads.best?.number ?? null);
  const pending = usePendingCapacity(api, ss58, view?.weight ?? null);

  // Only for a ready (identity-bound) account.
  if (viewer.status !== "ready") return null;

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
