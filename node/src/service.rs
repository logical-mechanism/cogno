//! Service and ServiceFactory implementation. Specialized wrapper over substrate service.

use cogno_chain_runtime::{self, apis::RuntimeApi, opaque::Block};
use futures::FutureExt;
use sc_client_api::{Backend, BlockBackend};
use sc_consensus_aura::{ImportQueueParams, SlotProportion, StartAuraParams};
use sc_consensus_grandpa::{GrandpaPruningFilter, SharedVoterState};
use sc_service::{error::Error as ServiceError, Configuration, TaskManager, WarpSyncConfig};
use sc_telemetry::{Telemetry, TelemetryWorker};
use sc_transaction_pool_api::OffchainTransactionPoolFactory;
use sp_consensus_aura::sr25519::AuthorityPair as AuraPair;
use std::{sync::Arc, time::Duration};
// in-protocol-observation (D4): the node-side Cardano-observation InherentDataProvider wiring. The
// deterministic db-sync read + the pure reduction now live in the shared `cogno-dbsync` crate — the node
// (writer) and the cogno-chain-cli (read-only diagnostic) go through byte-identical code.
use crate::cardano_observer::CardanoObservationInherentDataProvider;
use cogno_dbsync::dbsync;
use cogno_dbsync::reduction::{
    build_observation, hex_encode, reduce_role_observation, reference_slot,
};
use pallet_cardano_observer::{CardanoObservation, CardanoObserverApi, CardanoRef};
use sp_api::ProvideRuntimeApi;
use sp_runtime::traits::Block as BlockT;

pub(crate) type FullClient = sc_service::TFullClient<
    Block,
    RuntimeApi,
    sc_executor::WasmExecutor<sp_io::SubstrateHostFunctions>,
>;
type FullBackend = sc_service::TFullBackend<Block>;
type FullSelectChain = sc_consensus::LongestChain<FullBackend, Block>;

/// Build the node-side Cardano-observation `InherentDataProvider` for a block whose parent is `parent`
/// (in-protocol-observation, D4). Thin wrapper over [`observe_for_parent`] that records exactly one
/// Sweep length (in blocks) at which the credential scan's coverage latency becomes worth a WARN. At a
/// 6 s block that is ~10 minutes: the longest a fresh bind can wait before it is credited, and the
/// staleness ceiling on a chamber weight a `close_poll` freezes.
///
/// Not a correctness bound. Since spec 220 nothing is ever dropped from the scan, so there is nothing to
/// lose by sweeping slowly — only a wait to feel. Raising `MaxScanned` is the lever; it costs db-sync
/// query time per block and buys sweep time.
const SWEEP_WARN_BLOCKS: u64 = 100;

/// Sweep length at which it is an ERROR: ~2 hours at a 6 s block. Past here a new user's "your votes
/// will carry weight shortly" is not true in any useful sense, and a governance poll can freeze chamber
/// weights that old.
const SWEEP_ERROR_BLOCKS: u64 = 1_200;

/// observation/abstain into the observer-liveness metrics (authoring path only — those gauges track THIS
/// node's own AUTHORED observations) and wraps the result. Used by BOTH the import and authoring CIDPs; the
/// import path passes `None` for `metrics`.
async fn build_cardano_idp(
    client: Arc<FullClient>,
    parent: <Block as BlockT>::Hash,
    metrics: Option<Arc<crate::metrics::ObserverMetrics>>,
) -> CardanoObservationInherentDataProvider {
    match observe_for_parent(client, parent).await {
        Some((obs, max_scanned, scanned, sweep_blocks, dbsync_tip_slot, lag_slots)) => {
            // Alarm on COVERAGE LATENCY, not on the scan being full.
            //
            // ⚠ THIS INVERTED IN SPEC 220 and the old rule would now fire continuously. Until then the
            // scan was a hash-ordered PREFIX of the ledger, so "the scan is at MaxScanned" meant
            // credentials past it were being silently dropped — a real, per-identity omission worth an
            // ERROR. The scan is a rotating WINDOW now: on any chain larger than one window every
            // healthy block fills it exactly, so `scanned >= max_scanned` describes the normal state and
            // an alarm on it would page forever with text that is simply false. That is the
            // alert-fatigue failure this file already documents as its reason for excluding Committee.
            //
            // Nothing is dropped any more, so there is no omission left to alarm on. What can still
            // degrade is how LONG a full sweep takes — which is how long a new binder waits to be
            // credited, and how stale a chamber weight can be when `close_poll` freezes it. The runtime
            // reports that directly as `scan_sweep_blocks`; 1 means the whole ledger fits in one window.
            //
            // Fires on the import path too (metrics is None there) so any node warns.
            if sweep_blocks >= SWEEP_ERROR_BLOCKS {
                log::error!(
                    target: "cardano-observer",
                    "the credential scan takes {sweep_blocks} blocks (~{} minutes) to sweep the whole ledger: a new bind waits that long to be credited, and a governance poll closed in that window freezes chamber weights up to that stale. Raise MaxScanned (governed upgrade) or prune the ledger — see docs/IN-PROTOCOL-OBSERVATION.md",
                    sweep_blocks.saturating_mul(6) / 60,
                );
            } else if sweep_blocks >= SWEEP_WARN_BLOCKS {
                log::warn!(
                    target: "cardano-observer",
                    "the credential scan takes {sweep_blocks} blocks (~{} minutes) to sweep the whole ledger, and the wait grows with the population. Raise MaxScanned before it is felt",
                    sweep_blocks.saturating_mul(6) / 60,
                );
            }
            if let Some(m) = &metrics {
                m.record_observation(
                    obs.reference.slot,
                    dbsync_tip_slot,
                    lag_slots,
                    obs.entries.len(),
                    obs.stake_entries.len(),
                    obs.role_entries.len(),
                );
                m.set_scan(scanned, max_scanned, sweep_blocks);
            }
            CardanoObservationInherentDataProvider {
                observation: Some(obs),
            }
        }
        None => {
            if let Some(m) = &metrics {
                m.record_abstain();
            }
            CardanoObservationInherentDataProvider { observation: None }
        }
    }
}

/// The deterministic observation read — returns `Some(observation)` or `None` to ABSTAIN (fail-closed at
/// every step). Reads the consensus-pinned config via the `CardanoObserverApi` runtime API (single source
/// of truth — node + runtime can't drift), derives the stable reference slot from the PARENT block's Aura
/// slot (so author + every importer agree), and reads THIS node's own db-sync as-of that slot
/// (ONE consistent snapshot: freshness tip + the deterministic stable-block anchor + the vault UTxOs). Any
/// error (API / header / db-sync down or behind) ⇒ `None` — the author abstains (no inherent; the chain
/// stays live) and an importer that can't read defers-accepts via the runtime's `CannotVerify` path.
async fn observe_for_parent(
    client: Arc<FullClient>,
    parent: <Block as BlockT>::Hash,
) -> Option<(CardanoObservation, u32, u32, u64, u64, u64)> {
    // 1. consensus-pinned config (anchors, stability window, vault policy id, MaxScanned cap).
    let config = match client.runtime_api().observer_config(parent) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(target: "cardano-observer", "observer_config runtime API failed: {e:?} — abstaining");
            return None;
        }
    };
    // The credential-scan cap, surfaced to the caller so it can alarm as the scanned sets approach it.
    let max_scanned = config.max_scanned;
    let sweep_blocks = config.scan_sweep_blocks;
    // 2. parent block's Aura slot → canonical unix time (slot × SLOT_DURATION). Genesis ⇒ slot 0 ⇒
    //    pre-Shelley ⇒ abstain.
    let header = match client.header(parent) {
        Ok(Some(h)) => h,
        _ => return None,
    };
    let parent_slot = match sc_consensus_aura::standalone::find_pre_digest::<
        Block,
        sp_consensus_aura::sr25519::AuthoritySignature,
    >(&header)
    {
        Ok(s) => s,
        Err(_) => return None,
    };
    let parent_unix_s =
        u64::from(parent_slot).saturating_mul(cogno_chain_runtime::SLOT_DURATION / 1000);
    // 3. the deterministic reference slot (fail-closed: pre-Shelley / underflow ⇒ None).
    let ref_slot = match reference_slot(
        parent_unix_s,
        config.shelley_start_unix,
        config.shelley_start_slot,
        config.stability_slots,
    ) {
        Some(r) => r,
        None => return None,
    };
    let dbsync_url = std::env::var("DBSYNC_URL")
        .or_else(|_| std::env::var("DBSYNC"))
        .unwrap_or_default();
    if dbsync_url.is_empty() {
        log::warn!(target: "cardano-observer", "no DBSYNC_URL/DBSYNC set — abstaining (empty observation)");
        return None;
    }
    let vault_hex = hex_encode(&config.vault_policy_id);
    // 4. ONE consistent-snapshot db-sync read: freshness tip + the deterministic stable-block anchor + the
    //    vault matches. A single MVCC snapshot, so the tip/anchor/matches cannot diverge across an
    //    inter-call rollback (one atomic view).
    let read = match dbsync::read_observation(&dbsync_url, &vault_hex, ref_slot).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!(target: "cardano-observer", "db-sync read failed: {e} — abstaining (empty observation)");
            return None;
        }
    };
    // 4a. point-existence guard: only trust the read if THIS node's db-sync has indexed PAST the
    //     reference. A behind db-sync must ABSTAIN (→ the runtime's CannotVerify accept/defer path) rather
    //     than return a partial UTxO set that would trigger a FALSE fatal Mismatch on import.
    if read.tip_slot < ref_slot {
        log::debug!(
            target: "cardano-observer",
            "db-sync tip slot {} < reference {ref_slot} — source behind, abstaining (defer/CannotVerify)",
            read.tip_slot,
        );
        return None;
    }
    // 4b. the SEALED stable block-hash anchor: the
    //     header hash of the latest stable Cardano block AT/UNDER the reference — the single `block` row at
    //     max `slot_no ≤ reference` (deterministic: ≤1 block/slot on settled history). It becomes
    //     `CardanoRef.block_hash` — the custom proposer seals it into the block header (`cobs` digest) and
    //     `check_inherent` re-validates it cross-node. The tip is past the reference (guard above), so an
    //     anchor ≤ reference exists except at genesis depth ⇒ abstain rather than seal a degenerate hash.
    let anchor_hash = match read.anchor {
        Some((_, hash)) => hash,
        None => {
            log::debug!(
                target: "cardano-observer",
                "no db-sync block at/under reference {ref_slot} (tip {}) — abstaining (defer/CannotVerify)",
                read.tip_slot,
            );
            return None;
        }
    };
    // 5. the VOTING-POWER (epoch_stake) read: the bound stake credentials (from the parent block's state,
    //    deterministic) + their total Cardano stake at the as-of epoch. Same fail-closed discipline as the
    //    vault read: a db-sync error / an unpopulated target epoch ⇒ abstain, so the author never emits a
    //    partial voting-power set (and a behind importer defers via CannotVerify).
    let bound_creds = match client.runtime_api().bound_stake_credentials(parent) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(target: "cardano-observer", "bound_stake_credentials runtime API failed: {e:?} — abstaining");
            return None;
        }
    };
    let stake_entries = match dbsync::read_stake_observation(
        &dbsync_url,
        &bound_creds,
        ref_slot,
        config.stake_epoch_lookback,
    )
    .await
    {
        Ok(s) => s.entries,
        Err(e) => {
            log::warn!(target: "cardano-observer", "db-sync epoch_stake read failed: {e} — abstaining (empty observation)");
            return None;
        }
    };
    // 5b. the ROLE read: the claimed role credentials (parent state) scope the reduction; the SQL returns
    //     the raw label-867 registrations + active pools + the bound stake set's pool ownerships (SPO), and
    //     the CLAIMED, currently-live key-based dReps (`claimed_dreps` → the dRep liveness join runs in-DB).
    //     Same fail-closed discipline: any error ⇒ abstain. (`_claimed_committee` awaits Phase C.)
    let (claimed_calidus, claimed_dreps, _claimed_committee) = match client
        .runtime_api()
        .bound_role_credentials(parent)
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!(target: "cardano-observer", "bound_role_credentials runtime API failed: {e:?} — abstaining");
            return None;
        }
    };
    // The largest of the INDEPENDENTLY-CAPPED credential scans that actually scope a db-sync query. This
    // is the quantity `MaxScanned` bounds, and it has to be captured HERE because it is an INPUT: by the
    // time the observation exists the scan has already been truncated and the evidence is gone.
    //
    // Measuring the observation instead is wrong in both directions. `stake_entries` is strictly SMALLER
    // than the scanned set (the SQL returns rows only for credentials holding stake at the as-of epoch, so
    // a bound-but-undelegated key is simply absent), which hides a real truncation; and `role_entries` is
    // one-to-MANY per credential — one entry per declaring or owned pool — so it can run far past the cap
    // with no truncation having happened at all.
    //
    // ⚠ `_claimed_committee` is deliberately EXCLUDED until Phase C wires its reduction. Nothing reads it,
    // so a credential past the cap there costs nobody anything — but `RoleCredIndex[Committee]` grows via
    // the feeless bare-unsigned `claim_role_signed`, whose CC proof is self-generated and consults no
    // Cardano state. Folding it in would let anyone pin `scanned` at the cap for ever: a per-block ERROR
    // log and a permanently-firing `ObserverScanCapped` page whose text ("no voting power, no role badge")
    // would be false, training the operator to ignore the alarm that fires when a scan really is capped.
    let scanned = bound_creds
        .len()
        .max(claimed_calidus.len())
        .max(claimed_dreps.len()) as u32;
    let role_read = match dbsync::read_role_observation(
        &dbsync_url,
        ref_slot,
        &bound_creds,
        &claimed_dreps,
        config.stake_epoch_lookback,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!(target: "cardano-observer", "db-sync role read failed: {e} — abstaining (empty observation)");
            return None;
        }
    };
    // 5c. the SPO chamber weight (`pool_stake`): the pools that OWN a bound stake credential PLUS the pools
    //     whose cold key declared a CLAIMED Calidus key. This set is only knowable AFTER the role read
    //     returns the registrations (Calidus→pool lives in the label-867 CBOR), so it can't be a column of
    //     that query. The Calidus half is derived by `cogno_dbsync::reduction::claimed_calidus_pools` — the
    //     SAME definition the reduction restricts its witness verification to, shared so the scope here can
    //     never drift below what the reduction emits (a narrower scope would silently zero a Calidus SPO's
    //     chamber weight). Union into a `BTreeSet` (sorted + deduped ⇒ byte-deterministic query input), then
    //     read their delegated stake scoped to that set. Same fail-closed discipline: any error ⇒ abstain.
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
    let pool_stake = match dbsync::read_pool_stake(
        &dbsync_url,
        &pool_ids,
        ref_slot,
        config.stake_epoch_lookback,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            log::warn!(target: "cardano-observer", "db-sync pool_stake read failed: {e} — abstaining (empty observation)");
            return None;
        }
    };
    let role_entries = reduce_role_observation(
        &role_read.registrations,
        &role_read.active_pools,
        &role_read.owner_pools,
        &claimed_calidus,
        &role_read.live_dreps,
        &pool_stake,
        &role_read.drep_stake,
    );
    // 6. reduce the db-sync matches (canonical largest-wins-per-beacon) + canonicalize the stake + role sets.
    let obs = build_observation(
        CardanoRef {
            slot: ref_slot,
            block_hash: anchor_hash,
        },
        &read.matches,
        &vault_hex,
        stake_entries,
        role_entries,
    );
    log::debug!(
        target: "cardano-observer",
        "observed {} vault + {} stake + {} role entrie(s) as-of slot {} ({} unspent-as-of-ref db-sync match(es), {} bound cred(s), {} registration(s), anchor block {})",
        obs.entries.len(), obs.stake_entries.len(), obs.role_entries.len(), ref_slot, read.matches.len(), bound_creds.len(), role_read.registrations.len(), hex_encode(&anchor_hash),
    );
    // observer freshness: how far this node's db-sync tip trails the current (parent-derived) Cardano
    // slot. `ref_slot + StabilitySlots` reconstructs that current slot (reference_slot subtracted it);
    // the read already passed `tip >= ref` (§4a), so this lag is 0..=StabilitySlots on the landed path.
    let dbsync_tip_slot = read.tip_slot;
    let lag_slots = ref_slot
        .saturating_add(config.stability_slots)
        .saturating_sub(dbsync_tip_slot);
    Some((
        obs,
        max_scanned,
        scanned,
        sweep_blocks,
        dbsync_tip_slot,
        lag_slots,
    ))
}

/// The minimum period of blocks on which justifications will be
/// imported and generated.
const GRANDPA_JUSTIFICATION_PERIOD: u32 = 512;

pub type Service = sc_service::PartialComponents<
    FullClient,
    FullBackend,
    FullSelectChain,
    sc_consensus::DefaultImportQueue<Block>,
    sc_transaction_pool::TransactionPoolHandle<Block, FullClient>,
    (
        sc_consensus_grandpa::GrandpaBlockImport<FullBackend, Block, FullClient, FullSelectChain>,
        sc_consensus_grandpa::LinkHalf<Block, FullClient, FullSelectChain>,
        Option<Telemetry>,
    ),
>;

pub fn new_partial(config: &Configuration) -> Result<Service, ServiceError> {
    let telemetry = config
        .telemetry_endpoints
        .clone()
        .filter(|x| !x.is_empty())
        .map(|endpoints| -> Result<_, sc_telemetry::Error> {
            let worker = TelemetryWorker::new(16)?;
            let telemetry = worker.handle().new_telemetry(endpoints);
            Ok((worker, telemetry))
        })
        .transpose()?;

    let executor = sc_service::new_wasm_executor::<sp_io::SubstrateHostFunctions>(&config.executor);

    let (client, backend, keystore_container, task_manager) =
        sc_service::new_full_parts::<Block, RuntimeApi, _>(
            config,
            telemetry.as_ref().map(|(_, telemetry)| telemetry.handle()),
            executor,
            vec![Arc::new(GrandpaPruningFilter)],
        )?;
    let client = Arc::new(client);

    let telemetry = telemetry.map(|(worker, telemetry)| {
        task_manager
            .spawn_handle()
            .spawn("telemetry", None, worker.run());
        telemetry
    });

    let select_chain = sc_consensus::LongestChain::new(backend.clone());

    let transaction_pool = Arc::from(
        sc_transaction_pool::Builder::new(
            task_manager.spawn_essential_handle(),
            client.clone(),
            config.role.is_authority().into(),
        )
        .with_options(config.transaction_pool.clone())
        .with_prometheus(config.prometheus_registry())
        .build(),
    );

    let (grandpa_block_import, grandpa_link) = sc_consensus_grandpa::block_import(
        client.clone(),
        GRANDPA_JUSTIFICATION_PERIOD,
        &client,
        select_chain.clone(),
        telemetry.as_ref().map(|x| x.handle()),
    )?;

    let cidp_client = client.clone();
    let import_queue =
        sc_consensus_aura::import_queue::<AuraPair, _, _, _, _, _>(ImportQueueParams {
            block_import: grandpa_block_import.clone(),
            justification_import: Some(Box::new(grandpa_block_import.clone())),
            client: client.clone(),
            create_inherent_data_providers: move |parent_hash, _| {
                let cidp_client = cidp_client.clone();
                async move {
                    let slot_duration = sc_consensus_aura::standalone::slot_duration_at(
                        &*cidp_client,
                        parent_hash,
                    )?;
                    let timestamp = sp_timestamp::InherentDataProvider::from_system_time();

                    let slot =
						sp_consensus_aura::inherents::InherentDataProvider::from_timestamp_and_slot_duration(
							*timestamp,
							slot_duration,
						);

                    // D4: the importer re-derives its OWN Cardano observation at the parent-derived
                    // reference; the runtime's check_inherent compares it to the author's. No metrics on the
                    // import path — the observer-liveness gauges track THIS node's own AUTHORED observations.
                    let cardano = build_cardano_idp(cidp_client.clone(), parent_hash, None).await;

                    Ok((slot, timestamp, cardano))
                }
            },
            spawner: &task_manager.spawn_essential_handle(),
            registry: config.prometheus_registry(),
            check_for_equivocation: Default::default(),
            telemetry: telemetry.as_ref().map(|x| x.handle()),
            compatibility_mode: Default::default(),
        })?;

    Ok(sc_service::PartialComponents {
        client,
        backend,
        task_manager,
        import_queue,
        keystore_container,
        select_chain,
        transaction_pool,
        other: (grandpa_block_import, grandpa_link, telemetry),
    })
}

/// Builds a new service for a full client.
pub fn new_full<
    N: sc_network::NetworkBackend<Block, <Block as sp_runtime::traits::Block>::Hash>,
>(
    config: Configuration,
) -> Result<TaskManager, ServiceError> {
    let sc_service::PartialComponents {
        client,
        backend,
        mut task_manager,
        import_queue,
        keystore_container,
        select_chain,
        transaction_pool,
        other: (block_import, grandpa_link, mut telemetry),
    } = new_partial(&config)?;

    // A one-shot, non-blocking startup config check — read the consensus-pinned observer
    // config from the runtime + (if DBSYNC_URL is set) probe db-sync for the vault under the pinned policy.
    // Logs only; never gates authoring (the chain produces + finalizes regardless of the outcome).
    task_manager.spawn_handle().spawn(
        "cogno-config-check",
        None,
        crate::config_check::run(client.clone()),
    );

    let mut net_config = sc_network::config::FullNetworkConfiguration::<
        Block,
        <Block as sp_runtime::traits::Block>::Hash,
        N,
    >::new(&config.network, config.prometheus_registry().cloned());
    let metrics = N::register_notification_metrics(config.prometheus_registry());

    let peer_store_handle = net_config.peer_store_handle();
    let grandpa_protocol_name = sc_consensus_grandpa::protocol_standard_name(
        &client
            .block_hash(0)
            .ok()
            .flatten()
            .expect("Genesis block exists; qed"),
        &config.chain_spec,
    );
    let (grandpa_protocol_config, grandpa_notification_service) =
        sc_consensus_grandpa::grandpa_peers_set_config::<_, N>(
            grandpa_protocol_name.clone(),
            metrics.clone(),
            peer_store_handle,
        );
    net_config.add_notification_protocol(grandpa_protocol_config);

    let warp_sync = Arc::new(sc_consensus_grandpa::warp_proof::NetworkProvider::new(
        backend.clone(),
        grandpa_link.shared_authority_set().clone(),
        Vec::default(),
    ));

    let (network, system_rpc_tx, tx_handler_controller, sync_service) =
        sc_service::build_network(sc_service::BuildNetworkParams {
            config: &config,
            net_config,
            client: client.clone(),
            transaction_pool: transaction_pool.clone(),
            spawn_handle: task_manager.spawn_handle(),
            spawn_essential_handle: task_manager.spawn_essential_handle(),
            import_queue,
            block_announce_validator_builder: None,
            warp_sync_config: Some(WarpSyncConfig::WithProvider(warp_sync)),
            block_relay: None,
            metrics,
        })?;

    if config.offchain_worker.enabled {
        let offchain_workers =
            sc_offchain::OffchainWorkers::new(sc_offchain::OffchainWorkerOptions {
                runtime_api_provider: client.clone(),
                is_validator: config.role.is_authority(),
                keystore: Some(keystore_container.keystore()),
                offchain_db: backend.offchain_storage(),
                transaction_pool: Some(OffchainTransactionPoolFactory::new(
                    transaction_pool.clone(),
                )),
                network_provider: Arc::new(network.clone()),
                enable_http_requests: true,
                custom_extensions: |_| vec![],
            })?;
        task_manager.spawn_handle().spawn(
            "offchain-workers-runner",
            "offchain-worker",
            offchain_workers
                .run(client.clone(), task_manager.spawn_handle())
                .boxed(),
        );
    }

    let role = config.role;
    let force_authoring = config.force_authoring;
    let backoff_authoring_blocks: Option<()> = None;
    let name = config.network.node_name.clone();
    let enable_grandpa = !config.disable_grandpa;
    let prometheus_registry = config.prometheus_registry().cloned();

    // Register the cogno observer-liveness metrics on the node's Prometheus registry (if enabled). An
    // abstaining observer still authors blocks, so the generic `substrate_*` liveness gauges stay green
    // while weight goes stale — these `cogno_observer_*` gauges are the dedicated signal (fed from the
    // authoring CIDP below). Registration failure is non-fatal: run without them.
    let observer_metrics = prometheus_registry.as_ref().and_then(|registry| {
        match crate::metrics::ObserverMetrics::register(registry) {
            Ok(m) => Some(Arc::new(m)),
            Err(e) => {
                log::warn!(
                    target: "cardano-observer",
                    "failed to register observer Prometheus metrics: {e} — running without them"
                );
                None
            }
        }
    });

    let rpc_extensions_builder = {
        let client = client.clone();
        let pool = transaction_pool.clone();

        Box::new(move |_| {
            let deps = crate::rpc::FullDeps {
                client: client.clone(),
                pool: pool.clone(),
            };
            crate::rpc::create_full(deps).map_err(Into::into)
        })
    };

    let _rpc_handlers = sc_service::spawn_tasks(sc_service::SpawnTasksParams {
        network: Arc::new(network.clone()),
        client: client.clone(),
        keystore: keystore_container.keystore(),
        task_manager: &mut task_manager,
        transaction_pool: transaction_pool.clone(),
        rpc_builder: rpc_extensions_builder,
        backend,
        system_rpc_tx,
        tx_handler_controller,
        sync_service: sync_service.clone(),
        config,
        telemetry: telemetry.as_mut(),
        tracing_execute_block: None,
    })?;

    if role.is_authority() {
        let proposer_factory = sc_basic_authorship::ProposerFactory::new(
            task_manager.spawn_handle(),
            client.clone(),
            transaction_pool.clone(),
            prometheus_registry.as_ref(),
            telemetry.as_ref().map(|x| x.handle()),
        );
        // Wrap the stock proposer so each authored
        // block SEALS the stable Cardano block anchor (CardanoRef { slot, block_hash }) into its HEADER as a
        // `cobs` PreRuntime digest — the external-auditability artifact. The wrapper is passed to the STOCK
        // `start_aura` (generic over the proposer factory; NO import_queue/start_aura fork), and the
        // load-bearing importer re-validation rides the existing `check_inherent` (which compares the anchor
        // `block_hash`). The appended PreRuntime item survives `Executive::final_checks` because
        // `frame_system::initialize` stores the full incoming header digest (just like the Aura pre-digest).
        let proposer_factory = crate::consensus::PartnerChainsProposerFactory::<
            Block,
            _,
            crate::consensus::CardanoObsInherentDigest,
        >::new(proposer_factory);

        let slot_duration = sc_consensus_aura::slot_duration(&*client)?;
        // D4: a client clone for the authoring CIDP (it produces this node's observation too).
        let cardano_idp_client = client.clone();
        // The observer-liveness metrics for the authoring path (cloned into the CIDP closure below).
        let authoring_metrics = observer_metrics.clone();

        let aura = sc_consensus_aura::start_aura::<AuraPair, _, _, _, _, _, _, _, _, _, _>(
            StartAuraParams {
                slot_duration,
                client,
                select_chain,
                block_import,
                proposer_factory,
                create_inherent_data_providers: move |parent_hash, ()| {
                    let cardano_idp_client = cardano_idp_client.clone();
                    let metrics = authoring_metrics.clone();
                    async move {
                        let timestamp = sp_timestamp::InherentDataProvider::from_system_time();

                        let slot =
							sp_consensus_aura::inherents::InherentDataProvider::from_timestamp_and_slot_duration(
								*timestamp,
								slot_duration,
							);

                        // D4: the author proposes this node's observation as-of the parent-derived reference,
                        // recording it into the observer-liveness metrics (authoring path only).
                        let cardano =
                            build_cardano_idp(cardano_idp_client, parent_hash, metrics).await;

                        Ok((slot, timestamp, cardano))
                    }
                },
                force_authoring,
                backoff_authoring_blocks,
                keystore: keystore_container.keystore(),
                sync_oracle: sync_service.clone(),
                justification_sync_link: sync_service.clone(),
                block_proposal_slot_portion: SlotProportion::new(2f32 / 3f32),
                max_block_proposal_slot_portion: None,
                telemetry: telemetry.as_ref().map(|x| x.handle()),
                compatibility_mode: Default::default(),
            },
        )?;

        // the AURA authoring task is considered essential, i.e. if it
        // fails we take down the service with it.
        task_manager
            .spawn_essential_handle()
            .spawn_blocking("aura", Some("block-authoring"), aura);
    }

    if enable_grandpa {
        // if the node isn't actively participating in consensus then it doesn't
        // need a keystore, regardless of which protocol we use below.
        let keystore = if role.is_authority() {
            Some(keystore_container.keystore())
        } else {
            None
        };

        let grandpa_config = sc_consensus_grandpa::Config {
            // GRANDPA gossip duration; kept at the upstream default.
            gossip_duration: Duration::from_millis(333),
            justification_generation_period: GRANDPA_JUSTIFICATION_PERIOD,
            name: Some(name),
            observer_enabled: false,
            keystore,
            local_role: role,
            telemetry: telemetry.as_ref().map(|x| x.handle()),
            protocol_name: grandpa_protocol_name,
        };

        // start the full GRANDPA voter
        // NOTE: non-authorities could run the GRANDPA observer protocol, but at
        // this point the full voter should provide better guarantees of block
        // and vote data availability than the observer. The observer has not
        // been tested extensively yet and having most nodes in a network run it
        // could lead to finality stalls.
        let grandpa_config = sc_consensus_grandpa::GrandpaParams {
            config: grandpa_config,
            link: grandpa_link,
            network,
            sync: Arc::new(sync_service),
            notification_service: grandpa_notification_service,
            voting_rule: sc_consensus_grandpa::VotingRulesBuilder::default().build(),
            prometheus_registry,
            shared_voter_state: SharedVoterState::empty(),
            telemetry: telemetry.as_ref().map(|x| x.handle()),
            offchain_tx_pool_factory: OffchainTransactionPoolFactory::new(transaction_pool),
        };

        // the GRANDPA voter task is considered infallible, i.e.
        // if it fails we take down the service with it.
        task_manager.spawn_essential_handle().spawn_blocking(
            "grandpa-voter",
            None,
            sc_consensus_grandpa::run_grandpa_voter(grandpa_config)?,
        );
    }

    Ok(task_manager)
}
