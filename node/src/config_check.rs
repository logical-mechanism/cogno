//! Startup config check, run once at node boot.
//!
//! Reads the consensus-pinned observer config from the runtime (`CardanoObserverApi`, the single source),
//! logs the vault policy + Shelley params, and — if a db-sync URL is set — probes db-sync at a now-derived
//! reference slot: it confirms db-sync is reachable and synced (its tip is at/after the reference slot) and
//! reports how many `talk_vault` UTxOs it can see under the pinned policy. This exercises the node↔runtime
//! single-source AND catches a wrong-network / behind / unreachable db-sync early.
//!
//! Read-only and non-blocking: it logs only and never gates block production — the chain produces +
//! finalizes regardless of the outcome of this check. Lighter than a reference-datum check because cogno
//! observes ONE vault policy (there is no reference UTxO / on-chain contract-hash mirror).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use cogno_chain_runtime::opaque::Block;
use cogno_dbsync::dbsync;
use cogno_dbsync::reduction::{hex_encode, reference_slot};
use pallet_cardano_observer::CardanoObserverApi;
use sp_api::ProvideRuntimeApi;
use sp_blockchain::HeaderBackend;

const LOG: &str = "cogno-config-check";

/// Run the one-shot observer-config check. `DBSYNC_URL` (or `DBSYNC`) unset ⇒ log the config + skip the
/// live probe (the chain still produces blocks).
pub async fn run<C>(client: Arc<C>)
where
	C: ProvideRuntimeApi<Block> + HeaderBackend<Block> + Send + Sync + 'static,
	C::Api: CardanoObserverApi<Block>,
{
	let at = client.info().best_hash;
	let cfg = match client.runtime_api().observer_config(at) {
		Ok(c) => c,
		Err(e) => {
			log::error!(target: LOG, "observer_config runtime API call failed: {e}");
			return;
		},
	};
	let vault_hex = hex_encode(&cfg.vault_policy_id);
	log::info!(
		target: LOG,
		"observer config (consensus-pinned): vault policy = {vault_hex}, Shelley start unix/slot = {}/{}, \
		 stability window = {} slots, stake epoch lookback = {}",
		cfg.shelley_start_unix,
		cfg.shelley_start_slot,
		cfg.stability_slots,
		cfg.stake_epoch_lookback,
	);

	let url = std::env::var("DBSYNC_URL")
		.or_else(|_| std::env::var("DBSYNC"))
		.unwrap_or_default();
	if url.is_empty() {
		log::warn!(
			target: LOG,
			"no DBSYNC_URL/DBSYNC set — skipping the live vault probe (the chain still produces + finalizes \
			 blocks; the observer will abstain fail-closed until db-sync is configured)"
		);
		return;
	}

	// A now-derived reference slot (this is a node-local diagnostic, NOT the consensus reference — which is
	// parent-block-time-derived). `None` ⇒ pre-Shelley / underflow (a wrong network); skip the probe.
	let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
		Ok(d) => d.as_secs(),
		Err(e) => {
			log::error!(target: LOG, "system clock before UNIX_EPOCH: {e}");
			return;
		},
	};
	let ref_slot = match reference_slot(now, cfg.shelley_start_unix, cfg.shelley_start_slot, cfg.stability_slots) {
		Some(s) => s,
		None => {
			log::error!(
				target: LOG,
				"cannot derive a reference slot from now={now} + the pinned Shelley params — DBSYNC_URL may \
				 point at the WRONG network. Skipping the vault probe."
			);
			return;
		},
	};

	match dbsync::read_observation(&url, &vault_hex, ref_slot).await {
		Ok(read) => {
			let anchor = match read.anchor {
				Some((slot, _)) => format!("stable block at slot {slot}"),
				None => "<no stable block ≤ reference>".to_string(),
			};
			if read.tip_slot >= ref_slot {
				log::info!(
					target: LOG,
					"✓ db-sync reachable + synced (tip slot {} ≥ reference slot {ref_slot}); {} vault UTxO(s) \
					 under the pinned policy, {anchor}",
					read.tip_slot,
					read.matches.len(),
				);
			} else {
				log::warn!(
					target: LOG,
					"db-sync reachable but BEHIND (tip slot {} < reference slot {ref_slot}) — the observer \
					 will abstain fail-closed until it catches up",
					read.tip_slot,
				);
			}
		},
		Err(e) => log::error!(
			target: LOG,
			"live vault probe FAILED: {e} — DBSYNC_URL may point at the wrong network, or db-sync is \
			 unreachable / not FULL+tx_in-enabled. The observer will abstain fail-closed."
		),
	}
}
