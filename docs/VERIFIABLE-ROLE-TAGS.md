# Verifiable Cardano role tags

A profile can carry a **verified role tag** — stake pool operator (**SPO**), delegated representative
(**dRep**), or Constitutional Committee member (**CC**) — that means what it says: the account proved
control of the Cardano role key, and the chain confirms the key is a currently-live role on Cardano. No
operator hand-waves a badge on; the runtime verifies the proof and the observer verifies the liveness.
The badge buys no posting power, and no vote weight on a regular stake poll or a reputation vote. The one
place a role does more than decorate a profile is a **governance poll** (spec 207), where a verified SPO
votes with its pool's delegated stake and a verified dRep with its delegated voting stake — in a separate,
non-binding chamber tally, never mixed into the ordinary stake vote. See
[Governance polls](#governance-polls-spec-207). Either way the tag is trustless, and it disappears the
moment the underlying Cardano role does.

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
  — takes the highest-nonce *verified* registration per pool, and emits an entry for **each live pool**
  whose cold key authorized the claimed key. The pool never exposes its cold key to cogno-chain. The entry
  **names that specific pool** (id = the poolID, with a "verify on-chain" link) and carries the pool's
  total delegated stake as its chamber weight, exactly like the ownership path below. An **mSPO** — one
  operator running several pools, each declaring the same Calidus key from its own cold key — therefore
  earns one pool-named badge per pool, and the governance-poll chamber SUMS those per-pool weights into the
  operator's true aggregate (the stake they would vote with on Cardano). Every label-867 registration is
  cold-key-signed, so "pool P declares key K" is cryptographic proof that P's node key authorized K: the
  chamber **weight can never be fabricated** — it is always real on-chain delegation — and the highest-nonce
  winner is unique per pool, so a pool's stake resolves to at most one Calidus account and is never
  double-counted. The one residual edge is **cosmetic**: because the Calidus key never counter-signs
  (CIP-0151 defines no proof-of-possession for it), a pool *can* declare a public Calidus key someone else
  has claimed, making that pool's *ticker* appear on the victim's profile. That is display-only — it cannot
  inflate or steal vote weight — and, unlike the ownership path, a Calidus badge is claim-backed, so its
  holder can remove it.
- **SPO via ownership** (`RoleSource::SpoOwner`) — the free path, no claim needed. A stake credential the
  account already bound (for voting power) that is declared an owner of a live pool in that pool's latest
  registration certificate earns an SPO badge directly. This path **does** name its pool (id = the poolID,
  with a "verify on-chain" link): it is impersonation-proof, because a Cardano pool registration requires
  each declared owner's stake-key witness, so a pool cannot list a stake key it does not control.
- **dRep** (`RoleSource::DRep`). The SQL scopes to the claimed key-based dRep ids and keeps those whose
  latest `drep_registration` is not a deregistration; the credential *is* the display id.
- **CC** (`RoleSource::Committee`) — a **badge only**: no chamber, no vote weight, `weight` pinned at 0.
  A Constitutional Committee member proves control of their **hot** credential with a `role=cc` CIP-8
  proof, exactly as an SPO or dRep proves theirs; the observer then confirms they are actually seated.
  Four things have to hold at once, and each is a place a wrong answer would be silent:
  - **Seated.** Membership comes only from `epoch_state.committee_id` at the observed epoch. A
    `committee` row is written by every gov-action *proposal*, enacted or not, and
    the ledger lets a cold key authorize a hot key as soon as it is named in a *live* `UpdateCommittee`
    proposal, and a proposal need never pass: all 648 767 registration rows on preprod come from one that
    expired at epoch 194 unenacted. Reading either as membership would badge all of them.
  - **In term.** `committee_member` keeps a member's row after their term ends (preprod's enacted
    committee still lists seven members whose term expired three epochs before it took effect), so the
    expiry is checked against the epoch of the observed reference slot — never wall-clock, never the
    latest epoch db-sync happens to hold. The ledger rule is `expired ⇔ epoch > expiry`, so the term
    runs *through* the expiration epoch.
  - **Currently registered.** Only the newest `committee_registration` for that cold key counts (a
    member may rotate their hot key), and it counts only if no `committee_de_registration` is newer.
  - **Key-based, on the hot credential only.** A script credential cannot produce a CIP-8 signature, so
    a script *hot* credential can never be claimed and is never emitted. The *cold* credential is not
    filtered: it never signs anything on cogno, so a member holding a multisig cold credential and a
    plain key-hash hot one is a normal, claimable member. That split is the key hygiene the Cardano CC
    guidance encourages, and every member seated on preprod already uses a script cold credential.

  All three CC members sitting on preprod today registered script *hot* keys, so nothing is claimable
  there yet — the branch is wired and correct, and it returns an empty set until a member with a
  key-hash hot credential is seated.

Liveness is continuous, not a snapshot: when a pool retires, a dRep deregisters, a committee member's
term expires or they de-register their hot key, or a claim is unclaimed or revoked, the credential leaves
the scoping set on the next observation and the observer's unlock clamp clears the badge. The observer
holds the same enforce/freeze discipline as the weight and voting axes —
see [`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md).

### Several pools, several badges

An account may operate more than one pool. The observed set (`ObservedRoleSet`) is deduplicated by the
full `(kind, id)` pair, so **every** SPO badge — ownership OR Calidus — carries its own poolID and a
multi-pool operator shows one pool-named badge per pool. A pool an account reaches by *both* paths (it owns
the stake key and it declared a claimed Calidus key) collapses to a single badge, since the two share the
same `(kind, id)`. `MAX_OBSERVED_ROLES_PER_ACCOUNT` bounds the set; the runtime `RoleApply` sink truncates
to it deterministically rather than dropping the whole set.

## Reading the badge (node-served, no N+1)

The badge is read from `ObservedRoles`, but a scrolling feed would open one subscription per author to do
that. Instead the node folds the observed roles onto every author it already enriches: the node-served
`ProfileView` carries `observed_roles`, and each `EnrichedPost` / `QuotedSummary` carries `author_roles`
(`pallets/microblog/src/lib.rs`), filled by the runtime alongside the display name and avatar
(`runtime/src/apis.rs`). Because pallet-microblog must not depend on pallet-cardano-roles, the field is a
primitive `Vec<(u8, [u8; 28])>` — a role-kind index and a 28-byte display id — that the runtime maps down
from `ObservedRole`. So a feed card, a thread, a quote embed, and a hover card all render badges with no
extra read.

On the frontend the badge is `app/src/components/RoleBadge.tsx`. It renders one chip per live role — so a
multi-pool operator shows several ✓ SPO chips. **Every** SPO chip (ownership OR Calidus) shows an inline
pool ticker/name and a "verify on-chain" link to cexplorer, resolving the name best-effort through
Blockfrost (`app/src/lib/cardano/roleMeta.ts`, sanitized, degrading to a truncated poolID — never a
fabricated name). A dRep chip is a clean "✓ dRep": its long id is carried by the verify-on-chain link
rather than shown inline. A CC chip is a clean "✓ CC" with no link at all: a committee hot credential has
no canonical explorer page, so there is nothing honest to point at. `isBlankRoleId` survives only as a
defensive guard — a degenerate all-zero id names no pool, so it renders as a plain "✓ SPO" with no link.
The Settings claim wizard is `app/src/components/settings/RolesSection.tsx`; it offers SPO and dRep
cards, and CC rides the same card whenever a key-based member is seated somewhere worth wiring it for.

## Governance polls (spec 207–209)

A poll carries a **kind**. A regular **stake poll** is the default: everyone votes, each weighted by their
own `VotingPower` (their bound credential's `epoch_stake`), exactly as before. A **governance poll** — a
Cardano-community temperature check — takes the same single vote and *also* tallies it through two extra
lenses, so a verified SPO or dRep can weigh in "as if it were a real Cardano vote":

- the **SPO chamber**, where a voting SPO — via ownership OR a claimed Calidus key — counts for its
  pool's total delegated (block-production) stake, and
- the **dRep chamber**, where a voting dRep counts for its total delegated voting stake.

Because some Cardano actions are decided by only one body, a governance poll can also open **just one
chamber**: an **SPO-only** poll tallies only the SPO chamber, a **dRep-only** poll only the dRep chamber.
`Governance` opens both; `Stake` opens neither. Whichever chamber a poll does not use reports zero and, at
close, freezes empty (spec 209).

A **CC badge opens no chamber**, and that is a decision rather than an omission. A committee member's
on-chain power is a constitutionality veto, not a stake-weighted preference, so there is no honest number
to weight their vote by — folding one in would misrepresent what the badge means. The chamber walk never
writes a scratch row for kind 2, and a CC entry's `weight` is 0 everywhere it appears.

The three lenses are reported **side by side and never summed** — the same way Cardano shows the SPO, dRep,
and CC results of a governance action separately. Cogno's three lenses are the holder tally, the SPO
chamber and the dRep chamber; the resemblance to Cardano's own three bodies is deliberate but not exact,
because cogno has no CC chamber for the reason above. That separation is the whole point: a delegator's own
ADA already counts once when *they* vote in the holder tally, so folding a pool's or dRep's aggregate into
the *same* number would double-count it. Keeping each chamber in its own lane means nothing is counted
twice, and the governance poll reads as three honest, independent signals.

Where the chamber weight comes from is the same deterministic observer that drives everything else. Each
`ObservedRole` now carries a `weight` — for **either** SPO source, its pool's `SUM(epoch_stake)` at the
observed epoch; for a dRep, its `SUM(drep_distr)`; **0 for a CC badge**, always — read in the node's role reduction (`cogno-dbsync`),
bounded to the pools owned by (or declared via a claimed Calidus key by) / dReps claimed by bound accounts
(not an all-of-Cardano scan), and sealed into the inherent like the vault and voting-power reads. Both SPO
paths weight by real, cold-key-signed pool delegation, so the SPO chamber reflects the true governance stake
of every pool a voter operates; a pool with no delegators carries weight 0 and is skipped. The node scopes
the pool-stake read to `owner_pools ∪ claimed-Calidus pools` (a superset of the pools the reduction emits
SPO entries for), sharing the `reduction::claimed_calidus_pools` helper verbatim with the reduction so the
scope can never fall short of what the reduction needs.

The tally itself (`Pallet::poll_chamber_weights`, `pallets/microblog/src/lib.rs`) is a read-time
derivation over the poll's voters, **deduplicated by pool**: a pool's stake counts once even if several of
its declared owners voted, and if those owners *split* across options the pool abstains rather than being
assigned arbitrarily. dReps need no such dedup — the claim ledger is 1:1. The chambers are **display-only**: they decide nothing on-chain, and — like every badge — a chamber weight
vanishes the moment the underlying Cardano role does. While a poll is open they read **live** (re-pricing
as delegation moves); once `close_poll` finalizes it, the chamber snapshot is **frozen** alongside the
holder tally (spec 208), so a socially-concluded poll no longer re-prices as delegation later shifts.
`poll()`'s `PollView` carries all three lenses per option (`weight`/`count`, `spo_weight`/`spo_count`,
`drep_weight`/`drep_count`); a poll simply reports zero in a chamber it does not use.

This is deliberately *influence*, not *control*: a governance poll is a non-binding signal, not a gate on
any privileged call. The chamber-tally primitive is, however, exactly what a future stake-weighted
governance layer would need — so it is built once here and could later gate upgrades or committee actions,
a decision left open on purpose.

### Governance-action temperature checks (spec 209)

A chamber poll can be tagged as a **pre-submission temperature check on a specific Cardano governance
action**. The tag carries the CIP-1694 **action type** (Info, No-confidence, Update-committee,
New-constitution, Hard-fork, Parameter-change, Treasury-withdrawal) and an **anchor** — a link to the
off-chain proposal document (its home stays GitHub/IPFS, exactly like a real action's anchor). Cogno
stores the *type and the link*, never the proposal body: the chain is the discussion and the
stake-weighted signal, not the drafting tool.

The point is cheap iteration. A real governance action locks a **100,000-ADA deposit** — refundable on
enactment or expiry, so the cost is not a burned fee but a large capital lock-up on an **immutable**
on-chain object. If reviewers want the wording or parameters changed, the only recourse is to let it fail
or expire (up to ~30 days) and resubmit with a fresh lock. A governance poll lets a draft converge *before*
any of that, signalled by the exact bodies — SPOs and dReps — that will vote it on-chain. It mirrors
Cardano's own **Info action** (a non-binding Yes/No/Abstain tripartite signal that never enacts) but free,
editable, and ahead of submission. Which chamber a poll opens should match who decides the action on
Cardano — SPOs vote on only four of the seven types; dReps on all of them — and the poll creator nudges
toward a matching kind, but never enforces it: the tag is a label, not a gate.

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
