//! Read-only diagnostics behind the `query` group: `query state` (the chain inspector) and `query weight`
//! (the talk-stake ledger view). **Neither writes anything** — there is no talk-stake write path anywhere
//! in the CLI; weight is observer-written only.
//!
//! Both read EXCLUSIVELY from the node over RPC. `query weight` reads the on-chain `TalkStake@9` ledger
//! (`AllowedStake` = posting weight, `VotingPower` = stake-vote weight). That ledger is consensus state
//! (the observe inherent's applier runs in `execute_block` on every node), so it is fully populated on ANY
//! node you can reach — a relay / RPC node is enough.

use std::collections::{BTreeMap, BTreeSet};

use codec::Decode;
use pallet_cardano_observer::CardanoRef;
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
        "on-chain talk-stake ledger via {ws} — {} account(s) with weight",
        allowed.len()
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
