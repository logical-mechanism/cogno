# Client-side feed ranking (the "SVM stuff")

> **Status: DESIGN — not yet implemented.** This is a staged spec to build later. To pick it up:
> point at this doc and say *"implement Stage 1 of the client-side ranking"* (or Stage 2 / the SVM
> pipeline, or Stage 3). Each stage stands alone and ships independently.

## Why

The feed is pure recency ([`app/src/lib/feed/live.ts`](../app/src/lib/feed/live.ts) `byIdDesc`); there
is no ranking layer. We want a small **client-side** model that, given a block-time window, surfaces
the best posts — with **no backend algorithm** (the app is a static export, self-hostable on IPFS, no
telemetry).

**The honest framing (read this first).** The starting idea was a synthetic-data-trained SVM. But a
supervised model trained on synthetic posts *you label yourself* only re-learns your own labeling
rule — you could ship the rule directly. The synthetic phase earns its place only as (a) scaffolding
for a pipeline that later ingests real data, and (b) a neutral *prior*. The genuinely valuable version
is **on-device personalization**: the app already collects real implicit signal in the browser (votes,
reposts, replies, bookmarks, mutes); a tiny logistic model can learn from it locally, nothing leaving
the device — *more* on-brand with the no-telemetry ethos than a synthetic SVM, not less.

So this is built in three stages: **composite prior → trainable pipeline (the SVM/logistic
prototype) → on-device personalization**, surfaced on a **separate Explore view** (the home feed is
left as pure recency).

Two rules hold across every stage:

- **Windowing is a deterministic pre-filter** (a block range), separate from the model that ranks
  within it. The model never chooses the window.
- **The client can only rank what pagination loaded.** Pagination is id-descending, 50/page, so "top
  in the last N hours" means "top among the ≤M posts we paged within that window," capped — and the UI
  copy must say so.

### The seam already exists

Explore has a disabled **"Top | Recent"** toggle (`FirehoseOrderToggle`, gated by
`scoreOrderEnabled = false` in [`app/src/app/explore/page.tsx`](../app/src/app/explore/page.tsx)),
built for exactly this and waiting for a score source. Its own comment: *"The node has no score index,
so the score-ranked 'Top' order is unavailable… Flip `scoreOrderEnabled` back to true to restore
it — no other change needed."* Our client-side ranker **is** that missing score index. This is the
wire-in point; we do not touch the home feed.

## What signals we have

Every `CognoPost` ([`app/src/lib/types.ts`](../app/src/lib/types.ts)) already carries, in memory, no
extra fetch:

| Signal | Field | Notes |
|---|---|---|
| time | `at` | **block height** (u32), NOT a timestamp; elapsed = `(bestBlock − at) × 6s` |
| post reputation | `score` | stake-weighted `up − down`, **bigint lovelace, may be negative**, can exceed 2⁵³ |
| repost count | `repostCount` | u32 |
| reply count | `replyCount` | u32 (free bonus) |
| up/down counts + weights | `upCount`/`downCount`/`upWeight`/`downWeight` | collinear with `score` — see anti-leakage |
| is-poll / reply-vs-top | `isPoll` / `parent` | optional features |

Two caveats:

- **Author (user) reputation** exists but as a *separate, batched, async* lookup
  ([`app/src/hooks/useReputation.tsx`](../app/src/hooks/useReputation.tsx), `useAuthorReputation`) that
  can be `null` on first paint. Its own doc comment already flags it as "the seam a future filter reads
  from."
- **Quote count does not exist** — there is no on-chain "quoted-by" tally (`post.quote` is a single ref
  to what a post quotes). Adding it is a runtime/spec change; **out of scope**.

## Shared architecture (all three stages reuse this)

One feature-extraction layer; only the scoring *head* changes per stage. New pure module
**`app/src/lib/feed/rank.ts`** (+ `rank.test.ts`), sibling to `live.ts`. **Zero new dependencies.**

- `featurize(post, authorRepScore, bestBlock) -> number[]` — raw vector, magnitude/sign tamed:
  - **recency**: `age = max(0, bestBlock − post.at)` → `log1p(age)`. (`at === 0` = optimistic
    pending → excluded from ranking.)
  - **post reputation**: `slog1p(adaNum(post.score))`, where `slog1p(x) = sign(x)·log1p(|x|)` and
    `adaNum(x) = Number(x) / 1e6` (divide-to-ADA first — the only bigint→number step).
  - **reposts / replies**: `log1p(repostCount ?? 0)`, `log1p(replyCount ?? 0)`.
  - **author reputation**: `slog1p(adaNum(authorRepScore))`; `null` → impute neutral.
  - (optional, deferred) `isPoll`, controversy term `log1p(adaNum(downWeight))`.
  - **Anti-leakage**: one feature per concept. Use net `score`, NOT also up/downWeight + up/downCount
    (all collinear — they let the model "confirm" on a proxy of the label).
- `normalizeWindow(rawVectors) -> number[][]` — per-feature **robust z-score / percentile-rank over the
  current window**. Scale-free (handles the bigint/power-law ranges for free), adaptive, and needs **no
  shipped scaler**; scores are relative to the window, which is exactly "top *in this window*."
- `scoreHead(normalizedVector) -> number` — `dot(weights, v) + intercept`, optionally `sigmoid`.
  **Only this changes across stages.**
- Precompute each post's score ONCE, then sort (`byRankDesc`, tie-break with `byIdDesc`) — never score
  inside the comparator.

## Stage 1 — Composite score + window (ships first, no ML, no synthetic data)

The honest baseline, and the feature layer everything else reuses. Delivers "given a block of time,
return the best posts" today.

**Add**

- `app/src/lib/feed/rank.ts` — `featurize`, `normalizeWindow`, `slog1p`/`adaNum`/`log1p`,
  `rankPosts(posts, repLookup, bestBlock, weights)`, `byRankDesc`. Stage-1 `weights` are documented
  hand-chosen constants (recency −, postRep +, reposts +, replies +, authorRep +).
- `app/src/lib/feed/rank.test.ts` — Vitest (mirror `reputation.test.ts`): monotonicity, null-rep →
  neutral, bigint-overflow → finite (u128 max + a negative score), older-ranks-lower, a golden vector.
- `app/src/lib/feed/constants.ts` — add `BLOCKS_PER_HOUR = 600` (6s/block) next to `FEED_PAGE_SIZE`.

**Modify**

- [`app/src/hooks/useReputation.tsx`](../app/src/hooks/useReputation.tsx) — add
  `useAuthorReputations(addresses): (addr) => bigint | null`, a bulk selector reusing the existing
  `request` + `scores` context (ranking runs before cards mount, so it can't rely on badge-warming).
- [`app/src/app/explore/page.tsx`](../app/src/app/explore/page.tsx) — flip the existing "Top" path
  from "needs a node score index" to **client-side ranked**:
  - `scoreOrderEnabled = true`; `effectiveOrder === "score"` now means "rank the loaded firehose window
    client-side." "recency" is untouched.
  - Add a **time-window picker** (1h/6h/24h/7d/all), shown only in Top mode; window → blocks via
    `BLOCKS_PER_HOUR`, `lo = bestBlock − windowBlocks`, in-window predicate `p.at > 0 && p.at >= lo`.
  - **Paging-to-window driver**: while Top mode is active, call `firehose.loadMore()` until the oldest
    loaded `at < lo`, or `!hasNextPage`, or a page cap (`MAX_WINDOW_PAGES = 10` ≈ 500, aligned with
    `MAX_LIVE_FETCH`) — then `rankPosts(inWindow(firehose.posts), …)`. Guard the driver `useEffect`
    with a cancel flag (React 19 StrictMode double-invokes in `next dev`).
  - Honest copy when capped: "Top of the last N hours, from the most recent M posts."
  - Thread `bestBlock` in from `useSession()`.

**Reuse**: `FirehoseOrderToggle` (component + CSS already exist), `useFeedPage`
([`app/src/hooks/useFeed.ts`](../app/src/hooks/useFeed.ts)) for
`posts`/`hasNextPage`/`loadMore`/`loading`, `format.ts` (`adaNum` = `compactAda`'s ÷1e6), the
`Timeline` renderer (unchanged).

## Stage 2 — Trainable synthetic pipeline (the SVM/logistic prototype)

Replaces Stage 1's hand weights with *learned* ones, and proves the "swap synthetic → real later"
pipeline. Inference code is unchanged (still a dot product over normalized features).

**Add**

- `app/scripts/train-rank.mjs` — Node ESM (matches `scripts/*.mjs`; `postinstall: papi` proves
  Node-at-build). (a) synthesize ~5000 fake posts with **realistic overlap + label noise** — power-law
  counts, log-normal weights, signed heavy-tailed author rep, and crucially *desirable-but-cold* and
  *viral-but-bad* cases (without overlap the classes are trivially separable and the accuracy is
  fiction); (b) apply a documented labeling utility (top ~30% = "surface"); (c) train a zero-dep
  **logistic regression** (batch GD + L2) over the SAME `featurize`/`normalizeWindow` transforms;
  (d) emit `app/src/lib/feed/rank-weights.json` (`weights`, `intercept`, `features`,
  `meta{labelDef, seed, trainAcc, auc}`). Seed the PRNG for a reproducible build. `<1 KB`, imported via
  `resolveJsonModule` (precedent: `app/src/components/emoji/emoji-data.ts`). Add a `"train:rank"` npm
  script.
- **SVM swap**: a linear SVM (Pegasos hinge + L2) emits the identical `{weights, intercept}` — drop-in,
  inference byte-identical; rank on the raw margin (or Platt-sigmoid). **RBF is out**: it must ship
  support vectors (bundle cost, uninterpretable, and only re-learns the synthetic generator's
  nonlinearity). If a nonlinear boundary is ever needed, add explicit interaction features to the
  linear model instead.

**Modify**: `rank.ts` `scoreHead` reads the shipped `weights`/`intercept` (Stage 1's hand constants
become the fallback/prior). `rank.test.ts` gains a golden-probability assertion pinned to the emitted
weights (anti-drift guard if someone edits a transform without re-training).

**Framing to keep loud** (script header + JSON `meta`): this reproduces a hand-authored prior; it is
NOT learned from users. Never trust synthetic accuracy. Swapping to real data later = re-run the
trainer; inference never changes.

## Stage 3 — On-device personalization (the actually-useful version)

Cold-start from the Stage 2 prior, then learn locally from real implicit feedback. Nothing leaves the
device — same privacy contract as mutes/bookmarks.

**Add**

- `app/src/lib/feed/feedbackStore.ts` — a `createPersistentStore`
  ([`app/src/lib/persistentStore.ts`](../app/src/lib/persistentStore.ts)) instance: a capped ring
  buffer of `(featureVector, label)` rows + the current on-device weight vector. Quota/cross-tab are
  handled by the factory.
- Implicit-label capture at existing interaction sites: **positive** = vote-up / repost / reply /
  bookmark / thread-open; **negative** = mute / downvote. Sources already in-hand:
  [`useVote`](../app/src/hooks/useVote.ts), `useRepost`, `useFollow`,
  [`muteStore`](../app/src/lib/muteStore.ts), `bookmarkStore`. (Dwell needs a light
  `IntersectionObserver`; defer.)
- Online logistic **SGD** in `rank.ts` (one gradient step per interaction) updating the stored weights.
- **Cold-start shrink toward prior** by interaction count: `w = (n·w_learned + k·w_prior)/(n+k)` so
  early sessions feel neutral; mutes act as immediate hard negatives.

**Modify**: Explore Top mode reads on-device weights (falling back to the shipped prior). Add
"reset / inspect my feed model" in [`app/src/app/settings/page.tsx`](../app/src/app/settings/page.tsx) —
a genuinely novel, honest UX (clear the key / show the weights) no centralized feed can offer.

## Verification

- **Pure module (every stage)**: `cd app && npx vitest run src/lib/feed/rank.test.ts` — monotonicity,
  null-rep neutral, bigint-overflow finite (no NaN), age ordering, golden vector; plus a JSON-shape
  assertion (`features.length === weights.length`, all finite) once Stage 2 lands.
- **Stage 2 trainer**: `node app/scripts/train-rank.mjs` prints trainAcc/AUC and re-runs to a
  byte-identical JSON (determinism). Confirm `next build` bundles the JSON via `import` (compile-time,
  no runtime fetch — satisfies `output: 'export'`).
- **App end-to-end** (`cd app && npm run dev` against a node with real posts): on `/explore`, toggle
  Top + 24h → feed reorders by predicted quality; the network panel shows repeated page reads until the
  window is covered / cap hit; a just-posted optimistic card is excluded from ranking; reputation
  badges landing a beat later trigger a re-rank; toggling back to Recent is byte-identical to today;
  the home feed is unchanged throughout.
- **Stage 3**: vote/repost/mute a few posts, reload, confirm Top ordering shifts toward
  interacted-with authors/topics; "reset feed model" returns to the prior ordering.

## Risks / notes

- **Only ranks the loaded window** (fundamental) — surface honestly in copy; cap paging.
- **Synthetic accuracy is fiction** — use the synthetic model only as a prior; trust metrics only once
  real on-device labels exist.
- **bigint / power-law / leakage** — `adaNum` divides-to-ADA first, `slog1p` for signed values,
  per-window normalization, one feature per concept.
- **Reputation timing** — null on first paint → neutral → a visible reshuffle when scores land (same
  coarse-hint tradeoff the badge already makes; only in Top mode).
- **Do not revive `order: "score"` server-side** — the indexer that honored it is gone; ranking is
  client-side. Keep the home feed's `order: "recency"` untouched.
- **Main-thread cost is trivial** — ~5 mults + one `exp` per post over ≤~500 rows, memoized; no Web
  Worker needed.

## Files at a glance

**Add**: `app/src/lib/feed/rank.ts`, `rank.test.ts`, `app/scripts/train-rank.mjs`,
`app/src/lib/feed/rank-weights.json`, `app/src/lib/feed/feedbackStore.ts`.
**Modify**: `app/src/app/explore/page.tsx`, `app/src/hooks/useReputation.tsx`,
`app/src/lib/feed/constants.ts`, `app/src/app/settings/page.tsx`, `app/package.json`,
+ implicit-capture at `useVote` / `useRepost` / `muteStore` / `bookmarkStore` (Stage 3).
