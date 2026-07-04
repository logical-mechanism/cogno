//! Read-only diagnostics behind the `query` group: `query state` (the chain inspector) and `query weight`
//! (the talk-stake ledger view). **Neither writes anything** — there is no talk-stake write path anywhere
//! in the CLI; weight is observer-written only.
//!
//! Both read EXCLUSIVELY from the node over RPC. `query weight` reads the on-chain `TalkStake@9` ledger
//! (`AllowedStake` = posting weight, `VotingPower` = stake-vote weight). That ledger is consensus state
//! (the observe inherent's applier runs in `execute_block` on every node), so it is fully populated on ANY
//! node you can reach — a relay / RPC node is enough.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Context;
use codec::Decode;
use pallet_cardano_observer::CardanoRef;
use sp_core::H256;
use sp_runtime::{AccountId32, DigestItem};

use crate::committee::storage_prefix;
use crate::rpc::Rpc;

/// 6-decimal ADA (raw lovelace `u128`) → a human `"123.456789 ADA"` string. Display only.
pub(crate) fn ada(raw: u128) -> String {
    format!("{}.{:06} ADA", raw / 1_000_000, raw % 1_000_000)
}

/// SS58 (prefix 42) of an account.
pub(crate) fn ss58(a: &AccountId32) -> String {
    use sp_core::crypto::Ss58Codec;
    a.to_ss58check_with_version(crate::key::SS58_PREFIX.into())
}

/// Read an on-chain `TalkStake@9` weight map (`AllowedStake` or `VotingPower`, both `account → u128`) over
/// RPC. The account is the raw 32-byte `Blake2_128Concat` key tail (the 48-byte prefix+hash is stripped).
async fn read_weight_map(rpc: &Rpc, item: &str) -> anyhow::Result<BTreeMap<AccountId32, u128>> {
    let prefix = storage_prefix("TalkStake", item);
    let pairs = rpc.storage_pairs(&prefix, None).await?;
    let mut out = BTreeMap::new();
    for (key, val) in pairs {
        if key.len() < 48 + 32 {
            continue;
        }
        let mut a = [0u8; 32];
        a.copy_from_slice(&key[48..48 + 32]);
        let acct = AccountId32::new(a);
        match u128::decode(&mut &val[..]) {
			Ok(w) => {
				out.insert(acct, w);
			},
			// Surface rather than silently drop: an on-chain TalkStake value is always a valid 16-byte u128,
			// so a decode failure signals an encoding skew / corrupt value the operator should SEE (not have
			// the account silently vanish from the listing and under-count the Σ total).
			Err(e) => eprintln!(
				"warning: TalkStake {item} value for {} failed to decode as u128 ({e}) — omitted from the total",
				ss58(&acct)
			),
		}
    }
    Ok(out)
}

/// Count the live cogno-gate identity bindings (`CognoGate@8::PkhOf`, `account → 32-byte identity hash`).
async fn binding_count(rpc: &Rpc) -> anyhow::Result<usize> {
    let prefix = storage_prefix("CognoGate", "PkhOf");
    Ok(rpc.storage_pairs(&prefix, None).await?.len())
}

/// The chain's last accepted Cardano reference (`CardanoObserver::LastReference`), or `None` before the
/// first observation.
async fn last_reference(rpc: &Rpc) -> anyhow::Result<Option<CardanoRef>> {
    rpc.storage_decode(&storage_prefix("CardanoObserver", "LastReference"), None)
        .await
}

/// The observer enforcement flag (`CardanoObserver::EnforceWeight`, default `true`). `true` ⇒ the verified
/// observation writes weight (the sole-writer mode); `false` ⇒ weight is FROZEN (emergency governance revert).
async fn enforce_weight(rpc: &Rpc) -> anyhow::Result<bool> {
    Ok(rpc
        .storage_decode::<bool>(&storage_prefix("CardanoObserver", "EnforceWeight"), None)
        .await?
        .unwrap_or(true))
}

/// `query state` — read-only chain inspector: genesis/spec, committee, validators, observer enforcement +
/// last reference, a talk-stake summary, and the identity-binding count. Reads, never writes.
pub async fn run_state(ws: &str) -> anyhow::Result<()> {
    let rpc = Rpc::connect(ws).await?;
    let genesis = rpc.genesis_hash().await?;
    let (spec, txv) = rpc.runtime_version().await?;
    println!("chain: genesis={genesis:#x} spec_version={spec} transaction_version={txv}");

    // Committee membership.
    let members: Vec<AccountId32> = rpc
        .storage_decode(&storage_prefix("FollowerCommittee", "Members"), None)
        .await?
        .unwrap_or_default();
    println!(
        "\ncommittee ({} member(s), approval threshold {}):",
        members.len(),
        crate::committee::threshold_for(members.len())
    );
    for m in &members {
        println!("  {}", ss58(m));
    }

    // Validator set.
    let validators: Vec<AccountId32> = rpc
        .storage_decode(&storage_prefix("ValidatorSet", "Validators"), None)
        .await?
        .unwrap_or_default();
    println!("\nvalidators ({}):", validators.len());
    for v in &validators {
        println!("  {}", ss58(v));
    }

    // Observer state: enforcement mode + last accepted Cardano reference.
    let enforce = enforce_weight(&rpc).await?;
    println!(
        "\nobserver: enforcement={} (the observer is the SOLE weight writer)",
        if enforce {
            "ON — crediting weight"
        } else {
            "FROZEN (set_enforcement false)"
        }
    );
    match last_reference(&rpc).await? {
        Some(r) => println!(
            "  last observed Cardano reference: slot {} (block {:#x})",
            r.slot,
            H256::from(r.block_hash)
        ),
        None => println!("  last observed Cardano reference: <none yet>"),
    }

    // Talk-stake summary (the full per-account breakdown lives in `query weight`).
    let allowed = read_weight_map(&rpc, "AllowedStake").await?;
    let voting = read_weight_map(&rpc, "VotingPower").await?;
    let sa: u128 = allowed
        .values()
        .copied()
        .fold(0, |a, b| a.saturating_add(b));
    let sv: u128 = voting.values().copied().fold(0, |a, b| a.saturating_add(b));
    println!(
		"\ntalk-stake ledger: {} account(s) with posting weight (Σ {}), {} with voting power (Σ {}) — run \
		 `query weight` for the per-account breakdown",
		allowed.len(),
		ada(sa),
		voting.len(),
		ada(sv)
	);

    // Identity bindings (cogno-gate PkhOf).
    println!(
        "\nidentity bindings: {} account(s) bound (cogno-gate)",
        binding_count(&rpc).await?
    );
    Ok(())
}

/// `query weight` — a direct chain query of the talk-stake ledger (posting weight + voting power per
/// account), read over RPC from the on-chain `TalkStake@9` ledger. Reads, never writes.
pub async fn run_weight(ws: &str) -> anyhow::Result<()> {
    let rpc = Rpc::connect(ws).await?;
    let allowed = read_weight_map(&rpc, "AllowedStake").await?;
    let voting = read_weight_map(&rpc, "VotingPower").await?;
    let last_ref = last_reference(&rpc).await?;

    let sa: u128 = allowed
        .values()
        .copied()
        .fold(0, |a, b| a.saturating_add(b));
    let sv: u128 = voting.values().copied().fold(0, |a, b| a.saturating_add(b));
    println!(
        "on-chain talk-stake ledger via {ws} — {} account(s) with posting weight, {} with voting power",
        allowed.len(),
        voting.len()
    );
    match &last_ref {
        Some(r) => println!(
            "last observed Cardano reference: slot {} (block {:#x})",
            r.slot,
            H256::from(r.block_hash)
        ),
        None => println!("last observed Cardano reference: <none yet>"),
    }
    println!("Σ posting weight {}   Σ voting power {}", ada(sa), ada(sv));
    println!();
    println!(
        "{:<52}  {:>22}  {:>22}",
        "account", "posting weight", "voting power"
    );
    // Union of both maps, sorted by posting weight descending, ties by account.
    let accounts: BTreeSet<&AccountId32> = allowed.keys().chain(voting.keys()).collect();
    let mut rows: Vec<_> = accounts.into_iter().collect();
    rows.sort_by(|a, b| {
        let wa = allowed.get(*a).copied().unwrap_or(0);
        let wb = allowed.get(*b).copied().unwrap_or(0);
        wb.cmp(&wa).then((*a).cmp(*b))
    });
    for acct in rows {
        println!(
            "{:<52}  {:>22}  {:>22}",
            ss58(acct),
            ada(allowed.get(acct).copied().unwrap_or(0)),
            ada(voting.get(acct).copied().unwrap_or(0))
        );
    }
    Ok(())
}

/// The 4-byte Aura consensus engine id — the `aura` PreRuntime digest a block author seals into every
/// (non-genesis) header, carrying the `u64` slot the block was produced in.
const AURA_ENGINE_ID: [u8; 4] = *b"aura";

/// Recover the Aura slot from a block header's digest logs: find the `aura` PreRuntime item and decode its
/// payload as the `u64` slot (`Slot` SCALE-encodes as a bare little-endian `u64`). `None` for a header with
/// no such item (the genesis block). This mirrors what the node does on import
/// (`sc_consensus_aura::standalone::find_pre_digest`) but decodes the raw `DigestItem` directly, so the CLI
/// needs no `sc-*`/`sp-consensus-aura` dependency.
fn aura_slot(logs: &[Vec<u8>]) -> Option<u64> {
    for raw in logs {
        if let Ok(DigestItem::PreRuntime(id, data)) = DigestItem::decode(&mut &raw[..]) {
            if id == AURA_ENGINE_ID {
                return u64::decode(&mut &data[..]).ok();
            }
        }
    }
    None
}

/// The block timestamp (`pallet_timestamp::Now`, unix MILLIS) as of `hash`. `0` if absent (pre-first-set).
async fn block_time_ms(rpc: &Rpc, hash: H256) -> anyhow::Result<u64> {
    Ok(rpc
        .storage_decode::<u64>(&storage_prefix("Timestamp", "Now"), Some(hash))
        .await?
        .unwrap_or(0))
}

/// The lowest block number in `[1, tip]` whose timestamp is `>= target_ms` (a `lower_bound` over the
/// monotonically-increasing block times), or `tip + 1` when every block is older than the target. Used to
/// resolve a wall-clock `--from-time`/`--to-time` to a block height by binary search (O(log tip) reads).
async fn first_block_at_or_after(rpc: &Rpc, target_ms: u64, tip: u32) -> anyhow::Result<u32> {
    let (mut lo, mut hi) = (1u32, tip + 1); // hi is exclusive; hi == tip + 1 means "not found"
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let hash = rpc
            .block_hash(mid)
            .await?
            .with_context(|| format!("block {mid} has no hash (chain shorter than tip {tip}?)"))?;
        if block_time_ms(rpc, hash).await? >= target_ms {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

/// `query authors` — tally cogno-chain (Aura) block authors over a range, read over RPC. Each block's
/// author is derived exactly as the node does: the `aura` PreRuntime digest carries the slot, and the author
/// is `Session::Validators[slot % n]` as of that block (the active validator set is index-aligned with the
/// Aura authorities, [`pallet_session`] deriving both from the same queued-keys list). Read-only; needs no
/// runtime support. The range is `[from, to]` block heights; `--from-time`/`--to-time` (unix SECONDS)
/// resolve to heights by binary search. Defaults: `from = 1` (block 0 is genesis, not Aura-authored),
/// `to = the latest finalized block`.
pub async fn run_authors(
    ws: &str,
    from: Option<u32>,
    to: Option<u32>,
    from_time: Option<i64>,
    to_time: Option<i64>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !(from.is_some() && from_time.is_some()),
        "pass at most one of --from / --from-time"
    );
    anyhow::ensure!(
        !(to.is_some() && to_time.is_some()),
        "pass at most one of --to / --to-time"
    );
    let to_ms = |secs: i64| -> anyhow::Result<u64> {
        u64::try_from(secs)
            .ok()
            .and_then(|s| s.checked_mul(1000))
            .context("time (unix seconds) is out of range")
    };

    let rpc = Rpc::connect(ws).await?;
    let tip = rpc.header(rpc.finalized_hash().await?).await?.0;

    // Resolve the [from, to] height window (explicit height > resolved time > default).
    let from = match (from, from_time) {
        (Some(n), _) => n.max(1),
        (None, Some(secs)) => first_block_at_or_after(&rpc, to_ms(secs)?, tip).await?,
        (None, None) => 1,
    };
    let to = match (to, to_time) {
        (Some(n), _) => n,
        // last block at/before the time = (first block strictly after it) − 1.
        (None, Some(secs)) => first_block_at_or_after(&rpc, to_ms(secs)? + 1, tip)
            .await?
            .saturating_sub(1),
        (None, None) => tip,
    };
    anyhow::ensure!(
        from >= 1 && from <= to,
        "empty range: resolved [from={from}, to={to}] (finalized tip is {tip})"
    );

    // Walk the range, deriving each author. Cache the active validator set per session index — it only
    // changes at a session boundary, so a whole session's blocks read `Session::Validators` once.
    let mut counts: BTreeMap<AccountId32, u64> = BTreeMap::new();
    let mut counted: u64 = 0;
    let mut unattributed: u64 = 0;
    let mut last_seen = from.saturating_sub(1);
    let mut cur_session: Option<u32> = None;
    let mut cur_validators: Vec<AccountId32> = Vec::new();

    for n in from..=to {
        let hash = match rpc.block_hash(n).await? {
            Some(h) => h,
            None => break, // walked past the chain tip (an explicit --to beyond the finalized head)
        };
        last_seen = n;
        let (_, logs) = rpc.header(hash).await?;
        let slot = match aura_slot(&logs) {
            Some(s) => s,
            None => {
                unattributed += 1; // genesis / no aura pre-digest
                continue;
            }
        };
        let session = rpc
            .storage_decode::<u32>(&storage_prefix("Session", "CurrentIndex"), Some(hash))
            .await?
            .unwrap_or(0);
        if cur_session != Some(session) {
            cur_validators = rpc
                .storage_decode::<Vec<AccountId32>>(
                    &storage_prefix("Session", "Validators"),
                    Some(hash),
                )
                .await?
                .unwrap_or_default();
            cur_session = Some(session);
        }
        if cur_validators.is_empty() {
            unattributed += 1; // no active validator set to attribute to (should not happen on a live chain)
            continue;
        }
        let idx = (slot % cur_validators.len() as u64) as usize;
        *counts.entry(cur_validators[idx].clone()).or_default() += 1;
        counted += 1;
    }

    println!(
        "block authors over [{from}, {last_seen}] via {ws} — {counted} block(s) attributed to {} author(s) \
         (finalized tip {tip})",
        counts.len()
    );
    if unattributed > 0 {
        println!("  {unattributed} block(s) not attributed (genesis / no Aura pre-digest)");
    }
    println!();
    println!("{:<52}  {:>10}  {:>8}", "validator (author)", "blocks", "share");
    let mut rows: Vec<(&AccountId32, u64)> = counts.iter().map(|(a, c)| (a, *c)).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    for (acct, c) in rows {
        let share = if counted > 0 {
            c as f64 * 100.0 / counted as f64
        } else {
            0.0
        };
        println!("{:<52}  {:>10}  {:>7.2}%", ss58(acct), c, share);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use codec::Encode;

    /// The author-derivation hinge: `aura_slot` must read the slot from the `aura` PreRuntime digest and
    /// ignore every other log — notably the cogno `cobs` anchor (a DIFFERENT PreRuntime engine) and the Aura
    /// `Seal` (same engine id, different digest VARIANT) — returning `None` only for a header with no aura
    /// pre-digest (the genesis block).
    #[test]
    fn aura_slot_reads_the_pre_digest_and_ignores_other_logs() {
        let slot: u64 = 297_198_954;
        let aura = DigestItem::PreRuntime(*b"aura", slot.encode()).encode();
        let cobs = DigestItem::PreRuntime(*b"cobs", vec![1, 2, 3]).encode(); // cogno anchor — not aura
        let seal = DigestItem::Seal(*b"aura", vec![9u8; 64]).encode(); // Seal, not PreRuntime
        assert_eq!(
            aura_slot(&[cobs.clone(), aura, seal.clone()]),
            Some(slot),
            "the aura PreRuntime slot is decoded regardless of surrounding logs"
        );
        assert_eq!(aura_slot(&[cobs, seal]), None, "no aura pre-digest ⇒ None");
        assert_eq!(aura_slot(&[]), None, "genesis (no logs) ⇒ None");
    }
}
