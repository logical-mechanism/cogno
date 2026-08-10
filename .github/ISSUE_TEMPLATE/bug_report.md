---
name: Bug report
about: Report a defect in the node, runtime, pallets, CLI, contracts, or tooling
title: "bug: "
labels: bug
---

<!--
For anything with SECURITY impact, do NOT open a public issue — follow SECURITY.md instead.
Reminder: items labeled `MAINNET PREREQUISITE` in the source (MinAuthorities = 1, GRANDPA
equivocation reporting wired as a no-op, the un-independently-audited CIP-8 verifier, db-sync read
over plaintext, etc.) are deliberate testnet scope, not bugs.
-->

## What happened

<!-- A clear description of the bug. -->

## Expected behavior

## Steps to reproduce

1.
2.
3.

## Environment

- Component (node / runtime / pallet / cli / cogno-dbsync / cogno-keyfile / app / contracts / ci):
- Commit hash:
- `spec_version` (if runtime-related — the chain reports it via `state_getRuntimeVersion`):
- OS / toolchain (rustc, aiken, node versions):

## Logs / output

<!-- Paste relevant logs. For aiken output, capture via `script -qec "aiken check" /dev/null`. -->
