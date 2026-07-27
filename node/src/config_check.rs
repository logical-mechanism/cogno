//! Startup config check, run once at node boot.
//!
//! Reads the consensus-pinned observer config from the runtime (`CardanoObserverApi`, the single source),
//! logs the vault policy + Shelley params, and — if a db-sync URL is set — probes db-sync at a now-derived
//! reference slot. This exercises the node↔runtime single-source AND catches a wrong-network / behind /
//! unreachable db-sync early.
//!
//! It probes ALL FOUR reads the per-block observation performs (vault, voting power, roles, SPO chamber
//! weight), using the same scoping sets and the same shared helpers the consensus path uses. That breadth
//! is the point: an abstain on ANY one of them discards the WHOLE observation, so a read that is broken
//! but unprobed lets the node log a clean boot while the sole writer of Cardano weight is frozen from the
//! first block. Two of the four short-circuit on an empty input set and the log says so explicitly rather
//! than claiming a success the probe did not earn.
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
        }
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
        }
    };
    let ref_slot = match reference_slot(
        now,
        cfg.shelley_start_unix,
        cfg.shelley_start_slot,
        cfg.stability_slots,
    ) {
        Some(s) => s,
        None => {
            log::error!(
                target: LOG,
                "cannot derive a reference slot from now={now} + the pinned Shelley params — DBSYNC_URL may \
                 point at the WRONG network. Skipping the vault probe."
            );
            return;
        }
    };

    // Probe EVERY read the per-block observation performs, not just the vault one. Each is a hard
    // abstain on failure, and an abstain on ANY of them discards the whole observation — so a read that
    // is broken but unprobed produces a clean startup log while the sole writer of Cardano weight is
    // frozen from the first block onward. That is not hypothetical: a column-index slip in the ROLE read
    // did exactly that, and this probe (which then covered only the vault read) reported success.
    //
    // Failures are independent: every probe runs and reports, so one boot shows an operator all of what
    // is wrong rather than only the first thing.
    let mut failures = 0usize;

    match dbsync::read_observation(&url, &vault_hex, ref_slot).await {
        Ok(read) => {
            let anchor = match read.anchor {
                Some((slot, _)) => format!("stable block at slot {slot}"),
                None => "<no stable block ≤ reference>".to_string(),
            };
            if read.tip_slot >= ref_slot {
                log::info!(
                    target: LOG,
                    "✓ vault read: db-sync reachable + synced (tip slot {} ≥ reference slot {ref_slot}); \
                     {} vault UTxO(s) under the pinned policy, {anchor}",
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
        }
        Err(e) => {
            failures += 1;
            log::error!(
                target: LOG,
                "✗ vault read FAILED: {e} — DBSYNC_URL may point at the wrong network, or db-sync is \
                 unreachable / not FULL+tx_in-enabled. The observer will abstain fail-closed."
            );
        }
    }

    // The scoping sets the per-block reads use, read at the same block as the config above.
    let bound_creds = match client.runtime_api().bound_stake_credentials(at) {
        Ok(c) => c,
        Err(e) => {
            log::error!(target: LOG, "bound_stake_credentials runtime API call failed: {e}");
            return;
        }
    };
    let (claimed_calidus, claimed_dreps, _claimed_committee) =
        match client.runtime_api().bound_role_credentials(at) {
            Ok(c) => c,
            Err(e) => {
                log::error!(target: LOG, "bound_role_credentials runtime API call failed: {e}");
                return;
            }
        };

    // Voting power. Short-circuits to Ok(empty) on an empty credential set, so say plainly when the
    // query was NOT actually exercised rather than logging a success it did not earn.
    if bound_creds.is_empty() {
        log::info!(
            target: LOG,
            "· voting-power read: no bound stake credentials yet, so the epoch_stake query short-circuits \
             and was NOT exercised by this probe",
        );
    } else {
        match dbsync::read_stake_observation(&url, &bound_creds, ref_slot, cfg.stake_epoch_lookback)
            .await
        {
            Ok(s) => log::info!(
                target: LOG,
                "✓ voting-power read: {} of {} bound credential(s) carry epoch_stake",
                s.entries.len(),
                bound_creds.len(),
            ),
            Err(e) => {
                failures += 1;
                log::error!(
                    target: LOG,
                    "✗ voting-power (epoch_stake) read FAILED: {e} — the observer will abstain fail-closed \
                     on EVERY block, so no vault lock is credited and no weight is refreshed."
                );
            }
        }
    }

    // Roles. This one has no empty short-circuit — it always queries, so it is always exercised.
    match dbsync::read_role_observation(
        &url,
        ref_slot,
        &bound_creds,
        &claimed_dreps,
        cfg.stake_epoch_lookback,
    )
    .await
    {
        Ok(role_read) => {
            log::info!(
                target: LOG,
                "✓ role read: {} label-867 registration(s), {} active pool(s), {} owner pool(s), {} live \
                 dRep(s)",
                role_read.registrations.len(),
                role_read.active_pools.len(),
                role_read.owner_pools.len(),
                role_read.live_dreps.len(),
            );
            // The one db-sync misconfiguration the in-query probes CANNOT see: a metadata KEY WHITELIST
            // (`insert_options.metadata = {"keys": [721]}`) leaves `tx_metadata` non-empty, so `meta_ok`
            // passes, while every label-867 row is filtered out. The read then succeeds with zero
            // registrations and every Calidus SPO badge is stripped chain-wide. Pools exist but no
            // registration does is the signature; say so here, because nothing downstream can.
            if role_read.registrations.is_empty() && !role_read.active_pools.is_empty() {
                failures += 1;
                log::error!(
                    target: LOG,
                    "✗ role read returned {} active pool(s) but ZERO label-867 registrations. On a live \
                     Cardano network that combination means db-sync is indexing metadata under a KEY \
                     WHITELIST that excludes label 867 (`insert_options.metadata.keys`), which the \
                     in-query `tx_metadata` probe cannot detect. Every Calidus SPO badge will be stripped \
                     and every SPO chamber weight zeroed. Index label 867 (or all labels) and restart.",
                    role_read.active_pools.len(),
                );
            }
            // SPO chamber weight. Its pool set is only knowable AFTER the role read, exactly as on the
            // per-block path — derived through the same shared `claimed_calidus_pools`, so this probe
            // cannot drift from what the reduction scopes.
            let mut pool_id_set: std::collections::BTreeSet<[u8; 28]> = role_read
                .owner_pools
                .iter()
                .map(|(_, pool)| *pool)
                .collect();
            pool_id_set.extend(cogno_dbsync::reduction::claimed_calidus_pools(
                &role_read.registrations,
                &claimed_calidus,
                &role_read.active_pools,
            ));
            let pool_ids: Vec<[u8; 28]> = pool_id_set.into_iter().collect();
            if pool_ids.is_empty() {
                log::info!(
                    target: LOG,
                    "· SPO chamber-weight read: no owned or Calidus-declared pools yet, so the pool_stake \
                     query short-circuits and was NOT exercised by this probe",
                );
            } else {
                match dbsync::read_pool_stake(&url, &pool_ids, ref_slot, cfg.stake_epoch_lookback)
                    .await
                {
                    Ok(s) => log::info!(
                        target: LOG,
                        "✓ SPO chamber-weight read: {} of {} pool(s) carry delegated stake",
                        s.len(),
                        pool_ids.len(),
                    ),
                    Err(e) => {
                        failures += 1;
                        log::error!(
                            target: LOG,
                            "✗ SPO chamber-weight (pool_stake) read FAILED: {e} — the observer will abstain \
                             fail-closed on EVERY block."
                        );
                    }
                }
            }
        }
        Err(e) => {
            failures += 1;
            log::error!(
                target: LOG,
                "✗ role read FAILED: {e} — the observer will abstain fail-closed on EVERY block, so no \
                 vault lock is credited, no weight is refreshed and no role badge is confirmed. The SPO \
                 chamber-weight read was not probed because its pool set comes from this one."
            );
        }
    }

    if failures == 0 {
        log::info!(target: LOG, "✓ all db-sync reads the observation depends on are working");
    } else {
        log::error!(
            target: LOG,
            "{failures} of the db-sync reads the observation depends on FAILED — this node will abstain on \
             every block until they are fixed. Cardano weight, voting power and role badges are all frozen; \
             watch `cogno_observer_abstains_total` and the ObservationStalled alarm.",
        );
    }
}
