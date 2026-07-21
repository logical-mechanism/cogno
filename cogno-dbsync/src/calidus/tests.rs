//! Tests for the CIP-0151 Calidus registration verifier.
//!
//! No real `cardano-signer` fixture exists yet, so these use a HAND-MADE registration: a small CBOR
//! writer builds the exact label-867 structure this module documents, and an `ed25519-dalek` cold key
//! signs the CIP-0151 preimage (`blake2b256(hex(payload_cbor))`). This validates the signing round-trip,
//! the pool/Calidus extraction, and the fail-closed rejects against our reading of the spec. When a real
//! `cardano-signer` fixture lands, add it here as a golden vector to confirm the spec reading itself
//! (and to drive the method-`[2]` COSE path).

use super::*;
use ed25519_dalek::{Signer, SigningKey};

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
fn c_text(s: &[u8]) -> Vec<u8> {
    let mut v = head(3, s.len() as u64);
    v.extend_from_slice(s);
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
    calidus_hex: Vec<u8>,
    witnesses: Vec<([u8; 32], [u8; 64])>,
}

/// The Registration Payload CBOR — built identically for signing (preimage) and encoding, so the
/// cold-key signature is over exactly the bytes that appear on-chain.
fn encode_payload(reg: &Reg) -> Vec<u8> {
    c_map(&[
        (c_uint(1), c_arr(&[c_uint(1), c_bstr(&reg.scope_pool)])),
        (c_uint(2), c_arr(&[])),
        (c_uint(3), c_arr(&[c_uint(reg.method)])),
        (c_uint(4), c_uint(reg.nonce)),
        (c_uint(7), c_text(&reg.calidus_hex)),
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

/// The CIP-0151 preimage for a payload: `blake2b256(ascii_lowercase_hex(payload_cbor))`.
fn preimage_of(reg: &Reg) -> [u8; 32] {
    sp_crypto_hashing::blake2_256(&hex_lower_ascii(&encode_payload(reg)))
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
        calidus_hex: hex_lower_ascii(&calidus_pk),
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
fn rejects_method_2_as_unsupported() {
    let (mut reg, _, _) = honest([1u8; 32], [2u8; 32], 1);
    reg.method = 2; // CIP-8/COSE — not yet supported (fails closed)
    assert_eq!(
        verify_registration(&encode(&reg)),
        Err(CalidusError::UnsupportedValidationMethod)
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
