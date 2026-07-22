// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 LogicalMechanism. Reimplemented from the Apache-2.0 partner-chains
// `sp-partner-chains-consensus-aura` crate (see the repo NOTICE file for attribution).
//! `CardanoObsInherentDigest`: seals the stable Cardano block anchor (`CardanoRef { slot, block_hash }`)
//! into the block header as a `cobs` PreRuntime digest, and decodes it back on import.
//!
//! The sealed value is the SAME `CardanoRef` carried (and consensus-re-validated) by the `observe`
//! inherent. In Architecture A the header digest is the EXTERNAL-AUDITABILITY mirror — a third party
//! reading only PC block headers sees which stable Cardano block each block anchored to, without trusting
//! the operator — while the load-bearing importer re-validation rides the existing `check_inherent`
//! (which now compares `block_hash`). [`value_from_digest`] is implemented + tested here (the
//! missing→`None` / duplicate→`Err` / malformed→`Err` trichotomy) so the deferred Architecture-B upgrade
//! (making the header digest itself consensus-binding on import) is ready, even though Architecture A does
//! not extract it on the import path.

use crate::consensus::InherentDigest;
use codec::{Decode, Encode};
use pallet_cardano_observer::{CardanoObservation, CardanoRef, INHERENT_IDENTIFIER};
use sp_inherents::InherentData;
use sp_runtime::DigestItem;
use std::error::Error;

/// The 4-byte `DigestItem` engine id for the sealed Cardano-observation anchor (the partner-chains `mcsh`
/// analog). Distinct from `aura` (the Aura pre-digest) and `FRNK` (GRANDPA) — and a DIFFERENT namespace
/// from the 8-byte inherent identifier `cgnoobsv`.
pub const CARDANO_OBS_DIGEST_ID: [u8; 4] = *b"cobs";

/// The value decoded from a block header's `cobs` digest. Constructed only by [`value_from_digest`] (the
/// Architecture-B decoder) and the unit tests — Architecture A does not extract the header digest on
/// import, so these variants are not constructed on the production path.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SealedAnchor {
    /// No `cobs` digest in the header — a legitimately-abstaining block (e.g. a db-sync-lagging author). This
    /// is NEVER an error: a missing seal is a legal "no observation this block".
    NoSeal,
    /// The sealed stable Cardano block reference (the anchor the author observed as-of).
    Sealed(CardanoRef),
}

/// The cogno `InherentDigest`: seals the observation's `CardanoRef` anchor into the `cobs` header digest.
pub struct CardanoObsInherentDigest;

impl InherentDigest for CardanoObsInherentDigest {
    type Value = SealedAnchor;

    fn from_inherent_data(
        inherent_data: &InherentData,
    ) -> Result<Vec<DigestItem>, Box<dyn Error + Send + Sync>> {
        // Read this node's own observation. ABSENT ⇒ the author abstains ⇒ seal nothing (TOTAL over missing
        // data, so the proposer never fails on the common db-sync-lag abstain path). The sealed payload is the
        // observation's `reference` (CardanoRef { slot, block_hash }), SCALE-encoded.
        match inherent_data.get_data::<CardanoObservation>(&INHERENT_IDENTIFIER) {
            Ok(Some(obs)) => Ok(vec![DigestItem::PreRuntime(
                CARDANO_OBS_DIGEST_ID,
                obs.reference.encode(),
            )]),
            Ok(None) => Ok(vec![]),
            Err(e) => Err(format!("decode local CardanoObservation for cobs seal: {e}").into()),
        }
    }

    fn value_from_digest(
        digests: &[DigestItem],
    ) -> Result<SealedAnchor, Box<dyn Error + Send + Sync>> {
        let mut found: Option<CardanoRef> = None;
        let mut count = 0usize;
        for d in digests {
            if let DigestItem::PreRuntime(id, data) = d {
                if id == &CARDANO_OBS_DIGEST_ID {
                    count += 1;
                    let mut input = &data[..];
                    let cref = CardanoRef::decode(&mut input)
                        .map_err(|e| format!("decode cobs digest payload: {e}"))?;
                    if !input.is_empty() {
                        return Err("cobs digest payload has trailing bytes".into());
                    }
                    found = Some(cref);
                }
            }
        }
        // Duplicate-digest rejection — stricter than the partner-chains reference, which silently takes
        // the first match. More than one `cobs` item means a malformed header, so reject it.
        if count > 1 {
            return Err(format!(
                "header carries {count} cobs PreRuntime digests (expected at most 1)"
            )
            .into());
        }
        Ok(found
            .map(SealedAnchor::Sealed)
            .unwrap_or(SealedAnchor::NoSeal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cref(slot: u64, hash: u8) -> CardanoRef {
        CardanoRef {
            slot,
            block_hash: [hash; 32],
        }
    }

    fn obs(reference: CardanoRef) -> CardanoObservation {
        CardanoObservation {
            reference,
            inputs_commitment: [0u8; 32],
            entries: vec![],
            stake_entries: vec![],
            role_entries: vec![],
        }
    }

    #[test]
    fn from_inherent_data_seals_the_reference_and_round_trips() {
        let reference = cref(1_000, 0xab);
        let mut id = InherentData::new();
        id.put_data(INHERENT_IDENTIFIER, &obs(reference.clone()))
            .unwrap();
        let digests = CardanoObsInherentDigest::from_inherent_data(&id).unwrap();
        assert_eq!(digests.len(), 1, "exactly one cobs PreRuntime item");
        assert!(
            matches!(&digests[0], DigestItem::PreRuntime(id, _) if id == &CARDANO_OBS_DIGEST_ID)
        );
        // decode back ⇒ the same CardanoRef.
        assert_eq!(
            CardanoObsInherentDigest::value_from_digest(&digests).unwrap(),
            SealedAnchor::Sealed(reference),
        );
    }

    #[test]
    fn from_inherent_data_is_total_over_missing_data() {
        // The abstain path (db-sync lagging ⇒ no observation): seal nothing, NEVER panic/Err.
        let id = InherentData::new();
        assert_eq!(
            CardanoObsInherentDigest::from_inherent_data(&id).unwrap(),
            Vec::<DigestItem>::new()
        );
    }

    #[test]
    fn value_from_digest_missing_item_is_noseal_not_error() {
        // A header with NO cobs item (and unrelated digests) ⇒ NoSeal (a legal abstention), NOT an Err —
        // the import path runs this on EVERY header, so a missing seal must never fail import.
        let other = DigestItem::PreRuntime(*b"aura", vec![1, 2, 3]);
        assert_eq!(
            CardanoObsInherentDigest::value_from_digest(&[other]).unwrap(),
            SealedAnchor::NoSeal,
        );
        assert_eq!(
            CardanoObsInherentDigest::value_from_digest(&[]).unwrap(),
            SealedAnchor::NoSeal
        );
    }

    #[test]
    fn value_from_digest_rejects_duplicate_cobs_items() {
        let one = DigestItem::PreRuntime(CARDANO_OBS_DIGEST_ID, cref(1, 0x11).encode());
        let two = DigestItem::PreRuntime(CARDANO_OBS_DIGEST_ID, cref(2, 0x22).encode());
        assert!(CardanoObsInherentDigest::value_from_digest(&[one, two]).is_err());
    }

    #[test]
    fn value_from_digest_rejects_a_malformed_payload() {
        // Too-short payload (a CardanoRef is exactly 8 + 32 = 40 bytes).
        let short = DigestItem::PreRuntime(CARDANO_OBS_DIGEST_ID, vec![0u8; 8]);
        assert!(CardanoObsInherentDigest::value_from_digest(&[short]).is_err());
        // Trailing bytes after a valid CardanoRef ⇒ malformed.
        let mut bytes = cref(5, 0x05).encode();
        bytes.push(0xff);
        let trailing = DigestItem::PreRuntime(CARDANO_OBS_DIGEST_ID, bytes);
        assert!(CardanoObsInherentDigest::value_from_digest(&[trailing]).is_err());
    }
}
