# CLAUDE.md

Guidance for working in this repo. See [README.md](README.md) for the user-facing overview and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design; per-mechanism depth lives in the
focused docs under `docs/` (`IN-PROTOCOL-OBSERVATION`, `ECONOMICS`, `TRUSTLESS-IDENTITY`, `SCALE-NODE-READS`,
`VERIFIABLE-ROLE-TAGS`) and the operator runbooks (`PREPROD-BRINGUP`, `RELAY-NODE`, `UPGRADES`,
`D2-custody-runbook`). `PROTOCOL-PARAMS` maps every tunable to the file + symbol that sets it — keep it
in step on a spec bump, and re-snapshot the header's `spec_version` when you do.

## What this is

A Polkadot-SDK Substrate **app-chain** for a *feeless* "post text / read text" social app. The right
to post is metered by a regenerating, stake-weighted **talk-capacity** earned by locking ADA in a
Cardano L1 contract — not by per-post fees. Cardano is **observed, not bridged**: it supplies CIP-8
identity, the locked-ADA weight, and a deterministic block clock (a stable Cardano block hash sealed
into each header). The chain inherits **none** of Cardano's finality/security — its safety is its own
operator-run Aura/GRANDPA. It is **observe-only**: no bridge, no metadata anchoring back to Cardano.

**Posture.** The backend is **all-Rust** and **sudo-free from genesis**: every privileged call goes
through a 3-of-5 committee that exists from block 0 (it can start single-seat and federate out by
vote). The `cardano-observer` inherent is the *sole* writer of weight. This is a live, honestly-labeled
**preprod testnet** moving toward production-ready — with a single operator-run producer it is
*D4-shaped, not trustless* (that needs ≥3 independent producers). Mainnet gaps (`MinAuthorities` floor,
GRANDPA equivocation, an independent CIP-8-verifier audit, prod key custody) are deliberately left in
place as `MAINNET PREREQUISITE` comments — **do not "fix" them** unless explicitly asked; they are
scoped-out testnet choices, not bugs.

## Layout

| Path | What |
|---|---|
| `node/` | `cogno-chain-node` (Aura + GRANDPA). `src/consensus/` = a custom proposer (reimplemented Apache-2.0 partner-chains `PartnerChainsProposerFactory` + `InherentDigest`) that seals the stable Cardano block anchor into each header as a `cobs` PreRuntime digest. Operator subcommands: `run`, `gen-chainspec`, `export-chain-spec`, `key insert`/`inspect-node-key` (session secret by file; p2p identity); a one-shot db-sync `config_check` runs automatically at boot |
| `runtime/` | `cogno-chain-runtime` (`#[frame_support::runtime]`, **spec_version 213 / tx_version 7**) |
| `pallets/` | `microblog` (10, storage v10; call_index 1 `delete_post` and 6 `repost` both permanently vacant), `talk-stake` (9, call-less observer-written ledger), `cogno-gate` (8, CIP-8 1:1 identity), `governed-upgrade` (7), `validator-set` (14), `cardano-observer` (16, enforcing; `MaxObserved` 1024, benchmarked `observe`, on-chain stall alarm), `profile` (17), `governance-fuel` (18, committee-administered REGENERATING admin-fuel budget — `set_allowance`/`revoke` + an `on_initialize` regen hook; non-transferable, mint-on-demand), `cardano-roles` (19, verifiable role tags: a bare-unsigned CIP-8 `claim_role_signed` + feeless `unclaim_role`, over a call-less observer-written `ObservedRoles` ledger; only `revoke_role` is committee-gated), `tx-pause` (20, upstream FRAME — the committee break-glass wired into `BaseCallFilter`) |
| `cli/` | `cogno-chain-cli` — the all-Rust admin CLI (typed `RuntimeCall` only, keys-by-file, committee lifecycle, bare identity binds, `query state`/`weight`/`authors` over RPC) |
| `cogno-dbsync/` | shared crate: the deterministic db-sync reader + Cardano-state reduction (the node's inherent writer + its boot `config_check` probe read it identically) |
| `cogno-keyfile/` | shared crate: the cardano-cli-style JSON key envelope |
| `contracts/` | the Aiken (Plutus V3) L1 `talk_vault` validator + `audits/` — **LIVE on preprod, see gotcha below** |
| `app/` | Next.js 16 static-export frontend (PAPI + MeshJS). See [app/README.md](app/README.md) |
| `ci/cip8-oracle/` | an independent Python CIP-8 verifier (a second implementation), kept as a CI adversarial oracle — do **not** port to Rust |
| `deploy/` | two systemd units (`cogno-node` validator, `cogno-relay` public archive node), the nginx vhost that serves the static export and proxies `/rpc` → `:9944`, a root-only install script + its sudoers drop-in, and monitoring (Prometheus/Grafana/Alertmanager) |
| `chainspecs/`, `scripts/` | `preprod.raw.json` is the committed spec matching the LIVE genesis — a re-minted `gen-chainspec` yields a *different* genesis and will not peer. `scripts/run-tracking-node.sh` syncs the live chain locally so the frontend reads real data without touching the producer |
| `_sdk/`, `_reference/` | **gitignored** vendored checkouts (polkadot-sdk; partner-chains + midnight-node study clones). Exclude BOTH from repo-wide greps — `_reference/` embeds a whole stale copy of this repo |

## Build / run / test

The full build/test matrix, toolchain pins, and CI gates are in
[CONTRIBUTING.md](CONTRIBUTING.md). Quick reference for working here:

```bash
cargo build --release && ./target/release/cogno-chain-node run --dev   # single //Alice, WS :9944
cargo test --workspace
SKIP_WASM_BUILD=1 cargo check -p <crate>                               # fast, skips the wasm build
cd contracts && script -qec "aiken check" /dev/null                    # aiken errors are TTY-gated
```

- **Regenerate contract artifacts** (only on an intentional redeploy — this MOVES the live hash, see
  the gotcha below): `aiken build` (plutus.json) + `node contracts/scripts/regen-vault.mjs` (vault.json)
  — note the path, the root `scripts/` is a different directory.
- **After an encoding-affecting spec bump**, regenerate the frontend's PAPI descriptors:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.
- **Seeing the frontend, rather than reasoning about it.** `vitest` runs in a `node` environment, so no
  component can be rendered and no CSS change is verifiable by any other gate here. From `app/`, after a
  `npm run build`:

  ```bash
  npx playwright install chromium        # once per machine; ~115 MB into ~/.cache, NOT the repo
  npm run shoot -- /governance/ --v mobile,feed,desktop   # screenshots to $TMPDIR/cogno-shots
  npm run check:overflow                 # asserts nothing hides content sideways
  ```

  Both drive the BUILT export through the same nginx-accurate server the smoke check uses
  (`scripts/lib/export-server.mjs`), never `next dev` — the `_` SSG shims and the rewrites do not exist
  in dev. `scripts/lib/browser.mjs` holds the traps: a headless context is a MOUSE device unless
  `hasTouch` is set, so a 375px viewport silently renders the desktop styling, and a signed-in surface
  needs a fabricated `cg-session` whose five fields all pass `parseRestoredSession` or the run quietly
  stays a guest. Chrome (nav, headers, filters, empty states) renders with no chain; point `--ws` at
  `scripts/run-tracking-node.sh` for surfaces that need real posts.

  `check:overflow` reports exactly two faults: the page scrolling sideways, and an element that opts into
  scrolling while hiding its scrollbar. It deliberately ignores content overflowing a `visible` box,
  `.srOnly`, and `text-overflow`/`line-clamp` truncation — the first version flagged all of those and was
  17-for-17 wrong. Neither script runs in CI, and `npm ci` does NOT download browsers (the Playwright
  packages ship no install script), so CI is unaffected until someone deliberately adds the install step.

## Critical gotchas

[CONTRIBUTING.md](CONTRIBUTING.md#rules-that-will-bite-you-please-respect-these) carries the ones a
human contributor also needs — the contracts hash rule, the nvm-vs-snap `node`, TTY-gated `aiken`
errors, `next build` vs `next dev`. Don't let those drift out of sync with this file. The extra detail
an agent needs:

- **The live contract hashes** (for the `git diff` check after any `contracts/` touch): blueprint
  `49ffbfc6…`, applied vault `168a9710…`. Any *production* edit under `contracts/` recompiles the
  script and moves them, orphaning the deployed vault. Contracts logging is off-limits while live —
  even a `trace` line bakes into the script and moves the hash.
- **The nvm node path** to prepend for all Node/MeshJS work:
  `~/.nvm/versions/node/v22.12.0/bin`. The snap `node` writes stdout to `/dev/null` (silent failures),
  and importing `@meshsdk/core-cst` redirects stdio.
- **Cardano is read EXCLUSIVELY through db-sync (consensus-critical determinism)** via the
  `cogno-dbsync` crate. The node's inherent-data provider is the sole consensus **writer**; the node's
  boot-time `config_check` reuses the same crate **read-only** (a non-blocking startup probe) — both go
  through `DBSYNC_URL`. Determinism is pinned by the golden fixture in `cogno-dbsync` (a divergence is a
  **chain fork**); the CLI's `query weight` reads the resulting on-chain `TalkStake` ledger over RPC, not
  db-sync. **Preserve verbatim** the byte-identity invariants: spentness from **`tx_in`**
  (never `consumed_by_tx_id`); coins/qty as **`::text`** (lovelace > 2⁵³); the vault set from
  **`tx_out.payment_cred = <script hash>`**; a fail-closed **abstain** when `tx_in` is absent (and, since spec 213, when `ma_tx_out` or `tx_metadata`
  is — an under-indexed db-sync must never be read as authoritative emptiness; `dbsync.rs`'s test module
  now fails the build if a query gains a table with neither a probe nor an explicit exemption);
  largest-UTxO-wins per identity (never summed). Ogmios still SUBMITS L1 txs + serves cost models; the
  in-browser CIP-30 vault uses Blockfrost. MAINNET PREREQUISITE: db-sync must run FULL (non-pruned),
  **`tx_in`-enabled** (NOT `--consumed-tx-out`), and over TLS.
- **The ROLE read rides the same consensus path** — same inherent, same fail-closed abstain, same
  byte-identity bar. Two invariants the vault list above doesn't cover: db-sync hands back
  `tx_metadata.bytes` WRAPPED as `{867: value}` and the Calidus reader must strip that label before
  parsing (feeding it raw fails `BadVersion`, and *every* real registration silently drops); and
  `read_pool_stake` is scoped to `owner pools ∪ reduction::claimed_calidus_pools` — that one shared fn
  is why the node and the crate can't drift, and a narrower scope zeroes an mSPO's chamber weight. The
  golden fixture pins the VAULT reduction only; the role reduction is unit-tested.
- **`cogno-dbsync` is node-side, so a reduction change is consensus-affecting but INVISIBLE to
  `spec_version`.** It changes what the inherent writes with no runtime bump, no PAPI regen, and no FE
  lockstep — it ships as a new node binary plus a producer restart. Don't bump spec for it.
- **Pallet indices are on-wire contracts — never renumber.** Indices **6** (Sudo, removed) and **12**
  (Anchor, removed) are permanently vacant; **7** is GovernedUpgrade. Adding a pallet uses a new index
  (next free is **21**; 20 is TxPause); gaps are fine.
- **Spec-bump discipline.** Encoding-affecting runtime changes (calls/storage/events/extensions) bump
  `spec_version` (currently **213**); after a bump, regenerate PAPI descriptors against a LOCAL dev node
  (never the live chain):
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.
  Non-encoding changes (bounds, logging, tests) must **not** bump it. `transaction_version` moves ONLY on
  a call-arg / `TxExtension` change — *removing* a call does not move it.
  A bump is a **lockstep FE deploy**: `DESCRIPTOR_SPEC_VERSION` in `app/src/lib/chain/client.ts` must
  match (`npm run lint` runs `scripts/check-spec.mjs` and fails on drift), and the deployed bundle
  **blocks posting** against a chain whose `spec_version` differs from the one it was built against.
- **Event/Error variant indices are on-wire too — SCALE indexes enum variants by DECLARATION ORDER.**
  Deleting a variant silently shifts every one below it. Since spec 211 EVERY pallet's Event and Error
  enum is pinned with explicit `#[codec(index = N)]` (microblog `VoteDir` and the observer's
  `InherentError` included) — keep it that way. Retired variants leave a permanent GAP (microblog
  event 6 `Reposted`, error 5 `AlreadyReposted`; cogno-gate error 2 `BadThread`). Never insert into a
  gap, never reorder, always pin a new variant. Same rule as pallet/call indices. **CI now enforces all
  of this**: `scripts/check-metadata.sh` diffs the committed `app/.papi/metadata/cogno.scale` against a
  freshly built runtime, so a reorder no test would catch fails the `rust` job. It also means EVERY spec
  bump needs `./scripts/check-metadata.sh --write` (the snapshot embeds `spec_version` via
  `System::Version`) — read what the script says moved before re-snapshotting: one byte is a plain spec
  bump, more than one means a shape a client can see actually changed. Spec 212 retired
  microblog error 2 (`TooManyPosts`) with `MaxPostsPerAuthor` — index 2 is now a permanent gap too.
- **A storage migration must be wired into `SingleBlockMigrations`** (runtime/src/configs/mod.rs) or it
  never runs: the on-chain `StorageVersion` stays put while the code declares the new one, and
  `post_upgrade` never fires. Before enacting, run the `try-runtime` dry-run against live state that
  docs/UPGRADES.md prescribes — `--features try-runtime` compiles the `pre_upgrade`/`post_upgrade`/
  `try_state` hooks that are the whole safety net (CI does **not** gate on it).
  **`#[storage_alias]` takes the on-chain item name from the ALIAS TYPE NAME.** An alias named
  `ByAuthorV9` addresses `twox128(pallet) ++ twox128("ByAuthorV9")`, a prefix nothing ever wrote — the
  migration then iterates zero rows and reports success while orphaning every real one. Unit tests
  cannot catch it (they write and read through the same wrong prefix, so they agree with themselves);
  spec 212's v10 shipped that bug and only the live-state `try-runtime` run found it. Either name the
  alias exactly as the storage item, or spell out a `StorageInstance` with the real `STORAGE_PREFIX`
  and pin it against the pallet's own item with a `hashed_key_for` prefix assertion — microblog
  `migrations::v10` does the latter.
- **Toolchain is pinned to rustc 1.93.0** — the toolchain Parity builds the polkadot-sdk `stable2606`
  train against. The old "stable ≥ ~1.91 breaks the `sp_io` wasm link" ceiling was specific to
  stable2603's sp-io 45.0.0; stable2606's sp-io 48.0.0 links cleanly under 1.93.0. Stay on the
  toolchain the pinned SDK release is verified against — don't drift `rust-toolchain.toml` off it.
- **Privileged calls go through the 3-of-5 committee — there is no sudo.** Use `cogno-chain-cli
  committee …` (propose / vote / close over `FollowerCommittee`). Runtime upgrades are
  `upgrade authorize` (committee) + a permissionless `upgrade apply` (spec-checked).
- **Federating out is fund-before-seat (spec 203).** Seating gates now require a committee-granted
  governance-fuel allowance (and, for validators, registered session keys): a `fuel set-allowance
  --account <X>` must precede `committee members add` / `validator add`, and a new validator must
  `validator set-keys` first. Seating an unfunded/keyless account is rejected on-chain (`CallFiltered`
  for a committee seat, `NotFunded` / `NoSessionKeys` for a validator). See docs/PREPROD-BRINGUP.md Step 6.
- **Cardano cost models:** inject live Ogmios cost models via `setCostModels` when building L1 txs —
  MeshJS's stale defaults produce a bad script-integrity hash. (The in-browser CIP-30 path uses
  Blockfrost, which supplies live cost models, so it doesn't need this.)
- **Every raw user-text render goes through `app/src/lib/sanitize.ts`.** The chain stores unvalidated
  bytes (length-bounded only), so a display name, bio, poll option or post body can carry bidi-override,
  invisible or Zalgo spoofs. `PostBody` and `DisplayName` sanitize internally; anything else rendering
  chain text calls `sanitizeText` (multi-line) or `sanitizeInline` (single-line) itself. It is
  DISPLAY-ONLY — never sanitize before a byte-length count or an on-chain write. Nothing lints this.
- **Device-local state is bucketed PER ACCOUNT.** `createViewerScopedStore`
  (`app/src/lib/viewerScopedStore.ts`, or its `stringSetStore` set-facade) keys `<prefix>:<ss58>`, and
  `:anon` signed-out. A hand-rolled `localStorage` key hands the previous wallet's bookmarks, mutes,
  blocks, lists and unsent drafts to the next account on a shared device, and clobbers writes across
  tabs. A bare key is correct only when the state is genuinely device-global (theme, endpoints, recent
  emoji, the `cg-session` sign-in record) or already keyed by ss58 *inside* its value
  (`cg-pending-locks`) — so check the value shape before "fixing" one. `claimLegacy` is a one-shot
  migration reserved for stores that already shipped unbucketed.
- **Run the frontend dev server on a free port** if the live cardano-node monitoring is binding
  `:3000`/`:3001`. `npm run dev` pins `-p 3000`, and passing `-p` explicitly disables Next's port
  auto-retry, so it hard-fails on `EADDRINUSE` rather than shifting — use `npx next dev -p <free port>`.

## Conventions

Contribution workflow (branch-per-unit, PR-into-`main`, the commit-scope format, `Cargo.lock`
committed) lives in [CONTRIBUTING.md](CONTRIBUTING.md). Agent-specific notes:

- **Commits:** `<scope>(<area>): <summary>` (e.g. `feat(pallets): …`, `fix(node): …`, `docs: …`); end
  AI-assisted commits with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Pallet logging** uses the `log::` facade via each pallet's `LOG_TARGET` (no new Events) — keep it
  additive and encoding-neutral.
- **User-facing copy is plain language, and carries no em dashes.** Split the aside into its own
  sentence instead. Scope is every string a user reads — labels, titles, empty states, error text,
  aria-labels. Out of scope: code comments and JSDoc, console/log strings, the docs (all keep the house
  em-dash style), and the bare `"—"` empty-value glyph in formatters. Nothing lints this.
