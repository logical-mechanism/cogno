"use client";

// AnchorStatus — the Cardano WRITE-link marginalia (M3 Tier-A). A mono strip stating, honestly,
// which Cardano metadata tx last witnessed which finalized post-state root: "anchored to Cardano
// at tx X" (PLAN §7-E). The tx hash links to the preprod explorer so anyone can see the real
// metadata. Carries the honesty badge that anchoring is EVIDENCE, not enforcement (DR-20).

import { useState } from "react";
import type { AnchorCheckpoint } from "@/lib/types";
import { HonestyBadge } from "./HonestyBadge";
import styles from "./AnchorStatus.module.css";

export interface AnchorStatusProps {
  anchor: AnchorCheckpoint | null;
}

// Preprod explorer (the relayer anchors on preprod). Tx hashes are hex, no 0x prefix.
const EXPLORER_TX = "https://preprod.cardanoscan.io/transaction/";

function short(hex: string, n = 8): string {
  const h = hex.replace(/^0x/, "");
  return h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-n)}` : h;
}

export function AnchorStatus({ anchor }: AnchorStatusProps) {
  const [showInfo, setShowInfo] = useState(false);
  const txHex = anchor ? anchor.cardanoTxHash.replace(/^0x/, "") : "";

  return (
    <div className={styles.line}>
      <div className={styles.ledger}>
        <span className={styles.label}>Cardano anchor</span>
        <span className={styles.sep} aria-hidden="true">·</span>

        {anchor ? (
          <>
            <span className={styles.mono}>
              block <span className={styles.num}>#{anchor.blockNumber}</span>
            </span>
            <span className={styles.sep} aria-hidden="true">·</span>
            <span className={styles.mono} title={anchor.finalizedRoot}>
              root {short(anchor.finalizedRoot, 6)}
            </span>
            <span className={styles.sep} aria-hidden="true">·</span>
            <a
              className={styles.tx}
              href={`${EXPLORER_TX}${txHex}`}
              target="_blank"
              rel="noreferrer"
              title={anchor.cardanoTxHash}
            >
              tx {short(anchor.cardanoTxHash)} ↗
            </a>
          </>
        ) : (
          <span className={styles.mono}>
            not yet anchored — the relayer writes each finalized root to Cardano
          </span>
        )}

        <button
          type="button"
          className={styles.info}
          aria-expanded={showInfo}
          aria-label="What the Cardano anchor means"
          onClick={() => setShowInfo((v) => !v)}
        >
          ⓘ what this means
        </button>
      </div>

      <div className={styles.badges}>
        <HonestyBadge
          label="anchor: evidence, not enforcement"
          detail="Every N finalized blocks, the relayer writes that block's finalized post-state root onto Cardano as tx metadata. Cardano cannot reject a wrong root or roll this chain back — the anchor only lets anyone DETECT a silent rewrite after the fact, and only if they have an independent copy of the chain's history to re-derive the root from. It does not prevent a bad block, a fork, or censorship."
        />
      </div>

      {showInfo && (
        <p className={styles.explain}>
          The <strong>root</strong> above is the storage-trie root of the finalized block{" "}
          <strong>#{anchor?.blockNumber ?? "—"}</strong> — a fingerprint of the entire feed at that
          point. Writing it onto Cardano timestamps it on a chain this operator does not control, so
          a third party who keeps the chain&apos;s history can re-derive that root and compare. A
          match proves no silent rewrite before this anchor; a mismatch is public, on-Cardano
          evidence of tampering. Tier-A is a witness, not a bridge.
        </p>
      )}
    </div>
  );
}

export default AnchorStatus;
