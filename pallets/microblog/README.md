# pallet-microblog

cogno-chain's posting pallet.

**M0 shape (this milestone):** plain text posting — `post_message(text, parent)` and
`delete_post(id)`. No identity gate, no talk-capacity, no feeless extension yet (those land in
M2 / M2c / M2d per [`docs/DECISION-REGISTER.md`](../../docs/DECISION-REGISTER.md)). Posting is an
ordinary signed, fee-bearing extrinsic in M0.

Storage: `NextPostId: u64`, `Posts: map u64 -> Post`, `ByAuthor: map AccountId -> BoundedVec<u64>`.
`Post { author, text: BoundedVec<u8, MaxLength>, parent: Option<u64>, at }`. Every collection is
bounded; a full `ByAuthor` index returns `TooManyPosts` (never a silent drop).

Runtime pallet index: **10**. Constants: `MaxLength = 512`, `MaxPostsPerAuthor = 10_000` (DR-10b).

Weights are hand-set dev placeholders; real benchmarked `WeightInfo` is DR-05 (a later milestone).

License: Unlicense
