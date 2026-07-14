//! Node-side `InherentDataProvider` wrapper for the in-protocol-observation inherent (D4).
//!
//! This module is now ONLY the node-side glue: the [`CardanoObservationInherentDataProvider`] (which
//! carries the observation this node computed, or `None` to abstain) and the load-bearing
//! `try_handle_error` that branches on the runtime's typed [`InherentError`]. The two IO/pure halves it
//! used to also hold — the deterministic Cardano db-sync read and the pure reduction — were folded into
//! the shared [`cogno_dbsync`] crate (`cogno_dbsync::dbsync` + `cogno_dbsync::reduction`), so the node
//! (the WRITER) and the `cogno-chain-cli` (READ-ONLY diagnostic) go through byte-identical code, pinned by
//! the golden observation-equivalence fixture. `service.rs` derives the reference slot from the parent
//! block, calls `cogno_dbsync::dbsync::read_observation` once, applies the point-existence guard, feeds the
//! matches to `cogno_dbsync::reduction`, and wraps the result here.

use codec::Decode;
use pallet_cardano_observer::{CardanoObservation, InherentError, INHERENT_IDENTIFIER};
use sp_inherents::{InherentData, InherentDataProvider, InherentIdentifier};

/// The node-side `InherentDataProvider` for the Cardano observation. Holds the observation this node
/// computed, or `None` when its own db-sync source is behind/down (fail-closed — provide nothing, so the
/// author emits no inherent and the chain stays live).
pub struct CardanoObservationInherentDataProvider {
    pub observation: Option<CardanoObservation>,
}

#[async_trait::async_trait]
impl InherentDataProvider for CardanoObservationInherentDataProvider {
    async fn provide_inherent_data(
        &self,
        inherent_data: &mut InherentData,
    ) -> Result<(), sp_inherents::Error> {
        if let Some(obs) = &self.observation {
            inherent_data.put_data(INHERENT_IDENTIFIER, obs)?;
        }
        Ok(())
    }

    async fn try_handle_error(
        &self,
        identifier: &InherentIdentifier,
        error: &[u8],
    ) -> Option<Result<(), sp_inherents::Error>> {
        if *identifier != INHERENT_IDENTIFIER {
            return None;
        }
        // THE load-bearing rule: branch on the runtime's typed error. Mismatch and
        // ComputeDiverged are PROPAGATED (Some(Err) ⇒ block rejected — both are real disagreements on the
        // verified read); a CannotVerify is SWALLOWED (Some(Ok) ⇒ accept without verifying — never fork
        // because OUR follower lags). A blanket swallow would silently defeat the entire cross-node
        // fork-protection. The Mismatch/ComputeDiverged split is diagnostic: ComputeDiverged means the two
        // nodes agreed on the raw Cardano inputs but reduced them differently — a determinism bug / binary
        // version skew, the silent-fork risk an enforced multi-producer network most fears.
        match InherentError::decode(&mut &error[..]) {
			Ok(InherentError::Mismatch) => Some(Err(sp_inherents::Error::Application(
				Box::<dyn core::error::Error + Send + Sync>::from(
					"cardano observation mismatch: the author's read disagrees with this node's (different Cardano data)",
				),
			))),
			Ok(InherentError::ComputeDiverged) => Some(Err(sp_inherents::Error::Application(
				Box::<dyn core::error::Error + Send + Sync>::from(
					"cardano observation compute-divergence: same raw Cardano inputs, different reduced observation (a determinism bug / version skew)",
				),
			))),
			Ok(InherentError::CannotVerify) => Some(Ok(())),
			Err(_) => None,
		}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cogno_dbsync::reduction::hex32;
    use pallet_cardano_observer::CardanoRef;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn beacon(hex: &str) -> pallet_cardano_observer::BeaconName {
        hex32(hex).unwrap()
    }

    #[test]
    fn try_handle_error_branches_on_the_typed_error() {
        use codec::Encode;
        let idp = CardanoObservationInherentDataProvider { observation: None };
        let mismatch = InherentError::Mismatch.encode();
        let cannot = InherentError::CannotVerify.encode();
        let diverged = InherentError::ComputeDiverged.encode();
        // Mismatch ⇒ Some(Err) (propagate → reject); CannotVerify ⇒ Some(Ok) (accept without verifying);
        // ComputeDiverged ⇒ Some(Err) (propagate → reject, like Mismatch but a distinct diagnostic).
        assert!(matches!(
            futures::executor::block_on(idp.try_handle_error(&INHERENT_IDENTIFIER, &mismatch)),
            Some(Err(_))
        ));
        assert!(matches!(
            futures::executor::block_on(idp.try_handle_error(&INHERENT_IDENTIFIER, &cannot)),
            Some(Ok(()))
        ));
        assert!(matches!(
            futures::executor::block_on(idp.try_handle_error(&INHERENT_IDENTIFIER, &diverged)),
            Some(Err(_))
        ));
        // A different identifier is not ours ⇒ None.
        assert!(
            futures::executor::block_on(idp.try_handle_error(b"timstap0", &mismatch)).is_none()
        );
    }

    #[test]
    fn provide_inherent_data_puts_observation_only_when_present() {
        // Some(obs) ⇒ data is put under our identifier; None ⇒ nothing (fail-closed author abstains).
        let obs = CardanoObservation {
            reference: CardanoRef {
                slot: 1_000,
                block_hash: [0u8; 32],
            },
            inputs_commitment: [0u8; 32],
            entries: vec![(beacon(A), 200_000_000)],
            stake_entries: vec![],
        };
        let with = CardanoObservationInherentDataProvider {
            observation: Some(obs),
        };
        let mut id = InherentData::new();
        futures::executor::block_on(with.provide_inherent_data(&mut id)).unwrap();
        assert!(id
            .get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
            .unwrap()
            .is_some());

        let without = CardanoObservationInherentDataProvider { observation: None };
        let mut id2 = InherentData::new();
        futures::executor::block_on(without.provide_inherent_data(&mut id2)).unwrap();
        assert!(id2
            .get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
            .unwrap()
            .is_none());
    }
}
