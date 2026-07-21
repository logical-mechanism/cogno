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
//! ## What the pool cold key signs (CIP-0151 §"Signing")
//! The signing payload is `blake2b-256(` the **hex-encoded CBOR** of the Registration Payload object `)`
//! — i.e. `blake2b256( ascii_lowercase_hex( payload_cbor_bytes ) )`. The Registration Payload map keys
//! MUST be in numerical order. We capture the payload's exact byte span from the raw registration and
//! hash it verbatim, so we reproduce that preimage byte-for-byte.
//!
//! ## Structure (label 867 metadata value)
//! ```text
//! { 0: 2 (version),
//!   1: { 1: [1, h'poolID28'],        // scope: [Pool(1), the 28-byte pool cold-key hash]
//!        2: [],                       // feature set (empty for pools)
//!        3: [0],                      // validation method: [0] = Ed25519 (this module) / [2] = CIP-8 (TODO)
//!        4: <nonce uint>,             // highest-nonce-wins across a pool's registrations
//!        7: "<calidus pubkey hex64>"  // the authorized Calidus ed25519 key (hex text)
//!      },
//!   2: [ { 0: <type>, 1: h'coldPubkey32', 2: h'sig64' } ]  // witness array (Ed25519, v2 map form)
//! }
//! ```
//!
//! ## Scope of THIS implementation
//! Validation method **`[0]` (bare Ed25519 witness)** is implemented + tested against a hand-made
//! fixture. Method **`[2]` (CIP-8 / COSE witness — `cardano-signer`'s default)** is a documented
//! `Unsupported` reject pending a real `cardano-signer` golden fixture, so it fails CLOSED (an
//! unverifiable registration is simply not linked). See [`CalidusError::UnsupportedValidationMethod`].

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
    /// The validation method is `[2]` (CIP-8/COSE) — not yet supported (fails closed pending a real
    /// `cardano-signer` fixture), or an unknown method id.
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
    fn text(&mut self, max: usize) -> Result<&'a [u8], CalidusError> {
        let len = usize::try_from(self.typed_head(3)?).map_err(|_| CalidusError::Truncated)?;
        if len > max {
            return Err(CalidusError::Truncated);
        }
        self.take(len)
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

/// Lowercase-hex-encode `bytes` as ASCII — the "hex-encoded CBOR" the CIP-0151 signing preimage hashes.
fn hex_lower_ascii(bytes: &[u8]) -> Vec<u8> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 0x0f) as usize]);
    }
    out
}

/// Decode exactly `N` bytes from a `2N`-char lowercase-hex ASCII slice (the Calidus key is stored as a
/// hex text string). Rejects uppercase / non-hex / wrong length.
fn hex_decode<const N: usize>(s: &[u8]) -> Result<[u8; N], CalidusError> {
    if s.len() != N * 2 {
        return Err(CalidusError::BadPayload);
    }
    let mut out = [0u8; N];
    for (i, chunk) in s.chunks_exact(2).enumerate() {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}
fn hex_nibble(c: u8) -> Result<u8, CalidusError> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err(CalidusError::BadPayload),
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The verifier
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The parsed-but-unverified payload fields.
struct Payload {
    pool_id: PoolId,
    calidus_pubkey: [u8; 32],
    nonce: u64,
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
    // The CIP-0151 signing preimage: blake2b-256 of the hex-encoded payload CBOR.
    let preimage = sp_crypto_hashing::blake2_256(&hex_lower_ascii(payload_bytes));
    // Find a cold-key witness: its pubkey hashes to the scoped poolID AND its signature verifies over
    // the preimage. (The witness array may hold several; any valid cold-key witness authorizes.)
    if !witness_authorizes(witness_bytes, &payload.pool_id, &preimage)? {
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
    let mut method_seen = false;
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
            // validation method = [0] (Ed25519) | [2] (CIP-8/COSE — unsupported here)
            3 => {
                let arr = r.array_len().map_err(|_| CalidusError::BadPayload)?;
                if arr == 0 {
                    return Err(CalidusError::BadPayload);
                }
                let m = r.uint().map_err(|_| CalidusError::BadPayload)?;
                for _ in 1..arr {
                    r.skip_item()?;
                }
                if m != 0 {
                    return Err(CalidusError::UnsupportedValidationMethod);
                }
                method_seen = true;
            }
            // nonce
            4 => nonce = Some(r.uint().map_err(|_| CalidusError::BadPayload)?),
            // calidus key: a hex text string (64 chars → 32 bytes)
            7 => {
                let t = r.text(64).map_err(|_| CalidusError::BadPayload)?;
                calidus = Some(hex_decode::<32>(t)?);
            }
            // feature-set (2), cip-details (6), or any unknown field — skip.
            _ => r.skip_item()?,
        }
    }
    if r.remaining() != 0 {
        return Err(CalidusError::BadPayload);
    }
    if !method_seen {
        return Err(CalidusError::BadPayload); // the validation method is required
    }
    Ok(Payload {
        pool_id: pool_id.ok_or(CalidusError::BadPayload)?,
        calidus_pubkey: calidus.ok_or(CalidusError::BadPayload)?,
        nonce: nonce.ok_or(CalidusError::BadPayload)?,
    })
}

/// Does any witness in the array authorize the registration? A witness authorizes iff it is the pool's
/// COLD key — `blake2b_224(pubkey) == poolID` — AND its Ed25519 signature verifies over `preimage`.
/// Each witness is the v2 map form `{ 0: type, 1: h'pubkey32', 2: h'sig64' }` (extra keys tolerated).
fn witness_authorizes(
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

#[cfg(test)]
mod tests;
