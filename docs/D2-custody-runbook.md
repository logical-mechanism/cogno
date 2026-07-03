# DR-07 D2 — crown-jewel custody, rotation & audit-log runbook

> **Partly historical.** The committee-custody procedure is current, but this doc predates the all-Rust
> restart (`fork/all-rust`) and still lists keys that no longer exist (`sudo`/`set_code`, the anchor
> relayer, the follower) and references the retired layered specs. Treat the sudo/anchor rows as removed
> (the chain is sudo-free; runtime upgrades go through `governed-upgrade`). Current overview:
> [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Status: RUNBOOK (M6).** The procedure for operating cogno-chain's privileged keys at **D2** — a
> **3-of-5 k-of-t committee across five independent custody domains**, with a rotation procedure, an
> on-chain committee-key update, and a public audit log. **DR-07 is a hard gate before any
> mainnet / real-value run.**
>
> M6 shipped the **mechanism** (the `FollowerCommittee`, the `EnsureProportionAtLeast<3,5>` origins,
> the propose→vote→close tooling). This runbook is the **operational policy** that turns the mechanism
> into actual D2 — the part that is people-and-process, not code.
>
> ⚠ **Honest status today: D2-SHAPED, not D2-TRUST.** On the single-operator preprod/dev stack ONE
> operator holds all five committee keys. Every committee motion here exercises the exact on-chain
> mechanism and origin of real D2, but the "five independent custody domains" do not yet exist. The
> tooling prints this label on every run. §5 is the checklist to close the gap.

---

## 1. What the crown jewels are (the assets this protects)

| Key / origin | What it controls | Compromise = |
|---|---|---|
| **The 5 `FollowerCommittee` keys** (3-of-5) | `link_identity`/`revoke`, `set_stake`, `anchor_ack`, `force_set_capacity`, `add/remove_validator` | identity forgery + arbitrary posting weight + fake anchors + control of the validator set. The central crown jewel — **3 of 5 must collude.** |
| **The Cardano relayer/follower signing key** | builds + submits the Cardano metadata/observation txs (anchor, vault reads) | can publish false Cardano-side evidence; cannot by itself move L3 state (that needs the committee). Keep in a **separate hot wallet with a native-script/multisig spend policy.** |
| **`sudo` / `set_code`** (`EnsureRoot`) | the runtime-upgrade master key + the retained dev fallback on every origin | total control (can rewrite every rule). The **last** key to be retired (`L3-SPO-graduation.md` §3); until then it is the single largest risk and MUST live under the strongest custody of all. |

The capacity/feeless anti-spam is **not** in this table — it gates *users*, not operators
(`ECONOMICS.md` §8). Consensus + these keys are the trust boundary.

---

## 2. The four DR-07 requirements (and how each is met at D2)

DR-07 says: before any non-dev run, write down all four. Here they are.

### 2.1 The k-of-t threshold — **3-of-5**
`EnsureProportionAtLeast<AccountId, Instance1, 3, 5>` (DR-26). Three of five committee members must
vote aye on a motion for it to execute. Rationale: tolerates **2** lost/compromised keys without loss
of control AND **2** unavailable custodians without loss of liveness. (`MaxMembers = 7` leaves headroom
for rotation overlap.)

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

Membership is mutable on-chain via `Collective::set_members` (gated by `SetMembersOrigin`, `EnsureRoot`
in v1 → move to the committee itself / SPO selection at graduation, `L3-SPO-graduation.md` §5). To
rotate a seat (planned roll, suspected compromise, or custodian departure):

1. **Announce** out-of-band to all custodians: which seat, why, the new member's account, effective
   date. (For a *compromise*, skip the wait and treat as an emergency revocation — step 5.)
2. **Pre-stage** the incoming custodian: generate the new key in its target custody domain, fund the
   account (propose/vote are fee-bearing), and verify it can sign a no-op test motion on a testnet.
3. **Propose** the new member list via `set_members` (new prime, the swapped member, same or new size).
   Until `SetMembersOrigin` is the committee itself, this is a sudo/governance action — log it (§4).
4. **Enact + verify:** after the call lands, read `followerCommittee.members()` and confirm the new
   set. The departing key is now powerless (collective reads membership live; in-flight motions the
   removed member voted on are re-tallied against the new set).
5. **Emergency revocation (suspected compromise):** immediately `set_members` to drop the suspect seat
   (3-of-the-remaining-4 can still operate, or temporarily drop to a 2-of-3 / 3-of-4 while re-staffing).
   Rotate the **Cardano signing key** and **sudo** too if they shared any custody domain with the
   suspect. Publish a post-mortem to the audit log.
6. **Periodic roll:** rotate at least one seat on a fixed cadence (e.g. every 6–12 months) so the
   rotation path is exercised and never rusty.

> **Key-set lockstep reminder (consensus, not custody):** rotating a *validator's* session keys
> (`session.setKeys`) is a different operation — Aura (sr25519) and GRANDPA (ed25519) are **distinct
> keypairs**; update both together or finality silently breaks (`L3-chain.md` §8.1, M6 build §Gotchas).

---

## 4. The public audit log & its monitoring

**The audit log is the on-chain event stream — it is emitted by construction, not bolted on.**

- **Per-motion lifecycle** (`pallet-collective`, `Instance1` = `followerCommittee`):
  `Proposed{account, index, hash, threshold}` · `Voted{account, hash, voted, yes, no}` ·
  `Closed` · `Approved`/`Disapproved` · `Executed{result}`. Every privileged action is a motion, so
  **who proposed, who voted, and the outcome are all on-chain and public.**
- **Per-action** (the target pallets): `StakeSet`, `IdentityLinked`/`Revoked`, `AnchorAcked`/`AckIgnored`,
  `CapacityForced`, `ValidatorAdditionInitiated`/`ValidatorRemovalInitiated`.

### 4.1 The watchtower (monitoring policy)
Run an independent watcher (anyone can — the data is public; this is the **D0 recomputer** of
`L2-follower.md` §8) that subscribes to these events and alerts on:

- **Cadence anomalies** — an `anchor_ack` gap longer than `ANCHOR_EVERY × block_time × N` (the relayer
  died → tamper-evidence silently lapses, DR-22), or a burst of `set_stake` far above the observed
  vault-lock rate (a possibly-compromised follower).
- **Unexpected actors** — a `Proposed`/`Voted` from an account **not** in the published committee list,
  or a `Sudid` (sudo was used on a path that should be committee-only).
- **Membership changes** — any `set_members` / change in `followerCommittee.members()` that was not
  announced (§3.1) → treat as a compromise until proven otherwise.
- **Selection integrity** (D0) — independently recompute what `set_stake`/`link_identity` *should* be
  from public Cardano state and diff against what the committee actually wrote. A mismatch is provable
  fraud (the whole point of the D0 auditability claim).

A minimal watcher can subscribe with the same `@polkadot/api` the M6 tooling uses (dynamic metadata,
no codegen); the indexer (`services/indexer/`) already folds these events for the public feed.

---

## 5. Closing the gap: single-operator (today) → real D2

The mechanism is done; this is the remaining people-and-process work, in order:

1. **Recruit the five custodians** across genuinely independent domains (§2.2) — the hard,
   non-technical step.
2. **Distribute the keys**: each custodian generates their own key in their own domain; the operator
   never sees seats 2–5. Seat the five accounts via `set_members`.
3. **Run motions as true co-signs**: each custodian runs `vote` against the proposal hash with **their
   own key on their own infra** — not one operator scripting all five (which is what the M6 tooling
   does today, and what the honesty label flags). The `op.mjs`/`sync-weight.mjs` propose step stays
   centralized (anyone can propose), but the **votes** must be independent.
4. **Harden the two SPOF services** (DR-22): health checks + missed-`anchor_ack` alerting + a backfill
   path; the Cardano signing key in a separate hot wallet with a native-script/multisig spend policy.
5. **Stand up ≥2 independent watchtowers** (§4.1) run by different parties.
6. **Migrate the ⚠ origins off `EnsureRoot`** (`set_members`, `set_code`) and **drop `pallet-sudo`**
   (`L3-SPO-graduation.md` §3) — the point at which "3-of-5 controls the chain" becomes literally true
   with no escape hatch.

Until steps 1–3 are real, label every privileged action **"single-operator, D2-shaped, not D2-trust."**
The tooling does this automatically; keep it in the user-facing honesty badges too.
