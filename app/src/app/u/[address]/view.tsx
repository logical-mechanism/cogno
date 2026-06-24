"use client";

// ProfileView — the full /u/[address] surface (doc 07). The client half of a server/client split:
// page.tsx is the static-export server wrapper (generateStaticParams placeholder) and reads NOTHING;
// this reads the live ss58 from useParams(), validates it (plausible base58/length → else in-app
// not-found, NOT a hard 404), and renders the profile chrome + three tabs.
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
// ?tab= query via history.pushState (the static route stays /u/[address]). On PAPI-direct
// (caps.profiles === false) only the Posts tab + the bare ss58/identicon header show; counts + bio are
// omitted.
//
// NOTIFICATIONS SEAM (doc 07 §14, deferred): a Followed{ followee === viewer } is a "new follower"; the
// Voted / Reposted edges raised from the tab cards targeting this author, and replies/quotes of this
// author's posts, are exactly what a future /notifications surface folds. No bell/route is built here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import styles from "./view.module.css";
import { StickyHeader, NotFoundInline } from "@/components/AppShell";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Timeline } from "@/components/Timeline";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { ProfileTabs, type ProfileTab } from "@/components/profile/ProfileTabs";
import { PinnedPostBlock } from "@/components/profile/PinnedPostBlock";
import { useSession } from "@/components/Providers";
import { useHeads } from "@/hooks/useHeads";
import { useProfile } from "@/hooks/useProfile";
import { useFollow } from "@/hooks/useFollow";
import { useViewerStates } from "@/hooks/useViewerStates";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useRepost } from "@/hooks/useRepost";
import { modalActions } from "@/lib/modalStore";
import { isPlausibleSs58, handleOf } from "@/lib/ss58";
import type { ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, ViewerPostState, Ss58, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

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
  const params = useParams<{ address: string }>();
  const address = params?.address ?? "";

  // Invalid ss58 → in-app not-found (NOT a hard 404); never attempt a chain read (doc 07 §10).
  if (!isPlausibleSs58(address)) return <NotFoundInline kind="profile" />;

  return <ProfileBody address={address} />;
}

function ProfileBody({ address }: { address: Ss58 }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { api, client, signer, source, viewer, votingPower } = useSession();
  const bestBlock = useHeads(client).best?.number ?? null;

  const me = viewer.address ?? null;
  const isSelf = me != null && me === address;
  const canFollow = source?.caps.follows === true;
  const canProfiles = source?.caps.profiles === true; // display name / bio / avatar (node + indexer)
  const canReplies = source?.caps.profileReplies === true; // replies-by-author tab (indexer-only)
  const canLikes = source?.caps.profileLikes === true; // likes tab (node-direct since spec-118)
  const paginationCapable = source?.caps.pagination === true;

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
    () => ({ author: address, tab: tabArg(activeTab) }),
    [address, activeTab],
  );
  const { profile, posts, loading, error } = useProfile(source, profileArgs, bestBlock);

  // ── follow graph + optimistic toggle (header). READ gated on caps.follows; WRITE always allowed. ──
  const follow = useFollow(api, signer, source, me);
  const isFollowing = follow.isFollowing(address);

  // Header counts: optimistically bumped/decremented as the viewer follows/unfollows from THIS header.
  // Base counts come from the profile (indexer-denormalized); the optimistic delta layers on top.
  const [followDelta, setFollowDelta] = useState(0);
  const followerCount = (profile?.followerCount ?? 0) + followDelta;
  const followingCount = profile?.followingCount ?? 0;

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
      .thread(pinnedId)
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
  }, [source, pinnedId, activeTab, address]);

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
  const viewerStates = useViewerStates(source, postIds, me);

  // ── per-card write hooks (mirrors the home surface; D2 Like==up, D3 permanent repost) ──
  const vote = useVote(api, signer, votingPower ?? 0n);
  const repost = useRepost(api, signer);
  const { pin } = usePinPost(api, signer);

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
      onRepost: (post) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        repost.repost(post.id, cur.reposted);
      },
      onShare: (post) => {
        const url = `${typeof window !== "undefined" ? window.location.origin : ""}/post/${post.id}/`;
        void navigator.clipboard
          ?.writeText(url)
          .then(() => undefined)
          .catch(() => undefined);
      },
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, repost, pin],
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
          <Skeleton variant="post" count={6} />
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
            hasProfile={hasProfile}
            showCounts={canFollow}
            followingCount={followingCount}
            followerCount={followerCount}
            viewer={viewer}
            isFollowing={isFollowing}
            onEditProfile={onEditProfile}
            onToggleFollow={onToggleFollow}
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
                onRetry={() => router.refresh()}
                hasMore={false}
                paginationCapable={paginationCapable}
                emptyTitle={emptyForTab.title}
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
