<!-- Thanks for contributing! Please fill this out so reviewers can move quickly. -->

## Summary

<!-- What does this change do, and why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] CI / tooling / ops

## Testing

<!-- How was this verified? Tick what you ran. -->

- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cd contracts && script -qec "aiken check" /dev/null` (only if `contracts/` changed)
- [ ] Frontend `npm test` / `npm run build` (only if `app/` changed)

## Checklist

- [ ] Commit messages follow `<scope>(<area>): <summary>`.
- [ ] **Encoding discipline:** if this touches runtime calls/storage/events/extensions, `spec_version`
      was bumped and PAPI descriptors regenerated. If it does **not**, `spec_version` was left
      unchanged.
- [ ] **Pallet indices unchanged** (6 and 12 stay vacant; nothing renumbered).
- [ ] **No new sudo / privileged escape hatch** — privileged calls still go through the 3-of-5
      committee.
- [ ] **If `contracts/` changed:** the `hash` fields in `plutus.json` / `vault.json` are confirmed
      unchanged (the live vault must not be orphaned), or the PR explains an intentional redeploy.
- [ ] Docs updated where behavior changed.
