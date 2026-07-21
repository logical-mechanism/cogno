//! CIP-0151 / CIP-88-v2 **Calidus pool-key registration** verification (transaction metadata label
//! **867**).
//!
//! An SPO authorizes a hot "Calidus" key by posting a one-time on-chain registration signed by the pool
//! COLD key. This module verifies that registration so the cardano-observer can trustlessly link a
//! claimed Calidus key to a pool — WITHOUT the pool ever exposing its cold key to cogno-chain.
//!
//! ## Consensus-critical + deterministic (a divergence is a chain FORK)
//! It runs over the **RAW on-chain metadata bytes** (`tx_metadata.bytes` in db-sync — NEVER the lossy,
//! version-dependent `json` column), so the signing preimage is hashed over the exact bytes the operator
//! signed, with no canonical-reconstruction step. Like the rest of `cogno-dbsync`, this IS the spec: the
//! node's observation InherentDataProvider and every importing validator run it identically, so it is
//! golden-fixture-pinned.
//!
//! ## What the pool cold key signs (CIP-88-v2 §"Signing")
//! The signing preimage is `blake2b-256(` the **RAW CBOR** of the Registration Payload object `)` — i.e.
//! `blake2b256( payload_cbor_bytes )` (confirmed against a real `cardano-signer sign --cip88` fixture; it
//! is NOT hex-encoded first). The Registration Payload map keys MUST be in numerical order. We capture the
//! payload's exact byte span from the raw registration and hash it verbatim, so we reproduce that preimage
//! byte-for-byte with no canonical-reconstruction step.
//!
//! ## Structure (label 867 metadata value)
//! ```text
//! { 0: 2 (version),
//!   1: { 1: [1, h'poolID28'],        // scope: [Pool(1), the 28-byte pool cold-key hash]
//!        2: [],                       // feature set (empty for pools)
//!        3: [0] or [2],               // validation method: [0] = bare Ed25519 / [2] = CIP-8 (COSE)
//!        4: <nonce uint>,             // highest-nonce-wins across a pool's registrations
//!        7: "<calidus pubkey hex64>"  // the authorized Calidus ed25519 key (hex text)
//!      },
//!   2: [ <witness> ]  // method [0]: { 0:type, 1:h'coldPubkey', 2:h'sig' } — method [2]: { 1:COSE_Key, 2:COSE_Sign1 }
//! }
//! ```
//!
//! ## Scope of THIS implementation
//! BOTH validation methods are implemented + tested:
//! - **`[0]` (bare Ed25519 witness)** — the cold key signs the preimage directly.
//! - **`[2]` (CIP-8 / COSE witness — `cardano-signer`'s default)** — the cold key signs a COSE
//!   `Sig_structure` whose payload is the preimage; verified with the same COSE machinery as the audited
//!   cogno-gate `cip8`. Pinned by a golden vector from a real `cardano-signer sign --cip88` (see tests).
//!
//! Any OTHER validation method id fails CLOSED (`UnsupportedValidationMethod`) — an unverifiable
//! registration is simply not linked.

use ed25519_dalek::{Signature, VerifyingKey};

/// The 28-byte pool ID = `blake2b_224(pool cold pubkey)`.
pub type PoolId = [u8; 28];
/// A 28-byte Cardano key hash (the Calidus-key hash a cogno-chain claim carries).
pub type KeyHash = [u8; 28];

/// A verified Calidus registration: the cold-key witness checked out over the exact signed preimage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalidusRegistration {
    /// The pool the registration is scoped to (`scope = [1, h'poolID']`), confirmed to equal
    /// `blake2b_224(cold pubkey)` — so the signer controls this pool's cold key.
    pub pool_id: PoolId,
    /// `blake2b_224(calidus pubkey)` — the credential a cogno-chain SPO claim carries. The observer
    /// links a claim to this pool iff the claim's credential equals this.
    pub calidus_key_hash: KeyHash,
    /// The registration nonce (`payload[4]`). Highest-nonce-wins selects the active registration when a
    /// pool has re-registered (rotated its Calidus key).
    pub nonce: u64,
}

/// Every failure mode is a typed, fail-closed reject — never a panic (a panic in the reduction would
/// halt the node).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalidusError {
    /// Ran off the end of a buffer.
    Truncated,
    /// A non-minimal / indefinite / reserved CBOR encoding (not canonical), or an unexpected major type.
    NonCanonical,
    /// Bytes left over after a complete structure.
    TrailingBytes,
    /// The label-867 metadata value has the wrong top-level shape (missing version / payload / witness).
    BadRegistration,
    /// The registration version is not `2` (CIP-0151).
    BadVersion,
    /// The Registration Payload object is malformed (bad scope / nonce / calidus key).
    BadPayload,
    /// The validation method id is neither `[0]` (bare Ed25519) nor `[2]` (CIP-8 / COSE) — an unknown
    /// method fails closed rather than being linked.
    UnsupportedValidationMethod,
    /// No witness in the array is the pool's cold key (`blake2b_224(pubkey) == poolID`) with a signature
    /// that verifies over the registration preimage.
    WitnessInvalid,
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Strict, total CBOR reader (definite lengths, minimal encodings, no panics, span-capturing). A close
// sibling of the cogno-gate cip8 reader, re-implemented here because cogno-dbsync must not depend on a
// pallet/runtime crate.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], CalidusError> {
        let end = self.pos.checked_add(n).ok_or(CalidusError::Truncated)?;
        let s = self.buf.get(self.pos..end).ok_or(CalidusError::Truncated)?;
        self.pos = end;
        Ok(s)
    }
    fn byte(&mut self) -> Result<u8, CalidusError> {
        self.take(1)?.first().copied().ok_or(CalidusError::Truncated)
    }
    /// Read a CBOR head → `(major_type, argument)`, enforcing minimal-length encoding and rejecting
    /// indefinite/reserved additional-info (28..=31).
    fn head(&mut self) -> Result<(u8, u64), CalidusError> {
        let ib = self.byte()?;
        let mt = ib >> 5;
        let ai = ib & 0x1f;
        let arg = match ai {
            0..=23 => u64::from(ai),
            24 => {
                let b = self.byte()?;
                if b < 24 {
                    return Err(CalidusError::NonCanonical);
                }
                u64::from(b)
            }
            25 => {
                let b = self.take(2)?;
                let v = u64::from(u16::from_be_bytes([b[0], b[1]]));
                if v <= u64::from(u8::MAX) {
                    return Err(CalidusError::NonCanonical);
                }
                v
            }
            26 => {
                let b = self.take(4)?;
                let mut a = [0u8; 4];
                a.copy_from_slice(b);
                let v = u64::from(u32::from_be_bytes(a));
                if v <= u64::from(u16::MAX) {
                    return Err(CalidusError::NonCanonical);
                }
                v
            }
            27 => {
                let b = self.take(8)?;
                let mut a = [0u8; 8];
                a.copy_from_slice(b);
                let v = u64::from_be_bytes(a);
                if v <= u64::from(u32::MAX) {
                    return Err(CalidusError::NonCanonical);
                }
                v
            }
            _ => return Err(CalidusError::NonCanonical),
        };
        Ok((mt, arg))
    }
    fn typed_head(&mut self, want: u8) -> Result<u64, CalidusError> {
        let (mt, arg) = self.head()?;
        if mt != want {
            return Err(CalidusError::NonCanonical);
        }
        Ok(arg)
    }
    fn uint(&mut self) -> Result<u64, CalidusError> {
        self.typed_head(0)
    }
    fn map_len(&mut self) -> Result<u64, CalidusError> {
        self.typed_head(5)
    }
    fn array_len(&mut self) -> Result<u64, CalidusError> {
        self.typed_head(4)
    }
    fn bytes(&mut self, max: usize) -> Result<&'a [u8], CalidusError> {
        let len = usize::try_from(self.typed_head(2)?).map_err(|_| CalidusError::Truncated)?;
        if len > max {
            return Err(CalidusError::Truncated);
        }
        self.take(len)
    }
    /// Read a bstr, returning `(raw encoding incl. head, content)`. The RAW span is spliced VERBATIM into
    /// the COSE `Sig_structure` (method-`[2]` witness), so the signature covers the exact on-chain bytes.
    fn bytes_raw(&mut self, max: usize) -> Result<(&'a [u8], &'a [u8]), CalidusError> {
        let start = self.pos;
        let content = self.bytes(max)?;
        let raw = self.buf.get(start..self.pos).ok_or(CalidusError::Truncated)?;
        Ok((raw, content))
    }
    /// Advance past one full CBOR item (recursively) — used to capture the payload/witness spans and to
    /// skip fields we don't consume. Total (no panics); rejects indefinite forms via `head`.
    fn skip_item(&mut self) -> Result<(), CalidusError> {
        let (mt, arg) = self.head()?;
        match mt {
            0 | 1 => Ok(()),                    // uint / nint — the head already consumed it
            2 | 3 => self.take(arg as usize).map(|_| ()), // bstr / text — skip the content
            4 => {
                for _ in 0..arg {
                    self.skip_item()?;
                }
                Ok(())
            }
            5 => {
                for _ in 0..arg {
                    self.skip_item()?; // key
                    self.skip_item()?; // value
                }
                Ok(())
            }
            6 => self.skip_item(), // tag — skip the tagged item
            7 => Ok(()),           // simple / float — the head consumed the payload
            _ => Err(CalidusError::NonCanonical),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Hashing / hex (deterministic primitives)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// blake2b-224 (28-byte Cardano key hash). Fail-closed to zeros on the impossible error path (28 is in
/// `1..=64`, so `Blake2bVar::new` never fails) — zeros never match a real poolID, so a hypothetical
/// failure rejects rather than panics.
fn blake2b_224(input: &[u8]) -> [u8; 28] {
    use blake2::digest::{Update, VariableOutput};
    let mut out = [0u8; 28];
    if let Ok(mut h) = blake2::Blake2bVar::new(28) {
        h.update(input);
        let _ = h.finalize_variable(&mut out);
    }
    out
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The verifier
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The parsed-but-unverified payload fields.
struct Payload {
    pool_id: PoolId,
    calidus_pubkey: [u8; 32],
    nonce: u64,
    /// The CIP-0151 validation method: `0` = bare Ed25519 witness, `2` = CIP-8 / COSE witness. Selects
    /// which witness verifier `verify_registration` runs.
    method: u8,
}

/// A registration parsed WITHOUT verifying the cold-key witness — the identity fields only. Used by the
/// reduction to group registrations by pool cheaply BEFORE the (more expensive) witness check.
///
/// ⚠ SECURITY: never select a highest-nonce "active" registration from `parse_registration` output — a
/// bogus high-nonce registration (an attacker scoping a pool they don't control) parses fine. Only
/// [`verify_registration`] output (witness-checked) may drive highest-nonce-wins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalidusParsed {
    pub pool_id: PoolId,
    pub calidus_key_hash: KeyHash,
    pub nonce: u64,
}

/// Parse the top-level registration → `(payload fields, payload byte-span, witness byte-span)`. Shared by
/// [`parse_registration`] (parse-only) and [`verify_registration`] (parse + witness).
fn parse_all(bytes: &[u8]) -> Result<(Payload, &[u8], &[u8]), CalidusError> {
    let mut r = Reader::new(bytes);
    let n = r.map_len()?;
    let mut version: Option<u64> = None;
    let mut payload_span: Option<(usize, usize)> = None;
    let mut witness_span: Option<(usize, usize)> = None;
    for _ in 0..n {
        let key = r.uint().map_err(|_| CalidusError::BadRegistration)?;
        match key {
            0 => version = Some(r.uint().map_err(|_| CalidusError::BadRegistration)?),
            1 => {
                let start = r.pos;
                r.skip_item()?;
                payload_span = Some((start, r.pos));
            }
            2 => {
                let start = r.pos;
                r.skip_item()?;
                witness_span = Some((start, r.pos));
            }
            _ => r.skip_item()?,
        }
    }
    if r.remaining() != 0 {
        return Err(CalidusError::TrailingBytes);
    }
    if version != Some(2) {
        return Err(CalidusError::BadVersion);
    }
    let (ps, pe) = payload_span.ok_or(CalidusError::BadRegistration)?;
    let (ws, we) = witness_span.ok_or(CalidusError::BadRegistration)?;
    let payload_bytes = bytes.get(ps..pe).ok_or(CalidusError::BadRegistration)?;
    let witness_bytes = bytes.get(ws..we).ok_or(CalidusError::BadRegistration)?;
    let payload = parse_payload(payload_bytes)?;
    Ok((payload, payload_bytes, witness_bytes))
}

/// Parse a CIP-0151 label-867 registration's identity fields WITHOUT verifying the witness (cheap).
pub fn parse_registration(metadata_867_bytes: &[u8]) -> Result<CalidusParsed, CalidusError> {
    let (payload, _, _) = parse_all(metadata_867_bytes)?;
    Ok(CalidusParsed {
        pool_id: payload.pool_id,
        calidus_key_hash: blake2b_224(&payload.calidus_pubkey),
        nonce: payload.nonce,
    })
}

/// Verify a CIP-0151 label-867 Calidus registration from the RAW metadata-value CBOR bytes (db-sync
/// `tx_metadata.bytes`). Returns the resolved `(pool_id, calidus_key_hash, nonce)` on a valid cold-key
/// witness, or a typed fail-closed reject. PURE — no IO, no panics.
pub fn verify_registration(metadata_867_bytes: &[u8]) -> Result<CalidusRegistration, CalidusError> {
    let (payload, payload_bytes, witness_bytes) = parse_all(metadata_867_bytes)?;
    // The CIP-0151 / CIP-88-v2 signing preimage: blake2b-256 of the RAW payload CBOR bytes (verified
    // against a real `cardano-signer` fixture — NOT a hex-encoding of them). We hash the exact on-chain
    // span verbatim, so there is no canonical-reconstruction step (a parser-differential would fork).
    let preimage = sp_crypto_hashing::blake2_256(payload_bytes);
    // Find a cold-key witness: its pubkey hashes to the scoped poolID AND its signature verifies over
    // the preimage (directly for method `[0]`; wrapped in a COSE `Sig_structure` for method `[2]`). The
    // witness array may hold several; any valid cold-key witness authorizes.
    let authorized = match payload.method {
        0 => witness_authorizes_ed25519(witness_bytes, &payload.pool_id, &preimage)?,
        2 => witness_authorizes_cose(witness_bytes, &payload.pool_id, &preimage)?,
        // parse_payload only admits 0 | 2, so this is unreachable — reject closed regardless.
        _ => return Err(CalidusError::UnsupportedValidationMethod),
    };
    if !authorized {
        return Err(CalidusError::WitnessInvalid);
    }
    Ok(CalidusRegistration {
        pool_id: payload.pool_id,
        calidus_key_hash: blake2b_224(&payload.calidus_pubkey),
        nonce: payload.nonce,
    })
}

/// Parse the Registration Payload map → `(poolID, calidus pubkey, nonce)`. Enforces the scope shape
/// `[1, h'poolID28']`, requires the validation method to be `[0]` (Ed25519; `[2]` ⇒ Unsupported), and
/// decodes the hex-text Calidus key. Feature-set + any CIP-details field are skipped.
fn parse_payload(bytes: &[u8]) -> Result<Payload, CalidusError> {
    let mut r = Reader::new(bytes);
    let n = r.map_len().map_err(|_| CalidusError::BadPayload)?;
    let mut pool_id: Option<PoolId> = None;
    let mut calidus: Option<[u8; 32]> = None;
    let mut nonce: Option<u64> = None;
    let mut method: Option<u8> = None;
    for _ in 0..n {
        let key = r.uint().map_err(|_| CalidusError::BadPayload)?;
        match key {
            // scope = [1, h'poolID28']
            1 => {
                if r.array_len().map_err(|_| CalidusError::BadPayload)? != 2 {
                    return Err(CalidusError::BadPayload);
                }
                if r.uint().map_err(|_| CalidusError::BadPayload)? != 1 {
                    return Err(CalidusError::BadPayload); // scope kind must be Pool(1)
                }
                let pool = r.bytes(28).map_err(|_| CalidusError::BadPayload)?;
                if pool.len() != 28 {
                    return Err(CalidusError::BadPayload);
                }
                let mut p = [0u8; 28];
                p.copy_from_slice(pool);
                pool_id = Some(p);
            }
            // validation method = [0] (bare Ed25519) | [2] (CIP-8 / COSE) — both verified; else unsupported.
            3 => {
                let arr = r.array_len().map_err(|_| CalidusError::BadPayload)?;
                if arr == 0 {
                    return Err(CalidusError::BadPayload);
                }
                let m = r.uint().map_err(|_| CalidusError::BadPayload)?;
                for _ in 1..arr {
                    r.skip_item()?;
                }
                match m {
                    0 | 2 => method = Some(m as u8),
                    _ => return Err(CalidusError::UnsupportedValidationMethod),
                }
            }
            // nonce
            4 => nonce = Some(r.uint().map_err(|_| CalidusError::BadPayload)?),
            // calidus key: a raw 32-byte BSTR — the form `cardano-signer` (the reference tool) writes
            // on-chain. Anything else (e.g. a hex text string) fails closed (a mis-encoded registration is
            // simply not linked), matching the reference exactly rather than guessing at variants.
            7 => {
                let b = r.bytes(32).map_err(|_| CalidusError::BadPayload)?;
                if b.len() != 32 {
                    return Err(CalidusError::BadPayload);
                }
                let mut k = [0u8; 32];
                k.copy_from_slice(b);
                calidus = Some(k);
            }
            // feature-set (2), cip-details (6), or any unknown field — skip.
            _ => r.skip_item()?,
        }
    }
    if r.remaining() != 0 {
        return Err(CalidusError::BadPayload);
    }
    Ok(Payload {
        pool_id: pool_id.ok_or(CalidusError::BadPayload)?,
        calidus_pubkey: calidus.ok_or(CalidusError::BadPayload)?,
        nonce: nonce.ok_or(CalidusError::BadPayload)?,
        method: method.ok_or(CalidusError::BadPayload)?, // the validation method is required
    })
}

/// Method-`[0]`: does any witness in the array authorize the registration? A witness authorizes iff it is
/// the pool's COLD key — `blake2b_224(pubkey) == poolID` — AND its Ed25519 signature verifies over
/// `preimage` DIRECTLY. Each witness is the v2 map form `{ 0: type, 1: h'pubkey32', 2: h'sig64' }`
/// (extra keys tolerated).
fn witness_authorizes_ed25519(
    bytes: &[u8],
    pool_id: &PoolId,
    preimage: &[u8; 32],
) -> Result<bool, CalidusError> {
    let mut r = Reader::new(bytes);
    let count = r.array_len().map_err(|_| CalidusError::BadRegistration)?;
    for _ in 0..count {
        let (pubkey, sig) = parse_witness(&mut r)?;
        if blake2b_224(&pubkey) != *pool_id {
            continue; // not the pool's cold key
        }
        let vk = match VerifyingKey::from_bytes(&pubkey) {
            Ok(vk) => vk,
            Err(_) => continue,
        };
        let signature = Signature::from_bytes(&sig);
        if vk.verify_strict(preimage, &signature).is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Parse one v2 witness map, returning `(pubkey32, sig64)`. Requires keys `1` (pubkey bstr 32) and `2`
/// (sig bstr 64); key `0` (witness type) and any other key are skipped.
fn parse_witness(r: &mut Reader<'_>) -> Result<([u8; 32], [u8; 64]), CalidusError> {
    let n = r.map_len().map_err(|_| CalidusError::BadRegistration)?;
    let mut pubkey: Option<[u8; 32]> = None;
    let mut sig: Option<[u8; 64]> = None;
    for _ in 0..n {
        let key = r.uint().map_err(|_| CalidusError::BadRegistration)?;
        match key {
            1 => {
                let b = r.bytes(32).map_err(|_| CalidusError::BadRegistration)?;
                if b.len() != 32 {
                    return Err(CalidusError::BadRegistration);
                }
                let mut k = [0u8; 32];
                k.copy_from_slice(b);
                pubkey = Some(k);
            }
            2 => {
                let b = r.bytes(64).map_err(|_| CalidusError::BadRegistration)?;
                if b.len() != 64 {
                    return Err(CalidusError::BadRegistration);
                }
                let mut s = [0u8; 64];
                s.copy_from_slice(b);
                sig = Some(s);
            }
            _ => r.skip_item()?,
        }
    }
    Ok((
        pubkey.ok_or(CalidusError::BadRegistration)?,
        sig.ok_or(CalidusError::BadRegistration)?,
    ))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Method-[2] (CIP-8 / COSE) witness — cardano-signer's default. Each witness in the array is a map
// `{ 1: COSE_Key, 2: COSE_Sign1 }` where the COSE_Sign1 is `[protected, unprotected, payload, sig]` and
// the signed payload is the registration preimage. Mirrors the audited cogno-gate `cip8` COSE machinery
// (same `Sig_structure`), re-implemented here so cogno-dbsync stays free of a pallet dependency.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Method-`[2]`: does any COSE witness authorize the registration? A witness authorizes iff its COSE_Key
/// holds the pool's COLD key (`blake2b_224(pubkey) == poolID`) AND its COSE_Sign1 Ed25519 signature
/// verifies over the COSE `Sig_structure` whose payload is EXACTLY the registration `preimage`.
fn witness_authorizes_cose(
    bytes: &[u8],
    pool_id: &PoolId,
    preimage: &[u8; 32],
) -> Result<bool, CalidusError> {
    let mut r = Reader::new(bytes);
    let count = r.array_len().map_err(|_| CalidusError::BadRegistration)?;
    for _ in 0..count {
        if cose_witness_authorizes_one(&mut r, pool_id, preimage)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Parse + check ONE COSE witness map, advancing `r` past it. Returns `Ok(true)` iff it is a valid
/// cold-key COSE signature over the preimage; `Ok(false)` if it is well-formed but not authorizing (wrong
/// key / different payload / bad signature); `Err` only on a structurally-malformed witness (fail closed).
fn cose_witness_authorizes_one(
    r: &mut Reader<'_>,
    pool_id: &PoolId,
    preimage: &[u8; 32],
) -> Result<bool, CalidusError> {
    let n = r.map_len().map_err(|_| CalidusError::BadRegistration)?;
    let mut cold_pubkey: Option<[u8; 32]> = None;
    let mut sig_structure: Option<Vec<u8>> = None;
    let mut signature: Option<[u8; 64]> = None;
    let mut payload_matches_preimage = false;
    for _ in 0..n {
        let key = r.uint().map_err(|_| CalidusError::BadRegistration)?;
        match key {
            // 1: COSE_Key → the cold public key (label -2).
            1 => cold_pubkey = Some(parse_cose_key_pubkey(r)?),
            // 2: COSE_Sign1 `[protected, unprotected, payload, sig]`.
            2 => {
                let (protected_raw, payload_raw, payload, sig) = parse_cose_sign1(r)?;
                payload_matches_preimage = payload == &preimage[..];
                sig_structure = Some(cose_sig_structure(protected_raw, payload_raw));
                signature = Some(sig);
            }
            _ => r.skip_item()?,
        }
    }
    let (cold_pubkey, sig_structure, sig) = match (cold_pubkey, sig_structure, signature) {
        (Some(pk), Some(ss), Some(s)) => (pk, ss, s),
        _ => return Ok(false), // missing the COSE_Key or COSE_Sign1 — not an authorizing witness
    };
    // The signed COSE payload must BE this registration's preimage; else the signature covers a different
    // message and cannot authorize (anti-replay).
    if !payload_matches_preimage {
        return Ok(false);
    }
    if blake2b_224(&cold_pubkey) != *pool_id {
        return Ok(false); // not the pool's cold key
    }
    let vk = match VerifyingKey::from_bytes(&cold_pubkey) {
        Ok(vk) => vk,
        Err(_) => return Ok(false),
    };
    let signature = Signature::from_bytes(&sig);
    Ok(vk.verify_strict(&sig_structure, &signature).is_ok())
}

/// Extract the OKP public key (COSE_Key label `-2`) from a COSE_Key map, skipping the other labels
/// (`1` kty, `3` alg, `-1` crv). The signature binds the key material, so the label values need no
/// separate validation — a wrong curve/alg simply yields a signature that does not verify.
fn parse_cose_key_pubkey(r: &mut Reader<'_>) -> Result<[u8; 32], CalidusError> {
    let n = r.map_len().map_err(|_| CalidusError::BadRegistration)?;
    let mut pubkey: Option<[u8; 32]> = None;
    for _ in 0..n {
        let (kmt, karg) = r.head().map_err(|_| CalidusError::BadRegistration)?;
        // Label -2 (the OKP x-coordinate = the public key) is a negative int: major type 1, argument 1.
        if kmt == 1 && karg == 1 {
            let b = r.bytes(32).map_err(|_| CalidusError::BadRegistration)?;
            if b.len() != 32 {
                return Err(CalidusError::BadRegistration);
            }
            let mut k = [0u8; 32];
            k.copy_from_slice(b);
            pubkey = Some(k);
        } else if kmt == 0 || kmt == 1 {
            r.skip_item()?; // an int label we don't consume (kty / alg / crv) — skip its value
        } else {
            return Err(CalidusError::BadRegistration); // a non-int COSE_Key label — malformed
        }
    }
    pubkey.ok_or(CalidusError::BadRegistration)
}

/// Parse a COSE_Sign1 array `[protected, unprotected, payload, sig]`, advancing `r`. Returns the RAW
/// `protected` + `payload` bstr encodings (spliced verbatim into the `Sig_structure`), the payload
/// content (checked against the preimage by the caller), and the 64-byte signature. The unprotected
/// header is skipped (the CIP-88-v2 metadata form encodes it as `0`; a real map is also accepted).
#[allow(clippy::type_complexity)]
fn parse_cose_sign1<'a>(
    r: &mut Reader<'a>,
) -> Result<(&'a [u8], &'a [u8], &'a [u8], [u8; 64]), CalidusError> {
    if r.array_len().map_err(|_| CalidusError::BadRegistration)? != 4 {
        return Err(CalidusError::BadRegistration);
    }
    let (protected_raw, _protected) = r.bytes_raw(256).map_err(|_| CalidusError::BadRegistration)?;
    r.skip_item()?; // unprotected header (`0` in the metadata form, or a map) — not signed material
    let (payload_raw, payload) = r.bytes_raw(64).map_err(|_| CalidusError::BadRegistration)?;
    let sb = r.bytes(64).map_err(|_| CalidusError::BadRegistration)?;
    if sb.len() != 64 {
        return Err(CalidusError::BadRegistration);
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(sb);
    Ok((protected_raw, payload_raw, payload, sig))
}

/// Build the COSE `Sig_structure` the Ed25519 signature covers: `[ "Signature1", protected, h'', payload ]`.
/// `protected_raw` and `payload_raw` are spliced VERBATIM (the exact on-chain bstr encodings), and the
/// external_aad is the fixed empty bstr — byte-identical to the audited cogno-gate `cip8::sig_structure`.
fn cose_sig_structure(protected_raw: &[u8], payload_raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(13 + protected_raw.len() + 1 + payload_raw.len());
    out.push(0x84); // array(4)
    out.push(0x6a); // text(10)
    out.extend_from_slice(b"Signature1");
    out.extend_from_slice(protected_raw);
    out.push(0x40); // bstr(0) — empty external_aad
    out.extend_from_slice(payload_raw);
    out
}

#[cfg(test)]
mod tests;
