//! Tests for the CIP-0151 Calidus registration verifier.
//!
//! Two layers:
//! - **Hand-made method-`[0]` registrations**: a small CBOR writer builds the exact label-867 structure
//!   this module documents, and an `ed25519-dalek` cold key signs the CIP-0151 preimage
//!   (`blake2b256(hex(payload_cbor))`). This validates the signing round-trip, the pool/Calidus
//!   extraction, and the fail-closed rejects against our reading of the spec.
//! - **A real method-`[2]` (CIP-8 / COSE) golden vector** from `cardano-signer sign --cip88` (v1.35.0),
//!   generated with throwaway keys — [`verifies_a_real_cardano_signer_method2_registration`]. This pins
//!   the method-`[2]` spec reading against the reference implementation.

use super::*;
use ed25519_dalek::{Signer, SigningKey};

/// Decode a lowercase-hex string to bytes (test helper for the golden vector).
fn hx(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "hex must be even length");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("valid hex"))
        .collect()
}

/// A real `cardano-signer sign --cip88` (v1.35.0) Calidus registration — the label-867 metadata VALUE
/// (as db-sync's `tx_metadata.bytes` stores it), method `[2]` (CIP-8 / COSE witness). Throwaway keys.
const REAL_METHOD2_867_VALUE: &str = "a3000201a5018201581cbeaad33b3c9c9926cedf68d430c34db765089624f9b722842c5c919f028003810204193039075820a428f1b460475af12e5690ea28d8f3ea5ef8e88589f936b9876b8426a01bf49c0281a201a4010103272006215820cbf13d31fcf80d8248e8ce24ae0461c48684cb92c88eb0fddbc060c25ca3cb1402845829a201276761646472657373581cbeaad33b3c9c9926cedf68d430c34db765089624f9b722842c5c919f005820bcba75e88c8d54a9a783b322621f529e42e1885f91c62da5a95bdcf3f7dc16aa5840021949b01ed092e2692df6a5d4cc49308c9f4a3e9b750fd250a28b18bf2bba027551cec33f06e18ba37ed166f84f7dd35a6a02b828b07d17ef640414af7d7f08";

// ── a minimal deterministic CBOR writer (definite lengths, minimal heads) ────────────────────────────

fn head(major: u8, arg: u64) -> Vec<u8> {
    let mt = major << 5;
    if arg <= 23 {
        vec![mt | arg as u8]
    } else if arg <= 0xff {
        vec![mt | 24, arg as u8]
    } else if arg <= 0xffff {
        let a = arg as u16;
        vec![mt | 25, (a >> 8) as u8, a as u8]
    } else if arg <= 0xffff_ffff {
        let mut v = vec![mt | 26];
        v.extend_from_slice(&(arg as u32).to_be_bytes());
        v
    } else {
        let mut v = vec![mt | 27];
        v.extend_from_slice(&arg.to_be_bytes());
        v
    }
}
fn c_uint(n: u64) -> Vec<u8> {
    head(0, n)
}
fn c_bstr(b: &[u8]) -> Vec<u8> {
    let mut v = head(2, b.len() as u64);
    v.extend_from_slice(b);
    v
}
fn c_arr(items: &[Vec<u8>]) -> Vec<u8> {
    let mut v = head(4, items.len() as u64);
    for it in items {
        v.extend_from_slice(it);
    }
    v
}
fn c_map(pairs: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    let mut v = head(5, pairs.len() as u64);
    for (k, val) in pairs {
        v.extend_from_slice(k);
        v.extend_from_slice(val);
    }
    v
}

// ── the hand-made registration ───────────────────────────────────────────────────────────────────────

struct Reg {
    version: u64,
    scope_pool: [u8; 28],
    method: u64,
    nonce: u64,
    calidus_pk: [u8; 32],
    witnesses: Vec<([u8; 32], [u8; 64])>,
}

/// The Registration Payload CBOR — built identically for signing (preimage) and encoding, so the
/// cold-key signature is over exactly the bytes that appear on-chain. Key 7 (the Calidus key) is a raw
/// 32-byte bstr, matching `cardano-signer`'s on-chain form.
fn encode_payload(reg: &Reg) -> Vec<u8> {
    c_map(&[
        (c_uint(1), c_arr(&[c_uint(1), c_bstr(&reg.scope_pool)])),
        (c_uint(2), c_arr(&[])),
        (c_uint(3), c_arr(&[c_uint(reg.method)])),
        (c_uint(4), c_uint(reg.nonce)),
        (c_uint(7), c_bstr(&reg.calidus_pk)),
    ])
}

fn encode(reg: &Reg) -> Vec<u8> {
    let payload = encode_payload(reg);
    let witnesses: Vec<Vec<u8>> = reg
        .witnesses
        .iter()
        .map(|(pk, sig)| {
            c_map(&[
                (c_uint(0), c_uint(0)),
                (c_uint(1), c_bstr(pk)),
                (c_uint(2), c_bstr(sig)),
            ])
        })
        .collect();
    c_map(&[
        (c_uint(0), c_uint(reg.version)),
        (c_uint(1), payload),
        (c_uint(2), c_arr(&witnesses)),
    ])
}

/// The CIP-88-v2 preimage for a payload: `blake2b256(raw payload_cbor)`.
fn preimage_of(reg: &Reg) -> [u8; 32] {
    sp_crypto_hashing::blake2_256(&encode_payload(reg))
}

/// An HONEST registration: `scope_pool = blake2b_224(cold pubkey)`, one cold-key witness signing the
/// preimage. Returns `(reg, expected pool_id, expected calidus_key_hash)`.
fn honest(cold_seed: [u8; 32], calidus_seed: [u8; 32], nonce: u64) -> (Reg, [u8; 28], [u8; 28]) {
    let cold = SigningKey::from_bytes(&cold_seed);
    let cold_pk = cold.verifying_key().to_bytes();
    let calidus = SigningKey::from_bytes(&calidus_seed);
    let calidus_pk = calidus.verifying_key().to_bytes();
    let pool_id = blake2b_224(&cold_pk);
    let calidus_hash = blake2b_224(&calidus_pk);
    let mut reg = Reg {
        version: 2,
        scope_pool: pool_id,
        method: 0,
        nonce,
        calidus_pk,
        witnesses: vec![],
    };
    let sig = cold.sign(&preimage_of(&reg)).to_bytes();
    reg.witnesses = vec![(cold_pk, sig)];
    (reg, pool_id, calidus_hash)
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn verifies_a_handmade_ed25519_registration() {
    let (reg, pool_id, calidus_hash) = honest([1u8; 32], [2u8; 32], 12345);
    let got = verify_registration(&encode(&reg)).expect("an honest registration verifies");
    assert_eq!(got.pool_id, pool_id, "resolves the scoped pool ID");
    assert_eq!(
        got.calidus_key_hash, calidus_hash,
        "resolves the Calidus key hash (the claim credential)"
    );
    assert_eq!(got.nonce, 12345, "reports the nonce for highest-nonce-wins");
}

#[test]
fn rejects_a_tampered_witness_signature() {
    let (mut reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    reg.witnesses[0].1[10] ^= 0x01; // flip a signature bit
    assert_eq!(
        verify_registration(&encode(&reg)),
        Err(CalidusError::WitnessInvalid)
    );
}

#[test]
fn rejects_an_impostor_witness_key() {
    // The scope names pool A (cold_a), but the witness is cold_b — signing the SAME preimage. Since
    // blake2b_224(cold_b) != poolID_A, no witness authorizes ⇒ WitnessInvalid.
    let (mut reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    let imposter = SigningKey::from_bytes(&[9u8; 32]);
    let imposter_sig = imposter.sign(&preimage_of(&reg)).to_bytes();
    reg.witnesses = vec![(imposter.verifying_key().to_bytes(), imposter_sig)];
    assert_eq!(
        verify_registration(&encode(&reg)),
        Err(CalidusError::WitnessInvalid)
    );
}

#[test]
fn rejects_a_payload_tampered_after_signing() {
    // Bump the nonce AFTER signing ⇒ the payload span (hence preimage) changes, so the cold-key
    // signature no longer verifies ⇒ WitnessInvalid (the signature binds the exact payload bytes).
    let (mut reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    reg.nonce = 2;
    assert_eq!(
        verify_registration(&encode(&reg)),
        Err(CalidusError::WitnessInvalid)
    );
}

#[test]
fn rejects_an_unknown_validation_method() {
    // Only [0] (Ed25519) and [2] (CIP-8/COSE) are known; any other id fails closed.
    let (mut reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    reg.method = 1;
    assert_eq!(
        verify_registration(&encode(&reg)),
        Err(CalidusError::UnsupportedValidationMethod)
    );
}

#[test]
fn verifies_a_real_cardano_signer_method2_registration() {
    // The golden vector: a real `cardano-signer sign --cip88` method-[2] registration verifies, and we
    // extract the same pool ID + Calidus key hash + nonce cardano-signer reported. This pins the whole
    // method-[2] COSE reading (COSE_Key pubkey, COSE_Sign1, Sig_structure) against the reference tool.
    let value = hx(REAL_METHOD2_867_VALUE);
    let got = verify_registration(&value).expect("a real method-[2] registration verifies");
    assert_eq!(
        got.pool_id,
        hx("beaad33b3c9c9926cedf68d430c34db765089624f9b722842c5c919f").as_slice(),
        "resolves the scoped pool ID (blake2b_224 of the cold key)",
    );
    assert_eq!(
        got.calidus_key_hash,
        hx("9d71b60eca3a0807158889d570fa1105ae3106bce4aa8c14e74f53ed").as_slice(),
        "resolves the Calidus key hash (the claim credential)",
    );
    assert_eq!(got.nonce, 12345);
}

#[test]
fn rejects_a_tampered_real_method2_signature() {
    // Flip the last byte of the golden vector (inside the 64-byte COSE signature) ⇒ the COSE signature no
    // longer verifies over the Sig_structure ⇒ WitnessInvalid (fails closed, never a false positive).
    let mut value = hx(REAL_METHOD2_867_VALUE);
    let last = value.len() - 1;
    value[last] ^= 0x01;
    assert_eq!(
        verify_registration(&value),
        Err(CalidusError::WitnessInvalid)
    );
}

#[test]
fn rejects_a_bad_version() {
    let (mut reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    reg.version = 1;
    assert_eq!(
        verify_registration(&encode(&reg)),
        Err(CalidusError::BadVersion)
    );
}

#[test]
fn rejects_trailing_bytes() {
    let (reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    let mut bytes = encode(&reg);
    bytes.push(0x00);
    assert_eq!(
        verify_registration(&bytes),
        Err(CalidusError::TrailingBytes)
    );
}

#[test]
fn rejects_indefinite_length_cbor() {
    // A raw indefinite-length map header (0xbf) must be rejected by the strict reader, never looped on.
    assert_eq!(
        verify_registration(&[0xbf, 0xff]),
        Err(CalidusError::NonCanonical)
    );
}

#[test]
fn distinct_calidus_keys_yield_distinct_credentials() {
    let (reg1, _, h1) = honest([1u8; 32], [2u8; 32], 1);
    let (reg2, _, h2) = honest([1u8; 32], [3u8; 32], 1); // same pool, rotated Calidus key
    assert_ne!(h1, h2);
    assert_eq!(verify_registration(&encode(&reg1)).unwrap().calidus_key_hash, h1);
    assert_eq!(verify_registration(&encode(&reg2)).unwrap().calidus_key_hash, h2);
}
