//! Custom block proposer that seals the stable Cardano block anchor into the block HEADER as a `cobs`
//! PreRuntime digest (in-protocol-observation §15.3 / Midnight delta A.1 — the partner-chains "McHash"
//! header-seal pattern adapted to cogno's single pinned vault).
//!
//! **Architecture A (the signed-off design).** The header digest is an EXTERNAL-AUDITABILITY artifact: a
//! third party reading only PC block headers can see which stable Cardano block each block anchored to,
//! without trusting the operator. The LOAD-BEARING importer re-validation rides cogno's existing
//! `pallet_cardano_observer::check_inherent` chokepoint (which now compares `CardanoRef.block_hash`), so
//! the import path is UNCHANGED — NO forked `import_queue` / `start_aura` / verifier, and NO GPL-licensed
//! crate. Making the header digest ITSELF consensus-binding (extracting + re-validating it on import) is
//! the deferred Architecture-B upgrade, co-sequenced with the ≥3-independent-producer cutover ("D4-SHAPED,
//! not D4-TRUST").
//!
//! Reimplemented (DR-26: study, don't depend — the upstream repo is archived) from the partner-chains
//! Apache-2.0 `sp-partner-chains-consensus-aura` crate, pinned to cogno's polkadot-stable2603-3: the
//! [`InherentDigest`] trait + the [`PartnerChainsProposerFactory`]/`PartnerChainsProposer` wrapper. The
//! upstream proposer's `from_inherent_data` panic is replaced with a logged-empty fallback so a
//! db-sync-lagging author that legitimately abstains can never wedge the essential authoring task.

mod block_proposal;
mod cardano_digest;
mod inherent_digest;

pub use block_proposal::PartnerChainsProposerFactory;
pub use cardano_digest::CardanoObsInherentDigest;
#[allow(unused_imports)]
pub use cardano_digest::{SealedAnchor, CARDANO_OBS_DIGEST_ID};
pub use inherent_digest::InherentDigest;
