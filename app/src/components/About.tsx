"use client";

// About — the tucked-away panel for the honest trust posture (kept, per the project's ethos, just
// out of the default consumer view) plus the advanced config: connection/provider endpoints, the
// best-vs-finalized chain status, the Cardano anchor, and the dev accounts. A normal user never
// needs to open it; the curious and the operator can.

import { useEffect } from "react";
import type { ChainHeads, ConnStatus, AnchorCheckpoint } from "@/lib/types";
import type { UseSigner } from "@/hooks/useSigner";
import { HonestyBadge } from "./HonestyBadge";
import { ProvenanceLine } from "./ProvenanceLine";
import { AnchorStatus } from "./AnchorStatus";
import { EndpointSettings } from "./EndpointSettings";
import styles from "./About.module.css";

export interface AboutProps {
  open: boolean;
  onClose: () => void;
  signerCtl: UseSigner;
  heads: ChainHeads;
  status: ConnStatus;
  anchor: AnchorCheckpoint | null;
  onReconnect: (url: string) => void;
  onGraphqlChange: () => void;
}

export function About({ open, onClose, signerCtl, heads, status, anchor, onReconnect, onGraphqlChange }: AboutProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="About cogno-chain">
        <header className={styles.head}>
          <h2 className={styles.title}>About</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className={styles.prose}>
          cogno-chain is a feeless social chain: you post text, and the right to post is metered by a
          regenerating talk-capacity you earn by locking ADA in a Cardano vault — not by per-post fees.
          Your Cardano wallet is your identity; it derives your posting key, with nothing stored.
        </p>

        <div className={styles.badges}>
          <HonestyBadge
            label="follower: trusted (v1)"
            detail="A single trusted follower verifies your wallet signature and writes your weight in v1; privileged writes route through a 3-of-5 committee origin (D2-shaped on this single-operator stack)."
          />
          <HonestyBadge
            label="chain: operator-run (v1)"
            detail="The app chain is a single operator-run Aura/GRANDPA node in v1. Reads are verifiable against it; it is not yet decentralized."
          />
        </div>
        <p className={styles.maxim}>usable ≠ trustless · signed ≠ included · feeless ≠ unstoppable</p>

        <section className={styles.section}>
          <p className={styles.sectionTitle}>chain status</p>
          <ProvenanceLine heads={heads} status={status} />
          <AnchorStatus anchor={anchor} />
        </section>

        <section className={styles.section}>
          <p className={styles.sectionTitle}>connection &amp; provider</p>
          <EndpointSettings open onClose={onClose} onReconnect={onReconnect} onGraphqlChange={onGraphqlChange} />
        </section>

        <section className={styles.section}>
          <p className={styles.sectionTitle}>advanced — dev accounts</p>
          <p className={styles.fine}>
            Public, well-known Substrate dev accounts for testing without a wallet — anyone can sign
            as them. Selecting one posts as a dev key instead of your wallet-derived key.
          </p>
          <div className={styles.devRow}>
            {signerCtl.devAccounts.map((uri) => {
              const active = signerCtl.signer.kind === "dev" && signerCtl.signer.label.startsWith(uri);
              return (
                <button
                  key={uri}
                  type="button"
                  className={`${styles.devBtn} ${active ? styles.devActive : ""}`}
                  onClick={() => signerCtl.setDevAccount(uri)}
                >
                  {uri}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export default About;
