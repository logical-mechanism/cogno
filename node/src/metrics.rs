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
    /// This node's db-sync tip slot (`max(block.slot_no)`) at the most recent non-empty observation.
    /// The freshness of the Cardano source THIS node reads; compare against a cardano-node exporter's
    /// tip to catch a db-sync that has stopped indexing while cardano-node stays live.
    dbsync_tip_slot: Gauge<U64>,
    /// Observer lag in Cardano slots: how far this node's db-sync tip trails the current (parent-derived)
    /// Cardano slot at the most recent non-empty observation — `(reference_slot + StabilitySlots) −
    /// dbsync_tip_slot`. ~0 when db-sync is caught up; climbs 0→StabilitySlots as db-sync falls behind
    /// (the observation goes stale but still lands); once it EXCEEDS StabilitySlots the read abstains
    /// (`abstains_total` climbs instead). The early-warning gauge for a slowly-degrading db-sync — the
    /// binary `ObserverReferenceSlotStalled` alert only catches a fully-frozen tip.
    lag_slots: Gauge<U64>,
    /// Vault (locked-ADA weight) entry count in the most recent non-empty observation.
    observed_vaults: Gauge<U64>,
    /// Voting-power (epoch_stake) entry count in the most recent non-empty observation.
    observed_voters: Gauge<U64>,
    /// The runtime's `MaxObserved` ceiling (from `ObserverConfig`). Exposed so an alert rule can compare
    /// `observed_vaults`/`observed_voters` against it without hard-coding the limit.
    max_observed: Gauge<U64>,
    /// Observations whose vault OR stake set EXCEEDED `MaxObserved` — the SILENT-FREEZE condition
    /// (`create_inherent` abstains, so weight stops updating). A non-zero rate here is a page.
    observations_oversize_total: Counter<U64>,
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
			dbsync_tip_slot: register(
				Gauge::new(
					"cogno_observer_dbsync_tip_slot",
					"This node's db-sync tip slot (max block slot_no) at the most recent non-empty observation",
				)?,
				registry,
			)?,
			lag_slots: register(
				Gauge::new(
					"cogno_observer_lag_slots",
					"Observer lag in Cardano slots: how far this node's db-sync tip trails the current Cardano slot (0 healthy; abstains once it exceeds StabilitySlots)",
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
			max_observed: register(
				Gauge::new(
					"cogno_observer_max_observed",
					"Runtime MaxObserved ceiling; an observation reaching it freezes the weight writer",
				)?,
				registry,
			)?,
			observations_oversize_total: register(
				Counter::new(
					"cogno_observer_observations_oversize_total",
					"Observations exceeding MaxObserved (the silent-freeze condition: create_inherent abstains)",
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
    /// `dbsync_tip_slot` is this node's db-sync tip and `lag_slots` is how far that tip trails the
    /// current Cardano slot (see the field docs) — both captured from the same consistent db-sync read.
    pub fn record_observation(
        &self,
        ref_slot: u64,
        dbsync_tip_slot: u64,
        lag_slots: u64,
        vaults: usize,
        voters: usize,
    ) {
        self.observations_total.inc();
        self.last_reference_slot.set(ref_slot);
        self.dbsync_tip_slot.set(dbsync_tip_slot);
        self.lag_slots.set(lag_slots);
        self.observed_vaults.set(vaults as u64);
        self.observed_voters.set(voters as u64);
    }

    /// Publish the runtime's `MaxObserved` ceiling so alert rules can key off it without a duplicate const.
    pub fn set_max_observed(&self, max_observed: u32) {
        self.max_observed.set(u64::from(max_observed));
    }

    /// Record that an observation EXCEEDED `MaxObserved` — the silent-freeze condition
    /// (`create_inherent` will abstain, so the sole weight writer stops updating).
    pub fn record_oversize(&self) {
        self.observations_oversize_total.inc();
    }
}
