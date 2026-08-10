# pallet-microblog

cogno-chain's posting + social-engagement pallet (runtime index **10**).

## What it does

Posting is **feeless** and metered by **talk-capacity**, not by a per-post fee. Every user-facing
write is an ordinary signed extrinsic priced at the transaction pool by the `CheckCapacity`
transaction extension (the whole anti-spam budget), and each one re-checks the identity gate
(`CognoGate`, via the `IsAllowed` trait) in its own dispatch body — an account must have a bound
Cardano identity to post, vote, follow or poll. The one non-user-facing call, `force_set_capacity`,
sits outside all of that — committee origin, and unmetered. Content is **append-only**: there is no
`delete_post`. Call indices **1** (`delete_post`, removed before launch) and **6** (`repost`,
retired in spec 204) are permanently vacant — an index is an on-wire contract, so neither is ever
reused. Next free call index is **14**.

| # | Call | Origin |
|---|---|---|
| 0 | `post_message(text, parent)` | signed |
| 2 | `force_set_capacity(who, cap_last)` | **committee** (`ForceOrigin`) |
| 3 | `quote_post(text, quoted_id)` | signed |
| 4 / 5 | `vote(post_id, dir)` / `clear_vote(post_id)` | signed |
| 7 / 8 | `follow(target)` / `unfollow(target)` | signed |
| 9 / 10 | `create_poll(question, options, close_at, kind, action)` / `cast_poll_vote(post_id, option)` | signed |
| 11 / 12 | `vote_account(target, dir)` / `clear_account_vote(target)` | signed |
| 13 | `close_poll(host_id)` | signed, permissionless |

`vote_account` / `clear_account_vote` are stake-weighted reputation votes ON an account — the
anti-Sybil / impersonation signal. The target must itself be identity-bound, and self-votes are
rejected.

`close_poll` is the only permissionless keeper call: once a poll's `close_at` has passed, any bound
account may finalize it, freezing the weighted result into `PollResults` — plus, for a chamber poll
(kind `Governance`, `Spo` or `Drep`), whichever of the SPO and dRep snapshots that kind surfaces. It
is **paged** over the poll's own voters at `MaxClosePage` (64) per call, resuming from
`PollCloseState`, so finalizing a poll costs `O(MaxClosePage)` and does
**not** scale with how many accounts the observer credits. A tally whose pages span an observed weight
movement still completes and reports the fact with the `PollTallySmeared` event. Every early exit
refunds down to the base weight, and the body refunds to the rows it actually touched, so a
three-voter close is priced as one.

All the user-facing writes carry `#[pallet::feeless_if]` and are priced against the single per-account
capacity battery via `metered_cost` — `close_poll` included, at the flat `VoteCost`, so a keeper needs
capacity and cannot spam it. `force_set_capacity` is unmetered. `pallet-profile`'s writes share the
same battery through the runtime-supplied `ForeignCost` seam (`ForeignCapacityCost`), so the whole app
stays feeless without a second capacity extension.

## Storage & reads

Storage version **12**. The migration chain registered in the runtime starts at v5 (v1–v4 exist in the
crate but are deliberately not wired — the all-Rust restart was a fresh genesis). The three most
recent are what the current shape is made of: v10 repaged the per-author indexes off a per-author
`BoundedVec` blob onto seq-keyed double maps, v11 backfilled the ordered reply spine, v12 backfilled
the ordered likes index.

The items, grouped by what they serve:

- **Posts** — `NextPostId`, `Posts`. A `Post` carries `{ author, text, parent, at, quote }`; a quote
  (`quote = Some`) is distinct from a reply (`parent = Some`).
- **Per-author indexes** — `ByAuthor` / `ByAuthorCount` over every post an author made (replies and
  quotes included), and `TopLevelByAuthor` / `TopLevelByAuthorCount` over only their top-level posts,
  which is the correct profile post count.
- **The global feed spine** — `TopLevelPosts` + `NextTopLevelSeq`, dense and reply-free, so a feed
  page never scans past interleaved replies.
- **Replies** — `ReplyCount`, `RepliesByParent` (hash-ordered membership, the keyed client fallback)
  and `RepliesByParentSeq`, the dense seq-keyed ORDERED spine a reply page is read from.
- **Post votes** — `Votes`, `VoteTally`, plus the two liked-posts indexes: `VotesByAccount` answers
  "does this account like that post?" in O(1), and `LikesByAccount` carries the ORDER, keyed so the
  trie's own lexicographic order is descending post id.
- **Account-reputation votes** — `AccountVotes` / `AccountVoteTally`, keyed by target account.
- **Follows** — `Following`, `Followers`, `FollowerCount`, `FollowingCount`.
- **Polls** — `Polls`, `PollVotes`, `PollTally`, `PollResults` (the frozen result), plus
  `PollCloseState` and `PollChamberScratch`, the in-flight state a paged `close_poll` resumes from and
  drains.
- **Capacity** — `Capacity`, the per-identity battery. The row is never deleted on unlock (the
  relock-farm guard).

Where a collection IS `BoundedVec`-bounded it fails loudly at the bound (an error, never a silent
drop). The per-author, reply and likes indexes deliberately are not: keyed by `(owner, seq)` or
`(owner, key)` rather than held in one blob, an append is a couple of writes at any history length.

The node serves **all reads** from the `MicroblogApi` runtime API; there is no external indexer. Its
17 methods are `feed_page`, `author_feed_page`, `following_feed_page`, `thread`, `replies_page`,
`author_post_count`, `author_replies_page`, `likes_page`, `search_posts`, `poll`, `poll_choice`,
`viewer_states`, `follow_edges`, `profile`, `resolve_identity`, `search_people` and `who_to_follow`.
Feed reads are viewer-aware and profile-enriched, and every page returns a `next_cursor` that is
opaque and **endpoint-scoped**: the domains differ — `feed_page` / `following_feed_page` hand back a
`TopLevelPosts` seq, `replies_page` a `RepliesByParentSeq` seq, the other post readers a post id, and
the two people readers an account id — so a cursor is not interchangeable across endpoints. The one
hand-off between methods is `thread`'s `replies_next_cursor`, which is minted for `replies_page`:
`thread` returns the newest page of a post's direct replies plus the cursor `replies_page` continues
from, so a deep conversation is paged rather than truncated.

The ordered indexes make the unfiltered reads exact-N — one keyed read per post returned:
`feed_page` off the top-level spine, `replies_page` off the reply spine, `author_feed_page` off the
per-author spine, `likes_page` off the descending-key likes index. The filtered ones
(`following_feed_page`, `author_replies_page`, `search_posts`) spend a `limit · MAX_SCAN_FACTOR` scan
budget on top and may hand back a short page plus a cursor to continue; the two people readers spend
their own.

Constants: `MaxLength = 512` bytes (post body, and the poll question that becomes one), up to 4 poll
options of 80 bytes each, a 256-byte governance anchor URL, and a poll duration between 10 minutes and
90 days. Posts per author are UNBOUNDED since spec 212: `ByAuthor` and `TopLevelByAuthor` are
seq-keyed double maps beside explicit counters, so indexing a post is O(1) at any history length and
`MaxPostsPerAuthor` is gone (it bricked an author at the cap, permanently, since content is
append-only). The read side is bounded instead of the write side — see
[SCALE-NODE-READS.md](../../docs/SCALE-NODE-READS.md#bounds-and-safety). Weights are FRAME-benchmarked
(`WeightInfo`).

License: Apache-2.0
