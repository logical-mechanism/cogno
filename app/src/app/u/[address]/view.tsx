"use client";

// ProfileView — the full /u/[address] surface. The client half of a server/client split:
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
// here. The OLD "fee-bearing / fund-your-account" model is OBSOLETE. The Edit/Set-up button
// just opens the edit-profile modal (the form is owned by the Settings surface); capacity exhaustion on
// any tab-card action surfaces via the shared rate-limit toast inside the optimistic hooks.
//
// Tabs (Posts / Replies / Likes; NO Media — D1, the chain is text-only) are CLIENT state synced to the
// ?tab= query via history.pushState (the static route stays /u/[address]). The node serves the WHOLE
// profile directly: the header (name/bio/avatar/counts), the Posts tab, the Likes tab (spec-118 reverse
// maps) AND the reverse Replies tab (`author_replies_page`) — every one of them node-direct.
//

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
import { useSession, useBestBlock } from "@/components/Providers";
import { NO_VIEWER } from "@/lib/optimistic";
import { usePostActions } from "@/hooks/usePostActions";
import { modalActions } from "@/lib/modalStore";
import { useProfile } from "@/hooks/useProfile";
import { useFollow } from "@/hooks/useFollow";
import { useViewerStates } from "@/hooks/useViewerStates";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { useVote } from "@/hooks/useVote";
import { useAccountVoteFor } from "@/hooks/useAccountVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useToaster } from "@/components/toast/ToasterProvider";
import { isPlausibleSs58, handleOf, fallbackDisplayName } from "@/lib/ss58";
import { sanitizeInline } from "@/lib/sanitize";
import { useRouteSegment } from "@/lib/routeSegment";
import type { ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, Ss58 } from "@/components/kit";

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

  // Invalid ss58 → in-app not-found (NOT a hard 404); never attempt a chain read.
  if (!isPlausibleSs58(address)) return <NotFoundInline kind="profile" />;

  // key: every profile shares the one exported route segment ("_"), so React would otherwise keep
  // ProfileBody mounted across /u/A/ → /u/B/ (a mention chip, a hover card, an author click) and carry
  // A's tab + timeline state onto B. Keying on the address restores the per-profile remount.
  return <ProfileBody key={address} address={address} />;
}

function ProfileBody({ address }: { address: Ss58 }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { api, signer, source, viewer, votingPower } = useSession();
  // useBestBlock (the shared, visibility-frozen head), not a private useHeads subscription: a
  // second subscription re-renders on every block even while the tab is hidden, which is exactly
  // what freezing the shared one is for.
  const bestBlock = useBestBlock();

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
  // Coerce a persisted tab back to Posts when there is no reader at all (disconnected). Display
  // fields (name/bio/avatar) still show.
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
    // `viewer: me` lets the node stamp the Posts-tab `myVote` overlay in the same state_call.
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
  // Base counts come from the profile (the chain's denormalized counters); the delta layers on top.
  const [followDelta, setFollowDelta] = useState(0);
  const followerCount = (profile?.followerCount ?? 0) + followDelta;
  const followingCount = profile?.followingCount ?? 0;

  // Retire the optimistic delta once the reconciled base count catches up (so a landed follow isn't
  // double-counted). ProfileBody is keyed on `address` in ProfileView, so /u/A → /u/B REMOUNTS it and the
  // delta resets to 0 on its own — no `address` dep needed here.
  useEffect(() => setFollowDelta(0), [profile?.followerCount]);

  const onToggleFollow = useCallback(
    (target: Ss58, next: boolean) => {
      if (!viewer.writeReady) {
        router.push("/welcome/");
        return;
      }
      if (next) {
        // Roll the optimistic count back if the write fails — the button reverts via useFollow's own
        // isFollowing map, but this local delta is only cleared when the BASE count changes, which a
        // failed follow never does, so it would stay inflated by one until the profile changes.
        follow.follow(target, { onError: () => setFollowDelta((d) => d - 1) });
        setFollowDelta((d) => d + 1);
      } else {
        follow.unfollow(target, { onError: () => setFollowDelta((d) => d + 1) });
        setFollowDelta((d) => d - 1);
      }
    },
    [viewer.writeReady, follow, router],
  );

  // ── followers / following lists: a full-screen sub-view synced to ?follows=followers|following. ──
  // Tapping a follow count opens it (pushState → the header back-arrow / browser Back closes it, via
  // popstate below); switching sides inside replaces (no history stacking). Only reachable through the
  // follow counts, which are omitted when the reader can't serve the graph.
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

  // `follows` belongs to the address it was opened on, and it does: ProfileView keys ProfileBody on
  // `address`, so a soft nav to another profile (a PersonRow <Link>, a mention chip) REMOUNTS this
  // component and `follows` re-initializes from the new URL via its useState initializer above. The
  // popstate listener covers browser back/forward on the SAME profile. (An earlier "adjust follows on a
  // prop change" block guarded a reuse-across-profiles case the key makes impossible — it was dead.)

  // A list FollowButton just follows/unfollows (no header follower-count delta — that's for THIS
  // profile's own counter, driven by onToggleFollow above). Optimism lives in the useFollow hook.
  const onListToggleFollow = useCallback(
    (target: Ss58, next: boolean) => {
      if (!viewer.writeReady) {
        router.push("/welcome/");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.writeReady, follow, router],
  );

  // ── account reputation (header): stake-weighted up/down votes ON this account (spec-202) ──
  // One shared hook, the same one the profile hover card uses — so a vote cast from a hover card is
  // already showing when you land here. It composes the two session caches (the account tally + the
  // viewer's own vote) and rebases the viewer's declared intent over them; the whole bespoke block that
  // used to live here (a composed delta, a settle-on-agreement effect, a pending-flash guard, an unmount
  // reset) is gone, because rebasing makes settling an arithmetic identity rather than a rule.
  //
  // `liveKey: bestBlock` is the one thing this surface asks for that a hover card does not: re-read the
  // tally each block, so somebody ELSE's vote appears without a reload while you sit on the page.
  const {
    vote: shownAccountVote,
    ready: accountVoteReady,
    pending: accountVotePending,
    onUp: onAccountUp,
    onDown: onAccountDown,
  } = useAccountVoteFor(address, { liveKey: bestBlock });

  // ── pinned post: resolve the single id via source.thread(id).root (the seam's one-post resolver). ──
  // Silently omit on 404 / throw / author-mismatch. Only on the Posts tab.
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

  // ── viewer-relative state across the visible cards (the filled heart) ──
  const postIds = useMemo(() => {
    const ids = listPosts.map((p) => p.id);
    if (pinned) ids.unshift(pinned.id);
    return ids;
  }, [listPosts, pinned]);
  // Node-served posts (list + pinned) carry the overlay → skip the per-card viewer read for them.
  const carriedStates = useMemo(
    () => carriedViewerStates(pinned ? [pinned, ...listPosts] : listPosts),
    [listPosts, pinned],
  );
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── per-card write hooks (mirrors the home surface; D2 Like==up) ──
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const { toast } = useToaster();

  const handlers = usePostActions({ viewer, viewerStates, vote, pin, toast, follow });

  // ── derived header bits ──
  const hasProfile = !!(
    (profile?.displayName && profile.displayName.trim()) ||
    (profile?.bio && profile.bio.trim()) ||
    (profile?.avatar && profile.avatar.trim()) ||
    (profile?.banner && profile.banner.trim()) ||
    (profile?.location && profile.location.trim()) ||
    (profile?.website && profile.website.trim())
  );
  // Sticky-header <h1> renders this raw (not via DisplayName) — harden it here. Fall back to the SAME
  // cogno-… name the body's <DisplayName> uses, not the @handle, so a nameless profile doesn't show two
  // different "names" a few pixels apart (header "@5Grw…utQY" vs body "cogno-Grwkut").
  const headerName = sanitizeInline(profile?.displayName?.trim() ?? "") || fallbackDisplayName(address);
  const postCount = profile?.postCount ?? 0;
  const banned = profile?.banned === true;
  const handle = handleOf(address);

  const onEditProfile = useCallback(() => modalActions.openEditProfile(), []);

  // ── empty-state copy per tab ──
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
    // Posts (also the who-is-this-when-unbound fallback: never a 404, the empty shell).
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
            observedRoles={profile?.observedRoles}
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
            canAccountVote={canAccountVote && accountVoteReady}
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
                inline error+Retry row; the data layer prefers a PAPI-direct fallback over a
                hard error); (b) no posts + a pinned card → the pinned block stands alone (nothing more);
                (c) no posts + nothing pinned → a PROFILE-specific EmptyState (Timeline only knows
                feed|follows, so we render our own per-tab copy). */}
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
                  viewer.writeReady ? modalActions.openCompose() : router.push("/welcome/")
                }
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
