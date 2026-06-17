# L3 §8.3 — SPO / Ariadne D-parameter graduation (DESIGN, not built)

> **Status: DESIGN ONLY (M6, DR-26).** This document specifies the path from M6's *operator-gated
> mutable authorities* to a *Cardano-SPO-selected* block-producing committee. Per **DR-26** the
> graduation is **documented, not built** in v1 — there is **no SPO-ingestion code** in the runtime.
> It is the L3-side companion to `L2-follower.md` §9 (the D0→D4 follower glide) and `L3-chain.md` §8.3.
>
> Read first: `docs/L3-chain.md` §8 (the consensus/decentralization path), `docs/M6-build.md`
> (what M6 actually shipped), `docs/DECISION-REGISTER.md` DR-26 / DR-07 / DR-25.

---

## 0. Where M6 leaves the chain (the starting line)

M6 closed the two tracks `L3-chain.md` §8.2 / DR-07 named:

| Axis | Before M6 | After M6 (now) | The remaining graduation (this doc) |
|---|---|---|---|
| **Who produces blocks** (Aura/GRANDPA authorities) | frozen at genesis | **mutable** via `pallet-session` + `pallet-validator-set`; `add_validator`/`remove_validator` gated, queued to a session boundary | **selected by Cardano SPO registrations** via an Ariadne D-parameter pallet |
| **Who authorizes the privileged writes** (`AddRemoveOrigin`, `set_stake`, `link_identity`, `anchor_ack`, `set_code`) | single-key `EnsureRoot`/sudo | **`EitherOfDiverse<EnsureRoot, 3-of-5 FollowerCommittee>`** (the committee path is the daily driver in the services; sudo is the dev fallback) | **drop sudo entirely**; route every origin through the committee, then the SPO committee |

So the runtime already has the two seams the graduation needs:

1. **`SessionManager` is swappable.** Today it is `pallet-validator-set` (operator add/remove). The
   graduation replaces it with an Ariadne selection pallet. `pallet-aura`/`pallet-grandpa` follow the
   session blindly — **no consensus-pallet change.**
2. **Every privileged origin is an `EnsureOrigin`** (`AuthorityOrigin`). Widening or replacing the
   thing behind it (sudo → collective → SPO committee) is a **signature-free type swap** — no call
   changes, no client metadata break beyond the `spec_version` bump.

> **The throw-nothing-away property (L2 §9, L3 §8.3):** the app pallets — `microblog`, `cogno-gate`,
> `talk-stake`, capacity — change **ZERO** across this entire graduation. Only the consensus/session
> layer and the origin types move.

---

## 1. The endgame, stated plainly

A block-producing **committee elected each epoch from Cardano stake-pool operators (SPOs)**, mixing a
shrinking set of permissioned bootstrap seats with a growing set of registered-SPO seats by a tunable
**D-parameter**, so trust in the operator decays toward zero over time — *Approach B* in `PLAN.md`,
the `L2-follower.md` §9 **D2→D4** endgame. This is the IOG **Ariadne** committee-selection model
(the partner-chains design), re-implemented here because the canonical template is archived (§4).

Two independent things must both happen — they are often conflated:

- **(a) Selection** — *who* may be in the validator set is decided by Cardano SPO registrations, not
  by the operator's `add_validator`. → an **Ariadne/D-parameter selection pallet** as `SessionManager`.
- **(b) Authorization** — *no single key* can still override the chain (validator membership, runtime
  upgrades, the follower/relayer writes). → **drop `pallet-sudo`**, route every origin through the
  committee (and ultimately the SPO committee). Dropping sudo is a **process, not a flag** (§3).

D2 (the 3-of-5 committee, M6) gives you (b) in *shape*. Full graduation gives you (a) **and** real (b).

---

## 2. The Ariadne / D-parameter selection pallet (the one new pallet)

Replace `pallet-validator-set` as the session manager with `pallet-spo-committee` (name TBD). Sketch
— **none of this is built**; it is the contract the future pallet must satisfy:

```
pallet-spo-committee  (the new SessionManager; ~the only new on-chain code the graduation needs)
  Config:
    RegistrationOrigin : EnsureOrigin   // who may INGEST an SPO registration (see §2.1) — gated,
                                         // NEVER an offchain-worker HTTP read (L2 §5.1, the cardinal rule)
    GovernanceOrigin   : EnsureOrigin   // who may set the D-parameter + the permissioned seat list
                                         // = the FollowerCommittee at first, then the SPO committee itself
    DParameter         : Get<...>       // (permissioned_seats, registered_seats) per epoch — runtime-tunable
    Epoch              : ShouldEndSession / PeriodicSessions   // epoch boundary == session boundary
  Storage:
    RegisteredSpos : map SpoId -> { aura: AuraId, grandpa: GrandpaId, cardano_pool_id, stake, valid_until }
    PermissionedCandidates : Vec<(AccountId, AuraId, GrandpaId)>   // bootstrap seats (shrinking)
    DParam : (u16 permissioned, u16 registered)
  impl pallet_session::SessionManager:
    new_session(epoch) -> Some( ariadne_select(PermissionedCandidates, RegisteredSpos, DParam, seed) )
```

`ariadne_select` deterministically picks `D.permissioned` seats from the bootstrap list and
`D.registered` seats from the registered SPOs (stake-weighted, with an epoch seed) — the **D-parameter
is tuned toward `(0, N)`** over successive epochs, retiring the operator's seats. `new_session` returns
the elected set; Aura/GRANDPA follow exactly as they follow `pallet-validator-set` today.

### 2.1 SPO registration **ingress** — the cardinal rule

A Cardano SPO registers to be eligible by publishing a registration (its Cardano pool id + its L3
session keys `(AuraId, GrandpaId)` + a signature binding them). The runtime learns about it **the same
way the L2 follower learns about a vault lock** (`L2-follower.md` §5.1):

- **A gated extrinsic or an inherent** carrying the observed registration, submitted by the same
  trusted-then-decentralized ingress as the weight writes — **NEVER** an `offchain-worker` HTTP read
  of Cardano. (An OCW HTTP read is non-deterministic across validators and is the classic way to
  fork or brick a chain; it is forbidden in both L2 and here.)
- The ingress authority (`RegistrationOrigin`) walks the same **D0→D4 glide** as the follower:
  D0 single key + public recomputer → D2 k-of-t committee → D3 optimistic challenge → D4 inherent +
  Mithril-certified Cardano state proof (`DR-25`, deferred). **This is why the graduation is coupled
  to L2's D3/D4** — inherent re-verification is only load-bearing once there are multiple independent
  producers (`L2-follower.md` §5.1, §9).

Registration **validity** (the pool exists, the stake, the key-binding signature) is checked by the
ingress in v1 (the trusted recomputer) and on-chain at D4 (the inherent verifies a Mithril proof).

---

## 3. Dropping sudo is a PROCESS, not a flag (the audit that gates D2 → mainnet)

Removing `pallet-sudo` while *any* privileged origin still points at a single key just relocates the
centralization. Before sudo can be dropped, **every** privileged origin must already route through the
committee (then the SPO committee), and an audit must confirm none is left behind. The inventory for
**this** runtime (audit each line; ✅ = already off bare single-key after M5/M6):

| Privileged action | Origin today | Must become |
|---|---|---|
| `cogno-gate::link_identity` / `revoke` | `AuthorityOrigin` ✅ (committee‑or‑sudo) | committee → SPO committee; **remove the `EnsureRoot` arm** |
| `talk-stake::set_stake` | `AuthorityOrigin` ✅ | same |
| `anchor::anchor_ack` | `AuthorityOrigin` ✅ | same |
| `microblog::force_set_capacity` | `AuthorityOrigin` ✅ | same |
| `validator-set::add/remove_validator` (`AddRemoveOrigin`) | `AuthorityOrigin` ✅ (M6) | **replaced** — the SPO committee *is* the selector, so manual add/remove is retired (kept only as a permissioned-seat governance lever) |
| `collective::set_members` (`SetMembersOrigin`) | `EnsureRoot` ⚠ | committee self-rotation / SPO-derived membership |
| `Sudo.sudo(set_code)` (runtime upgrade) | `EnsureRoot` ⚠ | a committee/governance origin (the last and most dangerous single key) |

The two ⚠ rows — committee rotation and **`set_code`** — are the ones that actually keep sudo alive.
`set_code` is the master key (it can rewrite every other rule), so it is the *last* origin migrated
and the one that most needs a real k-of-t across independent custody domains first (DR-07,
`docs/D2-custody-runbook.md`). **Only when all ⚠ rows are migrated and the audit is clean does
`pallet-sudo` come out of `construct_runtime` (a `spec_version` bump + a storage-migration that
clears the sudo key).**

---

## 4. Constraints & cost (why this is a later milestone)

- **No template to depend on.** IOG **partner-chains** (the canonical Ariadne implementation) was
  **archived 2026-04-23**, read-only, folded into Midnight. The options: **self-build** the
  `pallet-spo-committee` above, **vendor-fork** partner-chains (Apache-2.0 / GPLv3-Classpath —
  reconcile the licence before vendoring, as we did for `pallet-validator-set`), or track **Midnight's**
  crates. Recommendation: **self-build** the thin selection pallet (it is small — the heavy lifting is
  the off-chain registration observer + the D4 Mithril proof, not the on-chain selector).
- **Per-seat Cardano infra is the real cost.** Each committee member that *verifies* SPO registrations
  independently (the point of decentralizing) runs a Cardano node + db-sync + Postgres. That operational
  weight — not the Rust — is why this is post-v1.
- **Coupled to L2 D3/D4 and Mithril (DR-25, deferred).** D4's inherent re-verification only pays off
  with multiple independent producers; the Mithril dependency (single IOG aggregator today, proves
  *membership* not *completeness*) must mature first. Pin a post-advisory Mithril client (≥0.12.x) **if**
  adopted.

---

## 5. Migration order (each step is a signature-free `EnsureOrigin`/`SessionManager` swap + a spec bump)

1. **(done, M6)** `pallet-session` + `pallet-validator-set`; authorities mutable; add/remove behind the
   3-of-5 committee; services drive privileged calls through the committee.
2. **Committee self-rotation:** move `collective::SetMembersOrigin` and `set_code` off `EnsureRoot` to a
   committee/governance origin. Audit: no bare `EnsureRoot` left except the to-be-removed sudo.
3. **Drop `pallet-sudo`** (the §3 audit is clean) — storage migration clears the key.
4. **Introduce `pallet-spo-committee`** as the new `SessionManager` (`pallet-validator-set` retired to a
   permissioned-seat governance role). D-parameter starts `(N, 0)` (all bootstrap) — behaviourally
   identical to today, so it is a safe cutover.
5. **Stand up SPO registration ingress** (gated extrinsic/inherent, D0→D2 like the follower) and begin
   moving the D-parameter toward `(0, N)` epoch by epoch as real SPOs register.
6. **D3/D4:** optimistic challenge → inherent + Mithril proof; the ingress becomes trustless. The chain
   is now SPO-secured; **the app pallets never changed.**

---

## 6. What M6 deliberately did NOT build (honest scope, DR-26)

- No `pallet-spo-committee`, no Ariadne selection, no D-parameter storage.
- No Cardano SPO-registration observer, no registration extrinsic/inherent, no Mithril client.
- No removal of `pallet-sudo` (it is retained as the documented v1 dev fallback).
- `MinAuthorities = 1` and 1–3 operator nodes remain the **honest permissioned-service** posture of v1
  (`L3-chain.md` §8.1): finality can stall on a 1–3 authority chain; tell users so. This document is the
  committed path off that posture — scheduled, not shipped.
