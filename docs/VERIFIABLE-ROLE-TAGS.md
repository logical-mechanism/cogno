# Verifiable Cardano role tags

A profile can carry a **verified role tag** — stake pool operator (**SPO**), delegated representative
(**dRep**), or Constitutional Committee member (**CC**) — that means what it says: the account proved
control of the Cardano role key, and the chain confirms the key is a currently-live role on Cardano. No
operator hand-waves a badge on; the runtime verifies the proof and the observer verifies the liveness.
The badge is display-only — it buys no posting power, no vote weight — but it is trustless, and it
disappears the moment the underlying Cardano role does.

It reuses the same two pieces the rest of the chain is built on: the CIP-8 self-proof
([`TRUSTLESS-IDENTITY.md`](TRUSTLESS-IDENTITY.md)) and the deterministic Cardano observer
([`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md)). The system overview is
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Two ledgers

Roles live in `pallet-cardano-roles` (`pallets/cardano-roles/src/lib.rs`, pallet index 19), split the same
way identity is split across cogno-gate (the proof) and talk-stake (the observer-written weight):

- **The claim ledger** — permissionless and CIP-8-proven. A user proves they control a raw Cardano role
  key; the pallet records `(account, role) ↔ credential` 1:1. Proving key control is the *whole* job of
  the claim — it interprets no Cardano registration.
- **The observed ledger** — call-less; the `cardano-observer` inherent is the only writer. Each block the
  observer reads db-sync, scoped to the claimed credentials, confirms which are currently-live Cardano
  roles, resolves each to its display id, and writes the account's live badge set to `ObservedRoles`. The
  badge reads *this* map, so a tag only ever reflects a role that is live right now.

The claim is the *authorization*; the observation is the *truth*. A claim with no live role shows nothing.

## Claiming (the proof)

`Call::claim_role_signed` is **unsigned and feeless** — the CIP-8 proof is the authorization, exactly like
the cogno-gate binds. The proof is a COSE_Sign1 the operator produces offline with their role key (a
Calidus pool key, a key-based dRep key, or a committee hot key) over a synthetic enterprise address whose
payment credential is `blake2b_224(role_key)`. The runtime verifies it with the shared crown-jewel
verifier `pallet_cogno_gate::cip8::verify_bind_proof_role` (`pallets/cogno-gate/src/cip8.rs`): the same
Ed25519 check, single-key-source rule, and address-key bind as every other proof, differing only in the
pinned payload grammar —

```
cogno-chain/role/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>;role=<spo|drep|cc>
```

The distinct `role/v1` domain and the trailing `role=` token are the anti-replay pins: a payment or stake
bind proof can never satisfy this grammar, and a proof minted for one role can never be replayed as
another. The role comes from the signed payload, not a call argument, so one call covers all three roles.
A claim requires the account to already be **payment-bound** (`IdentityGate` = cogno-gate), so it is a
Settings add-on, never part of onboarding.

Because the call is unsigned and feeless, its only spam gate is `validate_unsigned`: it re-verifies the
proof (rejecting a malformed or cross-chain proof before gossip), then cheap storage reads reject a
non-participant, an already-claimed credential, or a tombstoned one. A claim grants nothing actionable
until the observer confirms liveness, so a flood of valid claims earns no amplification.

Three claim maps enforce the invariants:

- `RoleClaimOf: (account, role) → credential` — one credential per (account, role).
- `RoleCredIndex: (role, credential) → account` — the reverse 1:1, and the enumeration the observer scopes
  its db-sync read to (`bound_role_credentials`).
- `TombstonedRoleCred: (role, credential) → ()` — the committee's permanent ban. `Call::revoke_role`
  (gated by the 3-of-5 `RoleAuthorityOrigin`, never `ensure_signed`) removes the claim and tombstones the
  credential so an eternally-valid proof replayed after a ban cannot resurrect it. `Call::unclaim_role` is
  the user's own release — signed, feeless when the caller actually holds the claim, and does *not*
  tombstone.

## Observing (the liveness)

The observer answers "is this credential a live role right now?" entirely off the claim, over authenticated
on-chain Cardano state read through `cogno-dbsync` — the same deterministic read path as the vault weight,
so a divergence here is a chain fork. The pure reduction is
`cogno_dbsync::reduction::reduce_role_observation`; the db-sync read is `read_role_observation`
(`cogno-dbsync/src/dbsync.rs`). It produces a canonical `Vec<RoleEntry>` carried in the observation
inherent, and the runtime resolves each entry to an account (`RoleResolver`) and writes the observed set
(`RoleSink` → `apply_roles`).

There are two SPO sources and one direct path each for dRep and CC:

- **SPO via Calidus** (`RoleSource::SpoCalidus`). An SPO authorizes a hot "Calidus" key by posting a
  one-time CIP-0151 / CIP-88-v2 registration (transaction metadata label **867**) signed by the pool
  **cold** key. The reduction verifies that registration's cold-key witness over the *raw* on-chain
  metadata bytes (`cogno-dbsync/src/calidus.rs`) — both the bare-Ed25519 and the CIP-8/COSE witness forms
  — takes the highest-nonce *verified* registration per pool, and emits an entry when the winner's Calidus
  key is claimed and the pool is active. The pool never exposes its cold key to cogno-chain. Crucially,
  this entry names **no pool**: its display id is the blank `BLANK_ROLE_ID`, so the badge reads a generic
  "verified SPO". The reason is that a Calidus registration is authorized by the pool cold key *alone* —
  the Calidus key never counter-signs, and CIP-0151 defines no proof-of-possession for it — so any pool
  can declare any public Calidus key, including one someone else has claimed. Naming the pool would let a
  pool operator attribute their pool to that account (cross-pool impersonation); attesting only "controls a
  Calidus key that a live pool authorized" is the honest, un-forgeable claim, and every pool authorizing
  the same claimed key collapses to one badge.
- **SPO via ownership** (`RoleSource::SpoOwner`) — the free path, no claim needed. A stake credential the
  account already bound (for voting power) that is declared an owner of a live pool in that pool's latest
  registration certificate earns an SPO badge directly. This path **does** name its pool (id = the poolID,
  with a "verify on-chain" link): it is impersonation-proof, because a Cardano pool registration requires
  each declared owner's stake-key witness, so a pool cannot list a stake key it does not control.
- **dRep** (`RoleSource::DRep`). The SQL scopes to the claimed key-based dRep ids and keeps those whose
  latest `drep_registration` is not a deregistration; the credential *is* the display id.
- **CC** — deferred. The claim side and the runtime plumbing exist, but the observer's liveness branch is
  not wired: every live preprod committee member uses a *script* hot key, which cannot CIP-8-sign, so
  there is nothing to validate against yet.

Liveness is continuous, not a snapshot: when a pool retires, a dRep deregisters, or a claim is unclaimed
or revoked, the credential leaves the scoping set on the next observation and the observer's unlock clamp
clears the badge. The observer holds the same enforce/freeze discipline as the weight and voting axes —
see [`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md).

### Several pools, several badges

An account may operate more than one pool. The observed set (`ObservedRoleSet`) is deduplicated by the
full `(kind, id)` pair. Because each *ownership* badge carries its own poolID, a multi-pool operator who
has bound the owner stake key of each pool shows one pool-named badge per pool. Calidus badges, by
contrast, all carry the blank id, so they collapse to a single generic "verified SPO" — which is exactly
what closes the impersonation (no per-pool Calidus badge can be minted for an account by a foreign pool).
`MAX_OBSERVED_ROLES_PER_ACCOUNT` bounds the set; the runtime `RoleApply` sink truncates to it
deterministically rather than dropping the whole set.

## Reading the badge (node-served, no N+1)

The badge is read from `ObservedRoles`, but a scrolling feed would open one subscription per author to do
that. Instead the node folds the observed roles onto every author it already enriches: the node-served
`ProfileView` carries `observed_roles`, and each `EnrichedPost` / `QuotedSummary` carries `author_roles`
(`pallets/microblog/src/lib.rs`), filled by the runtime alongside the display name and avatar
(`runtime/src/apis.rs`). Because pallet-microblog must not depend on pallet-cardano-roles, the field is a
primitive `Vec<(u8, [u8; 28])>` — a role-kind index and a 28-byte display id — that the runtime maps down
from `ObservedRole`. So a feed card, a thread, a quote embed, and a hover card all render badges with no
extra read.

On the frontend the badge is `app/src/components/RoleBadge.tsx`. It renders one chip per live role. A
pool-named badge (ownership SPO, dRep) is a "verify on-chain" link to cexplorer and resolves a pool ticker
or dRep name best-effort through Blockfrost (`app/src/lib/cardano/roleMeta.ts`, sanitized, degrading to a
truncated id — never a fabricated name). A Calidus SPO badge carries the blank id (`isBlankRoleId`), so it
renders as a plain "✓ SPO" with no pool name and no link — it names no pool, by design. The Settings claim
wizard is `app/src/components/settings/RolesSection.tsx`.

## Trust posture

The proof is trustless — every full node re-verifies the CIP-8 signature. The observation is
consensus-pinned and deterministic, but "every producer re-derives" is load-bearing only with multiple
independent producers; on the single-operator preprod stack it buys auditability, not trust, and graduates
as validators federate. The badge is honestly-labeled: it claims only that the chain holds a live binding,
and it never survives the Cardano role it reflects.

**MAINNET PREREQUISITE.** The role verifier shares the cogno-gate crown-jewel's unaudited status — a bug
forges a role — and wants the same independent audit. The role-pallet weights are conservative hand-set
placeholders and the observer's role term is a hand-estimated `DbWeight` addend; both want a benchmark
before mainnet.
