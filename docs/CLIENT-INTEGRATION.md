# Building a client against cogno-chain

cogno.forum is a client, not the chain. Everything it reads is public, everything it writes is a
plain extrinsic, and nothing about the chain assumes our frontend is the one talking to it. This
document is what you need to write a different one.

Two things that are usually the hard part of integrating with a Substrate chain are already done
here, and both were undocumented until now: the runtime metadata is **committed to this repo**, so
you can generate a typed client without running a node, and the public relay serves **CORS-open
HTTP-only JSON-RPC**, so a browser, a serverless function or a `curl` can read the chain without a
WebSocket or a session.

The live chain runs `spec_version` **214** (`transaction_version` 7) at the time of writing. Check it
rather than trusting this line:

```sh
curl -sX POST https://cogno.forum/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_getRuntimeVersion","params":[]}' \
  | jq -c '.result | {specName, specVersion, transactionVersion}'
# {"specName":"cogno-chain-runtime","specVersion":214,"transactionVersion":7}
```

## Reading, with no dependencies at all

Every read the app performs is one `state_call` against a runtime API. It is a stateless HTTP POST.
There is no subscription to hold open, no session, no key, and no indexer to operate.

The arguments are SCALE-encoded and concatenated. For `feed_page(before: Option<u64>, limit: u32,
viewer: Option<AccountId>)`, asking for the newest two posts as an anonymous reader:

| arg | value | SCALE |
|---|---|---|
| `before` | `None` | `00` |
| `limit` | `2u32` | `02000000` |
| `viewer` | `None` | `00` |

```sh
curl -sX POST https://cogno.forum/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_call",
       "params":["MicroblogApi_feed_page","0x000200000000"]}'
```

The result is a SCALE-encoded `FeedPage`. Decode it with the committed metadata (below), or by hand
against the types in `pallets/microblog/src/lib.rs`.

A second worked example, because it is the one nobody guesses. `search_posts` with an **empty term**
is not an error and not an empty result: it is a newest-first scan over **all** posts, replies
included, which is the only read that returns replies interleaved with top-level posts.

```sh
# search_posts(term=[], before_id=None, limit=2, viewer=None)
curl -sX POST https://cogno.forum/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_call",
       "params":["MicroblogApi_search_posts","0x00000200000000"]}'
```

Pin a whole page render to one block by passing a block hash as the third `state_call` parameter.
Every read below is atomic at a single block, so a page assembled from several calls at one hash is
internally consistent — and cacheable by that hash.

### A typed client without running a node

`app/.papi/metadata/cogno.scale` is the committed runtime metadata, and CI enforces that it matches a
freshly built runtime (`scripts/check-metadata.sh`). So you can generate PAPI descriptors from the
file rather than from a live endpoint:

```sh
npx papi add cogno --file /path/to/cogno-chain/app/.papi/metadata/cogno.scale
```

`npx papi add -w wss://…` also works, but note it rewrites `polkadot-api.json` to point at whatever
endpoint you passed, which is easy to commit by accident.

### The read API

All of these are `MicroblogApi_<name>` via `state_call`. `viewer` is optional everywhere it appears;
passing it stamps each post with that account's own vote, in the same call, with no second round trip.

| method | args | notes |
|---|---|---|
| `feed_page` | `before: Option<u64>, limit: u32, viewer: Option<AccountId>` | global timeline, top-level only, newest first |
| `following_feed_page` | `viewer: AccountId, before: Option<u64>, limit: u32` | same shape, restricted to who `viewer` follows |
| `author_feed_page` | `author, before_id: Option<u64>, limit, viewer` | one author's top-level posts |
| `author_replies_page` | `author, before_id, limit, viewer` | that author's replies |
| `likes_page` | `who, before_id, limit, viewer` | posts `who` up-voted, newest-liked first |
| `search_posts` | `term: Vec<u8>, before_id, limit, viewer` | ASCII-case-insensitive substring; empty term scans everything |
| `thread` | `focal: u64, viewer` | focal + ancestor chain + direct replies |
| `author_post_count` | `author` | top-level only — the correct profile post count |
| `profile` | `who` | cross-pallet view: profile + stake + identity + counters |
| `follow_edges` | `who` | followees, followers, exact counts |
| `viewer_states` | `who, ids: Vec<u64>` | one account's votes over a batch of posts |
| `poll` / `poll_choice` | `host_id` / `who, host_id` | options + tallies; the viewer's own choice |
| `resolve_identity` | `[u8; 32]` | Cardano identity hash → account |
| `search_people` | `term: Vec<u8>, limit` | display-name substring, ranked by followers |

### The caps, all of which truncate silently

None of these error. They return less than you asked for, which reads exactly like "that is all there
is" unless you know to check. The values are in `pallets/microblog/src/lib.rs`.

- **`limit` is clamped to `[1, 100]`.** Asking for 500 returns 100 and says nothing.
- **Scanning reads examine at most `limit × 8` ids per call** (`feed_page`, `following_feed_page`,
  `search_posts`, `author_replies_page`). A page can therefore come back short *with* a
  `next_cursor`; short does not mean finished. Follow the cursor until it is `None`.
- **`thread` caps ancestors at 64 deep and returns at most 512 direct replies per call.** Those are the
  *newest* 512, and `Thread.replies_next_cursor` continues into `replies_page` for the rest — pass it as
  `before_seq` and follow each `next_cursor` until it is `None`. Until spec 216 this cap really did
  truncate: it returned the *oldest* 512 with no cursor at all, so a longer thread was missing its most
  recent end and reply 513 was unreachable through any read.
- **`follow_edges` truncates at 1000 per side.**
- **`viewer_states` takes at most 256 ids per call.** Batch beyond that yourself.

### Cursors are opaque and endpoint-scoped

A `next_cursor` from one method is only valid passed back to **the same method**. `feed_page` and
`following_feed_page` page a `TopLevelPosts` sequence number; `replies_page` pages a per-parent reply
sequence number; `author_feed_page` and the rest page a post id. They are all `u64` and crossing them
silently returns plausible nonsense. The one cursor that legitimately crosses methods is
`Thread.replies_next_cursor`, which exists to seed `replies_page`.

One useful exception to treat them as opaque: `feed_page`'s cursor is an absolute index into a dense
sequence, and `Microblog.NextTopLevelSeq` is the running total of top-level posts. So offset paging
and a real total page count both work today, if you want numbered pages rather than infinite scroll.

## Writing

Writes are ordinary signed extrinsics. There is no API key, no allowlist and no registration — the
chain does not know or care which client submitted a call.

| pallet | index | calls |
|---|---|---|
| `Microblog` | 10 | 0 `post_message`, 3 `quote_post`, 4 `vote`, 5 `clear_vote`, 7 `follow`, 8 `unfollow`, 9 `create_poll`, 10 `cast_poll_vote`, 11 `vote_account`, 12 `clear_account_vote`, 13 `close_poll` |
| `CognoGate` | 8 | 2 `link_identity_signed`, 3 `link_stake_signed` |
| `CardanoRoles` | 19 | 0 `claim_role_signed`, 1 `unclaim_role` |
| `Profile` | 17 | 0 `set_profile`, 1 `clear_profile`, 2 `pin_post`, 3 `unpin_post` |

Indices are on-wire contracts and are never renumbered. Microblog 1 (`delete_post`) and 6 (`repost`)
are permanently vacant — both were deliberately dropped, and neither is coming back. Content on this
chain is permanent; a client that offers a delete button is lying to its users.

`Microblog::force_set_capacity` (2), `CognoGate::revoke` (1) and `CardanoRoles::revoke_role` (2) exist
but are committee-origin only.

### The three calls that need no funded account

`link_identity_signed`, `link_stake_signed` and `claim_role_signed` are **bare unsigned** — the CIP-8
signature inside the payload *is* the authorization, so a brand-new account with a zero balance can
submit them. That is what makes onboarding possible at all: the account has nothing until it binds,
and binding is the thing that gives it something.

### Read the post length bound, do not hardcode it

`Microblog::MaxLength` is a runtime constant, currently 512 bytes, and it can be raised by a governed
upgrade. A client that bakes 512 into its composer silently truncates its users the day it moves.
Read it from metadata (`api.constants.Microblog.MaxLength()`); the app does this in
`app/src/lib/chain/capacity.ts` and threads it to every composer through `useComposerGate`.

The same applies to the capacity constants (`CapRatio`, `RegenPerBlock`, `Ceiling`, `BaseCost`,
`PerByteCost`) if you want to show a posting-budget meter.

There is a second, invisible ceiling worth knowing about: `MAX_METERED_CALL_LEN` (8 KiB) is a bare
crate constant, **not** a `#[pallet::constant]`, so it does not appear in metadata and no client can
discover it. A metered extrinsic longer than that is rejected at the transaction pool as malformed
and is not retried.

### Posting costs talk-capacity, not a fee

Every write is feeless. Posting is metered by a regenerating, stake-weighted budget earned by locking
ADA in the Cardano L1 `talk_vault` contract. An account with no locked ADA has no posting power, and
waiting does not help — that is a different failure from an exhausted budget, and a client that shows
one as the other sends users to wait for something that will never arrive. `docs/ECONOMICS.md` has
the model; `app/src/lib/chain/capacity.ts` replays the runtime's own arithmetic and is the file to
copy if you want a live meter.

## Identity

An account is bound 1:1 to a Cardano address by a CIP-8 signature. `docs/TRUSTLESS-IDENTITY.md`
covers the bind payloads; `docs/VERIFIABLE-ROLE-TAGS.md` covers SPO and dRep role claims.

The posting key itself is a **deterministic function of a wallet signature**, which is what makes a
cogno account portable between clients: a user who onboarded on cogno.forum arrives at your client
with the identical account, and never exports a key to get there. The derivation is normative and is
specified with a test vector in `docs/TRUSTLESS-IDENTITY.md` — implement it exactly, because a client
that derives differently mints a *different* account that can never bind to that wallet, and the
identity bind is permanent.

## Running your own endpoint

`https://cogno.forum/rpc` is CORS-open on purpose (`--rpc-cors all`) and other frontends are welcome
to read from it. It is not sized to be somebody else's backend: it is one node behind an nginx rate
limit, and nginx overwrites `X-Forwarded-For` with the peer address, so every request from one
serverless platform's egress shares a single bucket.

If you are rendering pages from cogno on every request, run your own archive relay. It needs no keys
and no db-sync — it is a plain syncing node — and `docs/RELAY-NODE.md` covers it. That also removes
us from your availability path, which is the point of the whole exercise.

## Version compatibility

Encoding-affecting runtime changes bump `spec_version`. Most bumps do not change any shape a client
can see; `transaction_version` is the one that moves when a call's arguments change, and that is the
number to gate a write path on.

`CHANGELOG.md` describes what each change means, and notes the `spec_version` it shipped in where
that matters. If you are decoding by hand rather than through metadata, diff the committed
`app/.papi/metadata/cogno.scale` between two revisions — that file is the wire contract, and CI keeps
it honest.

Note that the deployed cogno.forum bundle blocks posting when the chain's `spec_version` differs from
the one it was built against. That is our deployment's choice, not a chain rule — nothing stops your
client from taking a looser line.

## What this chain will not do for you

Worth knowing before you design around it:

- **No delete, no edit.** Posts are permanent. Moderation is a serve-side decision each client makes
  for itself (ours is `app/src/lib/config/denylist.ts`), and two clients will disagree unless they
  coordinate out of band. There is no shared hidden-set on chain and there is not going to be.
- **Search is a bounded substring scan**, not an index. No ranking, no tokenization, no prefix
  matching, and no non-ASCII case folding. If search matters to your product, index the chain into
  your own store and treat cogno as the write-ahead log.
- **No titles, categories, or threads-with-a-subject.** Posts are flat with a `parent`. Anything more
  structured is your client's convention, layered on top.
- **Role weight lags by a Cardano epoch.** Stake and dRep chamber weight are read at the previous
  immutable epoch, so a freshly registered dRep carries zero weight for up to ~5 days. That is
  correct behaviour, not a bug, and it surfaces as a confusing zero unless you say so in the UI.
- **Script (multisig) dReps cannot participate.** The identity bind needs a key to CIP-8-sign with,
  and a script credential has none.
