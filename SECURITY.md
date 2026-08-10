# Security Policy

## Project posture

cogno-chain is a **live preprod testnet**. It is deliberately operator-run and honestly labeled: a
number of hardening items are **intentionally deferred**, most of them marked `MAINNET PREREQUISITE`
right where they live in the source — `MinAuthorities = 1`, GRANDPA equivocation reporting wired to
a no-op, an independent audit of the CIP-8 verifier, the db-sync read running in plaintext over a
private LAN, and split committee-key custody. **These are known, scoped-out testnet choices, not
vulnerabilities** — please do not report them as security issues.

Genuine security-relevant areas we *do* want to hear about include:

- The on-chain **CIP-8 verifier** (`pallets/cogno-gate/src/cip8.rs`) — one module behind three
  self-proofs: the payment bind that grants a posting identity (`link_identity_signed`), the stake
  bind that anchors voting power (`link_stake_signed`), and the role-key claim behind
  `pallet-cardano-roles` (`claim_role_signed`). All three are **bare unsigned and feeless** — the
  proof *is* the authorization, and pool admission is the only spam control on those paths — so a bug
  that lets one wallet forge, retarget or replay another wallet's proof is the highest-severity class
  here. `ci/cip8-oracle/` is a second, independent implementation kept as a CI oracle; a disagreement
  between the two is worth reporting on its own.
- The **bind and claim ledgers** those proofs write (`pallet-cogno-gate`, `pallet-cardano-roles`) —
  the 1:1 maps on both sides, the permanent tombstones a committee `revoke` / `revoke_role` /
  `tombstone_stake_cred` leaves behind, and the spent-nonce guards (`SpentStakeNonce`,
  `SpentRoleNonce`) that close the obvious replay of an eternally-valid proof after a self-service
  `unlink_stake` / `unclaim_role`. Each guard remembers only the most recent nonce, so a replay of an
  *older* proof is a known residual, documented at those storage items and griefing-bounded — tell us
  about anything that widens it past griefing. Anything that evades a ban, binds one credential to
  two accounts, or attaches governance weight to a credential the claimant does not control.
- The **`cardano-observer` inherent** — the sole writer of observed weight (talk-capacity, stake
  voting power, and role badges); anything that lets a producer credit weight the Cardano state does
  not support, or that breaks the deterministic re-derivation an importer runs in `check_inherent`
  (a consensus divergence). `check_inherent` is the cross-node read match only: it is skipped on
  warp/state sync and abstains non-fatally when the checking node's own db-sync is behind, so the
  layer that runs on every node is the Mandatory `observe` dispatchable. A gap in either is in scope.
- The **committee-governed upgrade path** (`pallet-governed-upgrade` + `FollowerCommittee`) — any way
  to bypass the 3-of-5 origin, to defeat the spec-name/spec-version check that the permissionless
  `System::apply_authorized_upgrade` enforces, or to brick the authority set or the committee itself.
- The **governance-fuel mint path** (`pallet-governance-fuel` + the runtime `CognoCallFilter`) — the
  only post-genesis native mint path; anything that mints fuel without the 3-of-5 `GrantOrigin`,
  defeats fuel non-transferability, lets fuel be spent on posting, or seats an unfunded account as a
  validator or committee member.
- The **`pallet-tx-pause` break-glass**, wired into the runtime `BaseCallFilter` — anything that
  pauses a call without the 3-of-5 `PauseOrigin`, or that manages to pause one of the five
  never-pausable entries that keep the chain recoverable: `CardanoObserver::observe`,
  `Timestamp::set`, the whole `FollowerCommittee` pallet, `GovernedUpgrade::authorize_upgrade`, and
  `System::apply_authorized_upgrade`.
- **Key handling** in `cogno-chain-cli` / `cogno-keyfile` and the operator ceremony.
- The L1 **`talk_vault`** Aiken validator (custodies real preprod ADA) — see `contracts/audits/`.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Email **support@logicalmechanism.io** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept is ideal),
- affected component/version (commit hash, `spec_version`, or contract hash where relevant).

We will acknowledge receipt within **5 business days**, keep you updated on our assessment, and credit
you in the fix notes unless you prefer to remain anonymous. Because this is a testnet, there is no bug
bounty at this time.

Abuse or objectionable content on the hosted network (<https://cogno.forum>) is not a security issue —
see [`POLICY.md`](POLICY.md), which also explains, plainly, what can and cannot be done about it.

## Coordinated disclosure

Please give us a reasonable window to investigate and remediate before any public disclosure. For a
verifier- or runtime-level issue we may need to coordinate a runtime upgrade — committee
`GovernedUpgrade::authorize_upgrade`, then the permissionless `System::apply_authorized_upgrade` —
across operators before details are made public. An issue in the Cardano read (`cogno-dbsync/`) is
node-side rather than runtime-side: it ships as a new node binary and a producer restart, with no
`spec_version` bump, so the coordination there is with whoever runs a node, not with the committee.
