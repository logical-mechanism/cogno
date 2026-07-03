# pallet-microblog

cogno-chain's posting + social-engagement pallet (runtime index **10**).

## What it does

Posting is **feeless** and metered by **talk-capacity**, not by a per-post fee. Every write is an
ordinary signed extrinsic gated at the transaction pool by the `CheckCapacity` transaction extension
(the whole anti-spam budget) and by the identity gate (`CognoGate`, via the `IsAllowed` trait) — an
account must have a bound Cardano identity to post. Content is **append-only**: there is no
`delete_post` (call_index 1 is permanently vacant).

Dispatchables: `post_message`, `quote_post`, `vote` / `clear_vote`, `repost`, `follow` / `unfollow`,
`create_poll` / `cast_poll_vote`, and `force_set_capacity` (committee-gated). The user-facing writes
carry `#[pallet::feeless_if]` and are priced against the single per-account capacity battery via
`metered_cost`; `pallet-profile`'s writes share the same battery through the runtime-supplied
`ForeignCost` seam, so the whole app stays feeless without a second capacity extension.

## Storage & reads

Storage version **4** (migrated v1→v4). Posts, per-author indexes, votes, polls, reposts, follows,
and a top-level-post index — every collection is `BoundedVec`-bounded (a full index returns an error,
never a silent drop). `Post` carries `{ author, text, parent, quote, at }`.

The node serves **all reads** from the `MicroblogApi` runtime API (feed / author feed / following
feed / thread / likes — viewer-aware and profile-enriched); there is no external indexer.

Constants: `MaxLength = 512`, `MaxPostsPerAuthor = 10_000` (tunable). Weights are FRAME-benchmarked
(`WeightInfo`).

License: Apache-2.0
