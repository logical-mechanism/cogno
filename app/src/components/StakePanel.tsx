"use client";

// StakePanel — the L1 "interact with the smart contract" surface (M8). Connect a real CIP-30
// Cardano wallet and lock ADA into the talk_vault to earn talk-capacity, or exit to reclaim it.
// The Cardano wallet signs the lock/exit tx in-browser (via Blockfrost); capacity is granted a
// few blocks later, once the trusted v1 follower observes the lock and writes the weight — so a
// successful lock is honestly "submitted", not "you can post now". The ADA never leaves the
// owner's control: the vault is owner-reclaimable, and exit is one click.

import { useEffect, useState } from "react";
import { listCardanoWallets, type CardanoWalletInfo } from "@/lib/cardano/cip8";
import type { UseVault } from "@/hooks/useVault";
import { HonestyBadge } from "./HonestyBadge";
import styles from "./StakePanel.module.css";

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const ada = (lovelace: bigint) =>
  `${(Number(lovelace) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} ₳`;

const BADGE_DETAIL =
  "Locking ADA earns capacity only after the trusted v1 follower observes it on Cardano and writes your weight on the app chain.";

export interface StakePanelProps {
  vault: UseVault;
  /** open the settings panel (where the Blockfrost project id is set). */
  onOpenSettings: () => void;
}

export function StakePanel({ vault, onOpenSettings }: StakePanelProps) {
  const [wallets, setWallets] = useState<CardanoWalletInfo[] | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);

  useEffect(() => {
    if (vault.available && wallets == null) void listCardanoWallets().then(setWallets);
  }, [vault.available, wallets]);

  const pick = (id: string) => {
    setWalletId(id);
    vault.inspect(id);
  };

  const header = (
    <header className={styles.head}>
      <span className={styles.title}>stake — talk capacity</span>
      <HonestyBadge label="capacity: follower-metered (v1)" detail={BADGE_DETAIL} />
    </header>
  );

  if (!vault.available) {
    return (
      <section className={styles.panel} aria-label="Stake">
        {header}
        <p className={styles.note}>
          Lock ADA from your own Cardano wallet to earn talk-capacity. This needs a Cardano
          provider — add a Blockfrost <em>preprod</em> project id in{" "}
          <button type="button" className={styles.inlineBtn} onClick={onOpenSettings}>
            settings
          </button>
          .
        </p>
      </section>
    );
  }

  const locked = vault.lockedKnown && vault.locked != null && vault.locked > 0n;

  return (
    <section className={styles.panel} aria-label="Stake">
      {header}

      {walletId == null ? (
        <>
          <p className={styles.note}>
            Connect a Cardano wallet (preprod) to lock ADA and earn capacity. Nothing is locked
            until you confirm in your wallet.
          </p>
          {wallets == null ? (
            <p className={styles.muted}>looking for wallets…</p>
          ) : wallets.length === 0 ? (
            <p className={styles.muted}>
              No Cardano wallet found. Install Eternl, Lace, or another CIP-30 wallet, then reload.
            </p>
          ) : (
            <ul className={styles.wallets}>
              {wallets.map((w) => (
                <li key={w.id}>
                  <button type="button" className={styles.walletBtn} onClick={() => pick(w.id)}>
                    {w.icon && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={w.icon} alt="" width={16} height={16} className={styles.walletIcon} />
                    )}
                    {w.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {vault.info && (
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>vault</dt>
                <dd className={styles.mono} title={vault.info.vaultAddress}>
                  {short(vault.info.vaultAddress)}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>identity</dt>
                <dd className={styles.mono} title={vault.info.beacon}>
                  {short(vault.info.beacon)}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>locked</dt>
                <dd className={styles.mono}>
                  {vault.lockedKnown ? (locked && vault.locked ? ada(vault.locked) : "— none") : "…"}
                </dd>
              </div>
            </dl>
          )}

          <div className={styles.actions}>
            {!locked ? (
              <button
                type="button"
                className={styles.primary}
                disabled={vault.busy}
                onClick={() => vault.lock(walletId)}
              >
                {vault.busy ? "locking…" : "lock 100 ₳"}
              </button>
            ) : (
              <button
                type="button"
                className={styles.secondary}
                disabled={vault.busy}
                onClick={() => vault.exit(walletId)}
              >
                {vault.busy ? "exiting…" : "exit — reclaim ADA"}
              </button>
            )}
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setWalletId(null);
                vault.reset();
              }}
            >
              switch wallet
            </button>
          </div>

          {vault.phase === "submitted" && vault.txHash && (
            <p className={styles.ok} role="status">
              submitted ✓{" "}
              <a
                className={styles.mono}
                href={`https://preprod.cardanoscan.io/transaction/${vault.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(vault.txHash)}
              </a>{" "}
              — capacity appears once the follower observes the lock (a few blocks).
            </p>
          )}
          {vault.error && (
            <p className={styles.err} role="alert">
              {vault.error}
            </p>
          )}
        </>
      )}

      <p className={styles.foot}>
        Locking mints your beacon at the vault; the follower (<code>trusted v1</code>) then grants
        your bound posting key its capacity. The ADA stays yours — the vault is owner-reclaimable,
        exit any time.
      </p>
    </section>
  );
}

export default StakePanel;
