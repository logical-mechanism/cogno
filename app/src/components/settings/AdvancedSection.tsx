"use client";

// AdvancedSection — Settings §7 (doc 12). Collapsed-by-default disclosure: the dev-account picker
// (useSigner.devAccounts + setDevAccount, for testing without a wallet) and read-only diagnostics
// (genesis hash via getGenesisHex, best/finalized heads via useHeads — THE ONLY place block numbers
// appear in the whole app — and the bound stake credential hex). Kept out of the main chrome.

import { useEffect, useState } from "react";
import styles from "./AdvancedSection.module.css";
import { useSession } from "@/components/Providers";
import { useHeads } from "@/hooks/useHeads";
import { getGenesisHex } from "@/lib/chain/identity";
import { truncateSs58 } from "@/lib/ss58";

function shortHex(hex: string | null, head = 10): string {
  if (!hex) return "—";
  const h = hex.startsWith("0x") ? hex : `0x${hex}`;
  return h.length > head + 2 ? `${h.slice(0, head)}…` : h;
}

export function AdvancedSection() {
  const { api, client, signerCtl, identity, sessionState } = useSession();
  const heads = useHeads(client);
  const [open, setOpen] = useState(false);
  const [genesis, setGenesis] = useState<string | null>(null);
  const [devChoice, setDevChoice] = useState<string>(signerCtl.devAccounts[0] ?? "//Alice");

  useEffect(() => {
    if (!open || !api) return;
    let cancelled = false;
    void getGenesisHex(api)
      .then((g) => {
        if (!cancelled) setGenesis(`0x${g}`);
      })
      .catch(() => {
        if (!cancelled) setGenesis(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  const walletActive = signerCtl.walletConnected;
  const devActive = signerCtl.postingEnabled && !walletActive;

  return (
    <div className={styles.legacy}>
      <button
        type="button"
        className={styles.disclosure}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} aria-hidden>
          ▸
        </span>
        Advanced
      </button>

      {open && (
        <div className={styles.body}>
          {/* Developer account */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Developer account</h3>
            <p className={styles.note}>Use a built-in test account (no wallet).</p>
            {walletActive && (
              <p className={styles.note}>Connected to a wallet — using a dev account will disconnect it.</p>
            )}
            <div className={styles.devRow}>
              <select
                className={styles.select}
                value={devChoice}
                onChange={(e) => setDevChoice(e.target.value)}
                aria-label="Developer account"
              >
                {signerCtl.devAccounts.map((uri) => (
                  <option key={uri} value={uri}>
                    {uri}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.useBtn}
                onClick={() => signerCtl.setDevAccount(devChoice)}
              >
                Use
              </button>
            </div>
            {devActive && (
              <p className={styles.active}>
                Active: <span className={styles.mono}>{truncateSs58(signerCtl.signer.ss58)}</span>
              </p>
            )}
          </div>

          {/* Diagnostics */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Diagnostics (read-only)</h3>
            <div className={styles.diagRow}>
              <span className={styles.diagLabel}>Genesis</span>
              <span className={styles.mono}>{shortHex(genesis)}</span>
            </div>
            <div className={styles.diagRow}>
              <span className={styles.diagLabel}>Best / final</span>
              <span className={styles.mono}>
                {heads.best ? `#${heads.best.number}` : "—"} / {heads.finalized ? `#${heads.finalized.number}` : "—"}
              </span>
            </div>
            {sessionState === "bound_staked" && (
              <div className={styles.diagRow}>
                <span className={styles.diagLabel}>Stake cred</span>
                <span className={styles.mono}>{shortHex(identity.boundStakeCredHex)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
