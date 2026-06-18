"use client";

// Masthead — the calm head of the reading room. A wordmark + one honest tagline,
// then the live identity rail and the connection pill. No nav chrome beyond this.

import type { ConnStatus } from "@/lib/types";
import type { UseIdentity } from "@/hooks/useIdentity";
import type { UseSigner } from "@/hooks/useSigner";
import { IdentityRail } from "./IdentityRail";
import { ConnState } from "./ConnState";
import styles from "./Masthead.module.css";

export interface MastheadProps {
  /** The posting-key controller (active signer + dev/session/keystore actions). */
  signerCtl: UseSigner;
  identity: UseIdentity;
  status: ConnStatus;
  wsUrl: string | null;
  onOpenSettings: () => void;
}

export function Masthead(props: MastheadProps) {
  return (
    <header className={styles.masthead}>
      <div className={styles.brandRow}>
        <div className={styles.brand}>
          <span className={styles.wordmark}>cogno-chain</span>
          <span className={styles.tagline}>
            post text · read text — feeless, operator-run
          </span>
        </div>
        <ConnState
          status={props.status}
          wsUrl={props.wsUrl}
          onOpenSettings={props.onOpenSettings}
        />
      </div>

      <IdentityRail signerCtl={props.signerCtl} identity={props.identity} />
    </header>
  );
}

export default Masthead;
