"use client";

// page.tsx — the M1 reading room. A single client-rendered page that wires the
// data layer (via hooks) into the calm, honest UI. There is ONE socket (useChain),
// from which feed, heads, submit and signer all hang.

import { useState } from "react";
import { useChain } from "@/hooks/useChain";
import { useFeed } from "@/hooks/useFeed";
import { useHeads } from "@/hooks/useHeads";
import { useSigner } from "@/hooks/useSigner";
import { useSubmit } from "@/hooks/useSubmit";
import { useCapacity } from "@/hooks/useCapacity";
import { useIdentity } from "@/hooks/useIdentity";
import { useAnchor } from "@/hooks/useAnchor";
import { Masthead } from "@/components/Masthead";
import { ProvenanceLine } from "@/components/ProvenanceLine";
import { AnchorStatus } from "@/components/AnchorStatus";
import { Composer } from "@/components/Composer";
import { Feed } from "@/components/Feed";
import { EndpointSettings } from "@/components/EndpointSettings";
import { TrustNote } from "@/components/TrustNote";
import styles from "./page.module.css";

export default function Page() {
  const { handle, api, status, boot, wsUrl, reconnect } = useChain();
  const { snapshot, ready } = useFeed(api);
  const heads = useHeads(handle?.client ?? null);
  const {
    signer,
    devAccounts,
    setDevAccount,
    useSessionKey,
    sessionMnemonic,
    ackSessionMnemonic,
  } = useSigner();
  const submit = useSubmit(api, signer, boot);
  // Live, advisory talk-capacity for the active posting key — ticks with the best block.
  const capacity = useCapacity(api, signer.ss58, heads.best?.number ?? null);
  // M2: the Cardano-identity bind state for the active posting key (+ the bind action).
  const identity = useIdentity(api, signer);
  // M3: the latest Cardano anchor checkpoint (Anchor.LastCheckpoint) — the WRITE link's evidence.
  const anchor = useAnchor(api);

  const [replyTo, setReplyTo] = useState<bigint | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const onSubmitPost = (text: string) => {
    submit.post(text, replyTo ?? undefined);
  };

  return (
    <main className={styles.shell}>
      <Masthead
        signer={signer}
        devAccounts={devAccounts}
        onSelectDev={setDevAccount}
        onGenerateSession={useSessionKey}
        sessionMnemonic={sessionMnemonic}
        onAckSessionMnemonic={ackSessionMnemonic}
        identity={identity}
        status={status}
        wsUrl={wsUrl}
        onOpenSettings={() => setSettingsOpen((o) => !o)}
      />

      <ProvenanceLine heads={heads} status={status} />

      <AnchorStatus anchor={anchor} />

      <EndpointSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onReconnect={(url) => reconnect(url)}
      />

      <div className={styles.composerSlot}>
        <Composer
          signer={signer}
          boot={boot}
          txState={submit.state}
          busy={submit.busy}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onSubmit={onSubmitPost}
          capView={capacity.view}
          capConsts={capacity.consts}
          bound={identity.bound}
        />
      </div>

      <Feed
        snapshot={snapshot}
        ready={ready}
        status={status}
        mySs58={signer.ss58}
        busy={submit.busy}
        onReply={(id) => {
          setReplyTo(id);
          if (typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        onDelete={(id) => submit.remove(id)}
      />

      <TrustNote />
    </main>
  );
}
