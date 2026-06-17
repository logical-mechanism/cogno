"use client";

// page.tsx — the M1 reading room, M4-extended. A single client-rendered page that wires the
// data layer (via hooks) into the calm, honest UI. There is ONE socket (useChain), from which
// heads, submit and signer all hang. The FEED now reads through a swappable FeedSource: the
// SubQuery indexer when a GraphQL endpoint is configured (search + pagination + revocation
// flagging), else the PAPI-direct node. The best-vs-finalized ProvenanceLine stays PAPI-driven
// regardless of which reader serves the feed.

import { useMemo, useState } from "react";
import { useChain } from "@/hooks/useChain";
import { useFeed, useFeedPage } from "@/hooks/useFeed";
import { useHeads } from "@/hooks/useHeads";
import { useSigner } from "@/hooks/useSigner";
import { useSubmit } from "@/hooks/useSubmit";
import { useCapacity } from "@/hooks/useCapacity";
import { useIdentity } from "@/hooks/useIdentity";
import { useAnchor } from "@/hooks/useAnchor";
import { makeFeedSource } from "@/lib/feed";
import { getGraphqlUrl } from "@/lib/config/endpoints";
import type { FeedSnapshot } from "@/lib/types";
import { Masthead } from "@/components/Masthead";
import { ProvenanceLine } from "@/components/ProvenanceLine";
import { AnchorStatus } from "@/components/AnchorStatus";
import { Composer } from "@/components/Composer";
import { Feed } from "@/components/Feed";
import { SearchBar } from "@/components/SearchBar";
import { EndpointSettings } from "@/components/EndpointSettings";
import { TrustNote } from "@/components/TrustNote";
import styles from "./page.module.css";

export default function Page() {
  const { handle, api, status, boot, wsUrl, reconnect } = useChain();

  // Bumped whenever the GraphQL endpoint changes in settings, so the source rebuilds.
  const [gqlEpoch, setGqlEpoch] = useState(0);
  // The active read path: indexer when a GraphQL endpoint is set, else the PAPI-direct node.
  const source = useMemo(
    () => (api ? makeFeedSource(api, getGraphqlUrl() || null) : null),
    // getGraphqlUrl() is read at build time; gqlEpoch forces a re-read on save/clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, gqlEpoch],
  );

  // Live feed (PAPI watchEntries or indexer poll, depending on the source).
  const { snapshot, ready, error: feedError } = useFeed(source);
  const heads = useHeads(handle?.client ?? null);

  // Search (indexer-only): a non-empty query swaps the live feed for a paginated result set.
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const searchEnabled = source?.caps.search === true && searching;
  const searchPage = useFeedPage(source, { search, first: 50 }, searchEnabled);

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

  // When searching, the Feed renders the paginated result set; otherwise the live snapshot.
  const feedSnapshot: FeedSnapshot = searchEnabled
    ? { posts: searchPage.posts, asOf: snapshot.asOf }
    : snapshot;
  const feedReady = searchEnabled ? !searchPage.loading || searchPage.posts.length > 0 : ready;
  const feedErr = searchEnabled ? searchPage.error : feedError;

  // Honest read-path label: which reader is actually serving the feed right now.
  const readPath =
    source?.kind === "graphql" ? "reads: indexer" : "reads: direct node";

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
        onGraphqlChange={() => {
          setSearch(""); // a path change invalidates any in-flight search
          setGqlEpoch((n) => n + 1);
        }}
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

      {source?.caps.search && (
        <SearchBar
          value={search}
          onSearch={setSearch}
          resultCount={searchEnabled ? searchPage.totalCount : undefined}
        />
      )}

      <p className={styles.readPath} aria-live="polite">
        {readPath}
      </p>

      <Feed
        snapshot={feedSnapshot}
        ready={feedReady}
        status={status}
        mySs58={signer.ss58}
        busy={submit.busy}
        error={feedErr}
        paginated={searchEnabled}
        hasNextPage={searchEnabled ? searchPage.hasNextPage : false}
        loadingMore={searchEnabled ? searchPage.loading : false}
        onLoadMore={searchPage.loadMore}
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
