# Committee custody, rotation & audit-log runbook

This is the operational policy for splitting cogno-chain's privileged keys across independent
custodians as you federate the committee outward. The **mechanism** already exists from genesis: a
3-of-5 `FollowerCommittee`, its origins, and the `propose → vote → close` tooling in
`cogno-chain-cli committee`. This document covers the people-and-process side — who holds which key,
how keys rotate, and how the public audit log lets anyone watch the committee.

**Posture:** on the single-operator stack today, one operator holds all five committee keys. The
on-chain mechanism is real, but the "five independent custodians" it is designed for do not exist yet.
Section 5 is the checklist to close that gap. For the wider trust model see
[`ARCHITECTURE.md`](ARCHITECTURE.md); for the current bring-up steps see
[`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md) (Step 6, federate-out) and
[`../deploy/README.md`](../deploy/README.md).

---

## 1. What the committee keys control

There is **no sudo** — the chain is sudo-free from genesis (pallet index 6 is permanently vacant), so
these keys are the entire privileged surface.

| Key / origin | What it controls | Compromise means |
|---|---|---|
| **The 5 `FollowerCommittee` keys** (a 3-of-5 threshold) | Every privileged runtime call: the identity `revoke` moderation lever, `force_set_capacity`, the observer `set_enforcement` switch, `add`/`remove_validator`, runtime upgrades (`governed-upgrade` `authorize_upgrade`), and the governance-fuel budget (`set_allowance`/`revoke` — the mint and claw-back lever for native FUEL). | Control of moderation, the validator set, and the runtime code itself. **3 of 5 must collude** — there is no fallback. |
| **Each validator's session keys** (Aura sr25519 + GRANDPA ed25519) | Block authoring and finality voting for that one validator. | Disruption of that validator's consensus participation. On the testnet there is no equivocation slashing (a `MAINNET PREREQUISITE`). Rotate both keys **in lockstep**. |

Talk-capacity **weight** is deliberately **not** a custodial key. It is written by the
`cardano-observer` inherent — a consensus output that every full node re-derives from db-sync, not a
value any operator can set. There is no off-chain follower, relayer, or Cardano signing key to protect:
the node only reads db-sync, and L1 transactions are built and signed in the user's own wallet in the
frontend. Consensus plus the committee keys are the whole trust boundary.

---

## 2. Requirements for a real custody split

### 2.1 The threshold — 3 of 5
The committee origin requires **three of five** members to vote aye before a motion executes. This
tolerates **2** lost or compromised keys without losing control, and **2** unavailable custodians
without losing liveness. (`MaxMembers = 7` leaves headroom for rotation overlap.)

### 2.2 Five independent custody domains
"Independent" means a compromise of one domain gives an attacker **at most one** key. Diversify across
**all** of these axes, not just one:

| Seat | Holder (distinct person/org) | Key material | Hosting / jurisdiction |
|---|---|---|---|
| 1 | core operator | hardware wallet, air-gapped signing | self-hosted, country A |
| 2 | second org / co-founder | hardware HSM | self-hosted, country B |
| 3 | independent community member | hardware wallet | residential, country C |
| 4 | cloud KMS (a different cloud than any infra) | KMS, IAM-isolated | cloud region D |
| 5 | legal/escrow or second community member | hardware wallet, offline | country E |

This defeats: one person coerced, one laptop owned, one cloud account breached, one jurisdiction seizing
keys, one hardware-vendor backdoor. **No two seats may share a person, a device model + seed, a cloud
account, or a building.** Record the actual assignment in a sealed, versioned registry (not in this repo).

### 2.3 Rotation and revocation
See section 3.

### 2.4 A public audit log
See section 4.

---

## 3. Rotation & revocation procedure

Membership is mutable on-chain via `Collective::set_members`, gated by the **committee itself** (the
same 3-of-5 origin — there is no root, and an empty new-member set is rejected by the runtime
brick-guard). To rotate a seat — a planned roll, a suspected compromise, or a custodian departure:

1. **Announce** out-of-band to all custodians: which seat, why, the new member's account, and the
   effective date. For a *compromise*, skip the wait and go straight to emergency revocation (step 5).
2. **Pre-stage the incoming custodian.** Generate the new key in its target custody domain, then fund it
   with a standing fuel allowance —
   `cogno-chain-cli fuel set-allowance --account <new-SS58> --max <units>` (itself a committee motion;
   the allowance regenerates so the seat never drains to zero). Verify it can sign a no-op test motion
   on a testnet. Fund **before** the `set_members` that seats them: this is enforced on-chain, so a
   `set_members` that adds an unfunded member is rejected (`CallFiltered`). A seated member can always
   vote from block one.
3. **Propose** the new member list via `set_members` (the swapped member; committee size stays `1` or
   `>= 3` — the runtime rejects a 2-seat committee, and no prime is set, since the runtime treats abstain
   as nay and a prime on a small committee is a foot-gun). Route it as a committee motion and log it (§4).
4. **Enact and verify.** After the motion executes, read `followerCommittee.members()` and confirm the
   new set. The departing key is now powerless — the collective reads membership live, and any in-flight
   motion the removed member voted on is re-tallied against the new set.
5. **Emergency revocation (suspected compromise).** Immediately propose a `set_members` that drops the
   suspect seat (3 of the remaining 4 can still operate, or drop temporarily to 3-of-4 while
   re-staffing). Publish a post-mortem to the audit log.
6. **Periodic roll.** Rotate at least one seat on a fixed cadence (every 6–12 months) so the rotation
   path stays exercised and never rusty.

**Validator keys are a separate operation.** Rotating a validator's session keys (`session.setKeys`) is
not a committee custody change: Aura (sr25519) and GRANDPA (ed25519) are distinct keypairs — update both
together or finality silently breaks. See [`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md) (Step 6,
`validator set-keys` / `key insert`).

---

## 4. The public audit log & monitoring

The audit log **is** the on-chain event stream — it is emitted by construction, not bolted on.

- **Per-motion lifecycle** (`pallet-collective`, `Instance1` = `followerCommittee`):
  `Proposed` · `Voted` · `Closed` · `Approved`/`Disapproved` · `Executed`. Every privileged action is a
  motion, so who proposed, who voted, and the outcome are all public.
- **Per-action** (the target pallets): `IdentityLinked`/`Revoked`, `CapacityForced`, the observer's
  enforcement toggle, `ValidatorAdditionInitiated`/`ValidatorRemovalInitiated`, and
  `AllowanceSet`/`AllowanceRevoked` (plus the periodic `FuelRegenerated`) from `governance-fuel`.

Run an independent watcher (anyone can — the data is public) that follows these events and alerts on:

- **Unexpected actors** — a `Proposed`/`Voted` from an account not in the published committee list.
- **Membership changes** — any `set_members` or change in `followerCommittee.members()` that was not
  announced (§3); treat it as a compromise until proven otherwise.
- **Enforcement changes** — any flip of the observer's `set_enforcement` switch.
- **Fuel / minting changes** — any `AllowanceSet`/`AllowanceRevoked` (native-FUEL mint or claw-back, and
  the only post-genesis supply-inflation path — there is no cumulative issuance cap) not tied to an
  announced rotation.
- **Observation integrity** — every full node already re-derives the observed weight and rejects a block
  whose observation disagrees (a divergence is a chain fork). A watcher can additionally recompute the
  expected weight from public Cardano state and compare it against the on-chain `TalkStake` ledger.

A minimal watcher subscribes over the node's own PAPI/JSON-RPC — the node serves every read from its
runtime API, with no separate indexer.

---

## 5. Closing the gap: single-operator → independent control

The mechanism and the sudo-free origins are done. The remaining work is people-and-process, in order:

1. **Recruit the five custodians** across genuinely independent domains (§2.2) — the hard,
   non-technical step.
2. **Distribute the keys.** Each custodian generates their own key in their own domain; the operator
   never sees seats 2–5. Fund each incoming account with a fuel allowance first (`cogno-chain-cli fuel
   set-allowance`, a committee motion) — seating an unfunded member is rejected on-chain — then seat the
   five accounts via `set_members`.
3. **Run motions as true co-signs.** The proposer opens the motion with `--propose` (one seat key, not
   five bundled on one host); each custodian then runs `cogno-chain-cli committee vote --proposal <hash>
   --index <n>` with **their own key on their own infra**. `committee list` prints the hash and index of
   every open motion. Anyone may *propose*; the **votes** must be independent.
4. **Stand up ≥2 independent watchtowers** (§4), run by different parties.
5. **Keep loss-tolerance headroom.** The runtime brick-guard enforces a `1 || ≥3` floor (it rejects both
   the empty set and the fault-intolerant 2-seat committee), so federation jumps directly from 1 seat to
   3+. Size the committee so it survives lost keys without bricking: a 5-seat set needs 3 of 5 seats and
   tolerates 2 lost keys; a 3-seat set tolerates 1. There is no sudo break-glass if too many live keys
   are lost, so pair every configuration with this written rotation runbook.

Until steps 1–3 are real, label every privileged action as single-operator: the on-chain mechanism is
genuine, but the votes are not yet independent.
