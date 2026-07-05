# Committee custody, rotation & audit-log runbook (the D2 rung)

> **Status: policy runbook.** The procedure for operating cogno-chain's privileged keys at **D2** — a
> **3-of-5 k-of-t committee across five independent custody domains**, with a rotation procedure, an
> on-chain committee-key update, and a public audit log. Reaching real D2 is a hard gate before any
> mainnet / real-value run.
>
> The **mechanism** already exists from genesis (the `FollowerCommittee`, the
> `EnsureProportionAtLeast<3,5>` origins, the propose→vote→close tooling in `cogno-chain-cli committee`).
> This runbook is the **operational policy** that turns the mechanism into actual D2 — the part that is
> people-and-process, not code.
>
> ⚠ **Honest status today: D2-SHAPED, not D2-TRUST.** On the single-operator stack ONE operator holds
> all five committee keys. Every committee motion here exercises the exact on-chain mechanism and origin
> of real D2, but the "five independent custody domains" do not yet exist. §5 is the checklist to close
> the gap. For the current operational how-to see [`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md) (§6
> federate-out) + [`../deploy/README.md`](../deploy/README.md); for the design, [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. What the crown jewels are (the assets this protects)

| Key / origin | What it controls | Compromise = |
|---|---|---|
| **The 5 `FollowerCommittee` keys** (3-of-5) | every privileged runtime call: the identity `revoke` moderation lever, `force_set_capacity`, the observer `set_enforcement` switch, `add/remove_validator`, runtime upgrades (`governed-upgrade` `authorize_upgrade`), and the governance-fuel budget (`governance-fuel` `set_allowance`/`revoke` — the native-FUEL mint/claw-back lever) | control of moderation, the validator set, and the runtime code itself. The central crown jewel — **3 of 5 must collude.** There is **no sudo fallback** (the chain is sudo-free from genesis; index 6 vacant). |
| **Each validator's session keys** (Aura sr25519 + GRANDPA ed25519) | block authoring + finality voting for that validator | can disrupt that validator's consensus participation. On the testnet there is no equivocation slashing (a `MAINNET PREREQUISITE`). Rotate both keys **in lockstep**. |

Talk-capacity **weight** is deliberately **not** a custodial key: it is written by the `cardano-observer`
inherent — a consensus output that every full node re-derives from db-sync (a divergence is a chain
fork), not a value any operator can set. There is no off-chain follower, relayer, or Cardano signing key
to protect: the node only **reads** db-sync (read-only), and L1 transactions are built and signed in the
user's own wallet in the frontend. The capacity/feeless anti-spam is also out of scope here — it gates
*users*, not operators (`ECONOMICS.md` §8). Consensus + the committee keys are the trust boundary.

---

## 2. The four custody requirements (and how each is met at D2)

Before any non-dev run, write down all four. Here they are.

### 2.1 The k-of-t threshold — **3-of-5**
`EnsureProportionAtLeast<AccountId, Instance1, 3, 5>`. Three of five committee members must vote aye on a
motion for it to execute. Rationale: tolerates **2** lost/compromised keys without loss of control AND
**2** unavailable custodians without loss of liveness. (`MaxMembers = 7` leaves headroom for rotation
overlap.)

### 2.2 The signer set — **five independent custody domains**
"Independent" means a compromise of one domain gives an attacker **at most one** key. Diversify across
**all** of these axes, not just one:

| Seat | Holder (distinct person/org) | Key material | Hosting / jurisdiction |
|---|---|---|---|
| 1 | core operator | Ledger/hardware wallet, air-gapped signing | self-hosted, country A |
| 2 | second org / co-founder | YubiHSM / hardware | self-hosted, country B |
| 3 | independent community member | hardware wallet | residential, country C |
| 4 | cloud KMS (different cloud than any infra) | AWS/GCP KMS, IAM-isolated | cloud region D |
| 5 | legal/escrow or second community member | hardware wallet, offline | country E |

The failure modes this defeats: one person coerced, one laptop owned, one cloud account breached, one
jurisdiction seizing keys, one hardware-vendor backdoor. **No two seats may share a person, a device
model+seed, a cloud account, or a building.** Record the actual assignment in a sealed, versioned
registry (NOT in this repo).

### 2.3 Rotation / revocation — see §3.

### 2.4 The public audit log — see §4.

---

## 3. Rotation & revocation procedure

Membership is mutable on-chain via `Collective::set_members`, gated by the **committee itself** (the same
3-of-5 `AuthorityOrigin` — there is no `EnsureRoot`, and an empty new-member set is rejected by the
runtime brick-guard). To rotate a seat (planned roll, suspected compromise, or custodian departure):

1. **Announce** out-of-band to all custodians: which seat, why, the new member's account, effective
   date. (For a *compromise*, skip the wait and treat as an emergency revocation — step 5.)
2. **Pre-stage** the incoming custodian: generate the new key in its target custody domain, **fund it
   with a standing fuel allowance** — `cogno-chain-cli fuel set-allowance --account <new-SS58> --max <units>`
   (a committee motion; propose/vote/close are fee-bearing, and the allowance then *regenerates* so the
   seat never drains to zero), and verify it can sign a no-op test motion on a testnet. Fund **before** the
   `set_members` that seats them — and note this is now **enforced on-chain**: a `set_members` that adds a
   member with no fuel allowance is rejected (`CallFiltered`), so a seated member can always vote from
   block one.
3. **Propose** the new member list via `set_members` (the swapped member; size stays `1` or `>= 3` — the
   runtime rejects a 2-seat committee, and a prime is not set: the runtime uses abstain-as-nay so a prime is
   inert and setting one is a foot-gun on the sole authority), routed as a committee motion — log it (§4).
4. **Enact + verify:** after the motion executes, read `followerCommittee.members()` and confirm the new
   set. The departing key is now powerless (the collective reads membership live; in-flight motions the
   removed member voted on are re-tallied against the new set).
5. **Emergency revocation (suspected compromise):** immediately propose a `set_members` that drops the
   suspect seat (3 of the remaining 4 can still operate, or temporarily drop to a 3-of-4 while
   re-staffing). Publish a post-mortem to the audit log.
6. **Periodic roll:** rotate at least one seat on a fixed cadence (e.g. every 6–12 months) so the
   rotation path is exercised and never rusty.

> **Key-set lockstep reminder (consensus, not custody):** rotating a *validator's* session keys
> (`session.setKeys`) is a different operation — Aura (sr25519) and GRANDPA (ed25519) are **distinct
> keypairs**; update both together or finality silently breaks. See
> [`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md) (§6, `validator set-keys` / `key insert`).

---

## 4. The public audit log & its monitoring

**The audit log is the on-chain event stream — it is emitted by construction, not bolted on.**

- **Per-motion lifecycle** (`pallet-collective`, `Instance1` = `followerCommittee`):
  `Proposed{account, index, hash, threshold}` · `Voted{account, hash, voted, yes, no}` ·
  `Closed` · `Approved`/`Disapproved` · `Executed{result}`. Every privileged action is a motion, so
  **who proposed, who voted, and the outcome are all on-chain and public.**
- **Per-action** (the target pallets): `IdentityLinked`/`Revoked`, `CapacityForced`, the observer's
  enforcement toggle, `ValidatorAdditionInitiated`/`ValidatorRemovalInitiated`, and
  `AllowanceSet`/`AllowanceRevoked` (plus the periodic `FuelRegenerated`) from `governance-fuel`.

### 4.1 The watchtower (monitoring policy)
Run an independent watcher (anyone can — the data is public) that follows these events and alerts on:

- **Unexpected actors** — a `Proposed`/`Voted` from an account **not** in the published committee list.
- **Membership changes** — any `set_members` / change in `followerCommittee.members()` that was not
  announced (§3) → treat as a compromise until proven otherwise.
- **Enforcement changes** — any flip of the observer's `set_enforcement` switch.
- **Fuel / minting changes** — any `AllowanceSet`/`AllowanceRevoked` (native-FUEL mint/claw-back, the
  first post-genesis supply-inflation path — no cumulative issuance cap) not tied to an announced seat
  rotation → investigate as a possible committee compromise.
- **Observation integrity** — because the `cardano-observer` inherent is deterministic, every full node
  already re-derives the weight and **rejects a block whose observation disagrees** (a divergence is a
  chain fork). A watcher can additionally recompute the expected weight from public Cardano state and
  compare against the on-chain `TalkStake` ledger.

A minimal watcher can subscribe over the node's own PAPI/JSON-RPC (the node serves every read from its
runtime API; there is no separate indexer).

---

## 5. Closing the gap: single-operator (today) → real D2

The mechanism and the sudo-free origins are already done; this is the remaining people-and-process work,
in order:

1. **Recruit the five custodians** across genuinely independent domains (§2.2) — the hard,
   non-technical step.
2. **Distribute the keys**: each custodian generates their own key in their own domain; the operator
   never sees seats 2–5. Fund each incoming account with a standing fuel allowance
   (`cogno-chain-cli fuel set-allowance`, a committee motion) **first** — seating an unfunded member is
   rejected on-chain (`CallFiltered`, see §3 step 2) — then seat the five accounts via `set_members`.
3. **Run motions as true co-signs**: each custodian runs `cogno-chain-cli committee vote` against the
   proposal hash with **their own key on their own infra** — not one operator scripting all five (which
   is what a single-operator stack does today, and what the honesty label flags). Anyone may *propose*;
   the **votes** must be independent.
4. **Stand up ≥2 independent watchtowers** (§4.1) run by different parties.
5. **Keep loss-tolerance headroom.** The runtime brick-guard already enforces a `1 || ≥3` floor (it
   rejects both the empty set and the fault-intolerant 2-seat committee), so federation jumps 1 → 3+
   directly. Beyond that, size the committee so it survives lost keys without bricking — a 5-seat set
   tolerates 2 lost keys (`ceil(5·3/5)=3`), a 3-seat set tolerates 1; pair it with a written
   key-custody/rotation runbook, because there is no sudo break-glass if `ceil(3n/5)` live keys are lost.

Until steps 1–3 are real, label every privileged action **"single-operator, D2-shaped, not D2-trust."**
The tooling does this automatically; keep it in the user-facing honesty badges too.
