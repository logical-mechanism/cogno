"use client";

// Account — the single wallet/identity/stake widget (the product flow). One Cardano wallet does
// everything: connecting DERIVES your sr25519 posting key from a signature (nothing stored), the
// same wallet registers it on-chain (one CIP-8 bind), and it locks/exits ADA in the vault for
// talk-capacity. No second wallet, no password, no key picker.

import { useEffect, useState } from "react";
import { listCardanoWallets, type CardanoWalletInfo } from "@/lib/cardano/cip8";
import type { UseSigner } from "@/hooks/useSigner";
import type { UseIdentity } from "@/hooks/useIdentity";
import type { UseVault } from "@/hooks/useVault";
import styles from "./Account.module.css";

const short = (s: string, h = 8, t = 6) => (s.length <= h + t + 1 ? s : `${s.slice(0, h)}…${s.slice(-t)}`);
const ada = (l: bigint) => `${(Number(l) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} ₳`;

export interface AccountProps {
  signerCtl: UseSigner;
  identity: UseIdentity;
  vault: UseVault;
  /** open the About panel (where the Blockfrost id + advanced config live). */
  onOpenAbout: () => void;
}

export function Account({ signerCtl: sc, identity, vault, onOpenAbout }: AccountProps) {
  const [wallets, setWallets] = useState<CardanoWalletInfo[] | null>(null);
  const [picking, setPicking] = useState(false);

  // Resolve the vault state once a wallet is connected (for the lock/exit UI).
  useEffect(() => {
    if (sc.walletConnected && sc.connectedWalletId && !vault.lockedKnown) {
      vault.inspect(sc.connectedWalletId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sc.walletConnected, sc.connectedWalletId]);

  const openPicker = () => {
    setPicking(true);
    if (wallets == null) void listCardanoWallets().then(setWallets);
  };
  const connect = (id: string) => {
    setPicking(false);
    void sc.connectWallet(id);
  };

  // ── NOT CONNECTED ──
  if (!sc.walletConnected) {
    return (
      <section className={styles.card} aria-label="Account">
        <p className={styles.lead}>Connect your Cardano wallet to post and to stake ADA for talk-capacity.</p>
        {!picking ? (
          <div className={styles.row}>
            <button type="button" className={styles.primary} disabled={sc.deriving} onClick={openPicker}>
              {sc.deriving ? "check your wallet…" : "Connect wallet"}
            </button>
            {sc.lastWalletId && (
              <button type="button" className={styles.link} disabled={sc.deriving} onClick={() => connect(sc.lastWalletId!)}>
                reconnect last
              </button>
            )}
          </div>
        ) : wallets == null ? (
          <p className={styles.muted}>looking for wallets…</p>
        ) : wallets.length === 0 ? (
          <p className={styles.muted}>
            No Cardano wallet found. Install Eternl, Lace, or another CIP-30 wallet, then reload.
          </p>
        ) : (
          <ul className={styles.wallets}>
            {wallets.map((w) => (
              <li key={w.id}>
                <button type="button" className={styles.walletBtn} onClick={() => connect(w.id)}>
                  {w.icon && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={w.icon} alt="" width={18} height={18} className={styles.icon} />
                  )}
                  {w.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {sc.error && (
          <p className={styles.err} role="alert">
            {sc.error}
          </p>
        )}
        <p className={styles.fine}>
          Connecting signs one message to derive your posting key — no funds move, nothing is stored.
        </p>
      </section>
    );
  }

  // ── CONNECTED ──
  const locked = vault.lockedKnown && vault.locked != null && vault.locked > 0n;
  return (
    <section className={styles.card} aria-label="Account">
      <div className={styles.identity}>
        <div className={styles.idCol}>
          <span className={styles.idLabel}>wallet</span>
          <span className={styles.mono} title={sc.walletAddress ?? ""}>
            {sc.walletAddress ? short(sc.walletAddress) : "—"}
          </span>
        </div>
        <div className={styles.idCol}>
          <span className={styles.idLabel}>posting as</span>
          <span className={styles.mono} title={sc.signer.ss58}>
            {short(sc.signer.ss58)}
          </span>
        </div>
        <button type="button" className={`${styles.link} ${styles.disconnect}`} onClick={sc.disconnect}>
          disconnect
        </button>
      </div>

      {/* Register (the one-time CIP-8 bind that links this wallet to the posting key). */}
      {identity.bound === false ? (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.primary}
            disabled={identity.binding}
            onClick={() => sc.connectedWalletId && identity.bind(sc.connectedWalletId)}
          >
            {identity.binding ? "registering…" : "Register to post"}
          </button>
          <span className={styles.fine}>one signature links this wallet to your posting key.</span>
        </div>
      ) : identity.bound === true ? (
        <>
          <p className={styles.ok}>✓ registered — you can post.</p>
          {identity.boundVia === "relay" && (
            <p className={styles.fine}>
              bind fee sponsored by the relay — your wallet signature is what registered you (the relay can&apos;t forge it).
            </p>
          )}
        </>
      ) : (
        <p className={styles.muted}>checking registration…</p>
      )}
      {identity.error && (
        <p className={styles.err} role="alert">
          {identity.error}
        </p>
      )}

      {/* Stake — lock ADA in the vault to earn talk-capacity. */}
      <div className={styles.stake}>
        <span className={styles.idLabel}>talk capacity</span>
        {!vault.available ? (
          <p className={styles.fine}>
            Locking ADA needs a Cardano provider — set a Blockfrost preprod id in{" "}
            <button type="button" className={styles.link} onClick={onOpenAbout}>
              About
            </button>
            .
          </p>
        ) : (
          <div className={styles.row}>
            <span className={styles.mono}>
              {vault.lockedKnown ? (locked && vault.locked ? `locked ${ada(vault.locked)}` : "none locked") : "…"}
            </span>
            {!locked ? (
              <button
                type="button"
                className={styles.primary}
                disabled={vault.busy}
                onClick={() => sc.connectedWalletId && vault.lock(sc.connectedWalletId)}
              >
                {vault.busy ? "locking…" : "lock 100 ₳"}
              </button>
            ) : (
              <button
                type="button"
                className={styles.secondary}
                disabled={vault.busy}
                onClick={() => sc.connectedWalletId && vault.exit(sc.connectedWalletId)}
              >
                {vault.busy ? "exiting…" : "exit"}
              </button>
            )}
          </div>
        )}
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
            — capacity appears once the follower observes the lock.
          </p>
        )}
        {vault.error && (
          <p className={styles.err} role="alert">
            {vault.error}
          </p>
        )}
      </div>
    </section>
  );
}

export default Account;
