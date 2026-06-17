// The exact, VERIFIED SubQuery (v6 / postgraphile) query shapes for the cogno-chain indexer.
// The schema is connection-based (edges/pageInfo/nodes), NOT the SQD `text_containsInsensitive`
// dialect. Relation field names are the @derivedFrom names — `posts` (on Author) and `replies`
// (on Post) — never postgraphile's `postsByAuthorId`. Forward relations are `author` / `parent`.
//
// These strings are queried against http://localhost:3000/ and confirmed live (M4).

/**
 * The global feed, cursor-paginated. `orderBy` accepts ID_DESC / TIMESTAMP_DESC /
 * BLOCK_HEIGHT_DESC. Pass the opaque `endCursor` as `$after`; omit it for page one. The
 * `$search` substring filter is spliced in by the caller when present (see {@link FEED}).
 */
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
        deleted
        author { id banned identityHash }
      }
    }
  }
}`;

/** A single author's profile + their posts, looked up by 0x identity hash (returns a list). */
export const PROFILE_BY_IDENTITY = `
query ProfileByIdentity($hex: String!) {
  authors(filter: { identityHash: { equalTo: $hex } }) {
    nodes {
      id
      banned
      identityHash
      postCount
      weight
      posts(orderBy: ID_DESC) {
        totalCount
        nodes { id text parentId blockHeight deleted }
      }
    }
  }
}`;

/** A single author's profile + their posts, looked up by SS58 account id. */
export const PROFILE_BY_ACCOUNT = `
query ProfileByAccount($ss58: String!) {
  author(id: $ss58) {
    id
    banned
    identityHash
    postCount
    weight
    posts(orderBy: ID_DESC) {
      totalCount
      nodes { id text parentId blockHeight deleted }
    }
  }
}`;

/** A thread: the root post + its direct replies (oldest-first). */
export const THREAD = `
query Thread($rootId: String!) {
  post(id: $rootId) {
    id
    authorId
    text
    blockHeight
    deleted
    author { id banned identityHash }
    replies(orderBy: ID_ASC) {
      totalCount
      nodes {
        id
        authorId
        text
        blockHeight
        deleted
        parent { id }
        author { id banned identityHash }
      }
    }
  }
}`;
