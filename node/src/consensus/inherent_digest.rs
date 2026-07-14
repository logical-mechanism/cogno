// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 LogicalMechanism. Reimplemented from the Apache-2.0 partner-chains
// `sp-partner-chains-consensus-aura` crate (see the repo NOTICE file for attribution).
//! The `InherentDigest` trait: which parts of a block's inherent data are sealed into the block HEADER
//! digest, and how to decode them back on import.
//!
//! Reimplemented from the Apache-2.0 partner-chains `sp-partner-chains-consensus-aura` primitives, pinned
//! to cogno's polkadot-stable2606 (the upstream repo is archived — study it, don't depend on it).

use sp_inherents::InherentData;
use sp_runtime::DigestItem;
use std::error::Error;

/// Defines the parts of a block's inherent data that are sealed into the header digest.
pub trait InherentDigest {
    /// The Rust value decoded back from a header's digest items on import.
    type Value: Send + Sync + 'static;

    /// AUTHOR side: construct the header digest items from a block's inherent data. MUST be total over
    /// MISSING/empty inherent data (return `Ok(vec![])` — "seal nothing"): cogno's author legitimately
    /// abstains when its db-sync lags, and the proposer must never fail on that path.
    fn from_inherent_data(
        inherent_data: &InherentData,
    ) -> Result<Vec<DigestItem>, Box<dyn Error + Send + Sync>>;

    /// IMPORTER side: decode the sealed value back from a header's digest items. NOT called on the
    /// Architecture-A import path (where the header digest is auditability-only and the load-bearing
    /// re-validation rides `check_inherent`); it is the decoder the deferred Architecture-B upgrade wires,
    /// and is exercised by the `cardano_digest` unit tests.
    #[allow(dead_code)]
    fn value_from_digest(
        digests: &[DigestItem],
    ) -> Result<Self::Value, Box<dyn Error + Send + Sync>>;
}

/// The no-op digest: a node wired with `()` seals nothing and is behaviorally identical to a node with no
/// custom proposer at all (used to prove the proposer vendoring is GRANDPA-neutral before any seal logic).
impl InherentDigest for () {
    type Value = ();

    fn from_inherent_data(
        _inherent_data: &InherentData,
    ) -> Result<Vec<DigestItem>, Box<dyn Error + Send + Sync>> {
        Ok(vec![])
    }

    fn value_from_digest(_digests: &[DigestItem]) -> Result<(), Box<dyn Error + Send + Sync>> {
        Ok(())
    }
}
