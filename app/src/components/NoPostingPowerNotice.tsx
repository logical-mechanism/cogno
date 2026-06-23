"use client";

// NoPostingPowerNotice — the honest "you can't post yet" banner. A bound account with ZERO locked ADA
// has zero talk-capacity, so every post is refused by the runtime's CheckCapacity. This is NOT a
// transient rate limit — waiting never helps; the block is permanent until ADA is locked — so it gets
// its own copy + a direct link to lock, distinct from RateLimitNotice's "try again shortly".
//
// Self-contained (reads the shared session + useHeads + useCapacity), mirroring CapacityMeter, so it
// can sit in the Composer notice area on EVERY surface (inline / modal / cold page / thread) without
// each surface re-wiring a capacity subscription. Advisory only — CheckCapacity is the authority.

import Link from "next/link";
import styles from "./NoPostingPowerNotice.module.css";
import { useSession } from "./Providers";
import { useHeads } from "@/hooks/useHeads";
import { useCapacity } from "@/hooks/useCapacity";

export function NoPostingPowerNotice() {
  const { api, client, viewer } = useSession();
  const heads = useHeads(client);
  const { view } = useCapacity(api, viewer.address ?? null, heads.best?.number ?? null);

  // Only for a ready (identity-bound) account with no posting power yet (weight 0). While the weight
  // read is still resolving (view null) render nothing rather than flashing the banner.
  if (viewer.status !== "ready" || !view || view.weight > 0n) return null;

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
