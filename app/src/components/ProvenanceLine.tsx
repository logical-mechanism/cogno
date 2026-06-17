"use client";

// ProvenanceLine — the Civic-Ledger marginalia. A mono strip stating, honestly,
// where the chain head is and how far finality trails it. In M1 it carries ONE
// honesty badge: "chain: operator-run (v1)". The follower/identity badge is M2.
//
// Honesty rule: a head that has stopped advancing must SAY so ("chain not
// advancing") — we never imply the feed is empty when it is merely unfinalized.

import { useEffect, useRef, useState } from "react";
import type { ChainHeads, ConnStatus } from "@/lib/types";
import { HonestyBadge } from "./HonestyBadge";
import styles from "./ProvenanceLine.module.css";

export interface ProvenanceLineProps {
  heads: ChainHeads;
  status: ConnStatus;
}

// How long without a new best block before we call the chain "not advancing".
const STALL_MS = 18_000;

export function ProvenanceLine({ heads, status }: ProvenanceLineProps) {
  const [showInfo, setShowInfo] = useState(false);
  const [stalled, setStalled] = useState(false);

  // Track the last time `best.number` changed; flag a stall if it stops moving
  // while we are nominally connected.
  const lastBestRef = useRef<number | null>(null);
  const lastChangeRef = useRef<number>(Date.now());

  useEffect(() => {
    const best = heads.best?.number ?? null;
    if (best !== lastBestRef.current) {
      lastBestRef.current = best;
      lastChangeRef.current = Date.now();
      setStalled(false);
    }
  }, [heads.best?.number]);

  useEffect(() => {
    if (status !== "connected") {
      setStalled(false);
      return;
    }
    const t = setInterval(() => {
      setStalled(Date.now() - lastChangeRef.current > STALL_MS);
    }, 4000);
    return () => clearInterval(t);
  }, [status]);

  const best = heads.best;
  const finalized = heads.finalized;
  const lag =
    best && finalized ? Math.max(0, best.number - finalized.number) : null;

  return (
    <div className={styles.line}>
      <div className={styles.ledger}>
        <span className={styles.mono}>
          {best ? (
            <>
              at <span className={styles.num}>#{best.number}</span> · best
            </>
          ) : (
            "awaiting chain head…"
          )}
        </span>
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
        <span className={styles.mono}>
          {finalized ? (
            <>
              finalized <span className={styles.num}>#{finalized.number}</span>
              {lag !== null && lag > 0 && (
                <span className={styles.lag}> (−{lag})</span>
              )}
            </>
          ) : (
            "finality pending"
          )}
        </span>

        {stalled && (
          <span className={styles.stall} role="status">
            chain not advancing
          </span>
        )}

        <button
          type="button"
          className={styles.info}
          aria-expanded={showInfo}
          aria-label="What best vs finalized means"
          onClick={() => setShowInfo((v) => !v)}
        >
          ⓘ what this means
        </button>
      </div>

      <div className={styles.badges}>
        <HonestyBadge
          label="chain: operator-run (v1)"
          detail="This chain runs on a single operator-run dev node. It is not yet a multi-validator network — treat liveness and censorship-resistance as provisional."
        />
      </div>

      {showInfo && (
        <p className={styles.explain}>
          <strong>best</strong> is the latest block this node has built — your post
          shows up here within seconds, but a best block can still be reorganised
          away. <strong>finalized</strong> is the block GRANDPA has irreversibly
          agreed on; once your post is at or below the finalized height it cannot be
          undone. A growing gap, or a head that stops moving, is shown here plainly.
        </p>
      )}
    </div>
  );
}

export default ProvenanceLine;
