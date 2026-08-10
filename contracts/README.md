# cogno-chain L1 — `talk_vault`

One merged Aiken (Plutus V3) validator implementing a per-user, **owner-reclaimable ADA vault**
marked by a **beacon NFT**. It is the L1 anchor for cogno-chain's stake→talk-capacity mechanic.

It is **live on Cardano preprod** — beacon policy id / vault script hash
`168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7`
([Cexplorer](https://preprod.cexplorer.io/policy/168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7)) —
and the committed artifacts are reproducible from this source. See [Verify the live script
yourself](#verify-the-live-script-yourself).

- `validators/talk_vault.ak` — the merged `mint` / `spend` / `else` validator + its test/bench suite.
- `lib/validate.ak` — mint-side creation-invariant enforcement (recursion + length/uniqueness).
- `lib/util.ak` — beacon-name derivation + the output search.
- `lib/types.ak` — `VaultDatum`, `VaultRedeemer`, `MintTypeRedeemer`, and `MintRedeemer` (a *list*
  of the latter, one entry per beacon minted or burned in the transaction).

The validator is parameterized by a single `min_lock: Int` (a lovelace floor). The beacon's
`policy_id` **is this validator's own script hash**; its `token_name` is
`blake2b_256(cbor.serialise(owner Address))`, binding the vault to the **whole** owner Address —
payment **and** stake credential.

## Trust model

There is exactly **one** privileged party: the **vault owner**, identified by the payment
verification key inside the vault's own datum. There is **no** admin, operator, batcher, upgrade,
or pause role — the contract is terminal and fully self-custodial.

Every value-moving path is gated **on-chain** by the owner's payment signature
(`extra_signatories`) before any value moves:

- **Create** — mint a beacon into a vault output. The mint arm enforces every creation invariant
  (floor, own-hash address, owner stake credential, no reference script, exactly two policies in the
  beacon output — lovelace plus this one, so no foreign token rides along — an inline `VaultDatum`
  naming the same owner, the owner's signature, and exactly `+1` of that beacon), because spend
  validators do not run on UTxO creation. A second mint-side pass pins the number of distinct beacon
  names *moved* — minted or burned — under this policy to the redeemer's length, and rejects
  duplicate redeemer entries.
- **Top up** — spend the vault into a single continuing vault output whose ADA is non-decreasing
  and whose token set, datum, stake credential, **and reference-script slot** are frozen. There is
  no partial-withdraw path: a continuation may only grow, so ADA leaves a vault through a full exit
  and no other way.
- **Exit** — spend the vault with no continuing output and burn the beacon (`-1`), reclaiming the
  ADA to any destination the owner chooses.

Two structural guards sit outside that list and cover **every** spend of a real vault
(beacon-bearing, `VaultDatum`): ahead of the top-up/exit branch, exactly one own-script input (the
double-satisfaction guard — one vault per transaction, and it is `== 1`, never `>= 1`); and, as that
branch's catch-all arm, an outright reject on fan-out into two or more own-script outputs. Neither
runs on the permissive no-datum / non-`VaultDatum` arms — those return before the guards are reached,
which is the footgun described next. The `else` purpose is `fail`, so the withdraw, publish
(certificates), vote and propose purposes are denied by default.

A third party can never open, drain, or forge a vault: they cannot produce the owner's signature,
and the beacon name is per-owner.

## ⚠️ Creator footguns — only mint through the protocol

The validator protects **protocol vaults** (beacon-bearing, `VaultDatum`) completely. It cannot,
however, protect ADA that is hand-sent to the vault **script address** without minting a beacon —
validators do not run when a UTxO is *created*, so the vault address can accumulate UTxOs the
protocol never made. For those misconfigured deposits:

- **No datum, or a datum that is not a `VaultDatum`** → the UTxO is **spendable by anyone**
  (the permissive liveness arms; preserves liveness for mis-sent dust). *(audit I-05)*
- **A `VaultDatum` whose `owner.payment_credential` is a `Script`** → the UTxO is **locked forever**
  (v1 admits verification-key owners only; the spend handler traps). *(audit I-06)*

Neither state is reachable through the protocol's own mint-gated creation path — the mint arm
performs the same `VerificationKey` check and requires an inline `VaultDatum`, so a real
beacon-bearing vault can never enter either footgun. **Always create a vault by minting its beacon;
never pay raw ADA to the vault address.**

## Build, test, benchmark

The compiler is pinned to **aiken v1.1.22** (`aiken.toml`'s `compiler` field; CI installs the same
version), targeting Plutus **v3**. Two dependencies are declared: `aiken-lang/stdlib` **v3.1.0** and
`aiken-lang/fuzz` **v2.1.0**. Aiken writes its errors only to a TTY, so under a pipe or in an agent
shell wrap the command: `script -qec "aiken check" /dev/null`.

```sh
aiken check          # 46 tests: 28 negative, and 7 property tests via aiken/fuzz at 100 samples each
aiken build          # regenerates plutus.json (the script blueprint + hash)
aiken bench          # 4 CPU/mem baselines: mint, burn, top-up spend, full-exit spend

node scripts/regen-vault.mjs   # redeploy only: rebuilds vault.json (applied hash + CBOR) from plutus.json
```

The validator body is the top hundred-odd lines of `validators/talk_vault.ak`; the roughly nine
hundred below it are the test and benchmark suite.

Test dependency note: `aiken-lang/fuzz` is used only by the property tests and benchmarks; it is
**not** linked into the on-chain script.

## Verify the live script yourself

The live vault is reproducible from this source — you do not have to take the hash on trust.

**1. The blueprint hash** (`49ffbfc6…`, unparameterized). With aiken v1.1.22, from `contracts/`:

```sh
script -qec "aiken build" /dev/null && git diff --exit-code plutus.json   # clean = reproduced
```

A different aiken version still reproduces the same `compiledCode` and `hash` (checked on v1.1.23),
but stamps its own version into `plutus.json`'s `preamble.compiler`, so the diff is not clean —
compare `jq -r '.validators[0].hash' plutus.json` instead. CI runs exactly this rebuild-and-diff in
its `contracts` job, after `aiken check`. The job fires on any change under `contracts/**`, and also
on any change to `.github/workflows/ci.yml`, because the compiler pin lives in that file and a
compiler bump is one of the things that could move the hash.

**2. The applied vault hash** (`168a9710…` — the beacon policy id and the vault script hash). Applying
`min_lock = 100_000_000` to the blueprint is what produces it, and `--verify` recomputes it and
writes nothing:

```sh
(cd ../app && npm ci)                          # the MeshJS deps live in app/node_modules
node scripts/regen-vault.mjs --verify          # exit 0 = the committed hashes derive from this source
```

**Nothing in CI runs that.** The `contracts` job diffs `plutus.json` and only `plutus.json`, so a
rebuild that moved the applied artifact without regenerating it would go unremarked there. `--verify`
is a manual step, and it belongs to any redeploy. The one automated cousin lives on the frontend
side — `app/src/lib/cardano/vaults.test.ts` asserts the shipped script list still tracks the pinned
copy — and it only fires when the frontend job does: a change under `app/**`, or to
`runtime/src/lib.rs`, or to `.github/workflows/ci.yml`. A `contracts/**`-only change never runs it.

**Three artifacts, one hash.** `contracts/plutus.json` is the unapplied blueprint;
`contracts/vault.json` is the applied artifact (`vaultHash` + `appliedCbor`) that off-chain tooling
reads; `app/src/lib/cardano/vault.json` is a byte-identical pinned copy the in-browser lock imports.
`--verify` is the only thing that recomputes the applied hash from the blueprint and checks all three
agree. The same policy id is consensus-pinned in the runtime as `ObsVaultPolicyId`
(`runtime/src/configs/mod.rs`) — that constant is what ties on-chain talk-capacity to *this* script,
and the observer counts nothing minted under any other policy.

**3. On Cardano.** Every live vault carries one beacon minted under that policy (`total_supply: 1`
each), and every vault address has it as its payment credential:

```sh
curl -s "https://preprod.koios.rest/api/v1/policy_asset_list?_asset_policy=168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7"
```

## Audit

[`audits/audit-report-2026-06-17.md`](./audits/audit-report-2026-06-17.md) is an **automated /
AI-assisted self-audit** (the `audit-machine` tool — a first-party multi-agent LLM review, **not** an
independent third-party human audit; an independent audit remains a `MAINNET PREREQUISITE`). It
raised 7 findings — 0 critical, 0 high, 0 medium, 1 low, 6 informational — and its own
mainnet-readiness verdict was "Needs Work", on the strength of the coverage gaps and L-01's missing
pin rather than any way in.

Read it as a dated snapshot of the tree as it stood on 2026-06-17, not as a description of this
source. It was written *before* remediation, so its build metadata is stale by construction: it cites
the pre-remediation blueprint hash `cf0712dc…`, an 18-test suite with no benchmarks, and a single
declared dependency. The committed source closes the audit's only on-chain finding (**L-01** — the
spend continuation now pins `reference_script == None`, mirroring the mint arm), and that one line is
what moved the blueprint hash to `49ffbfc6…` and forced the redeploy to `168a9710…`. It also adds the
negative, property, and benchmark coverage the report asked for in **I-01** through **I-04**.
**I-05** and **I-06** are the two creator footguns described above — filed as intentional and as not
exploitable as written, and neither reachable through the protocol's own mint-gated creation path.

## Redeploy impact

Changing the validator changes the compiled script hash (and therefore the
`min_lock`-applied policy_id / vault address). This **orphans any previously-deployed vault**: the
old UTxOs must be exited under the old script, and a fresh vault minted under the new one. Three
things move together, and skipping any one of them strands funds:

1. **The artifact.** `vault.json` (vaultHash + applied CBOR) is what the off-chain tooling and the
   frontend's MeshJS lock/unlock path read. Regenerate it with `node scripts/regen-vault.mjs` after
   `aiken build`; the default invocation rewrites `contracts/vault.json` *and* syncs the pinned copy
   at `app/src/lib/cardano/vault.json` (an explicit `--out` deliberately does not touch the pinned
   copy). Never hand-edit the hash — the applied `policy_id` must be recomputed through the script's
   `{ int: … }` param form, since a bare number silently yields a different, unspendable hash.
2. **The chain's pin.** `TALK_VAULT_POLICY_ID` in `runtime/src/configs/mod.rs` — the 28 literal bytes
   that both arms of `CARDANO_PARAMS` feed to `ObsVaultPolicyId` — must be updated to the new applied
   hash in the same runtime upgrade. Until it lands, the new script earns no talk-capacity, because
   the observer only counts what is minted under the pinned policy.
3. **The frontend's retired-script list.** The old hash and its applied CBOR go into `LEGACY_VAULTS`
   in `app/src/lib/cardano/vaults.ts` (git history has both), which is what keeps a stranded balance
   readable and exitable. The current entry is never hand-typed — it tracks `vault.json`.

The frontend PAPI descriptors describe the Substrate runtime and carry **no** L1 script hash, so
they are unaffected.

## The `DR-NN` markers in the source

The `.ak` sources and `aiken.toml` carry `DR-01`-style markers. They point into a design-decision
register that was kept privately during development and is not published; the rest of the repo has
been scrubbed of these pointers. They survive *here* for exactly one reason: editing a `.ak` file —
even a comment — recompiles the script, moves the blueprint hash, and orphans the vault that is
currently live on preprod. Leaving a stale comment is the cheaper mistake. Read them as historical
markers with no referent, not as a document you are missing.
