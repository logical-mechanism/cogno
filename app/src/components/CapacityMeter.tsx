"use client";

// CapacityMeter — a compact, always-on "posting power" indicator: how much of the viewer's regenerating
// talk-capacity is available right now (have / cap) and roughly how many posts that buys, so running
// low is visible BEFORE a post is refused. "Posting power" is the one canonical user-facing name for
// this resource (docs + every other surface); keep it consistent here. Self-contained (reads the shared
// session + useHeads + useCapacity), so it can sit in the Composer toolbar without the Composer taking
// on a capacity subscription — it's purely advisory; the runtime's CheckCapacity is the authority.

import styles from "./CapacityMeter.module.css";
import { useSession, useBestBlock } from "./Providers";
import { useCapacity } from "@/hooks/useCapacity";
import { postsOf } from "@/lib/chain/capacity";

export function CapacityMeter() {
  const { api, viewer } = useSession();
  // useBestBlock (the shared, visibility-frozen head), not a private useHeads subscription: a
  // second subscription re-renders on every block even while the tab is hidden, which is exactly
  // what freezing the shared one is for.
  const bestBlock = useBestBlock();
  const { view, consts } = useCapacity(api, viewer.address ?? null, bestBlock);

  // Only meaningful once bound with a non-zero capacity ceiling (weight > 0). Setup/welcome covers
  // the "add posting power" case, so we don't render an empty meter there.
  if (viewer.status !== "ready" || !view || !consts || view.cap <= 0n) return null;

  const pct = Math.max(0, Math.min(100, Number((view.have * 100n) / view.cap)));
  const posts = postsOf(view.have, consts);
  const low = pct < 20;

  return (
    // role="img" so the aria-label is announced as one discrete element (a bare div + aria-label is not
    // reliably surfaced). "up to" because `posts` counts EMPTY posts (have / baseCost) — a real post also
    // pays a per-byte cost, so this is an upper bound on how many will actually fit, not a guarantee.
    <div
      className={styles.meter}
      role="img"
      title={`Posting power: up to ${posts} more post${posts === 1 ? "" : "s"}, recharges over time`}
      aria-label={
        posts > 0
          ? `Posting power: up to ${posts} more post${posts === 1 ? "" : "s"}`
          : "Posting power: recharging"
      }
    >
      <span className={styles.bar} aria-hidden>
        <span className={`${styles.fill} ${low ? styles.low : ""}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={styles.label}>{posts > 0 ? `≈${posts}` : "recharging…"}</span>
    </div>
  );
}

export default CapacityMeter;
