# cogno-chain L4 — Reading & Serving the Feed

> Deep-dive design for the cogno-chain **L4**: the read / serve / index layer —
> "users see the posts." L4 turns **L3** (`pallet-microblog` on the Substrate
> solochain) into a global feed, profiles, and threads, and surfaces the
> onboarding / capacity read-state to the UI. It **NEVER touches Cardano on the
> post-read path** and is **NEVER the source of truth** — L3 is. Companion to
> `docs/L1-cardano.md` (the `talk_vault`), `docs/L2-follower.md` (the
> follower/bridge), `docs/L3-chain.md` (the chain & runtime).
>
> **This doc BUILDS ON those — it does not re-derive them.** The on-chain shapes
> (`Posts`/`ByAuthor`/`Capacity`, `PostCreated`/`PostDeleted`, the gate binding,
> the capacity math) are settled in `L3-chain.md` §4/§7; cited, not redone. What is
> *new* here is the two-tier read architecture (PAPI-direct vs indexer), the read
> API surface, the cross-layer onboarding/capacity read-state, and the
> **credibly-neutral / open-reads** stance that mirrors `L2-follower.md`'s
> "auditable, anyone-can-recompute" discipline one layer up.
>
> **L4 is comparatively standard** — a data/indexing layer over a public event log.
> This doc is kept proportionate (lighter than L1–L3). The *one* non-standard part,
> treated at depth, is the **hyperstructure read property**: reads stay open,
> permissionless, and reproducible, and no single managed indexer becomes the
> de-facto feed.

> **RECONCILED to DECISION-REGISTER.md (2026-06-16).** The following decisions change
> this doc; where the prose below still says otherwise, these override:
> - **DR-01 — identity = the WHOLE owner Address (32-byte hash), not a 28-byte pkh.**
>   Identity resolution keys on the **32-byte identity hash = `blake2b_256(serialized
>   owner Address)`** (== the beacon `token_name`), NOT a 28-byte `owner_pkh`. Throughout
>   §2.1/§4.1/§4.2/§5.1/§6.1: "profile-by-`owner_pkh`" is **profile-by-identity (the
>   address hash)**, the gate's reverse map (`CognoGate.AccountOf`) is **keyed on the
>   32-byte address hash**, and the db-sync "parked-now" read uses `token_name =
>   blake2b_256(serialized owner Address)`. The trust-inherited framing stands, but the
>   value is an **Address hash**, and its on-chain length check is **`len()==32`**, not 28.
>   *(supersedes §2.1, §2.2's `len()==28` claim, the §4.1 schema `ownerPkh` comment,
>   §4.2 `pkh28`/`AccountOf(pkh)` snippet, §5.1's `blake2b_256(owner_pkh)`, §5.3 diagram,
>   §6.1, §8's "Trust-inherited `owner_pkh`," App. A's `blake2b_256(owner_pkh)`.)*
> - **DR-18 — single merged `talk_vault` validator (mint + spend), no separate beacon
>   policy.** There is **one** validator whose `policy_id == vault script hash`; the
>   beacon `token_name` length is **`blake2b_256` / 32 bytes**. The old two-validator /
>   separate `beacon_policy_id` framing is deleted. *(affects the §5.1 db-sync read and
>   App. A's L1 reference — the policy id is the vault script hash.)*
> - **DR-21 — `NextPostId` is `u64`, not `u32`.** The "`u32` ceiling / `2^32` wrap"
>   caveat is **removed**: L3 uses `u64`, so the reproducibility claim is no longer
>   scoped below `2^32`. *(supersedes §3's ⚑ `u32` note, §4.1's `u32 post id` comment,
>   §8's "`u32` post-id ceiling" risk.)*
> - **DR-27 — SubQuery is the CHOSEN reference indexer.** PAPI-direct stays the v1
>   baseline; **SubQuery** (built at L3 M4) is the published reference indexer, and the
>   operator runs a **public rate-limited read RPC** for the PAPI-direct fallback. SQD
>   remains a valid second independent indexer but is no longer the recommended pick.
>   *(supersedes §1, §3.2, §7.2/§7.4, §10 Q2, §11's SQD-first phrasing.)*
> - **DR-08 — the archive is COMMITTED in v1 (no longer an open who/whether).** The
>   operator runs a `--pruning archive` node + publishes the genesis hash + chainspec;
>   the L4-M4c re-derivation from genesis is a **v1 acceptance test**. §10 Q4 is
>   **DECIDED** (only operational *how*, not *whether*). *(supersedes §6.5, §8, §10 Q4.)*
> - **DR-33 — default "parked ADA" read = L3 `AllowedStake`; db-sync optional cross-check,
>   NO Blockfrost.** Drop Blockfrost as a source everywhere; the live-balance cross-check
>   is an **optional read-only db-sync**, and the default posting-power read is L3
>   `AllowedStake`. *(supersedes §5.1, §5.3, §9 diagram, §10 Q6.)*
> - **DR-31 — devnet network = PREPROD** (db-sync/Ogmios path). *(context
>   for the §5.1 onboarding Cardano read.)*
>
> The "Open questions" §10 items above are **RESOLVED in DECISION-REGISTER.md
> (2026-06-16)** — see that doc; the detail is kept below for context.

---

## 1. TL;DR

- **L4 = the read/serve layer.** It reads `PostCreated`/`PostDeleted` events +
  `Posts`/`ByAuthor`/`Capacity` storage from L3 and serves a global feed,
  profiles, threads, search, and the onboarding/capacity widget. It writes nothing
  to L3 and owns no truth.
- **Two read paths, same data.** **Tier A = PAPI direct** (storage `getEntries`/
  `getValue` + `watchEntries` + `finalizedBlock$`) — zero infra, the credibly-
  neutral baseline. **Tier B = an indexer** (the chosen reference is **SubQuery**;
  SQD/Subsquid is a valid second) → Postgres + GraphQL — for paginated/searchable/
  threaded feeds at scale.
- **Recommendation: ship PAPI-direct for v1 (aligns with L3 M3), add a
  self-hosted indexer when scale needs it (L3 M4).** Both read the SAME events, so
  adding the indexer later changes **zero** on-chain code. The scale boundary is a
  single fact: `Posts.getEntries()` reads the **whole** map every call. The operator
  also runs a **public rate-limited read RPC** so the PAPI-direct fallback is honestly
  reachable (DR-27).
- **CHOSEN indexer: a SELF-HOSTED SubQuery** (DR-27 — open-source, Apache-licensed,
  Substrate-first, self-hostable, first-class `@fullText`, lower strategic risk). It
  is the *published reference* built at L3 M4. **A SELF-HOSTED SQD squid** (native
  Substrate batch processor, RPC-only ingestion, Apache-2.0 SDK) remains a valid
  **second** independent indexer for the "multiple indexers" property. Whichever —
  **self-host it, publish its config.**
- **Reads NEVER touch Cardano.** The post path and the live capacity widget read
  **only L3** via PAPI (`L3-chain.md` §7/§10, the hard invariant). The **only**
  Cardano read is the slow, one-time onboarding/provenance check (does my vault
  exist, how much ADA is parked), and it is **off** the post path.
- **The capacity widget is computed CLIENT-SIDE from L3 storage.** Read
  `AllowedStake` (weight) + `Capacity` (`{cap_last,last_block}`) + the current
  block, then replay `current_capacity()` (`L3-chain.md` §4.3, a PURE function) to
  show live capacity + a regen countdown — no server, and it agrees with what
  `CheckCapacity::validate()` will decide.
- **The hyperstructure read property (the interesting part):** because L3 is the
  source of truth and its events are **public + deterministic**, the feed is a pure
  fold over a public append-only log. **Anyone can run an indexer and reproduce the
  byte-identical feed — given the published mapping spec** (which pins the one
  divergence point, the soft-/hard-delete policy; §6.1). No indexer is authoritative;
  reads need no permission. This is `L2-follower.md`'s deterministic `vaults→weight`
  fold, one layer up: `events→feed`. **It rests on a real prerequisite — at least one
  independently-served archive of full history from genesis** (else "anyone can
  reproduce" is unbacked); this is a **COMMITTED v1 requirement** (DR-08 — the operator
  runs a `--pruning archive` node + publishes the genesis hash + chainspec), not a late
  nicety (§6.5).
- **The soft re-centralization to name and avoid:** a frontend hard-wired to ONE
  managed indexer/GraphQL endpoint makes that endpoint a de-facto read authority
  (it can omit/reorder/delay/censor, and it's a single point of failure) — even
  though L3 stays open. The defenses are cheap and real: **published open schema +
  mapping, endpoint-as-config (multi-endpoint), PAPI-direct fallback.**
- **Honest posture: reads are a convenience; the chain is truth.** "Anyone CAN run
  an indexer" is an **exit option**, not a free lunch — running Postgres + indexer +
  GraphQL 24/7 costs money, and a custom solochain isn't in any decentralized
  archive (RPC-only, slower sync). So the median user hits a hosted endpoint; the
  guarantee is verifiability + permissionless reproduction + fallback, **not** that
  everyone self-hosts. (This is `L2-follower.md` §10's *auditable ≠ trustless*,
  restated as *reproducible ≠ effortless*.)
- **Metadata coupling applies to BOTH tiers.** Any L3 `spec_version` bump that
  changes call/storage/event encoding requires re-running `npx papi` **and** the
  indexer's typegen, or decoding silently breaks (`L3-chain.md` §3.3/§7/§9).

---

## 2. What L4 does & does NOT

L4 is the fourth layer; its boundaries are settled by L3. This section pins them so
nothing is re-derived below.

### 2.1 L4 DOES

- **Reads & serves** the feed: a recency-ordered global feed, per-profile pages,
  threaded replies, and full-text search over post text.
- **Resolves profiles both ways** — by `AccountId` directly (via `ByAuthor`), and
  by **identity (the 32-byte owner-Address hash)** via the `pallet-cogno-gate` binding
  (`PkhOf`/`AccountOf`, `L3-chain.md` §4.1). *(DR-01: identity is the whole owner
  Address, keyed by `blake2b_256(serialized owner Address)`, not a 28-byte pkh — the
  storage names retain "pkh" but carry the 32-byte address hash.)*
- **Reconstructs threads** off-chain from `Post.parent` (the upward pointer; L3
  deliberately stores **no** on-chain children index — `L3-chain.md` §4.4).
- **Surfaces onboarding / capacity read-state** to the UI: a user's vault ADA (L1)
  → their L3 weight → current talk capacity + regen countdown (L3 storage, §5).
- **Keeps reads open** — published schema, self-hostable indexer, PAPI-direct
  fallback (§6).

### 2.2 L4 does NOT

- **L4 is NEVER the source of truth.** L3 is. The indexer/GraphQL endpoint is one
  **replaceable view** over public on-chain truth — a cache, not an authority.
- **L4 NEVER touches Cardano on the post-read path.** The feed, profiles, threads,
  and the live capacity widget are pure L3 reads. Only the onboarding/provenance
  widget consults Cardano, and that read is off the hot path (§5).
- **L4 writes NOTHING to L3.** It cannot post, bind, set weight, or self-bind. All
  writes go through L3's gated paths (the user's sr25519 key for `post_message`;
  the follower's `FollowerOrigin` for `link_identity`/`set_stake`). L4 only reads.
- **L4 does NOT re-verify on-chain facts.** The bound **identity (the 32-byte owner-
  Address hash)** on a profile is **trust-inherited** from the follower (`L3-chain.md`
  §4.1/§9 — the runtime checks only `len()==32`, DR-01). L4 surfaces the binding as-is;
  it does **not** present the identity as cryptographically re-verified on the read side.

---

## 3. Two read paths

The same on-chain data is served two ways. Pick per query class, not per project —
they coexist, and a frontend can use both.

### 3.1 Tier A — PAPI direct (small scale, the neutral baseline)

PAPI talks straight to a node's WS RPC. Zero infra, no database, trivially
permissionless: point at any public RPC (or run your own node) and read. This is
`L3-chain.md` §7's "Direct PAPI (demo / low scale)" path.

**What PAPI does well (cheap on-chain reads):**

- single post by id — `Posts.getValue(id)`;
- a profile's post-id list — `ByAuthor.getValue(account)` (**the index already
  exists on-chain** — profile-by-author is cheap without an indexer);
- identity resolution both ways — `CognoGate.PkhOf.getValue` / `AccountOf.getValue`;
- a live feed — `Posts.watchEntries()` (add/delete deltas) or
  `Microblog.PostCreated.watch()`;
- finality — `client.finalizedBlock$`;
- the full onboarding/capacity read-state (§5) — a few storage reads + a pure
  client-side computation, **no server**.

**Where PAPI is the wrong tool (the scale boundary):** `Posts.getEntries()` reads
the **entire** `Posts` `StorageMap` every call — O(all posts), client-side sort
only, no server-side pagination/ordering/limit, no full-text search, no efficient
"all replies under parent X" (parent lives on the child `Post`, so you'd scan all
posts), and `watchEntries()` over a large map is O(map). **That single fact is the
PAPI → indexer boundary.**

### 3.2 Tier B — an indexer → Postgres + GraphQL (scale)

An indexer subscribes to `PostCreated`/`PostDeleted` (and the gate/stake events),
upserts entity rows into Postgres, and serves GraphQL. This is `L3-chain.md` §7's
"Optional indexer (scale)" + L3 M4; the **chosen reference is SubQuery** (DR-27), with
SQD a valid second. It exists for exactly what PAPI can't do cheaply: recency-paginated
whole-feed with stable cursors, full-text search, materialized threads (parent→children),
profile-by-**identity** (the 32-byte address-hash) joins, and counts/aggregations.

The **event→entity mapping is identical** for either tool (filter pallet+event,
decode SCALE, upsert a `Post` row + a derived `Author` row, soft-delete on
`PostDeleted`; threads are a self-relation `Post.parent → Post`). Both self-host via
docker-compose (Postgres + GraphQL) against a plain RPC **with no token**, and both
handle reorgs via GRANDPA finality (§8.2), not confirmation counts.

### 3.3 When each — the decision table

| Query / need | Tier A (PAPI direct) | Tier B (indexer) |
|---|---|---|
| Single post by id | ✅ `Posts.getValue(id)` | ✅ |
| Live feed (new posts streaming) | ✅ `watchEntries()` / event `.watch()` | ✅ subscription |
| Profile = posts by one author | ✅ `ByAuthor.getValue(acct)` (on-chain index) | ✅ |
| Profile-by-**identity** (address-hash) | ✅ `AccountOf.getValue(idHash32)` then `ByAuthor` | ✅ (join the gate binding) |
| Identity resolution (idHash32↔acct) | ✅ `PkhOf`/`AccountOf` | ✅ |
| Onboarding / capacity widget | ✅ **preferred** (per-account, must match runtime) | ⚠️ possible, but PAPI is the right tool |
| Recency-paginated global feed (cursors) | ❌ `getEntries()` = whole map | ✅ `orderBy: timestamp_DESC, first, after` |
| Full-text search over post text | ❌ | ✅ `@fullText` / `text_containsInsensitive` |
| Threads materialized (parent→children, reply counts) | ❌ (scan all posts) | ✅ self-relation + `@derivedFrom` |
| Cross-author aggregates / counts / "replies to me" | ❌ | ✅ |
| Complete per-author history beyond `MaxPostsPerAuthor` | ❌ (`ByAuthor` is a capped `BoundedVec`) | ✅ (indexer keeps full history) |
| Infra required | none | Postgres + indexer + GraphQL, self-hosted |

**Recommendation:** ship Tier A for v1 (L3 M3 — demo feed, live `watchEntries`,
capacity countdown). Stand up Tier B (self-hosted) at L3 M4 when `getEntries()`
stops being acceptable. **Don't build the indexer first** — it's a scale
optimization, not a prerequisite, and PAPI-direct is the credibly-neutral fallback
you keep forever.

> ⚑ `ByAuthor` is a `BoundedVec` capped at `MaxPostsPerAuthor` (10_000 illustrative,
> `L3-chain.md` §4.5). A prolific author's full history can exceed it on-chain — so
> at scale the **indexer**, not `ByAuthor`, is the source for complete per-author
> history. `NextPostId` is **`u64`** (DR-21, `L3-chain.md` §4.4) — the old `u32`/`2^32`
> wrap concern is **removed**: the id space is effectively unbounded at this scale, so
> the reproducibility claim is no longer scoped below `2^32` posts and an indexer keying
> on `id` is safe.

---

## 4. The read API

Two surfaces: a **GraphQL entity schema** (Tier B) and **PAPI snippets** (Tier A).
Both serve the same four read surfaces — global feed, profiles, threads, search.

### 4.1 The GraphQL entity schema (published, open)

The schema below is the **published open schema** of §6 — it is what makes
independent indexers converge and lets a frontend swap endpoints transparently.
Dialect is the shared SQD/SubQuery GraphQL-entity dialect (`@entity`,
`@derivedFrom` for the reverse side of a relation, `@index` for a Postgres index).

```graphql
type Author @entity {
  id: ID!                 # AccountId (ss58)
  identityHash: String @index # 32-byte blake2b_256(serialized owner Address) hex (== beacon token_name),
                              #   from CognoGate.IdentityLinked; null until bound (DR-01; storage field is PkhOf,
                              #   but it now carries the 32-byte address hash, not a 28-byte pkh)
  postCount: Int!
  posts: [Post!]! @derivedFrom(field: "author")
}

type Post @entity {
  id: ID!                 # on-chain u64 post id (DR-21)
  author: Author!
  text: String!
  parent: Post            # null = top-level; self-relation gives threading
  replies: [Post!]! @derivedFrom(field: "parent")
  blockHeight: Int! @index
  timestamp: DateTime! @index   # for recency pagination
  deleted: Boolean!       # soft-delete on PostDeleted (keeps thread structure)
}

type Thread @entity {     # optional convenience; root = top-level post
  id: ID!                 # = root post id
  root: Post!
  replyCount: Int!
  lastActivity: DateTime! @index
}
```

- **Global feed** = `Post(orderBy: timestamp_DESC, first: N, after: cursor, where:
  { deleted_eq: false })`.
- **Profile** = `Author` addressable by `id` (AccountId) **or** by `identityHash` (the
  32-byte owner-Address hash, the gate binding; DR-01) → `posts`.
- **Threads** = `Post.replies` recursively, or `Thread.root` + derived replies.
- **Search** = `where: { text_containsInsensitive: q }` (SQD) or the generated
  `searchPost(search: q)` from SubQuery's `@fullText` directive (Postgres
  tsvector/tsquery).

⚑ **Soft-delete, don't hard-delete.** On `PostDeleted` set `deleted: true` rather
than removing the row — it keeps thread structure intact (a deleted *parent* must
not orphan its children; tombstone the parent, keep children queryable) and keeps
the feed reproducible/auditable. (On-chain, `delete_post` removes the `Posts` row
and there is no refund — `L3-chain.md` §4.4; `Posts.getValue` on a deleted id
returns `undefined`, and `ByAuthor` still holds the stale id, so the indexer
reconciles.) **This policy is a convergence-relevant choice — pin it in the
published mapping spec (§6.1/§6.2.1) or two indexers diverge.**

### 4.2 The PAPI snippets (Tier A)

Bootstrap (`L3-chain.md` §7): `npm i polkadot-api`; `npx papi add cogno -w
ws://localhost:9944`; `npx papi`.

```ts
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { cogno } from "@polkadot-api/descriptors";

const client = createClient(getWsProvider("ws://localhost:9944"));
const api = client.getTypedApi(cogno);

// GLOBAL FEED (small scale): one-shot + live deltas
const entries = await api.query.Microblog.Posts.getEntries({ at: "finalized" });
api.query.Microblog.Posts.watchEntries().subscribe(({ deltas }) => {/* render upserted/deleted */});
client.finalizedBlock$.subscribe(b => {/* finality marker */});

// PROFILE by AccountId (uses the on-chain ByAuthor index)
const ids = await api.query.Microblog.ByAuthor.getValue(account);
const posts = await api.query.Microblog.Posts.getValues(ids.map(id => [id]));

// PROFILE by IDENTITY (the 32-byte owner-Address hash; resolve via the gate, then ByAuthor)
// idHash32 = blake2b_256(serialized owner Address) — the SAME 32 bytes as the L1 beacon token_name (DR-01)
const acct = await api.query.CognoGate.AccountOf.getValue(Binary.fromBytes(idHash32));
//   reverse: const idHash = await api.query.CognoGate.PkhOf.getValue(account); // 32 bytes, not 28

// THREAD: read the root + walk replies off-chain from Post.parent
const root = await api.query.Microblog.Posts.getValue(rootId);
//   (no on-chain children index — reconstruct children client-side / via the indexer)
```

- **Search** has **no** Tier-A equivalent — it is indexer-only (§3.3).
- `at: 'best' | 'finalized' | blockHash` selects the snapshot; prefer `'finalized'`
  for stable reads, `'best'` for a snappier live feed (then handle reorg drops via
  `.watchBest()`'s `type:'drop'`, §8.2).
- Posting is signed by the user's **Substrate sr25519** key, never the Cardano
  wallet (`L3-chain.md` §7). The CIP-8 `signData` is a one-time onboarding step done
  by the follower, never on the post path.

---

## 5. Onboarding & capacity read-state

The onboarding/status panel is computed from **two independent read planes that
never meet on the hot path.** This is the one genuinely cross-layer read in L4 —
and the place the "reads never touch Cardano" invariant is easiest to violate by
accident, so the read map is explicit.

### 5.1 The exact read map — which read comes from WHERE

| UI element | Source | Read |
|---|---|---|
| **weight** (posting power) | **L3** (PAPI) | `TalkStake.AllowedStake.getValue(acct)` → `u128` (ValueQuery: 0 if unbound/unlocked) |
| **capacity bucket** | **L3** (PAPI) | `Microblog.Capacity.getValue(acct)` → `{cap_last,last_block}` or `undefined` |
| **clock** | **L3** (PAPI) | current best/finalized block number (`finalizedBlock$`) |
| **identity bound?** | **L3** (PAPI) | `CognoGate.PkhOf.getValue(acct).isSome` (the `is_allowed` proxy; the stored value is the 32-byte address hash, DR-01) |
| **constants** (`CapRatio`, `RegenPerBlock`, `Ceiling`, `BaseCost`, `PerByteCost`) | **L3** (PAPI) | `api.constants.Microblog.*()` — read from metadata, not hardcoded |
| **live vault balance** (parked now) | **Cardano** (db-sync — **optional cross-check**, DR-33; **NO Blockfrost**) | largest unspent beacon UTxO for `blake2b_256(serialized owner Address)` (DR-01) — onboarding only, **off** the post path. Default is to skip Cardano and read counted weight off L3 `AllowedStake`. |

Everything that gates or sizes posting is an **L3-only** read. Cardano is consulted
**only** to answer "is my vault set up / how much ADA is parked," and never blocks
posting.

> ⚑ **Two balances, do NOT conflate them.** **Live vault balance** = Cardano tip
> (optional read-only db-sync, DR-33; **no Blockfrost**), changes instantly on
> top-up/unlock. **Weight-bearing balance** = L3 `AllowedStake`, equals the
> **largest** buried beacon UTxO as-of the follower's pinned cursor (`L1-cardano.md`
> §10 / `L2-follower.md` largest-wins — **never sum** an identity's duplicate beacons).
> **Capacity is driven ONLY by `AllowedStake`** — which is the **default posting-power
> read** (DR-33), so the live Cardano balance is purely an optional cross-check. Show
> both when available — "Parked now: X ADA (live, optional)" vs "Counted for posting:
> Y ADA (as of cursor)" — and note "pending burial (~k confirmations)" so a
> freshly-funded user isn't confused that weight/capacity lag the deposit
> (going-forward-only + burial latency, `L2-follower.md`).

**Cardano onboarding read (read-only db-sync, the same index the follower uses):**
query db-sync (via `DBSYNC_URL`) for unspent vault UTxOs where the **`payment_cred`
is the merged `talk_vault` script hash** (DR-18 — there is one validator; the beacon
policy == the vault script hash, no separate beacon policy) and the beacon
`token_name = blake2b_256(serialized owner Address)` (DR-01, `L1-cardano.md`);
spentness comes from `tx_in` and lovelace is read as `::text`; parked-now ADA =
lovelace of the **largest** unspent match (mirror largest-wins so the UI agrees with
the follower). **Best default (DR-33):** skip Cardano entirely and read "ADA that
counts" straight off L3 (`AllowedStake` **is** the largest-beacon buried lovelace the
follower already published) — zero Cardano access, fully reproducible, and the
**default posting-power read**. Use db-sync only as an **optional** independent cross-
check; **do NOT use Blockfrost** (DR-33 — no Blockfrost dependency). Devnet is PREPROD
(db-sync/Ogmios, DR-31).

### 5.2 The live talk-capacity + regen countdown (client-side)

The widget replays `current_capacity()` (`L3-chain.md` §4.3) **verbatim** so it can
never disagree with the pool gate. All inputs are L3 storage; the math is pure and
publicly recomputable.

```ts
// constants K read once from PAPI typed constants (metadata) — never hardcoded
function currentCapacity(w: bigint, bucket: {cap_last: bigint, last_block: number} | undefined,
                         now: number, K: Consts): bigint {
  const capLinear = w * K.CapRatio;
  const cap = capLinear < K.Ceiling ? capLinear : K.Ceiling;   // capped-linear
  if (!bucket) return 0n;                                       // ⚑ None = first-touch = 0, NOT full
  const elapsed = BigInt(now) - BigInt(bucket.last_block);
  const filled = bucket.cap_last + w * K.RegenPerBlock * elapsed;
  return filled < cap ? filled : cap;                           // all saturating by construction
}

// turn it into what the user sees
const postCost = (len: number) => K.BaseCost + K.PerByteCost * BigInt(len);
const need = postCost(textLen);
const rate = w * K.RegenPerBlock;                               // capacity units per block
const current = currentCapacity(w, bucket, now, K);
const blocksUntilAffordable =
    rate === 0n  ? Infinity                                     // ⚑ BigInt /0n THROWS RangeError — guard first
  : current >= need ? 0
  : Number((need - current + rate - 1n) / rate);                // ceil-div; rate>0n guaranteed here
const secsUntilAffordable = blocksUntilAffordable * slotSeconds;// slotSeconds from Aura slot_duration
```

**Live tick without RPC spam:** subscribe once with
`api.query.Microblog.Capacity.watchValue({ at: 'best' })`, then a local
`setInterval` interpolates `now = lastBlock + (Date.now() - lastBlockWallclock) /
slotMs` and recomputes for a smooth countdown; the next `watchValue` emission
**resyncs to chain truth.**

**Edge cases the widget MUST render correctly:**

- `bucket === undefined` (`None`) ⇒ capacity **0**, not full — a freshly-bound
  identity charges up from empty. Rendering `undefined` as "full" tells a new user
  they can post when `validate()` will reject them. (⚑ The single most likely UI bug
  here.)
- `w === 0n` (unbound/unlocked) ⇒ `cap = rate = 0` ⇒ countdown shows "no capacity —
  lock ADA to post," not a finite timer. **`rate === 0n` is guarded *before* the
  ceil-division** — in JS `BigInt / 0n` throws `RangeError`, it does **not** yield
  `+Infinity` (that's float behavior), so the guard is mandatory, not cosmetic. On
  unlock the `Capacity` row is **never deleted** (clamped to 0 via `weight→0`), so
  always run the formula rather than reading `cap_last` directly.
- **Show capacity "as of finalized block N," not wall-clock-exact** — the clock is
  the block number; if Aura stalls, regen visibly pauses (`L3-chain.md` §4.3). Track
  blocks; wall-clock is only interpolation, resynced each block.

### 5.3 The onboarding checklist (all reads named)

```
  ┌─ ONBOARDING / STATUS PANEL ────────────────────────────────────────────────┐
  │                                                                             │
  │  1. Vault funded?   ── L3 AllowedStake>0 (DEFAULT, DR-33)   OR optional      │
  │                          db-sync cross-check: beacon UTxO for               │
  │                          blake2b_256(owner Address), lovelace ≥ 100 ADA     │
  │                          (no Blockfrost)                                     │
  │         │                                                                   │
  │  2. Identity bound? ── L3  CognoGate.PkhOf[acct].isSome  (is_allowed proxy) │
  │         │                  (follower-written; UI cannot self-bind)          │
  │  3. Weight granted? ── L3  TalkStake.AllowedStake[acct]                     │
  │         │                  (0 until follower buries past depth k → expect   │
  │         │                   "pending burial ~k blocks")                     │
  │  4. Capacity ready? ── L3  current_capacity(acct)  (0 right after bind,     │
  │                          charges up; live countdown §5.2)                   │
  │                                                                             │
  │  POST PATH + capacity widget:  L3 ONLY (PAPI).  Cardano: step 1 only,       │
  │  off the hot path.                                                          │
  └─────────────────────────────────────────────────────────────────────────────┘
```

The UI must set expectations: after the CIP-8 sign there is **follower latency +
burial latency** before `is_allowed` flips and weight/capacity appear. A
freshly-funded user seeing weight 0 is **pending**, not broken.

---

## 6. Credibly-neutral / open reads

This is the hyperstructure read property — and the one part of L4 that is not just
standard data plumbing. It mirrors `L2-follower.md`'s "auditable, anyone-can-
recompute" stance exactly: **determinism + public inputs + a published spec ⇒
verifiability without permission.**

### 6.1 Why anyone can reproduce the feed

The feed is a **pure fold over a public, append-only event log.** L3's
`pallet-microblog` emits `PostCreated{id, author}` / `PostDeleted{id}`, and `Posts`
is keyed by a strictly-increasing `NextPostId`. `feed = replay(events)`. There is
**zero non-determinism** in the mapping — no wall-clock (`post.at` is the on-chain
block number), no external lookups. So two indexers fed the same finalized block
range produce **byte-identical `Post` rows — given the published mapping spec.** The
one input the determinism of the event log does **not** fix is the delete policy:
soft- vs hard-delete on `PostDeleted` yields different entity tables, so convergence
holds **iff** the published spec **pins** that policy (§4.1, §6.2.1; the open
question in §10.3). With the spec pinned, "anyone can reproduce the identical feed"
is a **theorem, not a slogan** — the precise analogue of L2's deterministic
`vaults→weight` fold over public L1 UTxOs.

Every entity is a function of public chain data: `id`/`author` from the event,
`text`/`parent`/`at` from `Posts` storage, threads from `Post.parent`,
profile-by-author from `ByAuthor`, profile-by-**identity** (the 32-byte owner-Address
hash, DR-01) by joining the gate's `PkhOf`/`AccountOf` + `IdentityLinked`. Nothing is
trusted; everything is reconstructed.

### 6.2 The four defenses (all cheap, all real)

1. **Publish the open schema + mapping spec.** Ship (a) the GraphQL entity schema
   (§4.1) and (b) the deterministic event→entity mapping (which event/storage field
   → which entity field, the finality rule, the reorg rule, the **pinned** soft-/
   hard-delete policy), **versioned per `spec_version`.** This is the cheap,
   mandatory v1 deliverable that turns "open reads" from marketing into a property —
   exactly L2's D0 lesson: *"anyone can recompute" is empty unless the substrate to
   recompute against ships.*
2. **Finality-aware ingestion** (§8.2) so independents **converge** on the same
   entities and don't diverge on transient forks. Index against GRANDPA-finalized
   blocks; handle reorg rollback. Without this, "identical feed" breaks on forks —
   load-bearing, not polish.
3. **Endpoint-as-config + PAPI-direct fallback.** The frontend treats the indexer
   endpoint as configuration (ideally a list / user-overridable) and **degrades to
   PAPI-direct against any public RPC** when no indexer is trusted/available. The
   ability to fall back is the *structural* guarantee that no indexer is
   authoritative.
4. **Light reads via a public RPC.** At least one openly-reachable RPC (behind sane
   rate-limits / a reverse proxy — not naked `--rpc-external --rpc-cors all`, which
   `L3-chain.md` §3.2 flags dev-only) underpins both "run your own indexer" and the
   PAPI fallback. Anyone can also run a full/archive node from genesis and serve
   their own (§6.5 — the archive is the load-bearing dependency, not the indexer).

### 6.3 The soft re-centralization — named and avoided

> **The risk, stated plainly:** if the frontend hard-codes **ONE** managed
> indexer/GraphQL endpoint (SQD Cloud, a single hosted SubQuery), that endpoint
> becomes a **de-facto read authority** — it can omit, reorder, delay, or censor
> posts, and it is a single point of failure — **even though L3 itself stays
> open.** The open chain buys end-users nothing if the app only ever talks to one
> box. This is the soft re-centralization of the read path the hyperstructure goal
> forbids.

The mitigation is **structural, not a promise**: published schema + mapping (§6.2.1)
so independent indexers converge; endpoint-as-config with PAPI-direct fallback baked
in **from day one** (§6.2.3); and treating any single endpoint as a replaceable
cache over public on-chain truth. **Do not architect around a token-gated
decentralized indexing network either** — see §7 on why neither SQD Network nor
SubQuery's SQT network can serve a custom solochain anyway, and why coupling reads
to a third-party token network is its own re-centralization.

### 6.4 The honest limit (mirror L2 §10)

`L2-follower.md` §10's *auditable ≠ trustless* becomes here **reproducible ≠
effortless.** "Anyone CAN run an indexer" is a **capability**, not a cost-free
reality (§7).

### 6.5 Data availability is the hard prerequisite — not an optional late milestone

The deepest dependency for "anyone can reproduce the feed" is **not** the indexer —
it is **data availability**: at least one **independently-served archive** of full
history from genesis. The indexer is replaceable; archived history is not. If the
sole operator prunes or withholds L3 history, "anyone can reproduce the feed"
becomes **unbacked** — the exact data-availability caveat `L3-chain.md` §8.4 raises
for the anchor, applied to reads. **DECIDED (DR-08): the archive is COMMITTED in v1** —
this is no longer an open who/whether question. The operator runs a `--pruning archive`
node + publishes the genesis hash + chainspec, and L4-M4c re-derivation from genesis is
a **v1 acceptance test**. The concrete commitments:

- **The operator runs the archive node** (full history, `--pruning archive`) and serves
  it independently of the canonical indexer/RPC (DR-08).
- **Publish the genesis hash + chainspec** so a third party can sync from block 0 and
  byte-verify they reached the same chain (DR-08).
- **Gate the claim on a re-derivation test:** *a skeptic re-derives the feed from
  genesis against independently-served history* is a **committed v1 acceptance test**
  (L4-M4c, DR-08), **not** a late "nice to have." It is the gate that turns "open reads"
  from aspiration into a tested property at launch.

With DR-08 in place, "open reads" is **honestly backed at launch** rather than "open in
principle, contingent on an archival commitment that does not yet exist."

---

## 7. Hosting & decentralization

The load-bearing operational call: **self-host the indexer; treat managed clouds as
optional convenience, never the canonical read path.**

### 7.1 Self-host vs managed

- **Self-host (recommended).** Both SubQuery (the **chosen reference**, DR-27) and
  SQD's `squid-sdk` self-host via docker-compose (Postgres + indexer + GraphQL) against
  your own L3 RPC (`ws://…:9944`) with **no token and no managed-network dependency.**
  Reproducible from genesis by replaying public events → any operator gets the identical
  feed (backed by the COMMITTED v1 archive of §6.5 / DR-08).
- **Managed (optional only).** SQD Cloud / SQD Network portal and SubQuery's Managed
  Service / SQT network are conveniences. **Never make a hosted endpoint the sole or
  authoritative feed** (§6.3).

### 7.2 SQD/Subsquid status (verify before depending — 2026-06)

- **Subsquid/SQD was acquired by Rezolve AI** (NASDAQ:RZLV), deal closed **2025-10**
  (~$10M cash + 1M shares); the **SQD token is being rebranded** and product focus is
  shifting toward a token-gated decentralized data lake / AI-commerce data.
- **The open-source `squid-sdk` remains Apache-2.0 and actively maintained** (commits
  into 2026), so **self-hosting is unaffected today.** But the strategic center of
  gravity is moving away from Substrate — so **don't architect around the SQD
  Network/portal**, both because (a) it **cannot serve a brand-new custom
  solochain** (your chain isn't in its dataset registry → you ingest RPC-only
  anyway), and (b) its governance/economics are now a third party's.
- ⚑ Treat SQD-the-SDK as **one interchangeable option** behind the open schema, not
  a vendor lock-in. **SubQuery** (open-source, Apache-licensed, Substrate-first,
  self-hostable) is the **CHOSEN reference indexer** (DR-27 — lower strategic risk),
  with SQD a clean **second** independent indexer for the "multiple indexers" property.
- **The core point stands without anecdote:** don't couple reads to *either* token
  network (SQD Network or SubQuery's SQT) — the RPC-only / self-host path already
  removes the dependency. (Token-network exploits do happen — verify any current
  incident from a primary source before citing; this doc deliberately does not lean
  on one.)

### 7.3 The Substrate gotcha (custom-chain ingestion)

A custom solochain is in **no** decentralized archive, so the indexer ingests
**RPC-only**:

- **SQD:** `new SubstrateBatchProcessor().setRpcEndpoint({url:'ws://localhost:9944'})`
  **with `setGateway()` OMITTED.** Note: on Substrate the **RPC endpoint is required
  even if a gateway is set** (the processor pulls runtime metadata over RPC), and for
  a custom chain you supply your **own** metadata to typegen — the SQD-hosted
  metadata service won't have your chain. RPC-only sync is slower for full history,
  fine at this scale. This is **good** for the hyperstructure story: no SQD-network
  dependency.
- **SubQuery:** custom chain keyed by genesis (block-0) hash `chainId` + WS endpoint
  + chain type defs; same self-host docker stack.

### 7.4 Cost realities (be honest)

Running Postgres + an indexer process + a GraphQL server 24/7 with monitoring has
**real ongoing cost and ops burden**, and full-history re-index is **RPC-bound** (slow)
because a custom solochain is in **no decentralized/hosted archive** (the SQD/SubQuery
dataset registries don't carry it). That re-index is, however, honestly possible in v1:
DR-08 commits the operator to run a `--pruning archive` node + publish the genesis hash
+ chainspec, and DR-27 commits a **public rate-limited read RPC** for the PAPI-direct
fallback, so the substrate to recompute against actually ships. So in practice the
**median user hits a hosted endpoint**, but the hyperstructure guarantee is the **exit
option** (permissionless reproduction + verifiability + PAPI fallback against the public
RPC), **not** that everyone self-hosts. Overclaiming "fully decentralized reads" repeats
L2's *auditable ≠ trustless* trap one layer up. **Honest posture: reads are a
convenience; the chain is truth.**

---

## 8. Honest risks

- **Data availability is the deepest vector (not the indexer).** The indexer is
  replaceable; **archived history is not.** If the sole operator prunes/withholds L3
  history from genesis, "anyone can reproduce the feed" would be unbacked regardless of
  how many indexers exist (`L3-chain.md` §8.4, applied to reads). **DR-08 closes this for
  v1:** the archive is COMMITTED (operator runs a `--pruning archive` node + publishes the
  genesis hash + chainspec; the M4c re-derivation is a v1 acceptance test, §6.5). The
  residual risk is therefore operational (the operator must actually keep the archive node
  up + reachable), not an unresolved who/whether question.
- **Indexer trust / availability (soft re-centralization).** A single hosted
  GraphQL endpoint everyone's client hardcodes is a de-facto read authority and a
  single point of failure (§6.3). It can omit/reorder/delay/censor. Mitigate
  structurally: published schema + mapping, multi-endpoint config, PAPI-direct
  fallback — not a promise.
- **Reorg / finality handling.** If indexers index un-finalized (best-chain) blocks
  without reorg rollback, two independents diverge on transient forks and the
  "identical feed" claim breaks. Index against GRANDPA-finalized blocks
  (`finalizedBlock$`; SQD hot-block/unfinalized support, SubQuery
  `--unfinalized-blocks`) and roll back orphaned writes. **And** L3's finality can
  **stall** on a 1–3 authority chain (`L3-chain.md` §8.1) — when it stalls,
  finality-aware indexers correctly **stop advancing** rather than show unconfirmed
  data; **surface "finalized vs best" in the UI, don't paper over it.** Do not cache
  deletes/edits as permanent before finality.
- **Single-endpoint dependency.** Even with self-hosting available, the default
  client config points somewhere. If that one place dies, the app dies — unless
  endpoint-as-config + PAPI fallback are real and tested from day one. Treat "the
  app works against a second, independently-run endpoint" as a v1 acceptance test.
- **Search / abuse.** Full-text search is an indexer feature and an abuse surface:
  an open public RPC is a DoS target (no fee floor in front of it — same feeless
  reality as the post path), and search queries can be expensive. Rate-limit /
  proxy the public RPC and the GraphQL endpoint; the chain being open does **not**
  mean the read infra is unprotected.
- **Metadata coupling.** A `spec_version` bump that changes `PostCreated`/`Posts`
  encoding requires regenerating the indexer's typegen **and** re-running `npx papi`,
  or ingestion silently mis-decodes (`L3-chain.md` §3.3/§7/§9). Pin the indexer's
  codegen to the runtime version in lockstep with PAPI.
- **Post-id space (inherited from L3).** `NextPostId` is **`u64`** (DR-21,
  `L3-chain.md` §4.4) — the old `u32`/`2^32` wrap-and-collide concern is **removed**, so
  the reproducibility claim is no longer scoped below `2^32` posts and an indexer keying
  on `id` is safe at this scale.
- **Trust-inherited identity (the 32-byte owner-Address hash).** L4 surfaces the gate
  binding as-is; it is **not** cryptographically re-verified on the read side
  (`L3-chain.md` §4.1/§9). Don't present a profile's bound identity as proven by L4. (Per
  DR-01/DR-02 the binding itself is a whole-Address match committed in the CIP-8 payload,
  so bind-hijack is prevented at write time; L4 still does not re-prove it on read.)
- **Two-balance confusion.** Showing the **live** Cardano vault balance as "your
  posting power" misleads — capacity is driven only by `AllowedStake` (§5.1). Keep
  the two numbers distinct.

---

## 9. How L4 fits the stack

```
   L1 CARDANO            L2 FOLLOWER              L3 cogno-chain            L4 READ / SERVE (this doc)
   ═══════════           ═══════════              ═════════════            ══════════════════════════
   talk_vault    ──obs──▶ vaults→weight  ──set_stake/──▶ pallet-microblog
   (ADA + beacon)        (largest-wins,    link_identity   Posts / ByAuthor / parent
        │                 CIP-8, bury k)   (FollowerOrigin) Capacity (folded)
        │                                                  │
        │                                                  │ emits PostCreated / PostDeleted
        │                                                  │ (public + deterministic events)
        │                                                  ▼
        │                                   ┌──────────────────────────────────────────────┐
        │                                   │  TIER A: PAPI direct  (WS RPC :9944)           │
        │                                   │   getEntries / watchEntries / finalizedBlock$  │  ──▶ FRONTEND
        │                                   │   ByAuthor, PkhOf/AccountOf, Capacity          │       FEED
        │                                   │                                                │     (feed,
        │                                   │  TIER B: INDEXER (SubQuery [chosen] / SQD, SELF-HOST) │ profiles,
        │                                   │   PostCreated/Deleted + Gate/Stake events       │      threads,
        │                                   │     → Postgres → GraphQL                        │  ──▶ search,
        │                                   │   pagination · search · threads · profiles      │      capacity)
        │                                   └──────────────────────────────────────────────┘
        │                                          ▲ anyone can run their own (open schema
        │                                          │  + independently-served archive, §6.5)
        │  ONBOARDING READ (off the post path):    │ no indexer is authoritative
        └──L3 AllowedStake (DEFAULT) · db-sync opt.┘   +   L3: AllowedStake → Capacity → countdown
           cross-check (no Blockfrost): largest         (the capacity widget is L3-ONLY)
           beacon UTxO (vault ADA, one-time/verify)

   Post-read path: L3 ONLY — NEVER touches Cardano.   Onboarding/capacity: L1 (once) + L3 (live).
```

**One sentence:** L3 emits public, deterministic post events → anyone reads them
straight (PAPI) or via a self-hosted indexer (Postgres+GraphQL) against an
independently-served archive → the frontend shows the feed, profiles, and threads;
the onboarding widget alone reads L1 (once) and L3 (live) — and no single indexer is
the authority.

---

## 10. Open questions for the owner

> **RESOLVED in DECISION-REGISTER.md (2026-06-16) — see that doc.** Q2 (SubQuery is the
> chosen reference indexer, DR-27), Q4 (the archive is COMMITTED, DR-08), Q5 (run a
> public rate-limited read RPC for the PAPI fallback, DR-27), and Q6 (default = L3
> `AllowedStake`; db-sync optional cross-check, no Blockfrost, DR-33) are decided. The
> detail is kept below for context.

1. **PAPI-only for v1, or stand up the indexer at M3?** Recommend PAPI-direct for
   v1 (it's the neutral baseline, zero infra) and the indexer at M4 when
   `getEntries()` stops scaling. Is there a launch feature (search, deep
   pagination) that forces the indexer earlier?
2. **SQD or SubQuery as the reference indexer?** *(RESOLVED — DR-27: **SubQuery** is the
   chosen reference, self-hosted, built at L3 M4; PAPI-direct is the v1 baseline; SQD
   remains a valid second independent indexer.)* Original framing: recommend a self-hosted
   SQD squid on technical fit (native Substrate, RPC-only custom-chain ingestion,
   Apache-2.0 standalone SDK); SubQuery is the lower-strategic-risk default (Substrate-
   first, `@fullText`). Pick one as the *published reference* — or publish *both* configs
   to strengthen "multiple independent indexers"?
3. **Soft-delete vs hard-delete on `PostDeleted`.** Recommend soft-delete (keeps
   thread structure + "deleted post" placeholders + reproducibility). Whichever is
   chosen, it **must be pinned in the published mapping spec** or independent
   indexers diverge (§6.1). Acceptable, or does the product want deleted posts to
   vanish from every reproduction?
4. **Archival commitment (a v1 prerequisite, not optional — §6.5).** *(RESOLVED — DR-08:
   the archive is COMMITTED in v1; the operator runs the `--pruning archive` node +
   publishes the genesis hash + chainspec, and L4-M4c re-derivation from genesis is a v1
   acceptance test. No longer a who/whether question — only operational scheduling.)*
   Original framing: open-reads is contingent on an independently-served archive of full
   history from genesis, so the question is *who/how*, not *whether*: who runs the
   `--pruning archive` node, on what host independent of the canonical indexer, and when
   is the genesis hash + chainspec published so the L4-M4c re-derivation test can gate the
   "open reads" claim? (Shared data-availability concern with `L3-chain.md` §8.4 /
   `PLAN.md` Q4.)
5. **Public read RPC posture.** *(RESOLVED — DR-27: run an openly-reachable, rate-limited
   read RPC for PAPI-direct light reads + the fallback.)* Run an openly-reachable
   rate-limited read RPC for PAPI-direct light reads + the fallback, or require
   run-your-own-node? What rate-limit / proxy stance (the feeless DoS surface applies to
   reads too)?
6. **Onboarding read default for "parked ADA."** *(RESOLVED — DR-33: default posting-power
   read = L3 `AllowedStake`; live Cardano balance is an **optional** read-only db-sync
   cross-check; **no Blockfrost**.)* Show the live Cardano balance (optional db-sync)
   alongside the L3 counted weight, or show counted-weight only by default and make the
   Cardano cross-check opt-in? (Avoids any external-key single dependency.)
7. **Multi-endpoint UX.** Should the frontend ship a user-overridable indexer/RPC
   endpoint list (the structural anti-recentralization guarantee), and is that a v1
   requirement or a fast-follow?

---

## 11. Implementation milestones (L4)

Bite-sized, executable cold; aligned with `L3-chain.md` M3 onward (the
frontend post/read loop is L3 M3).

1. **L4-M3 — PAPI-direct read loop (with L3 M3).** Next.js + PAPI: live global feed
   via `watchEntries()`, single-post + profile-by-AccountId via
   `Posts`/`ByAuthor`, profile-by-**identity** (the 32-byte owner-Address hash, DR-01)
   via `CognoGate.AccountOf`, and the **client-side capacity widget**
   (`current_capacity` replay + regen countdown, §5.2). Zero indexer infra.
   **Acceptance:** the feed renders and the capacity countdown matches `validate()` (an
   over-budget account sees "wait N blocks"); the `w===0n` / `bucket===undefined` paths
   render "no capacity" / "charging from 0," never a false "ready" and never a
   `RangeError`.
2. **L4-M3b — Onboarding/status panel (cross-layer read).** Wire the read map of
   §5.1: L3-only weight/capacity/binding by default (DR-33: `AllowedStake` is the
   posting-power source) + (optional) the db-sync "parked-now vs counted"
   two-number cross-check with the burial-latency note (**no Blockfrost**).
   **Acceptance:** a freshly-funded user sees "pending burial," then weight, then
   capacity charging up — never a false "ready."
3. **L4-M4 — Self-hosted indexer + GraphQL (with L3 M4).** Stand up the **chosen
   reference indexer, a self-hosted SubQuery** (DR-27; SQD is the optional second), via
   docker-compose, RPC-only against the L3 node; ingest `PostCreated`/`PostDeleted` +
   `CognoGate.IdentityLinked` + `TalkStake.StakeSet`; serve the §4.1 schema (paginated
   feed, search, threads, profile-by-**identity-hash**). Enable finality-aware ingestion
   (`--unfinalized-blocks` / hot-block). **Acceptance:** paginated/searchable feed; an
   independently-run second instance reproduces byte-identical `Post` rows.
4. **L4-M4b — Publish the open schema + mapping spec (D0-equivalent).** Publish the
   versioned GraphQL schema + the event→entity mapping (finality rule, reorg rule,
   **pinned** soft-/hard-delete policy, start block, RPC), pinned per `spec_version`.
   **Acceptance:** a third party reproduces the feed from the published spec alone —
   the property is real, not asserted.
5. **L4-M4c — Archival commitment + re-derivation gate (COMMITTED v1 acceptance test,
   DR-08, §6.5).** Stand up the **independently-served** archive node (full history from
   genesis, `--pruning archive`); publish the genesis hash + chainspec. **Acceptance
   (gating):** a skeptic re-derives the feed **from genesis** against this independently-
   served history and reaches byte-identical `Post` rows. DR-08 makes this a committed
   v1 acceptance test, so "open reads" is honestly backed at launch once it passes.
6. **L4-M5 — Multi-endpoint frontend + PAPI fallback.** Endpoint-as-config
   (user-overridable indexer/RPC list); the app degrades to PAPI-direct when no
   indexer is reachable. **Acceptance:** the app works against a second,
   independently-run endpoint, and against PAPI-direct with no indexer at all.
7. **L4-M5b — Public read-RPC hardening (with L3 M5/M6).** Put the public read RPC
   (and the archive node of M4c) behind a rate-limited reverse proxy; not naked
   `--rpc-external --rpc-cors all`. **Acceptance:** light reads + PAPI fallback work
   against the proxied endpoint under sane rate limits.

---

## Appendix A — Key references

- **In-repo (authoritative, build on these):** `docs/L3-chain.md` (§4.1 CognoGate
  `PkhOf`/`AccountOf` + `IdentityLinked`; §4.3 `current_capacity` pure fn +
  constants; §4.4 `Posts`/`NextPostId`/`ByAuthor`/`parent` + `PostCreated`/
  `PostDeleted`; §7 the two read paths + PAPI snippets; §8.1 finality-stall reality;
  §8.4 data-availability caveat; M3/M4 milestones); `docs/L2-follower.md` (the
  deterministic largest-wins fold + published spec + standalone recomputer = D0; §10
  *auditable ≠ trustless* — carried here as *reproducible ≠ effortless*; largest-wins
  / never-sum; clamp-on-unlock); `docs/L1-cardano.md` (the merged single `talk_vault`
  validator, DR-18 — `policy_id == vault script hash`, no separate beacon policy; beacon
  `token_name = blake2b_256(serialized owner Address)`, DR-01; db-sync by script hash; §10 the
  L1→L2 read).
- **PAPI (typed read client):** storage queries
  (`getValue`/`getValues`/`getEntries`/`watchValue`/`watchEntries`,
  `at:'best'|'finalized'|hash`) https://papi.how/typed/queries ; typed events
  (`.watch`/`.watchBest`/`.filter`) https://papi.how/typed/events/ ; client +
  `finalizedBlock$` https://papi.how/client/ ; getting started
  https://papi.how/getting-started/
- **SQD / Subsquid (Squid SDK, Substrate):** tutorial
  https://docs.sqd.dev/sdk/tutorials/substrate/ ; SubstrateBatchProcessor general
  settings (setRpcEndpoint required, setGateway optional)
  https://docs.sqd.ai/sdk/reference/processors/substrate-batch/general/ ;
  unfinalized blocks / reorgs https://docs.sqd.dev/sdk/resources/unfinalized-blocks/ ;
  self-hosting https://docs.sqd.dev/sdk/resources/self-hosting/ ; Apache-2.0 SDK
  https://github.com/subsquid/squid-sdk
- **SQD acquisition (verify status):** Rezolve AI acquires Subsquid (2025-10)
  https://www.globenewswire.com/news-release/2025/10/09/3164101/0/en/Rezolve-Ai-Acquires-Subsquid-Building-the-Data-and-Payments-Backbone-for-the-AI-Economy.html
  ; https://investor.rezolve.com/news-releases/news-release-details/rezolve-ai-acquires-subsquid-building-data-and-payments-backbone
- **SubQuery (open-source, self-hostable):** SDK
  https://github.com/subquery/subql ; Polkadot/Substrate quickstart
  https://subquery.network/doc/indexer/quickstart/quickstart_chains/polkadot.html ;
  custom chain
  https://subquery.network/doc/indexer/quickstart/quickstart_chains/polkadot-other.html ;
  GraphQL + `@fullText`
  https://subquery.network/doc/indexer/run_publish/query/graphql.html ; reorg
  flag https://subquery.network/doc/indexer/run_publish/references.html ; SQT
  network (optional/managed) https://subquery.network/doc/subquery_network/welcome.html
- **Cardano db-sync (read-only Postgres index of Cardano state, via `DBSYNC_URL`;
  vault UTxOs by `tx_out.payment_cred`, spentness from `tx_in`, lovelace as `::text`):**
  https://github.com/IntersectMBO/cardano-db-sync
- **Polkadot wiki — indexers (build-data):**
  https://wiki.polkadot.network/docs/build-data
