# cogno-chain L1 — `talk_vault`

One merged Aiken (Plutus V3) validator implementing a per-user, **owner-reclaimable ADA vault**
marked by a **beacon NFT**. It is the L1 anchor for cogno-chain's stake→talk-capacity mechanic
(DR-01 / DR-18).

- `validators/talk_vault.ak` — the merged `mint` / `spend` / `else` validator + its test/bench suite.
- `lib/validate.ak` — mint-side creation-invariant enforcement (recursion + length/uniqueness).
- `lib/util.ak` — beacon-name derivation + the output search.
- `lib/types.ak` — `VaultDatum`, `VaultRedeemer`, `MintTypeRedeemer`.

The validator is parameterized by a single `min_lock: Int` (a lovelace floor). The beacon's
`policy_id` **is this validator's own script hash** (DR-18); its `token_name` is
`blake2b_256(cbor.serialise(owner Address))`, binding the vault to the **whole** owner Address —
payment **and** stake credential (DR-01).

## Trust model

There is exactly **one** privileged party: the **vault owner**, identified by the payment
verification key inside the vault's own datum. There is **no** admin, operator, batcher, upgrade,
or pause role — the contract is terminal and fully self-custodial.

Every value-moving path is gated **on-chain** by the owner's payment signature
(`extra_signatories`) before any value moves:

- **Create** — mint a beacon into a vault output. The mint arm enforces every creation invariant
  (floor, own-hash address, owner stake credential, no reference script, exactly `[ADA, 1 beacon]`,
  inline `VaultDatum` naming the same owner, owner signature, exactly `+1`), because spend
  validators do not run on UTxO creation.
- **Top up** — spend the vault into a single continuing vault output whose ADA is non-decreasing
  and whose token set, datum, stake credential, **and reference-script slot** are frozen.
- **Exit** — spend the vault with no continuing output and burn the beacon (`-1`), reclaiming the
  ADA to any destination the owner chooses.

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

```sh
aiken check          # 38 tests (incl. 5 property/fuzz tests, 100 samples each)
aiken build          # regenerates plutus.json (the script blueprint + hash)
aiken bench          # CPU/mem baselines for the mint/spend hot paths
```

Test dependency note: `aiken-lang/fuzz` is used only by the property tests and benchmarks; it is
**not** linked into the on-chain script.

## Audit

See [`audits/`](./audits/) for the full Cardano smart-contract audit. The committed source closes
the audit's only on-chain finding (**L-01** — the spend continuation now pins
`reference_script == None`, mirroring the mint arm) and adds the recommended negative, property,
and benchmark coverage (I-01 through I-06).

**Redeploy impact.** Changing the validator changes the compiled script hash (and therefore the
`min_lock`-applied policy_id / vault address). This **orphans any previously-deployed vault**: the
old UTxOs must be exited under the old script, and a fresh vault minted under the new one. The
artifact that bakes the L1 hash for the off-chain tooling is the **`vault.json`** (vaultHash +
applied CBOR) consumed by the MeshJS lock/unlock scripts and the follower/committee services — that
must be regenerated. The frontend PAPI descriptors describe the Substrate runtime and carry **no**
L1 script hash, so they are unaffected.
