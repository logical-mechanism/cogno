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
    /// Role (SPO / dRep / CC badge) entry count in the most recent non-empty observation.
    ///
    /// Tracked separately because it is one-to-MANY where the other two are one entry per identity: an
    /// mSPO emits one entry per declaring pool, and the owner path one per owned pool. So this gauge can
    /// run far ahead of the identity count, and an alert written only on vaults/voters is blind to it.
    observed_roles: Gauge<U64>,
    /// The largest credential SCAN that scoped this block's db-sync queries — the quantity `MaxScanned`
    /// actually truncates, measured at the scan in `observe_for_parent`.
    ///
    /// This is the ONLY series comparable to [`Self::max_scanned`], and it exists because neither
    /// observation-side gauge is. `observed_voters` is strictly SMALLER than the scan (a bound but
    /// undelegated credential holds no `epoch_stake` row, so it never reaches the output) and would stay
    /// quiet through a real truncation; `observed_roles` is one-to-MANY per credential and can sail past
    /// the cap with nothing truncated at all. An alert written on either is wrong in one direction or the
    /// other — see the note in `observe_for_parent`.
    scanned_credentials: Gauge<U64>,
    /// The runtime's `MaxScanned` cap (from `ObserverConfig`). Exposed so an alert rule can compare
    /// [`Self::scanned_credentials`] against it without hard-coding the limit.
    ///
    /// ⚠ NOT a ceiling on the observation — spec 215 removed that, along with the freeze that used to
    /// follow from crossing it. It caps the per-block credential SCANS that scope the db-sync query, so
    /// it bounds the STAKE and ROLE axes only. `observed_vaults` is not comparable to it.
    max_scanned: Gauge<U64>,
    /// How many blocks a complete sweep of the credential scan rotation takes — the worst-case AGE of a
    /// basis row the current window has not reached.
    ///
    /// ⚠ THIS REPLACED a `observations_scan_capped_total` counter in spec 220, and the replacement is
    /// not cosmetic. The scan used to be a hash-ordered PREFIX, so reaching `MaxScanned` meant
    /// identities were being silently dropped and a non-zero rate meant someone's badge was missing. It
    /// is a rotating WINDOW now: nothing is dropped, and on any chain larger than one window the scan is
    /// at its cap on every healthy block — so the old counter would have climbed monotonically forever
    /// while reporting a fault that no longer exists.
    ///
    /// `1` means the whole ledger fits in one window, which is the live chain today and is
    /// byte-identical to the pre-220 behaviour. Alert on this crossing a latency you care about, not on
    /// [`Self::scanned_credentials`] reaching [`Self::max_scanned`].
    scan_sweep_blocks: Gauge<U64>,
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
			observed_roles: register(
				Gauge::new(
					"cogno_observer_observed_roles",
					"Role entry count in the most recent non-empty observation (one-to-many: an entry per declaring pool)",
				)?,
				registry,
			)?,
			scanned_credentials: register(
				Gauge::new(
					"cogno_observer_scanned_credentials",
					"Largest credential scan scoping this block's db-sync queries (the quantity MaxScanned truncates)",
				)?,
				registry,
			)?,
			max_scanned: register(
				Gauge::new(
					"cogno_observer_max_scanned",
					"Runtime MaxScanned cap on the per-block credential scans; bounds the stake and role axes only",
				)?,
				registry,
			)?,
			scan_sweep_blocks: register(
				Gauge::new(
					"cogno_observer_scan_sweep_blocks",
					"Blocks for the credential scan window to sweep the whole ledger (worst-case age of an unscanned basis row)",
				)?,
				registry,
			)?,
		})
    }

    /// Record an abstention (empty observation).
    pub fn record_abstain(&self) {
        self.abstains_total.inc();
    }

    /// Record a non-empty observation produced at Cardano `ref_slot` with `vaults`/`voters`/`roles` entries.
    /// `dbsync_tip_slot` is this node's db-sync tip and `lag_slots` is how far that tip trails the
    /// current Cardano slot (see the field docs) — both captured from the same consistent db-sync read.
    pub fn record_observation(
        &self,
        ref_slot: u64,
        dbsync_tip_slot: u64,
        lag_slots: u64,
        vaults: usize,
        voters: usize,
        roles: usize,
    ) {
        self.observations_total.inc();
        self.last_reference_slot.set(ref_slot);
        self.dbsync_tip_slot.set(dbsync_tip_slot);
        self.lag_slots.set(lag_slots);
        self.observed_vaults.set(vaults as u64);
        self.observed_voters.set(voters as u64);
        self.observed_roles.set(roles as u64);
    }

    /// Publish the runtime's `MaxScanned` cap and the scan actually taken this block. Set together
    /// because the alert rule is the RATIO of the two, and a stale half would make it lie.
    pub fn set_scan(&self, scanned: u32, max_scanned: u32, sweep_blocks: u64) {
        self.scanned_credentials.set(u64::from(scanned));
        self.max_scanned.set(u64::from(max_scanned));
        self.scan_sweep_blocks.set(sweep_blocks);
    }
}
