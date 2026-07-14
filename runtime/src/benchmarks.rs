// This is free and unencumbered software released into the public domain.
//
// Anyone is free to copy, modify, publish, use, compile, sell, or
// distribute this software, either in source code form or as a compiled
// binary, for any purpose, commercial or non-commercial, and by any
// means.
//
// In jurisdictions that recognize copyright laws, the author or authors
// of this software dedicate any and all copyright interest in the
// software to the public domain. We make this dedication for the benefit
// of the public at large and to the detriment of our heirs and
// successors. We intend this dedication to be an overt act of
// relinquishment in perpetuity of all present and future rights to this
// software under copyright law.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
// OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
//
// For more information, please refer to <http://unlicense.org>

frame_benchmarking::define_benchmarks!(
    [frame_benchmarking, BaselineBench::<Runtime>]
    [frame_system, SystemBench::<Runtime>]
    [frame_system_extensions, SystemExtensionsBench::<Runtime>]
    [pallet_balances, Balances]
    [pallet_timestamp, Timestamp]
    // NOTE: no pallet-sudo (SUDO-FREE) and no pallet-governed-upgrade benchmark: the latter's single
    // `authorize_upgrade` call uses a fixed placeholder `WeightInfo = ()` (one storage write + one event),
    // so there is no `#[benchmarks]` module to list here yet.
    // ── cogno-chain app pallets ──
    // NOTE: no pallet-talk-stake — it is now a call-less observer-written ledger (no dispatchables to bench).
    // The SOLE weight writer. `observe` is Mandatory and runs in every block, so its weight is the one that
    // cannot be skipped: benchmarked over four components (observed vault entries, observed stake entries,
    // and the two unlock-clamp bases, which the arguments alone cannot express).
    [pallet_cardano_observer, CardanoObserver]
    [pallet_cogno_gate, CognoGate]
    [pallet_microblog, Microblog]
    // Social-actions branch: the fee-bearing display-profile pallet.
    [pallet_profile, Profile]
    // The regenerating admin-fuel budget: set_allowance/revoke + the on_initialize regeneration hook.
    // `regenerate` is billed from that hook and is linear in the funded-set size, so (like `observe`) it
    // runs on real benchmarked weights as of spec 204 — fund/revoke are O(1).
    [pallet_governance_fuel, GovernanceFuel]
    // Real WeightInfo for the mutable-authority add/remove extrinsics.
    [pallet_validator_set, ValidatorSet]
    // runtime-4: benchmark the FollowerCommittee (the path that EXECUTES every 3-of-5 privileged
    // motion — its propose/close weight scales with proposal count/length, a block-fill/griefing
    // surface). Now benchmarkable; pointing its `WeightInfo` at the generated module (instead of the
    // upstream `SubstrateWeight` reference weights wired in configs/mod.rs) is a DEPLOY step — run
    // `benchmark pallet` on representative production hardware, as the dev box's numbers would be wrong.
    [pallet_collective, FollowerCommittee]
    // NOTE: pallet-session is NOT listed — its set_keys/purge_keys benchmarks require
    // `pallet_session::historical` wiring, which the runtime intentionally does not have yet. That is
    // the SAME prerequisite as a real GRANDPA equivocation/offence path, so both graduate
    // together when historical session is added for a public multi-validator network.
);
