// The exact SubQuery (v6 / postgraphile) query shapes for the cogno-chain indexer.
//
// Dialect notes (load-bearing — confirmed live, M4 + the spec-113 social indexer):
//   - connection-based (edges / pageInfo / nodes), NOT the SQD `text_containsInsensitive` form;
//   - relation field names are the @derivedFrom names — `posts` (on Author), `replies` (on Post);
//     forward relations are `author` / `parent` / `quote`;
//   - cursors are the opaque `Cursor` scalar; pass `endCursor` as `$after`, omit for page one;
//   - `orderBy` is the `PostsOrderBy` enum (ID_DESC stable default == time order on one chain;
//     SCORE_DESC for "top"); follower ranking is FOLLOWER_COUNT_DESC.
//
// THERE IS NO `deleted` FIELD. `Microblog.delete_post` was removed at spec 113 (content is
// permanent); the indexer schema has no `deleted` column. The only mutable author state is
// `banned` (folded from `Revoked`); banned authors' posts STAY and are flagged, never dropped.
//
// Social fields (upWeight/downWeight/upCount/downCount/score/repostCount/isPoll) + the author
// profile snapshot (displayName/avatar/weight/banned) + quote/poll/follow aggregates are folded
// by the indexer (see services/indexer). All weight/score scalars are BigInt strings → BigInt().

// ── the home timeline + explore/search (cursor-paginated) ────────────────────────────────────
export const FEED = `
query Feed($first: Int!, $after: Cursor, $orderBy: [PostsOrderBy!], $filter: PostFilter) {
  posts(first: $first, after: $after, orderBy: $orderBy, filter: $filter) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        authorId
        text
        parentId
        blockHeight
        isPoll
        upWeight downWeight upCount downCount score repostCount
        author { id banned identityHash weight displayName avatar }
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}`;

// ── author search by display name (explore → People) ─────────────────────────────────────────
export const SEARCH_PEOPLE = `
query SearchPeople($term: String!, $limit: Int!) {
  authors(
    filter: { displayName: { includesInsensitive: $term }, banned: { equalTo: false } }
    first: $limit
    orderBy: FOLLOWER_COUNT_DESC
  ) {
    nodes { id displayName avatar weight followerCount }
  }
}`;

// ── a single author's profile shell + their POSTS tab (top-level: parentId is null) ──────────
export const PROFILE_BY_ACCOUNT = `
query ProfileByAccount($ss58: String!, $first: Int!, $after: Cursor) {
  author(id: $ss58) {
    id banned identityHash weight
    displayName bio avatar pinnedPostId
    postCount followerCount followingCount
    posts(first: $first, after: $after, orderBy: ID_DESC, filter: { parentId: { isNull: true } }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id authorId text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}`;

// ── a single author's profile shell, looked up by 0x identity hash (returns a list) ──────────
export const PROFILE_BY_IDENTITY = `
query ProfileByIdentity($hex: String!, $first: Int!, $after: Cursor) {
  authors(filter: { identityHash: { equalTo: $hex } }) {
    nodes {
      id banned identityHash weight
      displayName bio avatar pinnedPostId
      postCount followerCount followingCount
      posts(first: $first, after: $after, orderBy: ID_DESC, filter: { parentId: { isNull: true } }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id authorId text parentId blockHeight isPoll
          upWeight downWeight upCount downCount score repostCount
          quote { id text author { id banned displayName avatar } }
        }
      }
    }
  }
}`;

// ── the profile REPLIES tab (this author's replies: parentId is not null) ────────────────────
export const PROFILE_REPLIES = `
query ProfileReplies($ss58: String!, $first: Int!, $after: Cursor) {
  author(id: $ss58) {
    id banned identityHash weight
    displayName bio avatar pinnedPostId
    postCount followerCount followingCount
    posts(first: $first, after: $after, orderBy: ID_DESC, filter: { parentId: { isNull: false } }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id authorId text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}`;

// ── the profile LIKES tab (this author's UP votes → the liked posts; down-votes are not likes) ─
// Carries the author profile shell too, so the tab is self-contained (the header survives a tab swap).
export const PROFILE_LIKES = `
query ProfileLikes($ss58: String!, $first: Int!, $after: Cursor) {
  author(id: $ss58) {
    id banned identityHash weight
    displayName bio avatar pinnedPostId
    postCount followerCount followingCount
  }
  votes(
    filter: { voterId: { equalTo: $ss58 }, dir: { equalTo: "Up" } }
    first: $first
    after: $after
    orderBy: ID_DESC
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      post {
        id authorId text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        author { id banned displayName avatar weight }
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}`;

// ── a thread: the root post + its "replying to" parent context + direct replies ──────────────
export const THREAD = `
query Thread($rootId: String!) {
  post(id: $rootId) {
    id authorId text parentId blockHeight isPoll
    upWeight downWeight upCount downCount score repostCount
    author { id banned identityHash weight displayName avatar }
    quote { id text author { id banned displayName avatar } }
    parent { id authorId text author { id banned displayName avatar } }
    replies(orderBy: ID_ASC) {
      totalCount
      nodes {
        id authorId text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        author { id banned displayName avatar }
        quote { id text author { id banned displayName avatar } }
        replies { totalCount }
      }
    }
  }
}`;

// ── a single post by id (pinned post, quote-target resolution) ───────────────────────────────
export const ONE_POST = `
query OnePost($id: String!) {
  post(id: $id) {
    id authorId text parentId blockHeight isPoll
    upWeight downWeight upCount downCount score repostCount
    author { id banned identityHash weight displayName avatar }
    quote { id text author { id banned displayName avatar } }
  }
}`;

// ── poll options + per-option stake-weighted tally for a host id ─────────────────────────────
export const POLL = `
query Poll($hostId: String!) {
  poll(id: $hostId) {
    id
    options(orderBy: INDEX_ASC) { index label weight count }
    votes { totalCount }
  }
}`;

// ── the viewer's own choice on a single poll (drives the ✓ + results-after-vote on the poll card) ─
// NOTE: `pollVotes` / `voterId` / `pollId` follow the spec-113 social indexer's FK-column naming
// (same convention as VIEWER_STATES' `voterId`); confirm against the live `services/indexer` schema
// if a field renames. The PAPI-direct path reads the same choice from `Microblog.PollVotes`.
export const POLL_CHOICE = `
query PollChoice($who: String!, $hostId: String!) {
  pollVotes(filter: { voterId: { equalTo: $who }, pollId: { equalTo: $hostId } }) {
    nodes { option }
  }
}`;

// ── the viewer's own votes + reposts over a set of post ids (drives filled-heart / active-repost) ─
export const VIEWER_STATES = `
query ViewerStates($who: String!, $postIds: [String!]!) {
  votes(filter: { voterId: { equalTo: $who }, postId: { in: $postIds } }) {
    nodes { postId dir }
  }
  reposts(filter: { reposterId: { equalTo: $who }, postId: { in: $postIds } }) {
    nodes { postId }
  }
}`;

// ── follow edges + counts for one account ────────────────────────────────────────────────────
// NOTE: relation/field names (`follows`, `followerId`, `followeeId`) follow the spec-113 social
// indexer schema; confirm against the live `services/indexer` schema if a field renames.
export const FOLLOW_EDGES = `
query FollowEdges($who: String!) {
  author(id: $who) { followerCount followingCount }
  following: follows(filter: { followerId: { equalTo: $who } }) { nodes { followeeId } }
  followers: follows(filter: { followeeId: { equalTo: $who } }) { nodes { followerId } }
}`;

// ── ranked who-to-follow suggestions (RightRail) ─────────────────────────────────────────────
export const WHO_TO_FOLLOW = `
query WhoToFollow($limit: Int!) {
  authors(
    filter: { banned: { equalTo: false }, postCount: { greaterThan: 0 } }
    orderBy: FOLLOWER_COUNT_DESC
    first: $limit
  ) {
    nodes { id displayName avatar weight followerCount }
  }
}`;
