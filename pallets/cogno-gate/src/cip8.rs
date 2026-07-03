//! On-chain CIP-8 (COSE_Sign1) identity self-proof verifier — the trustless D1 core.
//!
//! Replaces the trusted off-chain follower (`services/cogno-follower/verify.py`): a user submits the
//! `signData` output their Cardano wallet produced over the pinned bind payload, and THIS runtime code
//! cryptographically verifies it — no trusted writer. The whole verifier is a PURE function over byte
//! slices ([`verify_bind_proof`]); the pallet wraps it with the genesis / tombstone / 1:1 checks.
//!
//! ## What it proves (mirrors verify.py, made on-chain)
//! 1. The Ed25519 signature is valid over the COSE `Sig_structure` (`sp_io::crypto::ed25519_verify`).
//! 2. The verifying key (the COSE_Key `-2` field, the SINGLE key source) hashes (blake2b-224) to the
//!    address's payment credential — so the signer controls the address (verify.py's `addresses_match`).
//! 3. The address is a VerificationKey-payment base/enterprise address on the configured network
//!    (rejects script-payment, pointer, stake-only, Byron, wrong-network — verify.py:70/76).
//! 4. The identity = `blake2b_256(plutus_data_cbor(owner Address))` reproduced BYTE-EXACT (the L1 beacon
//!    name, `services/cogno-follower/beacon.py`) so a bind matches an observed vault.
//! 5. The signed payload is exactly `cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>`
//!    (`payload.py`); the caller checks `genesis` == the chain genesis and binds the committed `account`.
//!
//! ## Security invariants (from the adversarial threat-model — every one is load-bearing)
//! - **Single key source.** The verification key is the COSE_Key `-2` ONLY; it is the SAME 32 bytes
//!   ed25519-verified AND blake2b-224-hashed for the address bind. If the protected header carries a KID,
//!   it must equal it byte-for-byte. (Closes the "verify one key, hash another" forge.)
//! - **Verbatim Sig_structure.** `protected_bstr` and `payload_bstr` are spliced into the Sig_structure
//!   as the EXACT wire bytes (head + content) the wallet signed — NEVER re-encoded. The address is parsed
//!   out of those same bytes in place. (Closes the COSE parser-differential.)
//! - **Strict canonical CBOR.** Definite lengths, minimal-length encodings, no indefinite forms, no
//!   duplicate map keys, no trailing bytes — every reader is TOTAL (checked access, no panics; the wasm
//!   runtime builds with overflow-checks OFF, so a panic on attacker input would halt block import).
//! - **Reject `hashed:true`, detached payloads, non-empty external_aad** (external_aad is hard-coded h'').
//! - **32-byte keys only** (reject 64-byte extended keys — one rule, no truncation).
//!
//! ⚠ MAINNET PREREQUISITE: this verifier is the anti-Sybil crown jewel — a bug forges any identity. It is
//! hardened by tests + a 4-agent adversarial threat-model, but it has NOT had a formal external audit
//! (a "Wormhole-class" forgery risk). Independent audit required before mainnet/real value.

use alloc::vec::Vec;

/// The configured Cardano network nibble (the low 4 bits of the address header byte): 0 = testnet,
/// 1 = mainnet. The beacon-name identity carries NO network byte, so without this check a mainnet
/// address and a testnet address with the same credentials would bind the identical identity.
pub type NetworkId = u8;

/// A verified self-proof. The caller (pallet) asserts `genesis` == the chain genesis and binds
/// `account` ↔ `identity` (1:1, non-tombstoned).
#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedProof {
    /// `blake2b_256(plutus_data_cbor(owner Address))` — the L1 beacon name / `AccountOf` key.
    pub identity: [u8; 32],
    /// The 32-byte sr25519 account the signed payload commits (the bind target).
    pub account: [u8; 32],
    /// The genesis hash the signed payload commits (caller checks == this chain's genesis).
    pub genesis: [u8; 32],
}

/// A verified STAKE-key self-proof ([`verify_bind_proof_stake`]) — the CIP-8 the wallet produced
/// over its REWARD address, signed with the STAKE key. The caller asserts `genesis` == the chain
/// genesis and binds `account` ↔ `stake_credential` (1:1, non-tombstoned) as the **voting-power**
/// anchor. Distinct from [`VerifiedProof`]: that proves the PAYMENT key (the posting/deposit
/// identity); this proves the STAKE key (the total-stake voting weight), so a whale's stake cannot
/// be claimed by anyone who does not hold its stake key.
#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedStakeProof {
    /// The 28-byte stake credential (the reward address's key hash) — the 1:1 voting anchor.
    pub stake_credential: [u8; 28],
    /// The 32-byte sr25519 account the signed payload commits (the bind target).
    pub account: [u8; 32],
    /// The genesis hash the signed payload commits (caller checks == this chain's genesis).
    pub genesis: [u8; 32],
}

/// Every failure mode is a typed, fail-closed reject — never a panic.
#[derive(Debug, PartialEq, Eq)]
pub enum Cip8Error {
    /// Ran off the end of a buffer.
    Truncated,
    /// A non-minimal length encoding / reserved or indefinite CBOR additional-info (not canonical).
    NonCanonical,
    /// Bytes left over after a complete structure.
    TrailingBytes,
    /// The COSE_Sign1 array shape is wrong (not `[protected, unprotected, payload, signature]`).
    BadCose,
    /// `hashed:true` (the payload would be a hash, not the literal bind string).
    HashedPayload,
    /// The protected header map is malformed / missing `alg=-8` / missing or duplicate `address`.
    BadProtected,
    /// The COSE_Key is malformed / not Ed25519-OKP / the `-2` key is not exactly 32 bytes.
    BadKey,
    /// The KID in the (signed) protected header disagrees with the COSE_Key.
    KeyMismatch,
    /// `ed25519_verify` returned false.
    SignatureInvalid,
    /// The Cardano address bytes are malformed (wrong length for the header type).
    BadAddress,
    /// The address type is not a VerificationKey-payment base/enterprise address.
    UnsupportedAddressType,
    /// The address network nibble != the configured network.
    WrongNetwork,
    /// `blake2b_224(pubkey)` != the address payment credential (the signer doesn't control the address).
    AddressKeyMismatch,
    /// The signed payload does not match the pinned `cogno-chain/bind/v1;…` grammar.
    BadPayload,
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Strict, total, canonical CBOR reader. Only the slice of CBOR this verifier needs is supported; every
// non-canonical / unexpected form is rejected. No method panics or indexes without a checked bound.
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

    /// Take exactly `n` bytes, advancing the cursor. Checked — never panics.
    fn take(&mut self, n: usize) -> Result<&'a [u8], Cip8Error> {
        let end = self.pos.checked_add(n).ok_or(Cip8Error::Truncated)?;
        let s = self.buf.get(self.pos..end).ok_or(Cip8Error::Truncated)?;
        self.pos = end;
        Ok(s)
    }

    fn byte(&mut self) -> Result<u8, Cip8Error> {
        self.take(1)?.first().copied().ok_or(Cip8Error::Truncated)
    }

    /// Read a CBOR head: returns `(major_type, argument)`, enforcing minimal-length (canonical) encoding
    /// and rejecting indefinite/reserved additional-info (28..=31).
    fn head(&mut self) -> Result<(u8, u64), Cip8Error> {
        let ib = self.byte()?;
        let mt = ib >> 5;
        let ai = ib & 0x1f;
        let arg = match ai {
            0..=23 => u64::from(ai),
            24 => {
                let b = self.byte()?;
                if b < 24 {
                    return Err(Cip8Error::NonCanonical);
                }
                u64::from(b)
            }
            25 => {
                let b = self.take(2)?;
                let v = u64::from(u16::from_be_bytes([
                    *b.first().ok_or(Cip8Error::Truncated)?,
                    *b.get(1).ok_or(Cip8Error::Truncated)?,
                ]));
                if v <= u64::from(u8::MAX) {
                    return Err(Cip8Error::NonCanonical);
                }
                v
            }
            26 => {
                let b = self.take(4)?;
                let mut a = [0u8; 4];
                a.copy_from_slice(b);
                let v = u64::from(u32::from_be_bytes(a));
                if v <= u64::from(u16::MAX) {
                    return Err(Cip8Error::NonCanonical);
                }
                v
            }
            27 => {
                let b = self.take(8)?;
                let mut a = [0u8; 8];
                a.copy_from_slice(b);
                let v = u64::from_be_bytes(a);
                if v <= u64::from(u32::MAX) {
                    return Err(Cip8Error::NonCanonical);
                }
                v
            }
            _ => return Err(Cip8Error::NonCanonical), // 28,29,30 reserved; 31 indefinite — reject all
        };
        Ok((mt, arg))
    }

    /// Read a head of an expected major type, returning its argument.
    fn typed_head(&mut self, want_mt: u8) -> Result<u64, Cip8Error> {
        let (mt, arg) = self.head()?;
        if mt != want_mt {
            return Err(Cip8Error::NonCanonical);
        }
        Ok(arg)
    }

    /// Definite array length.
    fn array_len(&mut self) -> Result<u64, Cip8Error> {
        self.typed_head(4)
    }

    /// Definite map length.
    fn map_len(&mut self) -> Result<u64, Cip8Error> {
        self.typed_head(5)
    }

    /// Unsigned integer.
    fn uint(&mut self) -> Result<u64, Cip8Error> {
        self.typed_head(0)
    }

    /// A definite byte string's CONTENT (the bytes inside), bounded by `max`.
    fn bytes(&mut self, max: usize) -> Result<&'a [u8], Cip8Error> {
        let len = self.typed_head(2)?;
        let len = usize::try_from(len).map_err(|_| Cip8Error::Truncated)?;
        if len > max {
            return Err(Cip8Error::Truncated);
        }
        self.take(len)
    }

    /// A definite text string's content, bounded by `max`.
    fn text(&mut self, max: usize) -> Result<&'a [u8], Cip8Error> {
        let len = self.typed_head(3)?;
        let len = usize::try_from(len).map_err(|_| Cip8Error::Truncated)?;
        if len > max {
            return Err(Cip8Error::Truncated);
        }
        self.take(len)
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// COSE parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// A parsed COSE_Sign1: the protected header (raw element for the Sig_structure + its content for the
/// address parse), the payload (raw element + content), and the 64-byte signature.
struct CoseSign1<'a> {
    protected_raw: &'a [u8],
    protected_content: &'a [u8],
    payload_raw: &'a [u8],
    payload_content: &'a [u8],
    signature: &'a [u8],
}

/// Parse the untagged COSE_Sign1 4-array `[protected_bstr, unprotected_map, payload_bstr, signature]`.
/// Captures the protected and payload elements VERBATIM (head + content) for the Sig_structure splice,
/// and asserts `hashed != true` on the unprotected header. Rejects trailing bytes.
fn parse_cose_sign1(buf: &[u8]) -> Result<CoseSign1<'_>, Cip8Error> {
    let mut r = Reader::new(buf);
    if r.array_len()? != 4 {
        return Err(Cip8Error::BadCose);
    }
    // 0: protected (bstr) — capture raw (head+content) and the content separately.
    let p_start = r.pos;
    let protected_content = r.bytes(256)?;
    let protected_raw = buf.get(p_start..r.pos).ok_or(Cip8Error::Truncated)?;
    // 1: unprotected (map) — must be empty or exactly {"hashed": false}.
    parse_unprotected(&mut r)?;
    // 2: payload (bstr).
    let pay_start = r.pos;
    let payload_content = r.bytes(256)?;
    let payload_raw = buf.get(pay_start..r.pos).ok_or(Cip8Error::Truncated)?;
    // 3: signature (bstr, exactly 64).
    let signature = r.bytes(64)?;
    if signature.len() != 64 {
        return Err(Cip8Error::BadCose);
    }
    if r.remaining() != 0 {
        return Err(Cip8Error::TrailingBytes);
    }
    Ok(CoseSign1 {
        protected_raw,
        protected_content,
        payload_raw,
        payload_content,
        signature,
    })
}

/// The unprotected header is NOT signed, so it is not a forge surface — but a `hashed:true` flag would
/// mean the payload bstr is a hash, not the literal bind string. Accept only `{}` or `{"hashed": false}`.
fn parse_unprotected(r: &mut Reader<'_>) -> Result<(), Cip8Error> {
    let n = r.map_len()?;
    if n == 0 {
        return Ok(());
    }
    if n != 1 {
        return Err(Cip8Error::BadCose);
    }
    if r.text(16)? != b"hashed" {
        return Err(Cip8Error::BadCose);
    }
    // value: a CBOR simple — false (0xf4) accepted, true (0xf5) rejected, anything else rejected.
    match r.byte()? {
        0xf4 => Ok(()),
        0xf5 => Err(Cip8Error::HashedPayload),
        _ => Err(Cip8Error::BadCose),
    }
}

/// Parse the protected header map content. Returns `(optional KID bytes, address bytes)`. Requires
/// `alg == -8` (EdDSA) present, `address` present exactly once; rejects duplicate/unknown keys.
fn parse_protected(content: &[u8]) -> Result<(Option<&[u8]>, &[u8]), Cip8Error> {
    let mut r = Reader::new(content);
    let n = r.map_len()?;
    let mut alg_seen = false;
    let mut kid: Option<&[u8]> = None;
    let mut address: Option<&[u8]> = None;
    for _ in 0..n {
        let (kmt, karg) = r.head()?;
        match (kmt, karg) {
            // alg (label 1) == -8 (EdDSA): value is nint with arg 7 (-1 - 7 = -8).
            (0, 1) => {
                if alg_seen {
                    return Err(Cip8Error::BadProtected);
                }
                alg_seen = true;
                let (vmt, varg) = r.head()?;
                if vmt != 1 || varg != 7 {
                    return Err(Cip8Error::BadProtected);
                }
            }
            // kid (label 4): a byte string (some wallets put the pubkey here).
            (0, 4) => {
                if kid.is_some() {
                    return Err(Cip8Error::BadProtected);
                }
                kid = Some(r.bytes(64)?);
            }
            // "address" (text key): the Cardano address bytes.
            (3, 7) => {
                // the only 7-byte text key we accept is exactly "address".
                let key = r.take(7)?;
                if key != b"address" {
                    return Err(Cip8Error::BadProtected);
                }
                if address.is_some() {
                    return Err(Cip8Error::BadProtected);
                }
                address = Some(r.bytes(128)?);
            }
            _ => return Err(Cip8Error::BadProtected), // any other key — reject
        }
    }
    if r.remaining() != 0 {
        return Err(Cip8Error::TrailingBytes);
    }
    if !alg_seen {
        return Err(Cip8Error::BadProtected);
    }
    let address = address.ok_or(Cip8Error::BadProtected)?;
    Ok((kid, address))
}

/// Parse a COSE_Key (OKP/Ed25519) and return the 32-byte public key (the `-2` field). Asserts
/// `kty == OKP(1)` and `crv == Ed25519(6)`; rejects any key that is not exactly 32 bytes (no 64-byte
/// extended keys, no truncation) and any unknown label.
fn parse_cose_key(buf: &[u8]) -> Result<&[u8], Cip8Error> {
    let mut r = Reader::new(buf);
    let n = r.map_len()?;
    let mut kty_ok = false;
    let mut crv_ok = false;
    let mut x: Option<&[u8]> = None;
    for _ in 0..n {
        let (kmt, karg) = r.head()?;
        match (kmt, karg) {
            (0, 1) => {
                // kty == OKP(1)
                if r.uint()? != 1 {
                    return Err(Cip8Error::BadKey);
                }
                kty_ok = true;
            }
            (0, 3) => {
                // alg == EdDSA(-8): nint arg 7
                let (vmt, varg) = r.head()?;
                if vmt != 1 || varg != 7 {
                    return Err(Cip8Error::BadKey);
                }
            }
            (1, 0) => {
                // crv (label -1) == Ed25519(6)
                if r.uint()? != 6 {
                    return Err(Cip8Error::BadKey);
                }
                crv_ok = true;
            }
            (1, 1) => {
                // x (label -2): the public key — exactly 32 bytes (read generously, then assert == 32 so
                // a 64-byte extended key is a clear BadKey, not a Truncated).
                let xb = r.bytes(64)?;
                if xb.len() != 32 {
                    return Err(Cip8Error::BadKey);
                }
                x = Some(xb);
            }
            _ => return Err(Cip8Error::BadKey),
        }
    }
    if r.remaining() != 0 {
        return Err(Cip8Error::TrailingBytes);
    }
    if !kty_ok || !crv_ok {
        return Err(Cip8Error::BadKey);
    }
    x.ok_or(Cip8Error::BadKey)
}

/// Build the COSE `Sig_structure` the Ed25519 signature covers, splicing `protected_raw` and
/// `payload_raw` VERBATIM (they are bstr elements; their exact wire bytes are what was signed). The
/// external_aad is the empty bstr `0x40` (CIP-30 always uses empty). Shape:
/// `["Signature1", protected, h'', payload]` = `84 6A "Signature1" <protected> 40 <payload>`.
fn sig_structure(protected_raw: &[u8], payload_raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(13 + protected_raw.len() + 1 + payload_raw.len());
    out.push(0x84); // array(4)
    out.push(0x6a); // text(10)
    out.extend_from_slice(b"Signature1");
    out.extend_from_slice(protected_raw);
    out.push(0x40); // bstr(0) — empty external_aad
    out.extend_from_slice(payload_raw);
    out
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Cardano address + the Plutus-Data beacon-name identity (byte-exact mirror of beacon.py)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The stake side of an owner address (the payment side is always a VerificationKey hash — script /
/// stake-only / pointer payment addresses are rejected before this).
enum Stake<'a> {
    None,
    KeyHash(&'a [u8]),
    ScriptHash(&'a [u8]),
}

/// Parse the Cardano address. Returns `(payment_key_hash_28, stake)`. Allows ONLY VerificationKey-payment
/// base (vkey/script stake) and enterprise (no stake) addresses on the configured network; everything
/// else (script-payment, pointer, stake-only, Byron, wrong-network) is a fail-closed reject.
fn parse_address<'a>(
    addr: &'a [u8],
    expected_network: NetworkId,
) -> Result<(&'a [u8], Stake<'a>), Cip8Error> {
    let header = *addr.first().ok_or(Cip8Error::BadAddress)?;
    let addr_type = header >> 4;
    let network = header & 0x0f;
    if network != expected_network {
        return Err(Cip8Error::WrongNetwork);
    }
    match addr_type {
        // 0b0000: base, vkey payment + vkey stake (1 + 28 + 28).
        0b0000 => {
            let payment = addr.get(1..29).ok_or(Cip8Error::BadAddress)?;
            let stake = addr.get(29..57).ok_or(Cip8Error::BadAddress)?;
            if addr.len() != 57 {
                return Err(Cip8Error::BadAddress);
            }
            Ok((payment, Stake::KeyHash(stake)))
        }
        // 0b0010: base, vkey payment + SCRIPT stake.
        0b0010 => {
            let payment = addr.get(1..29).ok_or(Cip8Error::BadAddress)?;
            let stake = addr.get(29..57).ok_or(Cip8Error::BadAddress)?;
            if addr.len() != 57 {
                return Err(Cip8Error::BadAddress);
            }
            Ok((payment, Stake::ScriptHash(stake)))
        }
        // 0b0110: enterprise, vkey payment only (1 + 28).
        0b0110 => {
            let payment = addr.get(1..29).ok_or(Cip8Error::BadAddress)?;
            if addr.len() != 29 {
                return Err(Cip8Error::BadAddress);
            }
            Ok((payment, Stake::None))
        }
        // script-payment (0001/0011/0101/0111), pointer (0100/0101), stake-only (1110/1111), Byron (1000).
        _ => Err(Cip8Error::UnsupportedAddressType),
    }
}

/// Parse a Cardano REWARD (stake) address, returning the 28-byte STAKE key hash. Allows ONLY a
/// VerificationKey stake-only reward address (header type `0b1110`, 1 + 28 bytes) on the configured
/// network; a SCRIPT reward address (`0b1111`) and every non-reward / wrong-network form is a
/// fail-closed reject. The stake credential IS the voting-power identity, so the returned hash is
/// later bound to `blake2b_224(stake_pubkey)` exactly as the payment path binds the payment cred.
fn parse_reward_address(addr: &[u8], expected_network: NetworkId) -> Result<&[u8], Cip8Error> {
    let header = *addr.first().ok_or(Cip8Error::BadAddress)?;
    let addr_type = header >> 4;
    let network = header & 0x0f;
    if network != expected_network {
        return Err(Cip8Error::WrongNetwork);
    }
    match addr_type {
        // 0b1110: reward, vkey stake only (1 + 28).
        0b1110 => {
            let stake = addr.get(1..29).ok_or(Cip8Error::BadAddress)?;
            if addr.len() != 29 {
                return Err(Cip8Error::BadAddress);
            }
            Ok(stake)
        }
        // script reward (1111) + every non-reward type (base/enterprise/pointer/Byron) — reject.
        _ => Err(Cip8Error::UnsupportedAddressType),
    }
}

// Plutus-Data CBOR primitives (constants only — no arithmetic, total). Constr 0 = tag 121 = `d8 79`,
// Constr 1 = tag 122 = `d8 7a`; fields as an INDEFINITE-length array `9f … ff`; a 28-byte hash as
// `58 1c <28>`. This is exactly `aiken/cbor.serialise` of the Aiken `Address` type (beacon.py).

fn push_constr_open(out: &mut Vec<u8>, ix: u8) {
    out.push(0xd8);
    out.push(0x79 + ix); // 0x79 = tag 121 (Constr 0); 0x7a = tag 122 (Constr 1)
    out.push(0x9f); // begin indefinite array
}

fn push_close(out: &mut Vec<u8>) {
    out.push(0xff); // break (end indefinite array)
}

fn push_hash28(out: &mut Vec<u8>, h: &[u8]) {
    out.push(0x58);
    out.push(0x1c); // bstr(28)
    out.extend_from_slice(h);
}

/// `credential`: VerificationKey(h) → `Constr0 [h]`; Script(h) → `Constr1 [h]`.
fn push_credential(out: &mut Vec<u8>, ix: u8, h: &[u8]) {
    push_constr_open(out, ix);
    push_hash28(out, h);
    push_close(out);
}

/// The exact bytes `aiken/cbor.serialise(owner)` produces, then `blake2_256` → the beacon-name identity.
/// `Address = Constr0 [ payment_credential, stake_option ]`, NO network byte (beacon.py).
fn plutus_address_cbor(payment_vkh: &[u8], stake: &Stake<'_>) -> Vec<u8> {
    let mut out = Vec::with_capacity(80);
    push_constr_open(&mut out, 0); // Address = Constr0 [ ... ]
    push_credential(&mut out, 0, payment_vkh); // payment is always a VerificationKey
    match stake {
        // None → Constr1 [] (enterprise).
        Stake::None => {
            push_constr_open(&mut out, 1);
            push_close(&mut out);
        }
        // Some(Inline(VerificationKey(h))) → Constr0 [ Constr0 [ Constr0 [h] ] ].
        Stake::KeyHash(h) => {
            push_constr_open(&mut out, 0); // Some
            push_constr_open(&mut out, 0); // Inline
            push_credential(&mut out, 0, h); // VerificationKey
            push_close(&mut out);
            push_close(&mut out);
        }
        // Some(Inline(Script(h))) → Constr0 [ Constr0 [ Constr1 [h] ] ].
        Stake::ScriptHash(h) => {
            push_constr_open(&mut out, 0); // Some
            push_constr_open(&mut out, 0); // Inline
            push_credential(&mut out, 1, h); // Script
            push_close(&mut out);
            push_close(&mut out);
        }
    }
    push_close(&mut out); // close Address
    out
}

/// blake2b-224 (28-byte) — the Cardano key hash. NOT an sp_io host fn, so use RustCrypto `blake2`.
fn blake2b_224(input: &[u8]) -> [u8; 28] {
    use blake2::digest::{Update, VariableOutput};
    let mut out = [0u8; 28];
    // `Blake2bVar::new(28)` and `finalize_variable` into a 28-byte buffer cannot fail (28 ∈ 1..=64);
    // on the impossible error path we return zeros, which fails the address-key match (fail-closed).
    if let Ok(mut h) = blake2::Blake2bVar::new(28) {
        h.update(input);
        let _ = h.finalize_variable(&mut out);
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pinned payload grammar: cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Decode exactly `n` lowercase-hex chars from `s` at `off` into bytes; returns the bytes and the new
/// offset. Rejects uppercase / non-hex / short input (mirrors payload.py's `[0-9a-f]` strictness).
fn take_hex(s: &[u8], off: usize, nbytes: usize) -> Result<(Vec<u8>, usize), Cip8Error> {
    let nchars = nbytes.checked_mul(2).ok_or(Cip8Error::BadPayload)?;
    let end = off.checked_add(nchars).ok_or(Cip8Error::BadPayload)?;
    let chars = s.get(off..end).ok_or(Cip8Error::BadPayload)?;
    let mut out = Vec::with_capacity(nbytes);
    let mut hi = None;
    for &c in chars {
        let v = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10, // lowercase ONLY
            _ => return Err(Cip8Error::BadPayload),
        };
        match hi.take() {
            None => hi = Some(v),
            Some(h) => out.push((h << 4) | v),
        }
    }
    Ok((out, end))
}

/// Assert `s[off..]` starts with `lit`, returning the new offset.
fn expect(s: &[u8], off: usize, lit: &[u8]) -> Result<usize, Cip8Error> {
    let end = off.checked_add(lit.len()).ok_or(Cip8Error::BadPayload)?;
    if s.get(off..end) != Some(lit) {
        return Err(Cip8Error::BadPayload);
    }
    Ok(end)
}

/// Parse the pinned bind payload, returning `(genesis[32], account[32])`. The nonce is validated for
/// FORMAT only (32 lowercase hex + end-of-input); it carries no on-chain anti-replay weight (the pallet's
/// tombstone + 1:1 maps do). Any deviation — wrong domain, wrong lengths, trailing bytes — is rejected.
fn parse_payload(p: &[u8]) -> Result<([u8; 32], [u8; 32]), Cip8Error> {
    let off = expect(p, 0, b"cogno-chain/bind/v1;genesis=")?;
    let (genesis, off) = take_hex(p, off, 32)?;
    let off = expect(p, off, b";account=")?;
    let (account, off) = take_hex(p, off, 32)?;
    let off = expect(p, off, b";nonce=")?;
    let (_nonce, off) = take_hex(p, off, 16)?; // format-checked, value ignored
    if off != p.len() {
        return Err(Cip8Error::BadPayload); // trailing bytes after the nonce
    }
    let mut g = [0u8; 32];
    let mut a = [0u8; 32];
    g.copy_from_slice(genesis.get(..32).ok_or(Cip8Error::BadPayload)?);
    a.copy_from_slice(account.get(..32).ok_or(Cip8Error::BadPayload)?);
    Ok((g, a))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Verify a CIP-8 bind self-proof. Returns the verified `(identity, account, genesis)` or a typed
/// reject. PURE — no storage, no panics. The caller binds `account` ↔ `identity` after checking
/// `genesis` == the chain genesis. See the module docs for the security invariants each step enforces.
pub fn verify_bind_proof(
    cose_sign1: &[u8],
    cose_key: &[u8],
    expected_network: NetworkId,
) -> Result<VerifiedProof, Cip8Error> {
    // 1. Parse the COSE_Sign1 (verbatim protected/payload elements) + the COSE_Key (the single key source).
    let cose = parse_cose_sign1(cose_sign1)?;
    let pubkey = parse_cose_key(cose_key)?;
    let (kid, address) = parse_protected(cose.protected_content)?;
    // If a KID rides in the (signed) protected header, it MUST be the same key we verify + hash.
    if let Some(kid) = kid {
        if kid != pubkey {
            return Err(Cip8Error::KeyMismatch);
        }
    }

    // 2. Ed25519-verify over the verbatim Sig_structure with the COSE_Key pubkey.
    let message = sig_structure(cose.protected_raw, cose.payload_raw);
    let mut pk = [0u8; 32];
    pk.copy_from_slice(pubkey.get(..32).ok_or(Cip8Error::BadKey)?);
    let mut sig = [0u8; 64];
    sig.copy_from_slice(cose.signature.get(..64).ok_or(Cip8Error::BadCose)?);
    let ok = sp_io::crypto::ed25519_verify(
        &sp_core::ed25519::Signature::from_raw(sig),
        &message,
        &sp_core::ed25519::Public::from_raw(pk),
    );
    if !ok {
        return Err(Cip8Error::SignatureInvalid);
    }

    // 3. Bind the verified key to the address: blake2b-224(pubkey) == the address payment credential.
    let (payment_vkh, stake) = parse_address(address, expected_network)?;
    if blake2b_224(&pk) != *payment_vkh {
        return Err(Cip8Error::AddressKeyMismatch);
    }

    // 4. Identity = blake2b_256(plutus_data_cbor(owner)) — the L1 beacon name (byte-exact, beacon.py).
    let identity = sp_io::hashing::blake2_256(&plutus_address_cbor(payment_vkh, &stake));

    // 5. The signed payload commits the genesis + account.
    let (genesis, account) = parse_payload(cose.payload_content)?;

    Ok(VerifiedProof {
        identity,
        account,
        genesis,
    })
}

/// Verify a CIP-8 STAKE-key bind self-proof (the wallet's `signData` over its REWARD address, signed
/// with the STAKE key). Returns the verified `(stake_credential, account, genesis)` or a typed reject.
/// PURE — no storage, no panics. The caller asserts `genesis` == the chain genesis and binds
/// `account` ↔ `stake_credential` 1:1 as the voting-power anchor.
///
/// ⚠ Steps 1, 2 and 5 are IDENTICAL to [`verify_bind_proof`] (the same single-key-source rule, the
/// same verbatim `Sig_structure` Ed25519 check, the same pinned payload grammar) and MUST stay in
/// lockstep with it — only step 3/4 differs: the address is a REWARD address and the verified key is
/// bound to its STAKE credential (not a payment credential), which IS the returned identity (no
/// `plutus_data_cbor` / beacon hashing — the voting anchor is the bare 28-byte stake key hash).
pub fn verify_bind_proof_stake(
    cose_sign1: &[u8],
    cose_key: &[u8],
    expected_network: NetworkId,
) -> Result<VerifiedStakeProof, Cip8Error> {
    // 1. Parse the COSE_Sign1 (verbatim protected/payload elements) + the COSE_Key (single key source).
    let cose = parse_cose_sign1(cose_sign1)?;
    let pubkey = parse_cose_key(cose_key)?;
    let (kid, address) = parse_protected(cose.protected_content)?;
    // If a KID rides in the (signed) protected header, it MUST be the same key we verify + hash.
    if let Some(kid) = kid {
        if kid != pubkey {
            return Err(Cip8Error::KeyMismatch);
        }
    }

    // 2. Ed25519-verify over the verbatim Sig_structure with the COSE_Key pubkey.
    let message = sig_structure(cose.protected_raw, cose.payload_raw);
    let mut pk = [0u8; 32];
    pk.copy_from_slice(pubkey.get(..32).ok_or(Cip8Error::BadKey)?);
    let mut sig = [0u8; 64];
    sig.copy_from_slice(cose.signature.get(..64).ok_or(Cip8Error::BadCose)?);
    let ok = sp_io::crypto::ed25519_verify(
        &sp_core::ed25519::Signature::from_raw(sig),
        &message,
        &sp_core::ed25519::Public::from_raw(pk),
    );
    if !ok {
        return Err(Cip8Error::SignatureInvalid);
    }

    // 3. Bind the verified key to the REWARD address: blake2b-224(stake_pubkey) == the stake credential.
    let stake_cred = parse_reward_address(address, expected_network)?;
    if blake2b_224(&pk) != *stake_cred {
        return Err(Cip8Error::AddressKeyMismatch);
    }

    // 4. Identity = the bare 28-byte stake credential (the 1:1 voting anchor — no beacon hashing).
    let mut stake_credential = [0u8; 28];
    stake_credential.copy_from_slice(stake_cred.get(..28).ok_or(Cip8Error::BadAddress)?);

    // 5. The signed payload commits the genesis + account (the same pinned grammar as the payment path).
    let (genesis, account) = parse_payload(cose.payload_content)?;

    Ok(VerifiedStakeProof {
        stake_credential,
        account,
        genesis,
    })
}

#[cfg(test)]
mod tests;
