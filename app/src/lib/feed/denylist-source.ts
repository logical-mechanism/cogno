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
// COST WHEN EMPTY: one `Array.filter` per page over an O(1) predicate that returns false on its first
// line. The wrap is unconditional because the list can now arrive at runtime (/denylist.json), after
// the moment a wrap-or-not decision would have been made — see the note on `withServeDenylist`.

import type { Observable } from "rxjs";
import { isDenied, isDeniedAuthor, isDeniedPost } from "@/lib/config/denylist";
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
import type {
  PollChoices,
  PollRoster,
  PollVoter,
} from "@/lib/chain/social-reads";
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
  // ⛔ This used to `return source` unwrapped when the list was empty. That was a correct
  // optimization while the only source was a build-time env var, and it became a silent hole the
  // moment /denylist.json could arrive later: the wrap decision is made ONCE, when the api connects,
  // so a list that landed a moment after it would have been parsed, validated, logged — and then
  // consulted by nothing at all. The lever would read as working right up until someone checked.
  //
  // Wrapping unconditionally costs one `Array.filter` per page with an O(1) predicate that returns
  // false on its first line while the sets are empty (`isDeniedAuthor` checks `size === 0` before it
  // decodes anything). The top-up loop cannot engage either: with nothing denied every post survives,
  // so `kept.length === 0` implies the page arrived empty — and the loop's own guard now excludes that
  // case. (This paragraph used to draw the opposite conclusion from the same sentence, and the loop
  // believed it: `kept.length === 0` is satisfied by an empty page, which is the ONE case the top-up
  // must not chase.)

  async function page(q: FeedQuery): Promise<FeedPage> {
    let pg = await source.page(q);
    let kept = filterDenied(pg.posts);

    // Top up rather than hand back an empty page with a live cursor. See the header.
    //
    // `pg.posts.length > 0` is the whole point of this guard: the loop exists for a page the DENYLIST
    // emptied, and `kept.length === 0` alone cannot tell that apart from a page that arrived empty.
    // Empty-with-a-live-cursor is routine upstream — `search_posts` returns a cursor whenever it
    // exhausts its scan budget without reaching id 0, matched or not — so every such page cost 3 extra
    // full chases. On the mentions probe (maxHops 8, refolded every 120s and after every post, per
    // signed-in tab) that is 32 `search_posts` state_calls instead of 8, against a single operator-run
    // node. `pg` is reassigned inside the loop, so consecutive fully-denied pages still chase, which is
    // the documented purpose.
    for (
      let hop = 0;
      pg.posts.length > 0 &&
      kept.length === 0 &&
      pg.hasNextPage &&
      pg.endCursor &&
      hop < MAX_TOP_UP;
      hop++
    ) {
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
      // `parent` is a SEPARATE field from `ancestors` — the richer QuotedRef that ThreadView draws as
      // the "Replying to <name>" line above the focal card — so filtering the chain does not touch it,
      // and it carries the parent author's chosen display name. Dropping it falls back to the bare
      // tappable "#id" the reader already renders when the ref is absent, which names nobody. (The
      // PAPI reader does not populate this today; a node-served or indexer-backed one would, and
      // "currently unreachable" is not a property this lever should depend on.)
      parent:
        t.parent && isDenied({ id: t.parent.id, author: t.parent.author })
          ? undefined
          : t.parent,
      // The count is what the UI renders as "N replies"; leaving it whole would promise rows that are
      // not there. Subtract what was dropped rather than using `replies.length` outright: the count is
      // the WHOLE thread's reply total, which can exceed the page of replies actually returned.
      replyCount: Math.max(
        0,
        t.replyCount - (t.replies.length - replies.length),
      ),
    };
  }

  async function repliesPage(
    parentId: bigint,
    beforeSeq: bigint | null,
    limit: number,
    viewer?: Ss58,
  ): Promise<{ posts: CognoPost[]; nextCursor: bigint | null }> {
    const page = await source.repliesPage(parentId, beforeSeq, limit, viewer);
    // Filter the posts, NEVER the cursor: `nextCursor` is a position in the parent's reply spine, so
    // dropping denied replies must shorten this page rather than move where the next one starts.
    // A page that filters down to nothing still carries its cursor, so the caller keeps walking.
    return { ...page, posts: filterDenied(page.posts) };
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
        page: {
          posts: [],
          endCursor: null,
          hasNextPage: false,
          totalCount: 0,
          asOf: null,
        },
      };
    }
    return { ...p, page: { ...p.page, posts: filterDenied(p.page.posts) } };
  }

  async function whoToFollow(
    who: Ss58 | null,
    limit: number,
  ): Promise<Suggestion[]> {
    return (await source.whoToFollow(who, limit)).filter(
      (s) => !isDeniedAuthor(s.author),
    );
  }

  async function searchPeople(q: string, limit: number): Promise<Suggestion[]> {
    return (await source.searchPeople(q, limit)).filter(
      (s) => !isDeniedAuthor(s.author),
    );
  }

  async function poll(hostId: bigint): Promise<PollView> {
    // A poll's OPTION TEXT is user-authored chain text hanging off a denied post, so it goes with the
    // post. Emptying the options is what stops it rendering; the host post itself is already gone from
    // every list, so this only covers a direct read (a permalink, /governance).
    const p = await source.poll(hostId);
    return isDeniedPost(hostId)
      ? { ...p, options: [], totalWeight: 0n, totalCount: 0 }
      : p;
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
  function viewerPollChoice(
    hostId: bigint,
    whoId: Ss58,
  ): Promise<number | null> {
    return source.viewerPollChoice(hostId, whoId);
  }

  async function pollChoices(
    hostId: bigint,
    authors: readonly Ss58[],
  ): Promise<PollChoices> {
    // A denied HOST takes its option labels with it, exactly as `poll()` above empties them: the labels
    // are user-authored chain text hanging off that post. With no labels nothing can render a chip, so
    // the choices are moot, but they go too rather than being left for a future caller to misuse.
    if (isDeniedPost(hostId)) return { labels: [], choices: new Map() };
    // A denied AUTHOR is dropped from the result even though the caller asked for them by name. Every
    // surface that feeds this list already filters denied authors out, so this is defence in depth
    // rather than the only guard, and it is cheap.
    //
    // THE SWEEP AFTER IT IS NOT REDUNDANT with the filter before it, although today's single reader
    // makes it look that way. `FeedSource.pollChoices` does not promise that the keys it answers with
    // are a subset of the accounts it was given, and it should not have to: a node-served or
    // indexer-backed reader could reasonably answer from a per-poll aggregate. The request filter keeps
    // us from ASKING about a denied account; the sweep keeps a reader that volunteers one from putting
    // their chip on a reply. Deleting it is a silent regression the day a second reader lands.
    const { labels, choices } = await source.pollChoices(
      hostId,
      authors.filter((a) => !isDeniedAuthor(a)),
    );
    for (const a of choices.keys()) if (isDeniedAuthor(a)) choices.delete(a);
    return { labels, choices };
  }
  function viewerPostState(
    post: bigint,
    whoId: Ss58,
  ): Promise<ViewerPostState> {
    return source.viewerPostState(post, whoId);
  }

  async function pollVoters(hostId: bigint): Promise<PollRoster> {
    // A denied HOST loses its roster with its option labels: without labels there is nothing to render a
    // position as, and a bare list of accounts beside a delisted poll is worse than nothing.
    if (isDeniedPost(hostId))
      return { voters: [], labels: [], truncated: false };
    // A denied AUTHOR is dropped from the list. This is the primary guard, not defence in depth: the
    // roster is the ONE surface that enumerates accounts from storage rather than receiving them from a
    // read that has already been filtered.
    //
    // `truncated` is passed through UNTOUCHED, and must be. It is a fact about the read that happened
    // upstream of this filter, so recomputing it from the shortened list would let one denied account
    // inside the cap turn a truncated roster into one that claims to be the whole electorate.
    const roster = await source.pollVoters(hostId);
    return {
      ...roster,
      voters: roster.voters.filter((v) => !isDeniedAuthor(v.who)),
    };
  }

  // Same two guards as `pollVoters`, applied per PAGE. A denied host yields an empty page AND a null
  // cursor, so the caller stops rather than walking a prefix it will never be allowed to show. A denied
  // author is dropped from the page while the CURSOR is passed through untouched: the cursor is a
  // position in storage, not a count, so shortening a page must never move it — recomputing it from the
  // filtered rows would skip every voter after a denied one.
  // A denied host discloses nothing, not even how many voted. There is no per-author filtering to do
  // here: these are per-OPTION counts, so no account is named and none can be dropped.
  async function pollVoterTotals(
    hostId: bigint,
  ): Promise<{ label: string; count: number }[]> {
    if (isDeniedPost(hostId)) return [];
    return source.pollVoterTotals(hostId);
  }

  async function pollVotersPage(
    hostId: bigint,
    opts: { after?: string | null; limit?: number } = {},
  ): Promise<{
    voters: PollVoter[];
    nextCursor: string | null;
    labels?: string[];
  }> {
    // A denied host loses its labels with its roster, for the same reason `pollVoters` does: a bare list
    // of accounts beside a delisted poll, with nothing to render a position as, is worse than nothing.
    if (isDeniedPost(hostId))
      return { voters: [], nextCursor: null, labels: [] };
    const page = await source.pollVotersPage(hostId, opts);
    return {
      ...page,
      voters: page.voters.filter((v) => !isDeniedAuthor(v.who)),
    };
  }

  return {
    liveHeadId,
    page,
    thread,
    repliesPage,
    profile,
    poll,
    viewerPollChoice,
    pollChoices,
    pollVoters,
    pollVoterTotals,
    pollVotersPage,
    viewerPostState,
    followEdges,
    whoToFollow,
    searchPeople,
  };
}
