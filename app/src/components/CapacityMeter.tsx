"use client";

// CapacityMeter — a compact, always-on "talk points" indicator: how much of the viewer's regenerating
// talk-capacity is available right now (have / cap) and roughly how many posts that buys, so running
// low is visible BEFORE a post is refused. Self-contained (reads the shared session + useHeads +
// useCapacity), so it can sit in the Composer toolbar without the Composer taking on a capacity
// subscription — it's purely advisory; the runtime's CheckCapacity is the authority.

import styles from "./CapacityMeter.module.css";
import { useSession } from "./Providers";
import { useHeads } from "@/hooks/useHeads";
import { useCapacity } from "@/hooks/useCapacity";
import { postsOf } from "@/lib/chain/capacity";

export function CapacityMeter() {
  const { api, client, viewer } = useSession();
  const heads = useHeads(client);
  const { view, consts } = useCapacity(api, viewer.address ?? null, heads.best?.number ?? null);

  // Only meaningful once bound with a non-zero capacity ceiling (weight > 0). Setup/welcome covers
  // the "add posting power" case, so we don't render an empty meter there.
  if (viewer.status !== "ready" || !view || !consts || view.cap <= 0n) return null;

  const pct = Math.max(0, Math.min(100, Number((view.have * 100n) / view.cap)));
  const posts = postsOf(view.have, consts);
  const low = pct < 20;

  return (
    <div
      className={styles.meter}
      title={`Talk points: about ${posts} post${posts === 1 ? "" : "s"} ready (regenerates over time)`}
      aria-label={
        posts > 0
          ? `Talk points: about ${posts} post${posts === 1 ? "" : "s"} ready`
          : "Talk points: recharging"
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
