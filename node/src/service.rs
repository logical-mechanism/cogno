//! Service and ServiceFactory implementation. Specialized wrapper over substrate service.

use futures::FutureExt;
use sc_client_api::{Backend, BlockBackend};
use sc_consensus_aura::{ImportQueueParams, SlotProportion, StartAuraParams};
use sc_consensus_grandpa::{GrandpaPruningFilter, SharedVoterState};
use sc_service::{error::Error as ServiceError, Configuration, TaskManager, WarpSyncConfig};
use sc_telemetry::{Telemetry, TelemetryWorker};
use sc_transaction_pool_api::OffchainTransactionPoolFactory;
use cogno_chain_runtime::{self, apis::RuntimeApi, opaque::Block};
use sp_consensus_aura::sr25519::AuthorityPair as AuraPair;
use std::{sync::Arc, time::Duration};
// in-protocol-observation (D4): the node-side Cardano-observation InherentDataProvider wiring. The
// deterministic db-sync read + the pure reduction now live in the shared `cogno-dbsync` crate — the node
// (writer) and the cogno-chain-cli (read-only diagnostic) go through byte-identical code.
use crate::cardano_observer::CardanoObservationInherentDataProvider;
use cogno_dbsync::dbsync;
use cogno_dbsync::reduction::{build_observation, hex_encode, reference_slot};
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
/// observation/abstain into the observer-liveness metrics (authoring path only — those gauges track THIS
/// node's own AUTHORED observations) and wraps the result. Used by BOTH the import and authoring CIDPs; the
/// import path passes `None` for `metrics`.
async fn build_cardano_idp(
	client: Arc<FullClient>,
	parent: <Block as BlockT>::Hash,
	metrics: Option<Arc<crate::metrics::ObserverMetrics>>,
) -> CardanoObservationInherentDataProvider {
	match observe_for_parent(client, parent).await {
		Some(obs) => {
			if let Some(m) = &metrics {
				m.record_observation(obs.reference.slot, obs.entries.len(), obs.stake_entries.len());
			}
			CardanoObservationInherentDataProvider { observation: Some(obs) }
		},
		None => {
			if let Some(m) = &metrics {
				m.record_abstain();
			}
			CardanoObservationInherentDataProvider { observation: None }
		},
	}
}

/// The deterministic observation read — returns `Some(observation)` or `None` to ABSTAIN (fail-closed at
/// every step). Reads the consensus-pinned config via the `CardanoObserverApi` runtime API (single source
/// of truth — node + runtime can't drift), derives the stable reference slot from the PARENT block's Aura
/// slot (so author + every importer agree, design §5.1), and reads THIS node's own db-sync as-of that slot
/// (ONE consistent snapshot: freshness tip + the deterministic stable-block anchor + the vault UTxOs). Any
/// error (API / header / db-sync down or behind) ⇒ `None` — the author abstains (no inherent; the chain
/// stays live) and an importer that can't read defers-accepts via the runtime's `CannotVerify` path.
async fn observe_for_parent(
	client: Arc<FullClient>,
	parent: <Block as BlockT>::Hash,
) -> Option<CardanoObservation> {
	// 1. consensus-pinned config (anchors, stability window, vault policy id).
	let config = match client.runtime_api().observer_config(parent) {
		Ok(c) => c,
		Err(e) => {
			log::warn!(target: "cardano-observer", "observer_config runtime API failed: {e:?} — abstaining");
			return None;
		},
	};
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
	let dbsync_url = std::env::var("DBSYNC_URL").or_else(|_| std::env::var("DBSYNC")).unwrap_or_default();
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
		},
	};
	// 4a. point-existence guard (§5.4): only trust the read if THIS node's db-sync has indexed PAST the
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
	// 4b. the SEALED stable block-hash anchor (in-protocol-observation §15.3, Midnight delta A.1): the
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
		},
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
		},
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
		},
	};
	// 6. reduce the db-sync matches (canonical largest-wins-per-beacon) + canonicalize the stake set.
	let obs = build_observation(
		CardanoRef { slot: ref_slot, block_hash: anchor_hash },
		&read.matches,
		&vault_hex,
		stake_entries,
	);
	log::debug!(
		target: "cardano-observer",
		"observed {} vault + {} stake entrie(s) as-of slot {} ({} db-sync match(es), {} bound cred(s), anchor block {})",
		obs.entries.len(), obs.stake_entries.len(), ref_slot, read.matches.len(), bound_creds.len(), hex_encode(&anchor_hash),
	);
	Some(obs)
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
		task_manager.spawn_handle().spawn("telemetry", None, worker.run());
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

	let mut net_config = sc_network::config::FullNetworkConfiguration::<
		Block,
		<Block as sp_runtime::traits::Block>::Hash,
		N,
	>::new(&config.network, config.prometheus_registry().cloned());
	let metrics = N::register_notification_metrics(config.prometheus_registry());

	let peer_store_handle = net_config.peer_store_handle();
	let grandpa_protocol_name = sc_consensus_grandpa::protocol_standard_name(
		&client.block_hash(0).ok().flatten().expect("Genesis block exists; qed"),
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
			offchain_workers.run(client.clone(), task_manager.spawn_handle()).boxed(),
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
			},
		}
	});

	let rpc_extensions_builder = {
		let client = client.clone();
		let pool = transaction_pool.clone();

		Box::new(move |_| {
			let deps = crate::rpc::FullDeps { client: client.clone(), pool: pool.clone() };
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
		// D4 (in-protocol-observation §15.3 / Midnight delta A.1): wrap the stock proposer so each authored
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
						let cardano = build_cardano_idp(cardano_idp_client, parent_hash, metrics).await;

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
		let keystore = if role.is_authority() { Some(keystore_container.keystore()) } else { None };

		let grandpa_config = sc_consensus_grandpa::Config {
			// FIXME #1578 make this available through chainspec
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
