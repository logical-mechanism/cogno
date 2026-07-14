# Security Policy

## Project posture

cogno-chain is a **live preprod testnet**. It is deliberately operator-run and honestly labeled: a
number of hardening items are **intentionally deferred** and marked `MAINNET PREREQUISITE` in the
source (for example: `MinAuthorities = 1`, GRANDPA equivocation reporting as a no-op, an independent
audit of the CIP-8 verifier, production key custody, and db-sync over TLS). **These are known,
scoped-out testnet choices, not vulnerabilities** — please do not report them as security issues.

Genuine security-relevant areas we *do* want to hear about include:

- The on-chain **CIP-8 identity verifier** (`pallets/cogno-gate`, `cip8.rs`) — a bug that lets one
  wallet forge or hijack another identity.
- The **`cardano-observer` inherent** — the sole writer of talk-capacity weight; anything that lets a
  producer credit weight the Cardano state does not support, or that breaks the deterministic
  re-derivation (a consensus divergence).
- The **committee-governed upgrade path** (`pallet-governed-upgrade` + `FollowerCommittee`) — any way
  to bypass the 3-of-5 origin or brick the authority set.
- The **governance-fuel mint path** (`pallet-governance-fuel` + the runtime `CognoCallFilter`) — the
  sole committee-gated native mint path; anything that mints fuel without the 3-of-5 `GrantOrigin`,
  defeats fuel non-transferability, lets fuel be spent on posting, or seats an unfunded account as a
  validator or committee member.
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
consensus- or verifier-level issue we may need to coordinate a runtime upgrade (committee `authorize`
+ permissionless `apply`) across operators before details are made public.
