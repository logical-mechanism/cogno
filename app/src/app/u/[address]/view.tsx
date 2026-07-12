"use client";

// ProfileView — the full /u/[address] surface (doc 07). The client half of a server/client split:
// page.tsx is the static-export server wrapper (generateStaticParams placeholder) and reads NOTHING;
// this reads the live ss58 from the URL (useRouteSegment, NOT useParams — see lib/routeSegment),
// validates it (plausible base58/length → else in-app not-found, NOT a hard 404), and renders the
// profile chrome + three tabs.
//
// Composition (thin orchestrator): StickyHeader(back + name + "N posts" + <ProfileTabs>) → <ProfileHeader>
// (banner / avatar / action-button switch / name / handle / bio / counts / banned note) → the active
// tab body = a <Timeline> of PostCards (+ a hoisted <PinnedPostBlock> on Posts).
//
// SPEC 117 FEELESS: pallet-profile writes (set_profile / pin_post / …) are feeless + capacity-metered
// + optimistic exactly like a post — there is NO funding gate / balance check / fee-estimate anywhere
// here. The OLD doc-07 §9.4 "fee-bearing / fund-your-account" model is OBSOLETE. The Edit/Set-up button
// just opens the edit-profile modal (the form is owned by the Settings surface); capacity exhaustion on
// any tab-card action surfaces via the shared rate-limit toast inside the optimistic hooks.
//
// Tabs (Posts / Replies / Likes; NO Media — D1, the chain is text-only) are CLIENT state synced to the
// ?tab= query via history.pushState (the static route stays /u/[address]). The node serves the WHOLE
// profile directly: the header (name/bio/avatar/counts), the Posts tab, the Likes tab (spec-118 reverse
// maps) AND the reverse Replies tab (spec-200 `author_replies_page`) — nothing needs an indexer.
//
// NOTIFICATIONS SEAM (doc 07 §14, deferred): a Followed{ followee === viewer } is a "new follower"; the
// Voted / Reposted edges raised from the tab cards targeting this author, and replies/quotes of this
// author's posts, are exactly what a future /notifications surface folds. No bell/route is built here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./view.module.css";
import { StickyHeader, NotFoundInline } from "@/components/AppShell";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Timeline } from "@/components/Timeline";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { ProfileTabs, type ProfileTab } from "@/components/profile/ProfileTabs";
import { FollowsPanel } from "@/components/profile/FollowsPanel";
import { PinnedPostBlock } from "@/components/profile/PinnedPostBlock";
import { useSession } from "@/components/Providers";
import { useHeads } from "@/hooks/useHeads";
import { useProfile } from "@/hooks/useProfile";
import { useFollow } from "@/hooks/useFollow";
import { useViewerStates } from "@/hooks/useViewerStates";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { useVote } from "@/hooks/useVote";
import { useAccountVote } from "@/hooks/useAccountVote";
import { usePinPost } from "@/hooks/usePinPost";
import { modalActions } from "@/lib/modalStore";
import { useToaster } from "@/components/toast/ToasterProvider";
import { sharePostWithToast } from "@/lib/share";
import { isPlausibleSs58, handleOf } from "@/lib/ss58";
import { useRouteSegment } from "@/lib/routeSegment";
import type { ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, ViewerPostState, Ss58, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null };

/** Map a ProfileTab to the seam's tab arg (Posts → undefined / Replies / Likes). */
function tabArg(tab: ProfileTab): ProfileArgs["tab"] {
  if (tab === "replies") return "replies";
  if (tab === "likes") return "likes";
  return undefined;
}

function parseTabParam(raw: string | null): ProfileTab {
  return raw === "replies" || raw === "likes" ? raw : "posts";
}

export function ProfileView() {
  // The ss58 comes from the URL, not useParams() — in the static export the router state tree carries
  // the "_" placeholder for every profile (see lib/routeSegment).
  const address = useRouteSegment("u");

  // null = pre-hydration. Every profile is served the SAME prerendered shell, so the first render is
  // the one render that must not judge the address: rendering not-found here is what the server would
  // bake into that shared HTML, flashing "This account doesn't exist" on every cold deep link.
  if (address === null) {
    return (
      <>
        <StickyHeader showBack title="Profile" />
        <div aria-busy="true">
          <Skeleton variant="profileHeader" />
          <Skeleton variant="post" count={6} />
        </div>
      </>
    );
  }

  // Invalid ss58 → in-app not-found (NOT a hard 404); never attempt a chain read (doc 07 §10).
  if (!isPlausibleSs58(address)) return <NotFoundInline kind="profile" />;

  // key: every profile shares the one exported route segment ("_"), so React would otherwise keep
  // ProfileBody mounted across /u/A/ → /u/B/ (a mention chip, a hover card, an author click) and carry
  // A's tab + timeline state onto B. Keying on the address restores the per-profile remount.
  return <ProfileBody key={address} address={address} />;
}

function ProfileBody({ address }: { address: Ss58 }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { api, client, signer, source, viewer, votingPower } = useSession();
  const bestBlock = useHeads(client).best?.number ?? null;

  const me = viewer.address ?? null;
  const isSelf = me != null && me === address;
  // The node serves every one of these, so they collapse to "is the reader connected yet".
  const canFollow = source != null;
  const canAccountVote = source != null;
  const canProfiles = source != null;
  const canReplies = source != null;
  const canLikes = source != null;
  const paginationCapable = source != null;

  // ── active tab: client state synced to ?tab= (the static route stays /u/[address]). ──
  const [tab, setTab] = useState<ProfileTab>(() => parseTabParam(searchParams?.get("tab") ?? null));
  // Coerce a persisted tab the active reader can't serve back to Posts (the Replies tab needs the
  // indexer; Likes is node-direct). Display fields (name/bio/avatar) still show.
  const activeTab: ProfileTab =
    (tab === "replies" && !canReplies) || (tab === "likes" && !canLikes) ? "posts" : tab;

  const onTabChange = useCallback(
    (next: ProfileTab) => {
      setTab(next);
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (next === "posts") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      // Tab is query state, not a route change — pushState keeps <main> mounted (no full nav).
      window.history.pushState(null, "", url.toString());
    },
    [],
  );

  // ── profile + the active tab's posts (one round-trip per tab via the seam) ──
  const profileArgs = useMemo<ProfileArgs>(
    // `viewer: me` lets a spec-120 node stamp the Posts-tab overlay node-side; keyed/indexer ignore it.
    () => ({ author: address, tab: tabArg(activeTab), viewer: me ?? undefined }),
    [address, activeTab, me],
  );
  const { profile, posts, loading, error, hasMore, loadingMore, loadMore, reload } = useProfile(
    source,
    profileArgs,
    bestBlock,
  );

  // ── follow graph + optimistic toggle (header). ──
  const follow = useFollow(api, signer, source, me);
  const isFollowing = follow.isFollowing(address);

  // Header counts: optimistically bumped/decremented as the viewer follows/unfollows from THIS header.
  // Base counts come from the profile (indexer-denormalized); the optimistic delta layers on top.
  const [followDelta, setFollowDelta] = useState(0);
  const followerCount = (profile?.followerCount ?? 0) + followDelta;
  const followingCount = profile?.followingCount ?? 0;

  // Retire the optimistic delta once the reconciled base count catches up (so a landed follow isn't
  // double-counted), and whenever the viewed profile changes — ProfileBody is NOT remounted across
  // /u/A → /u/B, so a delta accrued on profile A must not leak onto B.
  useEffect(() => setFollowDelta(0), [address, profile?.followerCount]);

  const onToggleFollow = useCallback(
    (target: Ss58, next: boolean) => {
      if (viewer.status !== "ready") {
        router.push("/welcome/");
        return;
      }
      // NOTIFICATIONS SEAM (doc 07 §14): this Followed edge is a future "new follower" notification.
      if (next) {
        follow.follow(target);
        setFollowDelta((d) => d + 1);
      } else {
        follow.unfollow(target);
        setFollowDelta((d) => d - 1);
      }
    },
    [viewer.status, follow, router],
  );

  // ── followers / following lists: a full-screen sub-view synced to ?follows=followers|following. ──
  // Tapping a follow count opens it (pushState → the header back-arrow / browser Back closes it, via
  // popstate below); switching sides inside replaces (no history stacking). caps.follows already gates
  // the counts, so this is only reachable when the reader serves the follow graph.
  const [follows, setFollows] = useState<"followers" | "following" | null>(() => {
    const v = searchParams?.get("follows");
    return v === "followers" || v === "following" ? v : null;
  });
  useEffect(() => {
    const onPop = () => {
      const v = new URLSearchParams(window.location.search).get("follows");
      setFollows(v === "followers" || v === "following" ? v : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const openFollows = useCallback((which: "followers" | "following") => {
    setFollows(which);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("follows", which);
    window.history.pushState(null, "", url.toString()); // Back / the header ← closes it
  }, []);
  const switchFollows = useCallback((which: "followers" | "following") => {
    setFollows(which);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("follows", which);
    window.history.replaceState(null, "", url.toString()); // side-switch: no history stacking
  }, []);

  // `follows` belongs to the address it was opened on. ProfileBody is REUSED (not remounted) across
  // /u/A → /u/B, and a soft nav to another profile — e.g. tapping a PersonRow's <Link> inside the list
  // — changes `address` but does NOT fire popstate, so without this the previous account's follow panel
  // would render under the new /u/<b>/ URL. Re-derive `follows` from the new URL DURING render (React's
  // "adjust state on a prop change" pattern — no wrong-surface flash); the popstate listener above still
  // covers browser back/forward on the SAME profile.
  const [followsAddr, setFollowsAddr] = useState(address);
  if (followsAddr !== address) {
    setFollowsAddr(address);
    const v =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("follows")
        : null;
    setFollows(v === "followers" || v === "following" ? v : null);
  }

  // A list FollowButton just follows/unfollows (no header follower-count delta — that's for THIS
  // profile's own counter, driven by onToggleFollow above). Optimism lives in the useFollow hook.
  const onListToggleFollow = useCallback(
    (target: Ss58, next: boolean) => {
      if (viewer.status !== "ready") {
        router.push("/welcome/");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.status, follow, router],
  );

  // ── account reputation (header): stake-weighted up/down votes ON this account (spec-202). The base
  // tally + the viewer's own vote come from the profile read; useAccountVote layers a local optimistic
  // override (single-target, single-surface — it never touches the app-wide overlay). ──
  const accountVoteHook = useAccountVote(api, signer, votingPower ?? 0n);
  const {
    upvote: upvoteAccount,
    downvote: downvoteAccount,
    merge: mergeAccountVote,
    reset: resetAccountVote,
    isOptimistic: isAccountVoteOptimistic,
    pending: accountVotePendingRaw,
  } = accountVoteHook;
  const accountVoteBase = useMemo(
    () => ({
      myVote: profile?.myAccountVote ?? null,
      upWeight: profile?.accountUpWeight ?? 0n,
      downWeight: profile?.accountDownWeight ?? 0n,
      upCount: profile?.accountUpCount ?? 0,
      downCount: profile?.accountDownCount ?? 0,
    }),
    [
      profile?.myAccountVote,
      profile?.accountUpWeight,
      profile?.accountDownWeight,
      profile?.accountUpCount,
      profile?.accountDownCount,
    ],
  );
  const shownAccountVote = mergeAccountVote(address, accountVoteBase);
  // Scope the pending-disable to THIS profile: `pending` is shared across the reused ProfileBody, so a
  // vote in flight on /u/A must not disable /u/B's arrows — only when THIS target carries the override.
  const accountVotePending = accountVotePendingRaw && isAccountVoteOptimistic(address);
  // Retire a SETTLED override once a fresh read of the viewer's OWN vote matches what we show (merge
  // already renders the base when settled, so this only keeps the record + `isOptimistic` clean). The
  // separate cleanup below drops this address's override on a profile switch (ProfileBody is reused
  // across /u/A → /u/B) so a not-yet-reconciled override can't leak back on return.
  useEffect(() => {
    // Only retire once NO tx is in flight: a net-zero re-vote (Up then clear) transiently makes
    // `o.myVote === base.myVote` while both txs are still pending, and dropping the override then would
    // expose an intermediate read (a brief "Up" flash before the clear lands). Waiting for `!pending`
    // keeps the override holding the intended end-state until the chain has fully caught up.
    if (
      !accountVotePendingRaw &&
      isAccountVoteOptimistic(address) &&
      (profile?.myAccountVote ?? null) === shownAccountVote.myVote
    ) {
      resetAccountVote(address);
    }
  }, [
    accountVotePendingRaw,
    address,
    profile?.myAccountVote,
    shownAccountVote.myVote,
    isAccountVoteOptimistic,
    resetAccountVote,
  ]);
  useEffect(() => {
    return () => resetAccountVote(address);
  }, [address, resetAccountVote]);

  const onAccountUp = useCallback(() => {
    if (viewer.status !== "ready") return void router.push("/welcome/");
    upvoteAccount(address, shownAccountVote.myVote);
  }, [viewer.status, router, upvoteAccount, address, shownAccountVote.myVote]);
  const onAccountDown = useCallback(() => {
    if (viewer.status !== "ready") return void router.push("/welcome/");
    downvoteAccount(address, shownAccountVote.myVote);
  }, [viewer.status, router, downvoteAccount, address, shownAccountVote.myVote]);

  // ── pinned post: resolve the single id via source.thread(id).root (the seam's one-post resolver). ──
  // Silently omit on 404 / throw / author-mismatch (doc 07 §5.1 / §11). Only on the Posts tab.
  const pinnedId = profile?.pinnedPostId ?? null;
  const [pinned, setPinned] = useState<CognoPost | null>(null);
  useEffect(() => {
    if (!source || pinnedId == null || activeTab !== "posts") {
      setPinned(null);
      return;
    }
    let cancelled = false;
    source
      .thread(pinnedId, me ?? undefined)
      .then((t) => {
        // Only render it if it resolved AND it's actually this author's post.
        if (!cancelled) setPinned(t.root.author === address ? t.root : null);
      })
      .catch(() => {
        if (!cancelled) setPinned(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source, pinnedId, activeTab, address, me]);

  // De-dupe: if the pinned post is also in the first page, show it only as the pinned block.
  const listPosts = useMemo(() => {
    if (!pinned) return posts;
    return posts.filter((p) => p.id !== pinned.id);
  }, [posts, pinned]);

  // ── viewer-relative state across the visible cards (filled heart / active repost) ──
  const postIds = useMemo(() => {
    const ids = listPosts.map((p) => p.id);
    if (pinned) ids.unshift(pinned.id);
    return ids;
  }, [listPosts, pinned]);
  // Node-served posts (list + pinned) carry the overlay → skip the per-card Reposts scan for them.
  const carriedStates = useMemo(
    () => carriedViewerStates(pinned ? [pinned, ...listPosts] : listPosts),
    [listPosts, pinned],
  );
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── per-card write hooks (mirrors the home surface; D2 Like==up) ──
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const { toast } = useToaster();

  // NOTIFICATIONS SEAM (doc 07 §14): the Voted / Reposted / reply / quote edges raised here targeting
  // this profile's author are what a future useNotifications(author) folds — deferred, seam left.
  const handlers = useMemo<PostActionCallbacks>(
    () => ({
      onOpen: (id) => router.push(`/post/${id}/`),
      onAuthorOpen: (addr) => router.push(`/u/${addr}/`),
      onReply: (post) =>
        viewer.status === "ready" ? modalActions.openReply(post.id) : router.push("/welcome/"),
      onQuote: (post) =>
        viewer.status === "ready" ? modalActions.openQuote(post.id) : router.push("/welcome/"),
      onLike: (post, next) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        if (next) vote.like(post.id, cur);
        else vote.unlike(post.id, cur);
      },
      onDownvote: (post, next) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        if (next) vote.downvote(post.id, cur);
        else vote.clear(post.id, cur);
      },
      onShare: (post) => void sharePostWithToast(post.id, toast),
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, pin, toast],
  );

  // ── derived header bits ──
  const hasProfile = !!(
    (profile?.displayName && profile.displayName.trim()) ||
    (profile?.bio && profile.bio.trim()) ||
    (profile?.avatar && profile.avatar.trim()) ||
    (profile?.banner && profile.banner.trim()) ||
    (profile?.location && profile.location.trim()) ||
    (profile?.website && profile.website.trim())
  );
  const headerName = profile?.displayName?.trim() || handleOf(address);
  const postCount = profile?.postCount ?? 0;
  const banned = profile?.banned === true;
  const handle = handleOf(address);

  const onEditProfile = useCallback(() => modalActions.openEditProfile(), []);

  // ── empty-state copy per tab (doc 07 §11 / §6) ──
  const emptyForTab = useMemo(() => {
    if (activeTab === "replies") {
      return isSelf
        ? { variant: "replies" as const, title: "You haven't replied to anything yet." }
        : { variant: "replies" as const, title: `${handle} hasn't replied yet.` };
    }
    if (activeTab === "likes") {
      return isSelf
        ? { variant: "profile" as const, title: "Posts you like show up here." }
        : { variant: "profile" as const, title: `${handle} hasn't liked any posts yet.` };
    }
    // Posts (also the who-is-this-when-unbound fallback — §6: never a 404, the empty shell).
    return isSelf
      ? {
          variant: "profile" as const,
          title: hasProfile ? "You haven't posted anything yet." : "Set up your profile and post something.",
          action: { label: "Compose", onClick: () => modalActions.openCompose() },
        }
      : { variant: "profile" as const, title: `${handle} hasn't posted yet.` };
  }, [activeTab, isSelf, handle, hasProfile]);

  // ── cold load: header skeleton + post skeletons, no layout shift when data lands ──
  const cold = loading && !profile;

  // Followers / Following sub-view (X-exact): while active it REPLACES the profile chrome. Gated on
  // canFollow so a stale ?follows= deep-link on a reader that can't serve the graph falls back to the
  // profile. The profile hooks above stay mounted, so closing it doesn't refetch the profile.
  if (canFollow && follows) {
    return (
      <FollowsPanel
        address={address}
        name={headerName}
        side={follows}
        followerCount={followerCount}
        followingCount={followingCount}
        source={source}
        viewer={viewer}
        isFollowing={follow.isFollowing}
        onToggleFollow={onListToggleFollow}
        onSwitch={switchFollows}
      />
    );
  }

  return (
    <>
      <StickyHeader
        showBack
        title={headerName}
        subtitle={`${postCount} ${postCount === 1 ? "post" : "posts"}`}
        tabs={
          <ProfileTabs
            active={activeTab}
            onChange={onTabChange}
            showReplies={canReplies}
            showLikes={canLikes}
          />
        }
      />

      {cold ? (
        <div aria-busy="true">
          <Skeleton variant="profileHeader" />
          {/* Keep the tabpanel container in the DOM during cold load so ProfileTabs' aria-controls
              target always exists. */}
          <div
            id="cg-profile-panel"
            role="tabpanel"
            aria-labelledby={`cg-ptab-${activeTab}`}
            className={styles.panel}
          >
            <Skeleton variant="post" count={6} />
          </div>
        </div>
      ) : (
        <>
          <ProfileHeader
            address={address}
            displayName={profile?.displayName}
            bio={canProfiles ? profile?.bio : undefined}
            avatar={profile?.avatar}
            banner={profile?.banner}
            location={canProfiles ? profile?.location : undefined}
            website={canProfiles ? profile?.website : undefined}
            banned={banned}
            isSelf={isSelf}
            followsYou={canFollow && !isSelf && follow.followers.includes(address)}
            hasProfile={hasProfile}
            showCounts={canFollow}
            followingCount={followingCount}
            followerCount={followerCount}
            onOpenFollowing={() => openFollows("following")}
            onOpenFollowers={() => openFollows("followers")}
            viewer={viewer}
            isFollowing={isFollowing}
            onEditProfile={onEditProfile}
            onToggleFollow={onToggleFollow}
            canAccountVote={canAccountVote}
            accountVote={shownAccountVote}
            accountVotePending={accountVotePending}
            onAccountUp={onAccountUp}
            onAccountDown={onAccountDown}
          />

          <div
            id="cg-profile-panel"
            role="tabpanel"
            aria-labelledby={`cg-ptab-${activeTab}`}
            className={styles.panel}
          >
            {/* Pinned post (Posts tab only), hoisted above the list; silently omitted on miss. */}
            {activeTab === "posts" && pinned && (
              <PinnedPostBlock
                post={pinned}
                viewer={viewerStates.get(pinned.id) ?? NO_VIEWER}
                gate={viewer}
                handlers={handlers}
              />
            )}

            {/* Body: (a) loading / has posts / a read-error → Timeline (it owns the skeleton + the
                inline error+Retry row, doc 07 §11; the data layer prefers a PAPI-direct fallback over a
                hard error); (b) no posts + a pinned card → the pinned block stands alone (nothing more);
                (c) no posts + nothing pinned → a PROFILE-specific EmptyState (Timeline only knows
                feed|follows, so we render our own per-tab copy, doc 07 §6/§11). */}
            {loading || listPosts.length > 0 || error ? (
              <Timeline
                posts={listPosts}
                gate={viewer}
                viewerStates={viewerStates}
                handlers={handlers}
                loading={loading && listPosts.length === 0}
                error={error}
                onRetry={reload}
                hasMore={hasMore}
                onLoadMore={loadMore}
                loadingMore={loadingMore}
                paginationCapable={paginationCapable}
                // Match the standalone EmptyState below. Passing only the title let `emptyVariant` fall
                // through to Timeline's `feed` default, so a profile whose read FAILED rendered the feed
                // preset — "Find some people to follow." under an error row — and silently dropped the
                // owner's Compose CTA.
                emptyVariant={emptyForTab.variant}
                emptyTitle={emptyForTab.title}
                emptyAction={"action" in emptyForTab ? emptyForTab.action : undefined}
                onCompose={() =>
                  viewer.status === "ready" ? modalActions.openCompose() : router.push("/welcome/")
                }
                api={api}
                signer={signer}
              />
            ) : pinned ? null : (
              <EmptyState
                variant={emptyForTab.variant}
                title={emptyForTab.title}
                action={"action" in emptyForTab ? emptyForTab.action : undefined}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}
