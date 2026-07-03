//! In-node Prometheus metrics for the Cardano observer.
//!
//! Substrate's built-in `substrate_*` metrics (block height best/finalized, peer count, …) on the node's
//! Prometheus endpoint cover chain-level health. These add the cogno-specific signal: is THIS node's
//! observer actually reading Cardano (via db-sync) and writing the talk-stake weight ledger every block,
//! or is it ABSTAINING (db-sync unset/down/behind)? An abstaining observer still produces blocks, so
//! chain-liveness alerts would stay green while weight silently goes stale — hence a dedicated signal.
//! Updated from the authoring `build_cardano_idp` (the single-validator producer observes every slot).

use substrate_prometheus_endpoint::{register, Counter, Gauge, PrometheusError, Registry, U64};

/// Observer-liveness metrics, registered on the node's Prometheus registry (`:9615/metrics`).
#[derive(Clone)]
pub struct ObserverMetrics {
    /// Non-empty observations this node has proposed (a successful db-sync read → reduced ledger).
    observations_total: Counter<U64>,
    /// Abstentions: an empty observation (db-sync unset/down/behind, pre-Shelley, or a runtime-API error).
    abstains_total: Counter<U64>,
    /// The Cardano reference slot of the most recent non-empty observation (0 until the first).
    last_reference_slot: Gauge<U64>,
    /// Vault (locked-ADA weight) entry count in the most recent non-empty observation.
    observed_vaults: Gauge<U64>,
    /// Voting-power (epoch_stake) entry count in the most recent non-empty observation.
    observed_voters: Gauge<U64>,
}

impl ObserverMetrics {
    /// Register the observer metrics on `registry`.
    pub fn register(registry: &Registry) -> Result<Self, PrometheusError> {
        Ok(Self {
			observations_total: register(
				Counter::new(
					"cogno_observer_observations_total",
					"Non-empty Cardano observations this node has proposed",
				)?,
				registry,
			)?,
			abstains_total: register(
				Counter::new(
					"cogno_observer_abstains_total",
					"Observer abstentions (empty observation: db-sync unset/down/behind or pre-Shelley)",
				)?,
				registry,
			)?,
			last_reference_slot: register(
				Gauge::new(
					"cogno_observer_last_reference_slot",
					"Cardano reference slot of the most recent non-empty observation",
				)?,
				registry,
			)?,
			observed_vaults: register(
				Gauge::new(
					"cogno_observer_observed_vaults",
					"Vault (locked-ADA weight) entry count in the most recent non-empty observation",
				)?,
				registry,
			)?,
			observed_voters: register(
				Gauge::new(
					"cogno_observer_observed_voters",
					"Voting-power (epoch_stake) entry count in the most recent non-empty observation",
				)?,
				registry,
			)?,
		})
    }

    /// Record an abstention (empty observation).
    pub fn record_abstain(&self) {
        self.abstains_total.inc();
    }

    /// Record a non-empty observation produced at Cardano `ref_slot` with `vaults`/`voters` entries.
    pub fn record_observation(&self, ref_slot: u64, vaults: usize, voters: usize) {
        self.observations_total.inc();
        self.last_reference_slot.set(ref_slot);
        self.observed_vaults.set(vaults as u64);
        self.observed_voters.set(voters as u64);
    }
}
