"use client";

// Masthead — the calm head of the reading room. A wordmark + one honest tagline,
// then the live identity rail and the connection pill. No nav chrome beyond this.

import type { ConnStatus, PostingSigner } from "@/lib/types";
import type { UseIdentity } from "@/hooks/useIdentity";
import { IdentityRail } from "./IdentityRail";
import { ConnState } from "./ConnState";
import styles from "./Masthead.module.css";

export interface MastheadProps {
  signer: PostingSigner;
  devAccounts: readonly string[];
  onSelectDev: (uri: string) => void;
  onGenerateSession: () => void;
  sessionMnemonic: string | null;
  onAckSessionMnemonic: () => void;
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

      <IdentityRail
        signer={props.signer}
        devAccounts={props.devAccounts}
        onSelectDev={props.onSelectDev}
        onGenerateSession={props.onGenerateSession}
        sessionMnemonic={props.sessionMnemonic}
        onAckSessionMnemonic={props.onAckSessionMnemonic}
        identity={props.identity}
      />
    </header>
  );
}

export default Masthead;
