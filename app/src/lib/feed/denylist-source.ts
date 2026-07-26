// The serve lever, applied at the DATA LAYER rather than at the render sites.
//
// WHY HERE. There is no single render choke point. Post lists funnel through Timeline, but thread
// replies, quote embeds, pinned posts, people rows, who-to-follow, follows lists, the mention
// autocomplete and notifications each carry their own copy of the suppression filter, and three
// surfaces (the profile header, the hover card, the governance poll list) have never had one at all.
// A lever assembled from eight hand-rolled call sites is a lever with eight places to forget, none of
// which any test or lint would catch. `createPapiFeedSource` is the ONE reader in the app, so wrapping
// it puts the omission somewhere it cannot be forgotten, and every surface that reads through the seam
// inherits it whether or not anyone remembered.
//
// The device-local moderation seam (useModeration) gets the same predicate folded in as well, so the
// "N new posts" pill counts what will actually render and a permalinked card knows to render a stub.
// That is defence in depth, not the primary: the data layer is the primary.
//
// WHAT IT DOES NOT TOUCH. The chain. Every post is still in every block and every node still serves
// it; this only changes what THIS deployment renders. Point the same bundle at another endpoint, or
// run a node, and the record is complete. See lib/config/denylist.ts for the full posture.
//
// PAGINATION, WHICH IS THE SHARP EDGE
//
// Dropping posts out of a page leaves `hasNextPage` and `endCursor` intact, so the reader can hand
// back an EMPTY page with a live cursor. Timeline's tail is an IntersectionObserver over a sentinel
// that a short list never pushes out of view, and it re-observes on every `loadMore` identity change,
// so re-observing an already-intersecting sentinel fires the callback immediately. One empty page
// therefore starts a loop that walks the cursor toward post id 0, each hop costing up to six
// `feed_page` state_calls that each rebuild `staker_weights()` over up to `MaxObserved` accounts, to
// append nothing. /explore already documents and guards exactly this for its lens and topic axes; Home,
// profile, bookmarks and lists pass `hasMore` through raw.
//
// So this does NOT hand back an empty-but-more page. It TOPS UP: if a page has no survivors and the
// reader says there is more, it fetches the next one, bounded by MAX_TOP_UP hops. That keeps the fix in
// the layer that caused the problem instead of patching five render sites, and it degrades honestly —
// if the budget is exhausted the page comes back short, which is the same shape the bounded lens reads
// already produce and which /explore's guard already covers.
//
// COST WHEN EMPTY: nothing at all. `withServeDenylist` returns the source unwrapped when the list is
// empty, which is the shipped state, so there is not even a predicate call on the hot path.

import type { Observable } from "rxjs";
import { DENYLIST_EMPTY, isDenied, isDeniedAuthor, isDeniedPost } from "@/lib/config/denylist";
import type {
  CognoPost,
  FeedPage,
  FeedQuery,
  ThreadView,
  ProfileView,
  PollView,
  ViewerPostState,
  FollowEdges,
  Suggestion,
  Ss58,
} from "@/lib/types";
import type { FeedSource, ProfileArgs } from "./source";

/**
 * How many extra pages to pull when a page comes back entirely denied.
 *
 * Small on purpose. This is the same trade the runtime's filtered lenses make with
 * FILTERED_LENS_MAX_HOPS: a bounded chase keeps a pathological list from turning one scroll into an
 * unbounded walk, and coming back short is a better failure than reading the whole chain. An operator
 * denying a large CONTIGUOUS run of post ids should expect the extra reads; denying scattered
 * individual posts costs nothing, because a page is never fully emptied.
 */
const MAX_TOP_UP = 3;

/** Drop denied posts from a list, preserving order. */
export function filterDenied<T extends CognoPost>(posts: T[]): T[] {
  return posts.filter((p) => !isDenied(p));
}

/**
 * Wrap a FeedSource so this deployment stops serving what the operator has listed.
 *
 * Returns `source` UNWRAPPED when nothing is denied, so the shipped build carries no indirection.
 */
export function withServeDenylist(source: FeedSource): FeedSource {
  if (DENYLIST_EMPTY) return source;

  async function page(q: FeedQuery): Promise<FeedPage> {
    let pg = await source.page(q);
    let kept = filterDenied(pg.posts);

    // Top up rather than hand back an empty page with a live cursor. See the header.
    for (let hop = 0; kept.length === 0 && pg.hasNextPage && pg.endCursor && hop < MAX_TOP_UP; hop++) {
      pg = await source.page({ ...q, after: pg.endCursor });
      kept = filterDenied(pg.posts);
    }

    return {
      ...pg,
      posts: kept,
      // `totalCount` is a claim about THIS page's contents on the surfaces that read it, so it must
      // follow the survivors rather than advertise rows that will not render.
      totalCount: pg.totalCount === undefined ? undefined : kept.length,
    };
  }

  async function thread(rootId: bigint, viewer?: Ss58): Promise<ThreadView> {
    const t = await source.thread(rootId, viewer);
    const replies = filterDenied(t.replies);
    // The ROOT is not dropped: `thread()` has no shape for "the focal post is gone", and returning a
    // thread whose root is somebody else's reply would be worse than rendering the stub the card layer
    // already knows how to draw. The permalink is handled at the render seam (useModeration), which
    // is exactly why the predicate is folded in there as well.
    return {
      ...t,
      ancestors: filterDenied(t.ancestors),
      replies,
      // The count is what the UI renders as "N replies"; leaving it whole would promise rows that are
      // not there. Subtract what was dropped rather than using `replies.length` outright: the count is
      // the WHOLE thread's reply total, which can exceed the page of replies actually returned.
      replyCount: Math.max(0, t.replyCount - (t.replies.length - replies.length)),
    };
  }

  async function profile(args: ProfileArgs): Promise<ProfileView> {
    const p = await source.profile(args);
    if (isDeniedAuthor(p.author)) {
      // A denied AUTHOR loses the whole profile surface, not just their posts: the header renders the
      // display name, bio, banner and website, all of which are chain text this deployment has chosen
      // not to serve. Blanking it here is the DATA half; the /u/[address] route renders its
      // not-found body from its own `isDeniedAuthor` check, because it resolves the header from the
      // URL rather than from this object and would otherwise draw a plausible empty account page with
      // live Follow and vote controls on it. Both halves are needed, and neither is redundant: this
      // one also covers every OTHER consumer of `profile()` (the hover card, Settings' own preview).
      return {
        author: null,
        identityHash: null,
        postCount: 0,
        banned: false,
        page: { posts: [], endCursor: null, hasNextPage: false, totalCount: 0, asOf: null },
      };
    }
    return { ...p, page: { ...p.page, posts: filterDenied(p.page.posts) } };
  }

  async function whoToFollow(who: Ss58 | null, limit: number): Promise<Suggestion[]> {
    return (await source.whoToFollow(who, limit)).filter((s) => !isDeniedAuthor(s.author));
  }

  async function searchPeople(q: string, limit: number): Promise<Suggestion[]> {
    return (await source.searchPeople(q, limit)).filter((s) => !isDeniedAuthor(s.author));
  }

  async function poll(hostId: bigint): Promise<PollView> {
    // A poll's OPTION TEXT is user-authored chain text hanging off a denied post, so it goes with the
    // post. Emptying the options is what stops it rendering; the host post itself is already gone from
    // every list, so this only covers a direct read (a permalink, /governance).
    const p = await source.poll(hostId);
    return isDeniedPost(hostId) ? { ...p, options: [], totalWeight: 0n, totalCount: 0 } : p;
  }

  async function followEdges(whoId: Ss58): Promise<FollowEdges> {
    const e = await source.followEdges(whoId);
    return {
      ...e,
      followers: e.followers.filter((a) => !isDeniedAuthor(a)),
      following: e.following.filter((a) => !isDeniedAuthor(a)),
    };
  }

  // Passthroughs. `liveHeadId` is a counter, and the two viewer-state reads are about the VIEWER's own
  // vote, which carries no denied content and which the surfaces above have already filtered the
  // targets of.
  function liveHeadId(): Observable<bigint | null> {
    return source.liveHeadId();
  }
  function viewerPollChoice(hostId: bigint, whoId: Ss58): Promise<number | null> {
    return source.viewerPollChoice(hostId, whoId);
  }
  function viewerPostState(post: bigint, whoId: Ss58): Promise<ViewerPostState> {
    return source.viewerPostState(post, whoId);
  }

  return {
    liveHeadId,
    page,
    thread,
    profile,
    poll,
    viewerPollChoice,
    viewerPostState,
    followEdges,
    whoToFollow,
    searchPeople,
  };
}
