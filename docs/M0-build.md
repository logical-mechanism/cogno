# M0 build log — cogno-chain solochain stand-up

> Persistent log for milestone **M0** (PLAN.md §8): *solochain stands up, plain text
> posting, NO Cardano.* Updated as the build progresses so the next context can resume
> cleanly. Two sub-steps: (a) DE-RISK the stock template build; (b) FORK the monorepo +
> add a minimal `pallet-microblog`.

## DR-03 — pinned polkadot-sdk release (decided 2026-06-16, from GitHub ground truth)

| field | value |
|---|---|
| repo | https://github.com/paritytech/polkadot-sdk |
| release line | `polkadot-stable2603` — latest **final** stable line |
| **pinned tag** | **`polkadot-stable2603-3`** (latest patch on that line) |
| **pinned commit** | **`e3737178ec726cffe506c907263aaaa417893fd0`** (lightweight tag → commit; GitHub API `"type":"commit"`) |
| toolchain file | `templates/solochain/env-setup/rust-toolchain.toml` (the monorepo has **no root** `rust-toolchain.toml`) |
| template's env-setup file | `channel = "stable"`, `profile = "minimal"`, components incl. `rust-src`/`rust-std`; `targets = ["wasm32-unknown-unknown"]` |
| **our toolchain pin** | **`rustc 1.90.0`** — pinned exactly in `rust-toolchain.toml`, **NOT** rolling `stable` (see the gotcha below) |
| **our wasm target** | **`wasm32v1-none`** (wasm-builder prefers it when installed; the de-risk verified this combo end-to-end) |

> ### ⚠ Toolchain gotcha — pin 1.90.0, do NOT use rolling `stable`
> The repo's `rust-toolchain.toml` started as `channel = "stable"` (matching the template).
> On this box `stable` resolved to **rustc 1.96.0 (2026-05-25)**, which **fails to build the
> WASM runtime**: `rust-lld` reports *every* sp_io host function as an `undefined symbol`
> (`ext_storage_get_version_1`, `ext_hashing_blake2_256_version_1`, `ext_logging_log_version_1`,
> … — the `#[runtime_interface]` import machinery in sp-io 45.0.0 is incompatible with
> rustc ≳1.91). The failure is target-independent (both `wasm32v1-none` and
> `wasm32-unknown-unknown` fail under 1.96.0). The **de-risk** build proved the SAME sp-io 45.0.0
> links cleanly under **rustc 1.90.0**, so the fork is pinned to `1.90.0`. Revisit only when a
> newer polkadot-sdk stable line ships an sp-io that supports newer rustc.

**Why not a newer tag:** `polkadot-stable2606` exists only as `-rc1` (`prerelease=true`);
`polkadot-unstable2604-*` is the unstable line. `polkadot-stable2603-3` is the newest tag
with `prerelease=false` (GitHub releases API confirmed). DR-03 requires the latest *stable*
`polkadot-stableYYMM` tag, not an RC or the lagging `v0.0.2` mirror.

**Fork rename targets (FORK sub-step):**
- node crate:    `solochain-template-node`    → `cogno-chain-node`
- runtime crate: `solochain-template-runtime` → `cogno-chain-runtime`
- runtime `VERSION` `spec_name`/`impl_name` → `"cogno-chain-runtime"`

Template already uses `#[frame_support::runtime]` + `#[runtime::pallet_index(N)]` (confirmed;
indices 0..=7 present). Target index map: System(0) Timestamp(1) Aura(2) Grandpa(3)
Balances(4) TransactionPayment(5) Sudo(6) Template(7, drop later) — **add Microblog at 10**,
leaving 8=CognoGate / 9=TalkStake free (FRAME allows index gaps).

## Environment (checked 2026-06-16)

- Box: 12 cores, 62 GiB RAM (49 free), 1.1 TB free disk — ample for a Substrate first build.
- `rustup`/`cargo`/`rustc` **1.90.0** stable; `rust-src` present; **`wasm32-unknown-unknown` added** ✓.
- System deps: `pkg-config` ✓, `make` ✓, `cc`/gcc 13 ✓, `libssl` 3.0.13 ✓;
  **`clang` ✗, `protobuf-compiler` ✗, `cmake` ✗ — TO INSTALL.**
  `sudo apt-get update && sudo apt-get install -y clang protobuf-compiler cmake libssl-dev pkg-config make build-essential`
  (passwordless sudo unavailable → needs the user to run it.)

## Status checklist

- [x] DR-03 pin chosen from GitHub ground truth (tags + releases API + template toolchain file)
- [x] `wasm32-unknown-unknown` + `wasm32v1-none` targets added (insurance against wasm-builder default)
- [x] polkadot-sdk shallow clone `@ polkadot-stable2603-3` → `_sdk/` (HEAD = `e3737178…`, dated 2026-05-28)
- [x] system deps installed: clang 18.1.3, protobuf-compiler 3.21.12, cmake 3.28.3
- [x] **DE-RISK: stock `solochain-template-node` compiled** (`cargo build --release`, 7m41s; binary `0.1.0-e3737178ec7`)
- [x] **DE-RISK: `--dev` authored + finalized blocks** (Aura #1→#6 ~6s cadence; GRANDPA finalized #0→#3; JSON-RPC `127.0.0.1:9944`)
- [x] FORK: scaffolded standalone `cogno-chain` workspace (`node/` + `runtime/` + `pallets/{template,microblog}/`), crates.io deps pinned to stable2603-3 versions; renamed `cogno-chain-{node,runtime}`; runtime `spec_name`/`impl_name` → `cogno-chain-runtime`, `spec_version` 100→101; Microblog at `pallet_index(10)` (8/9 reserved)
- [x] FORK: minimal `pallet-microblog` written (`post_message`/`delete_post`; `u64` ids; bounded text 512 + ByAuthor 10_000; ByAuthor overflow → `TooManyPosts`, never silent-drop; NO gate/capacity/feeless) + mock & unit tests
- [x] FORK: `cargo test -p pallet-microblog` → **7 passed** (post/read, replies, too-long, delete+author-guard, overflow-without-consuming-id)
- [x] FORK: `cargo build --release -p cogno-chain-node` → **built under rustc 1.90.0** (7m38s; binary 86M; wasm runtime via wasm32v1-none)
- [x] **ACCEPTANCE: PASS (exit 0)** — see results below

## Acceptance results (2026-06-16, `cogno-chain-node --dev --tmp`)

Run via `scripts/acceptance/acceptance.mjs` (`@polkadot/api` 16.5.6) against `ws://127.0.0.1:9944`:

```
connected: cogno-chain-runtime v101 (impl cogno-chain-runtime)
signer: Alice = 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
[1] post_message(...)  -> included in block 0xd73d…4d33; PostCreated fired -> id = 0
[2] query.Microblog.Posts(0): author = 5Grw…utQY; text matches; at = #2; parent = None
    Posts.entries() count = 1
[3] delete_post(0) -> included; PostDeleted fired -> id = 0; Posts(0) removed ✓
==================== M0 ACCEPTANCE: PASS ====================
block production: Aura 🏆 Imported #1, #2 ; JSON-RPC 127.0.0.1:9944
```

All four PLAN.md §8 done-when criteria met: (1) `--dev` authors blocks; (2) a signed
`Microblog.post_message` lands in a block; (3) `query.Microblog.Posts` returns it + `PostCreated`
fired; (4) `delete_post` removes it. **M0 is functionally complete.**

> Acceptance-script note: `Microblog.post_message`'s `text` (`Vec<u8>` → `Bytes`) must be passed
> to polkadot-js as a **hex string** (`u8aToHex(stringToU8a(text))`), not a `Uint8Array` — `Bytes`
> decodes a `Uint8Array` as already-SCALE-encoded (length-prefixed) input and misreads the first
> byte as a bogus compact length (`Compact input is > Number.MAX_SAFE_INTEGER`).
