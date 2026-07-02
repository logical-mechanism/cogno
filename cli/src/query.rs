//! Read-only diagnostics behind the `query` group: `query state` (the chain inspector) and `query weight`
//! (the talk-stake ledger view + an optional db-sync cross-check). **Neither writes anything** — there is
//! no talk-stake write path anywhere in the CLI; weight is observer-written only.
//!
//! `query weight` defaults to a **direct chain query** — it reads the on-chain `TalkStake@9` ledger
//! (`AllowedStake` = posting weight, `VotingPower` = stake-vote weight) over RPC. That ledger is consensus
//! state (the observe inherent's applier runs in `execute_block` on every node), so it is fully populated
//! on ANY node you can reach — a relay / RPC node with no db-sync.
//!
//! Passing `--dbsync <url>` adds an **opt-in cross-check** (operator-only): re-derive the vault weight from
//! Cardano with the SHARED reducer **at the exact slot the chain last observed**
//! (`CardanoObserver::LastReference`) and compare it to the on-chain `AllowedStake` ledger byte-for-byte. A
//! divergence at the same reference slot is a real problem (the CLI's manual analog of `check_inherent` —
//! the Rust replacement for the retired `shadow-diff.mjs`).

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Context;
use codec::Decode;
use cogno_dbsync::dbsync;
use cogno_dbsync::reduction::{self, hex_encode};
use pallet_cardano_observer::{CardanoRef, ObserverConfig};
use sp_core::hashing::blake2_128;
use sp_core::H256;
use sp_runtime::AccountId32;

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
		if let Ok(w) = u128::decode(&mut &val[..]) {
			out.insert(AccountId32::new(a), w);
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
	rpc.storage_decode(&storage_prefix("CardanoObserver", "LastReference"), None).await
}

/// The observer enforcement flag (`CardanoObserver::EnforceWeight`, default `true`). `true` ⇒ the verified
/// observation writes weight (the sole-writer mode); `false` ⇒ weight is FROZEN (emergency governance revert).
async fn enforce_weight(rpc: &Rpc) -> anyhow::Result<bool> {
	Ok(rpc
		.storage_decode::<bool>(&storage_prefix("CardanoObserver", "EnforceWeight"), None)
		.await?
		.unwrap_or(true))
}

/// Fetch the consensus-pinned `ObserverConfig` FROM THE CHAIN via the `CardanoObserverApi` runtime API
/// (never hardcoded — so the cross-check scans exactly the chain's target vault policy).
pub async fn observer_config(rpc: &Rpc) -> anyhow::Result<ObserverConfig> {
	let bytes = rpc
		.state_call("CardanoObserverApi_observer_config", &[], None)
		.await
		.context("fetching observer config via runtime API")?;
	ObserverConfig::decode(&mut &bytes[..]).context("decoding ObserverConfig")
}

/// Resolve a 32-byte Cardano beacon (the cogno-gate `AccountOf` key) → its bound account, or `None`.
async fn beacon_account(rpc: &Rpc, beacon: &[u8; 32]) -> anyhow::Result<Option<AccountId32>> {
	let mut key = storage_prefix("CognoGate", "AccountOf");
	key.extend_from_slice(&blake2_128(beacon));
	key.extend_from_slice(beacon);
	rpc.storage_decode::<AccountId32>(&key, None).await
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
		if enforce { "ON — crediting weight" } else { "FROZEN (set_enforcement false)" }
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
	let sa: u128 = allowed.values().copied().fold(0, |a, b| a.saturating_add(b));
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
	println!("\nidentity bindings: {} account(s) bound (cogno-gate)", binding_count(&rpc).await?);
	Ok(())
}

/// `query weight` — default: a direct chain query of the talk-stake ledger (posting weight + voting power
/// per account). With `--dbsync`: also re-derive the vault weight from Cardano at the chain's last-observed
/// slot and cross-check it against the on-chain `AllowedStake` ledger.
pub async fn run_weight(ws: &str, dbsync: Option<&str>, reference: Option<u64>) -> anyhow::Result<()> {
	let rpc = Rpc::connect(ws).await?;
	let allowed = read_weight_map(&rpc, "AllowedStake").await?;
	let voting = read_weight_map(&rpc, "VotingPower").await?;
	let last_ref = last_reference(&rpc).await?;

	let sa: u128 = allowed.values().copied().fold(0, |a, b| a.saturating_add(b));
	let sv: u128 = voting.values().copied().fold(0, |a, b| a.saturating_add(b));
	println!("on-chain talk-stake ledger via {ws} — {} account(s) with weight", allowed.len());
	match &last_ref {
		Some(r) => println!("last observed Cardano reference: slot {} (block {:#x})", r.slot, H256::from(r.block_hash)),
		None => println!("last observed Cardano reference: <none yet>"),
	}
	println!("Σ posting weight {}   Σ voting power {}", ada(sa), ada(sv));
	println!();
	println!("{:<52}  {:>22}  {:>22}", "account", "posting weight", "voting power");
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

	// ── Opt-in cross-check (operator-only): re-derive the vault weight from Cardano + compare AllowedStake.
	if let Some(url) = dbsync {
		let ref_slot = reference.or(last_ref.as_ref().map(|r| r.slot)).context(
			"the chain has no LastReference yet and no --reference was given; pass --reference <slot>",
		)?;
		println!();
		println!("cross-check vs db-sync as-of reference slot {ref_slot}:");
		let derived = dbsync_allowed_stake(&rpc, url, ref_slot).await?;
		println!("  re-derived {} bound vault weight(s) from Cardano", derived.len());
		cross_check(&allowed, &derived)?;
	}
	Ok(())
}

/// Re-derive the per-account posting weight (`AllowedStake`) from db-sync as-of `ref_slot`, with the SHARED
/// reducer — exactly what the node IDP feeds the inherent: read the vault matches, reduce to the canonical
/// per-beacon largest-wins weight, and resolve each beacon → its bound account (cogno-gate `AccountOf`), so
/// an unbound beacon contributes nothing (as the observer credits weight only to bound accounts).
async fn dbsync_allowed_stake(
	rpc: &Rpc,
	dbsync_url: &str,
	ref_slot: u64,
) -> anyhow::Result<BTreeMap<AccountId32, u128>> {
	let cfg = observer_config(rpc).await?;
	let vault_hex = hex_encode(&cfg.vault_policy_id);
	let read = dbsync::read_observation(dbsync_url, &vault_hex, ref_slot)
		.await
		.map_err(|e| anyhow::anyhow!("db-sync observation read failed: {e}"))?;
	// The stable-block anchor only affects the sealed reference, not the vault entries; a zero hash is fine
	// for the read-only weight re-derivation. `build_observation` runs the canonical largest-wins reduction.
	let block_hash = read.anchor.map(|(_, h)| h).unwrap_or([0u8; 32]);
	let reference = CardanoRef { slot: ref_slot, block_hash };
	let obs = reduction::build_observation(reference, &read.matches, &vault_hex, Vec::new());
	let mut out = BTreeMap::new();
	for (beacon, weight) in obs.entries {
		if let Some(account) = beacon_account(rpc, &beacon).await? {
			// Impossible dup (two beacons → one account) would last-write-win; the observer credits per
			// resolved account, so accumulate defensively.
			let e = out.entry(account).or_insert(0u128);
			*e = (*e).saturating_add(weight);
		}
	}
	Ok(out)
}

/// Compare the on-chain `AllowedStake` ledger against the db-sync re-derivation (both at the same reference
/// slot, so an exact match is expected). Prints per-account divergence and returns an error (non-zero exit)
/// if ANY account differs — the CLI's manual analog of the node's `check_inherent`.
fn cross_check(
	chain: &BTreeMap<AccountId32, u128>,
	derived: &BTreeMap<AccountId32, u128>,
) -> anyhow::Result<()> {
	let keys: BTreeSet<&AccountId32> = chain.keys().chain(derived.keys()).collect();
	let mut diverged = 0usize;
	let mut matched = 0usize;
	for k in keys {
		match (chain.get(k), derived.get(k)) {
			(Some(c), Some(d)) if c == d => matched += 1,
			(c, d) => {
				diverged += 1;
				println!(
					"  ✗ {} DIVERGES — chain={} | cardano={}",
					ss58(k),
					c.map(|v| ada(*v)).unwrap_or_else(|| "<absent>".into()),
					d.map(|v| ada(*v)).unwrap_or_else(|| "<absent>".into()),
				);
			},
		}
	}
	if diverged == 0 {
		println!("  ✓ {matched}/{matched} account(s) match the on-chain ledger exactly");
		Ok(())
	} else {
		anyhow::bail!(
			"cross-check FAILED: {diverged} account(s) diverge between the chain ledger and the db-sync \
			 re-derivation at this reference slot (matched {matched}). The chain observation and your db-sync \
			 disagree — check that db-sync is synced to the right network and is FULL/tx_in-enabled."
		)
	}
}
