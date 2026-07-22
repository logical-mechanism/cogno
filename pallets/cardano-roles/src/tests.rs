//! Unit tests for `pallet-cardano-roles`.
//!
//! The claim path is exercised end-to-end against SELF-CONSTRUCTED role-key CIP-8 proofs (the same
//! wire shape `cardano-signer --cip8 --address <enterprise>` emits): a deterministic ed25519 key
//! signs the verbatim COSE Sig_structure over a `cogno-chain/role/v1;…` payload, and
//! `claim_role_signed` runs the real crown-jewel verifier (`cip8::verify_bind_proof_role`) + the
//! genesis check + the 1:1 / tombstone ledger logic. The observed ledger (`apply_roles`) is driven
//! directly (the observer is another crate's job). `BlockHash[0]` is pinned to the fixture genesis so
//! the anti-cross-chain check passes — the same technique cogno-gate's tests use.

// stable2606 deprecated `ValidateUnsigned` (see lib.rs) — these tests exercise that still-supported
// pool-admission path directly, so allow the deprecation lint module-wide under the `-D warnings` gate.
#![allow(deprecated)]

use crate::{
    mock::*, Call, Error, Event, ObservedRole, ObservedRoleSet, ObservedRoles, RoleClaimOf,
    RoleCredIndex, RoleCredential, RoleKind, TombstonedRoleCred,
};
use frame_support::{assert_noop, assert_ok, traits::ConstU32, BoundedVec};
use sp_core::{ed25519, Pair};
use sp_runtime::{
    traits::ValidateUnsigned,
    transaction_validity::{InvalidTransaction, TransactionSource, TransactionValidityError},
    DispatchError,
};

const GENESIS: [u8; 32] = [0x27u8; 32];
const ALICE: u64 = 1;
const BOB: u64 = 2;
const UNBOUND: u64 = 0; // MockGate treats account 0 as "not onboarded"

// ── proof construction (mirrors cip8/tests.rs::build_role_proof) ────────────────────────────────────

fn hexs(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// blake2b-224 (the Cardano key hash) — matches the verifier's own address→credential bind, so the
/// synthetic enterprise address we build is accepted.
fn blake2b_224(input: &[u8]) -> [u8; 28] {
    use blake2::digest::{Update, VariableOutput};
    let mut out = [0u8; 28];
    let mut h = blake2::Blake2bVar::new(28).unwrap();
    h.update(input);
    h.finalize_variable(&mut out).unwrap();
    out
}

/// Canonical CBOR byte-string head + content (definite length, major type 2).
fn bstr(content: &[u8]) -> Vec<u8> {
    let len = content.len();
    let mut out = if len <= 23 {
        vec![0x40 | len as u8]
    } else if len <= 0xff {
        vec![0x58, len as u8]
    } else {
        vec![0x59, (len >> 8) as u8, (len & 0xff) as u8]
    };
    out.extend_from_slice(content);
    out
}

/// The 32-byte account field the payload commits, decoded to `u64` by the verifier (first 8 LE bytes).
fn account32(account: u64) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..8].copy_from_slice(&account.to_le_bytes());
    a
}

/// Build a signed role-key CIP-8 proof: returns `(cose_sign1, cose_key, credential)`. `seed` selects
/// the (deterministic) role key — distinct seeds ⇒ distinct credentials.
fn build_proof(
    seed: [u8; 32],
    account: u64,
    genesis: [u8; 32],
    role: &str,
) -> (
    BoundedVec<u8, ConstU32<512>>,
    BoundedVec<u8, ConstU32<128>>,
    RoleCredential,
) {
    let pair = ed25519::Pair::from_seed(&seed);
    let public = pair.public();
    let pk: Vec<u8> = AsRef::<[u8]>::as_ref(&public).to_vec();
    let cred = blake2b_224(&pk);
    // synthetic enterprise address (0x60 = enterprise, network 0) over the role-key credential.
    let mut addr = vec![0x60u8];
    addr.extend_from_slice(&cred);
    // protected content: map(3){ alg(1):-8, kid(4):pubkey, "address":addr }.
    let mut prot = vec![0xa3u8, 0x01, 0x27, 0x04];
    prot.extend_from_slice(&bstr(&pk));
    prot.push(0x67); // text(7)
    prot.extend_from_slice(b"address");
    prot.extend_from_slice(&bstr(&addr));
    let protected_raw = bstr(&prot);
    let payload = format!(
        "cogno-chain/role/v1;genesis={};account={};nonce={};role={}",
        hexs(&genesis),
        hexs(&account32(account)),
        "ab".repeat(16),
        role,
    )
    .into_bytes();
    let payload_raw = bstr(&payload);
    // Sig_structure = 84 6a "Signature1" <protected_raw> 40 <payload_raw>.
    let mut ss = vec![0x84u8, 0x6a];
    ss.extend_from_slice(b"Signature1");
    ss.extend_from_slice(&protected_raw);
    ss.push(0x40);
    ss.extend_from_slice(&payload_raw);
    let signature = pair.sign(&ss);
    let sig: Vec<u8> = AsRef::<[u8]>::as_ref(&signature).to_vec();
    // cose_sign1 = 84 <protected_raw> a0 <payload_raw> <bstr sig>.
    let mut cose = vec![0x84u8];
    cose.extend_from_slice(&protected_raw);
    cose.push(0xa0);
    cose.extend_from_slice(&payload_raw);
    cose.extend_from_slice(&bstr(&sig));
    // cose_key = a4 kty(1):OKP(1) alg(3):-8 crv(-1):Ed25519(6) x(-2):bstr(pubkey).
    let mut key = vec![0xa4u8, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21];
    key.extend_from_slice(&bstr(&pk));
    (
        BoundedVec::try_from(cose).expect("cose_sign1 fits 512"),
        BoundedVec::try_from(key).expect("cose_key fits 128"),
        cred,
    )
}

/// Pin `BlockHash[0]` to `GENESIS` so the on-chain anti-cross-chain check passes.
fn set_genesis() {
    frame_system::BlockHash::<Test>::insert(0u64, sp_core::H256::from_slice(&GENESIS));
}

fn spo_proof(
    seed: u8,
    account: u64,
) -> (
    BoundedVec<u8, ConstU32<512>>,
    BoundedVec<u8, ConstU32<128>>,
    RoleCredential,
) {
    build_proof([seed; 32], account, GENESIS, "spo")
}

// ── claim path ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn claim_binds_both_ledgers_and_emits_event() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (cose, key, cred) = spo_proof(7, ALICE);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            cose,
            key
        ));
        assert_eq!(RoleClaimOf::<Test>::get(ALICE, RoleKind::Spo), Some(cred));
        assert_eq!(RoleCredIndex::<Test>::get(RoleKind::Spo, cred), Some(ALICE));
        assert_eq!(
            crate::Pallet::<Test>::claim_of(&ALICE, RoleKind::Spo),
            Some(cred)
        );
        System::assert_has_event(
            Event::RoleClaimed {
                who: ALICE,
                role: RoleKind::Spo,
                credential: cred,
            }
            .into(),
        );
    });
}

#[test]
fn claim_rejects_wrong_genesis() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // BlockHash[0] left at default (all-zero) — the proof commits GENESIS ⇒ anti-cross-chain reject.
        let (cose, key, _) = spo_proof(7, ALICE);
        assert_noop!(
            CardanoRoles::claim_role_signed(RuntimeOrigin::none(), cose, key),
            Error::<Test>::WrongGenesis
        );
    });
}

#[test]
fn claim_rejects_not_payment_bound() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        // Account 0 is "not onboarded" per MockGate ⇒ NotPaymentBound.
        let (cose, key, _) = spo_proof(7, UNBOUND);
        assert_noop!(
            CardanoRoles::claim_role_signed(RuntimeOrigin::none(), cose, key),
            Error::<Test>::NotPaymentBound
        );
    });
}

#[test]
fn claim_rejects_double_claim_same_account() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (cose1, key1, _) = spo_proof(7, ALICE);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            cose1,
            key1
        ));
        // A second SPO claim for ALICE (different key/credential) ⇒ AccountAlreadyClaimedRole.
        let (cose2, key2, _) = spo_proof(8, ALICE);
        assert_noop!(
            CardanoRoles::claim_role_signed(RuntimeOrigin::none(), cose2, key2),
            Error::<Test>::AccountAlreadyClaimedRole
        );
    });
}

#[test]
fn claim_rejects_double_claim_same_credential() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (cose1, key1, cred) = spo_proof(7, ALICE);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            cose1,
            key1
        ));
        // BOB proves the SAME Calidus key (same seed) ⇒ RoleCredAlreadyClaimed (credential side 1:1).
        let (cose2, key2, cred2) = spo_proof(7, BOB);
        assert_eq!(cred, cred2, "same seed ⇒ same credential");
        assert_noop!(
            CardanoRoles::claim_role_signed(RuntimeOrigin::none(), cose2, key2),
            Error::<Test>::RoleCredAlreadyClaimed
        );
    });
}

// ── unclaim / revoke ────────────────────────────────────────────────────────────────────────────────

#[test]
fn unclaim_removes_the_claim() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (cose, key, cred) = spo_proof(7, ALICE);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            cose,
            key
        ));
        assert_ok!(CardanoRoles::unclaim_role(
            RuntimeOrigin::signed(ALICE),
            RoleKind::Spo
        ));
        assert!(RoleClaimOf::<Test>::get(ALICE, RoleKind::Spo).is_none());
        assert!(RoleCredIndex::<Test>::get(RoleKind::Spo, cred).is_none());
        System::assert_has_event(
            Event::RoleUnclaimed {
                who: ALICE,
                role: RoleKind::Spo,
            }
            .into(),
        );
    });
}

#[test]
fn unclaim_rejects_when_not_claimed() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            CardanoRoles::unclaim_role(RuntimeOrigin::signed(ALICE), RoleKind::Spo),
            Error::<Test>::NotClaimed
        );
    });
}

#[test]
fn revoke_tombstones_and_blocks_reclaim() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (cose, key, cred) = spo_proof(7, ALICE);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            cose,
            key
        ));
        // Committee (root in the mock) revokes + tombstones.
        assert_ok!(CardanoRoles::revoke_role(
            RuntimeOrigin::root(),
            ALICE,
            RoleKind::Spo
        ));
        assert!(RoleClaimOf::<Test>::get(ALICE, RoleKind::Spo).is_none());
        assert!(TombstonedRoleCred::<Test>::contains_key(
            RoleKind::Spo,
            cred
        ));
        System::assert_has_event(
            Event::RoleRevoked {
                who: ALICE,
                role: RoleKind::Spo,
            }
            .into(),
        );
        // The same credential can never be re-claimed (ban-the-key), even by another account.
        let (cose2, key2, _) = spo_proof(7, BOB);
        assert_noop!(
            CardanoRoles::claim_role_signed(RuntimeOrigin::none(), cose2, key2),
            Error::<Test>::RoleCredTombstoned
        );
    });
}

#[test]
fn revoke_requires_authority_origin() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            CardanoRoles::revoke_role(RuntimeOrigin::signed(ALICE), BOB, RoleKind::Spo),
            DispatchError::BadOrigin
        );
    });
}

// ── the observed ledger (apply_roles — the observer's sink) ─────────────────────────────────────────

fn observed(kind: RoleKind, id: RoleCredential) -> ObservedRoleSet {
    ObservedRoleSet::try_from(vec![ObservedRole { kind, id }]).unwrap()
}

#[test]
fn apply_roles_writes_clears_and_is_idempotent() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        let pool_id: RoleCredential = [0x11u8; 28];
        let set = observed(RoleKind::Spo, pool_id);
        // First write: sets the observed set + emits RolesUpdated.
        crate::Pallet::<Test>::apply_roles(&ALICE, set.clone());
        assert_eq!(ObservedRoles::<Test>::get(ALICE), set);
        assert_eq!(
            crate::Pallet::<Test>::observed_roles(&ALICE),
            vec![ObservedRole {
                kind: RoleKind::Spo,
                id: pool_id
            }]
        );
        System::assert_has_event(
            Event::RolesUpdated {
                who: ALICE,
                roles: set.clone(),
            }
            .into(),
        );
        // Idempotent re-derive: same set ⇒ no state change, no new event.
        let events_before = System::events().len();
        crate::Pallet::<Test>::apply_roles(&ALICE, set);
        assert_eq!(System::events().len(), events_before, "no event on no-op");
        // Clamp to empty: clears the row.
        crate::Pallet::<Test>::apply_roles(&ALICE, ObservedRoleSet::default());
        assert!(ObservedRoles::<Test>::get(ALICE).is_empty());
        System::assert_has_event(
            Event::RolesUpdated {
                who: ALICE,
                roles: ObservedRoleSet::default(),
            }
            .into(),
        );
    });
}

#[test]
fn apply_roles_stores_multiple_spo_badges() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // A multi-pool operator: three distinct SPO badges + one dRep — all fit the grown
        // MAX_OBSERVED_ROLES_PER_ACCOUNT bound (formerly capped at one-per-kind = 3 total).
        let set = ObservedRoleSet::try_from(vec![
            ObservedRole {
                kind: RoleKind::Spo,
                id: [0x11u8; 28],
            },
            ObservedRole {
                kind: RoleKind::Spo,
                id: [0x22u8; 28],
            },
            ObservedRole {
                kind: RoleKind::Spo,
                id: [0x33u8; 28],
            },
            ObservedRole {
                kind: RoleKind::DRep,
                id: [0x44u8; 28],
            },
        ])
        .expect("four badges fit MAX_OBSERVED_ROLES_PER_ACCOUNT");
        crate::Pallet::<Test>::apply_roles(&ALICE, set.clone());
        assert_eq!(ObservedRoles::<Test>::get(ALICE), set);
        // observed_roles() returns all four (three SPO + one dRep), so the badge UI can render each pool.
        assert_eq!(crate::Pallet::<Test>::observed_roles(&ALICE).len(), 4);
        assert_eq!(
            crate::Pallet::<Test>::observed_roles(&ALICE)
                .iter()
                .filter(|r| r.kind == RoleKind::Spo)
                .count(),
            3,
        );
    });
}

#[test]
fn claimed_credentials_enumerates_the_scoping_set() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (c1, k1, cred1) = spo_proof(7, ALICE);
        let (c2, k2, cred2) = spo_proof(9, BOB);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            c1,
            k1
        ));
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            c2,
            k2
        ));
        let mut creds = crate::Pallet::<Test>::claimed_credentials(RoleKind::Spo);
        creds.sort();
        let mut want = vec![cred1, cred2];
        want.sort();
        assert_eq!(creds, want);
        // A role with no claims enumerates empty.
        assert!(crate::Pallet::<Test>::claimed_credentials(RoleKind::DRep).is_empty());
    });
}

// ── the feeless pool gate (validate_unsigned) ────────────────────────────────────────────────────────

fn validate(call: &Call<Test>) -> Result<(), TransactionValidityError> {
    <CardanoRoles as ValidateUnsigned>::validate_unsigned(TransactionSource::External, call)
        .map(|_| ())
}

#[test]
fn validate_unsigned_admits_a_valid_claim() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        let (cose_sign1, cose_key, _) = spo_proof(7, ALICE);
        let valid = <CardanoRoles as ValidateUnsigned>::validate_unsigned(
            TransactionSource::External,
            &Call::claim_role_signed {
                cose_sign1,
                cose_key,
            },
        )
        .expect("a valid claim is admitted");
        assert!(valid.propagate, "claims must gossip");
        assert!(
            !valid.provides.is_empty(),
            "a `provides` tag dedupes the claim"
        );
    });
}

#[test]
fn validate_unsigned_mirrors_dispatch_rejections() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        set_genesis();
        // wrong genesis (default BlockHash[0]) is a hard BadProof — reset genesis to break it.
        frame_system::BlockHash::<Test>::remove(0u64);
        let (cose_sign1, cose_key, _) = spo_proof(7, ALICE);
        assert_eq!(
            validate(&Call::claim_role_signed {
                cose_sign1,
                cose_key
            }),
            Err(InvalidTransaction::BadProof.into())
        );
        set_genesis();
        // not payment-bound ⇒ Custom(1)
        let (cose_sign1, cose_key, _) = spo_proof(7, UNBOUND);
        assert_eq!(
            validate(&Call::claim_role_signed {
                cose_sign1,
                cose_key
            }),
            Err(InvalidTransaction::Custom(1).into())
        );
        // already claimed ⇒ Stale
        let (cose_sign1, cose_key, _) = spo_proof(7, ALICE);
        assert_ok!(CardanoRoles::claim_role_signed(
            RuntimeOrigin::none(),
            cose_sign1.clone(),
            cose_key.clone()
        ));
        assert_eq!(
            validate(&Call::claim_role_signed {
                cose_sign1,
                cose_key
            }),
            Err(InvalidTransaction::Stale.into())
        );
    });
}

#[test]
fn validate_unsigned_refuses_origin_gated_calls() {
    new_test_ext().execute_with(|| {
        // unclaim/revoke are signed/origin-gated — never accepted unsigned.
        assert_eq!(
            validate(&Call::unclaim_role {
                role: RoleKind::Spo
            }),
            Err(InvalidTransaction::Call.into())
        );
        assert_eq!(
            validate(&Call::revoke_role {
                account: ALICE,
                role: RoleKind::Spo
            }),
            Err(InvalidTransaction::Call.into())
        );
    });
}
