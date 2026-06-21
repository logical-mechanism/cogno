"use client";

// page.tsx — the reading room, product-shaped. One Cardano wallet runs everything: connecting
// derives your posting key, registers it, and stakes ADA for talk-capacity (the Account widget).
// The default view is just connect → stake → read/post; the trust posture, chain status, and
// advanced config live behind the "about" link. There is ONE socket (useChain).

import { useMemo, useState } from "react";
import { useChain } from "@/hooks/useChain";
import { useFeed, useFeedPage } from "@/hooks/useFeed";
import { useHeads } from "@/hooks/useHeads";
import { useSigner } from "@/hooks/useSigner";
import { useSubmit } from "@/hooks/useSubmit";
import { useCapacity } from "@/hooks/useCapacity";
import { useIdentity } from "@/hooks/useIdentity";
import { useVault } from "@/hooks/useVault";
import { useAnchor } from "@/hooks/useAnchor";
import { makeFeedSource } from "@/lib/feed";
import { getGraphqlUrl } from "@/lib/config/endpoints";
import type { FeedSnapshot } from "@/lib/types";
import { Masthead } from "@/components/Masthead";
import { Account } from "@/components/Account";
import { About } from "@/components/About";
import { Composer } from "@/components/Composer";
import { Feed } from "@/components/Feed";
import { SearchBar } from "@/components/SearchBar";
import styles from "./page.module.css";

export default function Page() {
  const { handle, api, status, boot, wsUrl, reconnect } = useChain();

  // Bumped whenever the GraphQL endpoint changes in settings, so the source rebuilds.
  const [gqlEpoch, setGqlEpoch] = useState(0);
  const source = useMemo(
    () => (api ? makeFeedSource(api, getGraphqlUrl() || null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, gqlEpoch],
  );

  const { snapshot, ready, error: feedError } = useFeed(source);
  const heads = useHeads(handle?.client ?? null);

  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const searchEnabled = source?.caps.search === true && searching;
  const searchPage = useFeedPage(source, { search, first: 50 }, searchEnabled);

  const signerCtl = useSigner();
  const signer = signerCtl.signer;
  const submit = useSubmit(api, signer, boot);
  const capacity = useCapacity(api, signer.ss58, heads.best?.number ?? null);
  const identity = useIdentity(api, handle?.client ?? null, signer);
  const vault = useVault();
  const anchor = useAnchor(api);

  const [replyTo, setReplyTo] = useState<bigint | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  const onSubmitPost = (text: string) => {
    submit.post(text, replyTo ?? undefined);
  };

  const feedSnapshot: FeedSnapshot = searchEnabled
    ? { posts: searchPage.posts, asOf: snapshot.asOf }
    : snapshot;
  const feedReady = searchEnabled ? !searchPage.loading || searchPage.posts.length > 0 : ready;
  const feedErr = searchEnabled ? searchPage.error : feedError;

  return (
    <main className={styles.shell}>
      <Masthead onOpenAbout={() => setAboutOpen(true)} />

      <Account
        signerCtl={signerCtl}
        identity={identity}
        vault={vault}
        onOpenAbout={() => setAboutOpen(true)}
      />

      {signerCtl.postingEnabled && (
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
      )}

      {source?.caps.search && (
        <SearchBar
          value={search}
          onSearch={setSearch}
          resultCount={searchEnabled ? searchPage.totalCount : undefined}
        />
      )}

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
      />

      <About
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        signerCtl={signerCtl}
        heads={heads}
        status={status}
        anchor={anchor}
        onReconnect={(url) => reconnect(url)}
        onGraphqlChange={() => {
          setSearch("");
          setGqlEpoch((n) => n + 1);
        }}
      />
    </main>
  );
}
