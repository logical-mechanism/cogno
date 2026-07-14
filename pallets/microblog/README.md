# pallet-microblog

cogno-chain's posting + social-engagement pallet (runtime index **10**).

## What it does

Posting is **feeless** and metered by **talk-capacity**, not by a per-post fee. Every write is an
ordinary signed extrinsic gated at the transaction pool by the `CheckCapacity` transaction extension
(the whole anti-spam budget) and by the identity gate (`CognoGate`, via the `IsAllowed` trait) — an
account must have a bound Cardano identity to post. Content is **append-only**: there is no
`delete_post`. Call indices **1** (`delete_post`) and **6** (`repost`, retired in spec 204) are
permanently vacant — an index is an on-wire contract, so neither is ever reused.

Dispatchables: `post_message`, `quote_post`, `vote` / `clear_vote`, `vote_account` /
`clear_account_vote` (stake-weighted reputation votes ON an account — the anti-Sybil / impersonation
signal; the target must be identity-bound and self-votes are rejected; call indices 11 & 12),
`follow` / `unfollow`, `create_poll` / `cast_poll_vote`, and `force_set_capacity` (committee-gated). The user-facing writes
carry `#[pallet::feeless_if]` and are priced against the single per-account capacity battery via
`metered_cost`; `pallet-profile`'s writes share the same battery through the runtime-supplied
`ForeignCost` seam, so the whole app stays feeless without a second capacity extension.

## Storage & reads

Storage version **5** (migrated v1→v5; v5 retired the repost storage and settled every capacity
bucket). Posts, per-author indexes, post votes (with a reverse liked-posts index), account-reputation
votes (`AccountVotes` / `AccountVoteTally`, keyed by target account), polls, follows, and a
top-level-post index — every collection is `BoundedVec`-bounded (a full index returns an error, never a
silent drop). `Post` carries `{ author, text, parent, quote, at }`.

The node serves **all reads** from the `MicroblogApi` runtime API (feed / author feed / following
feed / thread / likes — viewer-aware and profile-enriched); there is no external indexer.

Constants: `MaxLength = 512`, `MaxPostsPerAuthor = 10_000` (tunable). Weights are FRAME-benchmarked
(`WeightInfo`).

License: Apache-2.0
