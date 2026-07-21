//! Tests for the on-chain CIP-8 verifier. Two oracles:
//!  • the cross-impl-LOCKED beacon-name vector (`6e2f65e9…`, asserted byte-identical in the Aiken
//!    contract `talk_vault.ak::beacon_name_matches_follower` and `ci/cip8-oracle/test_beacon.py`)
//!    — proves the on-chain Plutus-CBOR identity matches the L1 join key;
//!  • a REAL `MeshWallet.signData` fixture (`app/scripts/m2-cip8-fixture.mjs`) — proves end-to-end verify.
//! Plus adversarial negatives (tampered sig, swapped key, wrong network, trailing bytes, extended key,
//! script address, non-canonical CBOR), each asserting a specific fail-closed reject.

use super::*;

/// Decode a hex string to bytes (test helper).
fn hx(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i + 2 <= b.len() {
        let hi = (b[i] as char).to_digit(16).unwrap() as u8;
        let lo = (b[i + 1] as char).to_digit(16).unwrap() as u8;
        out.push((hi << 4) | lo);
        i += 2;
    }
    out
}

fn rep(byte: &str, n: usize) -> String {
    byte.repeat(n)
}

// ── the real fixture (app/scripts/m2-cip8-fixture.mjs, default mnemonic, //CognoGateA, nonce ab*16) ──
const SIG: &str = "845869a3012704582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d67616464726573735839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dca166686173686564f458cc636f676e6f2d636861696e2f62696e642f76313b67656e657369733d323761663338353730616230373261326137383233326664663436616335653935376561613463343461356339326430366235363435353862666232656431363b6163636f756e743d333033356361336134626436306335356635313035626231386663373636613630333634643032323666373230666665336665333364323964363633313033343b6e6f6e63653d616261626162616261626162616261626162616261626162616261626162616258400cdf9b33e4179a29995b0d0d96fb770c58b54ed570ede16df0d32b2e904efa7687ee2efa0bbc6840ecab99a6c6e20992f1916f41e4ca6b28b4d5b103234cf00e";
const KEY: &str =
    "a401010327200621582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d";
const ACCOUNT: &str = "3035ca3a4bd60c55f5105bb18fc766a60364d0226f720ffe3fe33d29d6631034";
const GENESIS: &str = "27af38570ab072a2a78232fdf46ac5e957eaa4c44a5c92d06b564558bfb2ed16";
const LOCKED: &str = "6e2f65e9160dfbef407bfd9bce3a0aa733e12b562a856327acc3092060e0ca50";

fn ext() -> sp_io::TestExternalities {
    sp_io::TestExternalities::default()
}

// ── 1. The Plutus-CBOR identity (make-or-break: must equal the L1 beacon name) ──────────────────────

#[test]
fn plutus_cbor_matches_the_locked_aiken_python_vector() {
    // test_beacon.py LOCKED: base address, vkey payment a1*28 + vkey stake b2*28.
    let payment = hx(&rep("a1", 28));
    let stake = hx(&rep("b2", 28));
    let cbor = plutus_address_cbor(&payment, &Stake::KeyHash(&stake));
    // The exact serialise() bytes: Constr0[ Constr0[h_pay], Constr0[Constr0[Constr0[h_stake]]] ].
    let expected = hx(&format!(
        "d8799fd8799f581c{}ffd8799fd8799fd8799f581c{}ffffffff",
        rep("a1", 28),
        rep("b2", 28),
    ));
    assert_eq!(
        cbor, expected,
        "Plutus-Data Address CBOR must match aiken/cbor.serialise byte-for-byte"
    );
    // …and its blake2_256 is the value the Aiken contract + the follower both lock.
    ext().execute_with(|| {
        let identity = sp_io::hashing::blake2_256(&cbor);
        assert_eq!(
            identity.as_slice(),
            hx(LOCKED).as_slice(),
            "on-chain beacon-name == the L1 join key"
        );
    });
}

#[test]
fn enterprise_and_script_stake_differ_from_base() {
    let payment = hx(&rep("a1", 28));
    // Enterprise (no stake) = Constr0[ Constr0[h], Constr1[] ].
    let ent = plutus_address_cbor(&payment, &Stake::None);
    assert_eq!(
        ent,
        hx(&format!("d8799fd8799f581c{}ffd87a9fffff", rep("a1", 28)))
    );
    // Script-stake uses Constr1 for the inner credential (tag 122), distinct bytes ⇒ distinct identity.
    let scr = plutus_address_cbor(&payment, &Stake::ScriptHash(&hx(&rep("cc", 28))));
    ext().execute_with(|| {
        let id_ent = sp_io::hashing::blake2_256(&ent);
        let id_scr = sp_io::hashing::blake2_256(&scr);
        assert_ne!(id_ent.as_slice(), hx(LOCKED).as_slice());
        assert_ne!(id_scr.as_slice(), hx(LOCKED).as_slice());
        assert_ne!(id_ent, id_scr);
    });
}

// ── 2. Full verify on the real wallet fixture ───────────────────────────────────────────────────────

#[test]
fn verifies_a_real_signdata_fixture() {
    ext().execute_with(|| {
        let v =
            verify_bind_proof(&hx(SIG), &hx(KEY), 0).expect("a real signData proof must verify");
        assert_eq!(
            v.account.as_slice(),
            hx(ACCOUNT).as_slice(),
            "binds the committed account"
        );
        assert_eq!(
            v.genesis.as_slice(),
            hx(GENESIS).as_slice(),
            "carries the committed genesis"
        );
        // The identity is the beacon name of the fixture's address (payment 9493…, stake 32c728…).
        let payment = hx("9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e");
        let stake = hx("32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc");
        let expect =
            sp_io::hashing::blake2_256(&plutus_address_cbor(&payment, &Stake::KeyHash(&stake)));
        assert_eq!(
            v.identity, expect,
            "identity is the whole-address beacon name"
        );
    });
}

// ── 2b. Stake-key proof over a reward address (verify_bind_proof_stake) ──────────────────────────────
// A REAL headless MeshWallet.signData fixture over the wallet's REWARD address, signed with the STAKE
// key (app/scripts/m2-cip8-stake-fixture.mjs, same mnemonic + //CognoGateA account as the payment
// fixture above). The stake credential 32c728… is exactly the stake half of the payment fixture's base
// address — same wallet, different (stake) key.
const STAKE_SIG: &str = "84584da301270458202c041c9c6a676ac54d25e2fdce44c56581e316ae43adc4c7bf17f23214d8d8926761646472657373581de032c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dca166686173686564f458cc636f676e6f2d636861696e2f62696e642f76313b67656e657369733d323761663338353730616230373261326137383233326664663436616335653935376561613463343461356339326430366235363435353862666232656431363b6163636f756e743d333033356361336134626436306335356635313035626231386663373636613630333634643032323666373230666665336665333364323964363633313033343b6e6f6e63653d61626162616261626162616261626162616261626162616261626162616261625840c529e2e90f856433733c21100d9d3e2e7f891491464aab47df94822feadce361c45352bbc3c4fa4397ee3843b5edd18df7d3318b389d652a4a771041bffbd40b";
const STAKE_KEY: &str =
    "a40101032720062158202c041c9c6a676ac54d25e2fdce44c56581e316ae43adc4c7bf17f23214d8d892";
const STAKE_CRED: &str = "32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc";

#[test]
fn verifies_a_real_stake_signdata_fixture() {
    ext().execute_with(|| {
        let v = verify_bind_proof_stake(&hx(STAKE_SIG), &hx(STAKE_KEY), 0)
            .expect("a real stake-key signData proof must verify");
        assert_eq!(
            v.stake_credential.as_slice(),
            hx(STAKE_CRED).as_slice(),
            "binds the proven stake credential"
        );
        assert_eq!(
            v.account.as_slice(),
            hx(ACCOUNT).as_slice(),
            "commits the same posting account"
        );
        assert_eq!(
            v.genesis.as_slice(),
            hx(GENESIS).as_slice(),
            "carries the committed genesis"
        );
    });
}

#[test]
fn stake_proof_rejects_wrong_network_and_tamper() {
    ext().execute_with(|| {
        // The reward address is testnet (network 0); verifying for mainnet (1) ⇒ WrongNetwork.
        assert_eq!(
            verify_bind_proof_stake(&hx(STAKE_SIG), &hx(STAKE_KEY), 1),
            Err(Cip8Error::WrongNetwork)
        );
        // Flip a signature bit ⇒ SignatureInvalid.
        let mut sig = hx(STAKE_SIG);
        let last = sig.len() - 1;
        sig[last] ^= 0x01;
        assert_eq!(
            verify_bind_proof_stake(&sig, &hx(STAKE_KEY), 0),
            Err(Cip8Error::SignatureInvalid)
        );
    });
}

#[test]
fn parse_reward_address_allows_vkey_reward_and_rejects_the_rest() {
    let s = hx(&rep("b2", 28));
    let mut reward = vec![0xe0u8]; // 0b1110 reward (vkey stake), network 0
    reward.extend_from_slice(&s);
    assert_eq!(parse_reward_address(&reward, 0).unwrap(), s.as_slice());
    // SCRIPT reward (0b1111, 0xf0) ⇒ UnsupportedAddressType.
    let mut script_reward = vec![0xf0u8];
    script_reward.extend_from_slice(&s);
    assert_eq!(
        parse_reward_address(&script_reward, 0).err(),
        Some(Cip8Error::UnsupportedAddressType)
    );
    // A base address (0x00) is NOT a reward address ⇒ UnsupportedAddressType.
    let mut base = vec![0x00u8];
    base.extend_from_slice(&hx(&rep("a1", 28)));
    base.extend_from_slice(&s);
    assert_eq!(
        parse_reward_address(&base, 0).err(),
        Some(Cip8Error::UnsupportedAddressType)
    );
    // Wrong network (0xe1 on a network-0 verifier) ⇒ WrongNetwork.
    let mut wn = vec![0xe1u8];
    wn.extend_from_slice(&s);
    assert_eq!(
        parse_reward_address(&wn, 0).err(),
        Some(Cip8Error::WrongNetwork)
    );
    // Truncated reward (one byte short) ⇒ BadAddress, never a panic.
    assert_eq!(
        parse_reward_address(&reward[..28], 0).err(),
        Some(Cip8Error::BadAddress)
    );
}

// ── 3. Adversarial negatives ────────────────────────────────────────────────────────────────────────

#[test]
fn tampered_signature_is_rejected() {
    ext().execute_with(|| {
        let mut sig = hx(SIG);
        let last = sig.len() - 1;
        sig[last] ^= 0x01; // flip a signature bit
        assert_eq!(
            verify_bind_proof(&sig, &hx(KEY), 0),
            Err(Cip8Error::SignatureInvalid)
        );
    });
}

#[test]
fn swapped_cose_key_is_caught_by_the_kid_equality_check() {
    ext().execute_with(|| {
        // A different (well-formed) COSE_Key. The fixture's SIGNED protected header carries a KID equal to
        // the real pubkey, so the single-key-source rule (kid == COSE_Key) rejects BEFORE ed25519_verify.
        let other =
            "a40101032720062158200000000000000000000000000000000000000000000000000000000000000001";
        assert_eq!(
            verify_bind_proof(&hx(SIG), &hx(other), 0),
            Err(Cip8Error::KeyMismatch)
        );
    });
}

#[test]
fn wrong_network_is_rejected() {
    ext().execute_with(|| {
        // The fixture address is testnet (network 0). Verifying for mainnet (1) ⇒ WrongNetwork.
        assert_eq!(
            verify_bind_proof(&hx(SIG), &hx(KEY), 1),
            Err(Cip8Error::WrongNetwork)
        );
    });
}

#[test]
fn trailing_bytes_are_rejected() {
    ext().execute_with(|| {
        let mut sig = hx(SIG);
        sig.push(0x00); // append junk after the COSE_Sign1 4-array
        assert_eq!(
            verify_bind_proof(&sig, &hx(KEY), 0),
            Err(Cip8Error::TrailingBytes)
        );
    });
}

#[test]
fn sixty_four_byte_extended_key_is_rejected() {
    ext().execute_with(|| {
        // A COSE_Key whose x is 64 bytes (extended key) ⇒ BadKey (exactly 32, no truncation).
        let ext_key = format!("a4010103272006215840{}", rep("11", 64));
        assert_eq!(
            verify_bind_proof(&hx(SIG), &hx(&ext_key), 0),
            Err(Cip8Error::BadKey)
        );
    });
}

// ── 4. Pure-parser units (no crypto) ────────────────────────────────────────────────────────────────

#[test]
fn parse_address_allows_vkey_base_enterprise_and_rejects_the_rest() {
    let p = hx(&rep("a1", 28));
    let s = hx(&rep("b2", 28));
    let mut base = vec![0x00u8]; // base, network 0
    base.extend_from_slice(&p);
    base.extend_from_slice(&s);
    assert!(parse_address(&base, 0).is_ok());
    let mut ent = vec![0x60u8]; // enterprise, network 0
    ent.extend_from_slice(&p);
    assert!(parse_address(&ent, 0).is_ok());
    let mut scr = vec![0x10u8]; // SCRIPT-payment ⇒ UnsupportedAddressType
    scr.extend_from_slice(&p);
    scr.extend_from_slice(&s);
    assert_eq!(
        parse_address(&scr, 0).err(),
        Some(Cip8Error::UnsupportedAddressType)
    );
    let mut wn = vec![0x01u8]; // base, network 1 on a network-0 verifier ⇒ WrongNetwork
    wn.extend_from_slice(&p);
    wn.extend_from_slice(&s);
    assert_eq!(parse_address(&wn, 0).err(), Some(Cip8Error::WrongNetwork));
    // truncated base (one byte short) ⇒ BadAddress, never a panic
    assert_eq!(
        parse_address(&base[..56], 0).err(),
        Some(Cip8Error::BadAddress)
    );
}

#[test]
fn parse_payload_enforces_the_pinned_grammar() {
    let good = format!(
        "cogno-chain/bind/v1;genesis={};account={};nonce={}",
        rep("27", 32),
        rep("30", 32),
        rep("ab", 16)
    );
    let (g, a) = parse_payload(good.as_bytes()).unwrap();
    assert_eq!(g, [0x27u8; 32]);
    assert_eq!(a, [0x30u8; 32]);
    // wrong domain
    assert!(parse_payload(b"evil/bind/v1;genesis=deadbeef").is_err());
    // uppercase hex rejected (payload.py is [0-9a-f])
    let bad = format!(
        "cogno-chain/bind/v1;genesis={};account={};nonce={}",
        rep("2A", 32),
        rep("30", 32),
        rep("ab", 16)
    );
    assert!(parse_payload(bad.as_bytes()).is_err());
    // trailing byte after the nonce
    let mut trail = good.into_bytes();
    trail.push(b'x');
    assert!(parse_payload(&trail).is_err());
}

#[test]
fn cbor_reader_rejects_indefinite_and_non_minimal() {
    // indefinite array (0x9f…) is rejected by head()
    let mut r = Reader::new(&[0x9f, 0xff]);
    assert!(r.array_len().is_err());
    // non-minimal: array length 5 encoded in a 1-byte follow (0x98 0x05 — should be 0x85)
    let mut r2 = Reader::new(&[0x98, 0x05]);
    assert_eq!(r2.array_len().err(), Some(Cip8Error::NonCanonical));
    // truncated take never panics
    let mut r3 = Reader::new(&[0x58, 0x20]); // says bstr(32) but no body
    assert!(r3.bytes(64).is_err());
}

// ── 5. Role-key proof (verify_bind_proof_role) ────────────────────────────────────────────────────────
// The payment/stake paths use REAL wallet fixtures. A role key is instead signed by cardano-signer /
// a CIP-95 wallet over a SYNTHETIC enterprise address (payment credential = blake2b_224(role_key)).
// We construct the identical COSE_Sign1 wire shape here and sign it with a deterministic ed25519 key,
// so the positive + negative role cases are self-contained (no external signer) yet exercise the SAME
// parse+verify path the crown jewel runs on-chain.

use sp_core::{ed25519, Pair};

/// Canonical CBOR byte-string head for `len` bytes (major type 2), definite length.
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

fn hexs(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn role_payload(genesis: &[u8; 32], account: &[u8; 32], role: &str) -> Vec<u8> {
    format!(
        "cogno-chain/role/v1;genesis={};account={};nonce={};role={}",
        hexs(genesis),
        hexs(account),
        rep("ab", 16),
        role,
    )
    .into_bytes()
}

/// Build a signed role-key CIP-8 proof over an address of the given header (0x60 enterprise / 0x00
/// base), returning `(cose_sign1, cose_key, expected_credential)`. Signs the VERBATIM Sig_structure
/// with the fixed test ed25519 key — the same shape cardano-signer `--cip8 --address <enterprise>`
/// emits (protected map {alg:-8, kid:pubkey, "address":addr}, empty unprotected, bstr payload, sig).
fn build_role_proof(addr_header: u8, payload: &[u8]) -> (Vec<u8>, Vec<u8>, [u8; 28]) {
    let pair = ed25519::Pair::from_seed(&[7u8; 32]);
    let public = pair.public();
    let pk: Vec<u8> = AsRef::<[u8]>::as_ref(&public).to_vec(); // 32 bytes
    let cred = blake2b_224(&pk);
    let mut addr = vec![addr_header];
    addr.extend_from_slice(&cred);
    if addr_header == 0x00 {
        addr.extend_from_slice(&[0xb2u8; 28]); // arbitrary stake half for a base address
    }
    // protected content: map(3){ alg(1):-8, kid(4):pubkey, "address":addr }.
    let mut prot = vec![0xa3u8];
    prot.extend_from_slice(&[0x01, 0x27]); // alg = -8 (nint arg 7)
    prot.push(0x04); // kid
    prot.extend_from_slice(&bstr(&pk));
    prot.push(0x67); // text(7)
    prot.extend_from_slice(b"address");
    prot.extend_from_slice(&bstr(&addr));
    let protected_raw = bstr(&prot);
    let payload_raw = bstr(payload);
    // Sig_structure = 84 6a "Signature1" <protected_raw> 40 <payload_raw>.
    let mut ss = vec![0x84u8, 0x6a];
    ss.extend_from_slice(b"Signature1");
    ss.extend_from_slice(&protected_raw);
    ss.push(0x40);
    ss.extend_from_slice(&payload_raw);
    let signature = pair.sign(&ss);
    let sig: Vec<u8> = AsRef::<[u8]>::as_ref(&signature).to_vec(); // 64 bytes
    // cose_sign1 = 84 <protected_raw> a0 <payload_raw> <bstr sig>.
    let mut cose = vec![0x84u8];
    cose.extend_from_slice(&protected_raw);
    cose.push(0xa0); // empty unprotected map
    cose.extend_from_slice(&payload_raw);
    cose.extend_from_slice(&bstr(&sig));
    // cose_key = a4 kty(1):OKP(1) alg(3):-8 crv(-1):Ed25519(6) x(-2):bstr(pubkey).
    let mut key = vec![0xa4u8, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21];
    key.extend_from_slice(&bstr(&pk));
    (cose, key, cred)
}

#[test]
fn verifies_a_constructed_role_proof_enterprise_and_base() {
    ext().execute_with(|| {
        let genesis = [0x27u8; 32];
        let account = [0x30u8; 32];
        // Both an enterprise (0x60) and a base (0x00) VerificationKey-payment address bind the same
        // 28-byte payment credential; the role path takes it regardless of the (ignored) stake part.
        for header in [0x60u8, 0x00u8] {
            let (cose, key, cred) = build_role_proof(header, &role_payload(&genesis, &account, "spo"));
            let v = verify_bind_proof_role(&cose, &key, 0).expect("a role proof must verify");
            assert_eq!(v.role, RoleClass::Spo);
            assert_eq!(v.credential.as_slice(), cred.as_slice(), "binds the role-key hash");
            assert_eq!(v.account, account, "commits the account");
            assert_eq!(v.genesis, genesis, "carries the genesis");
        }
    });
}

#[test]
fn role_proof_maps_each_role_token() {
    ext().execute_with(|| {
        let g = [0x27u8; 32];
        let a = [0x30u8; 32];
        for (tok, want) in [
            ("spo", RoleClass::Spo),
            ("drep", RoleClass::DRep),
            ("cc", RoleClass::Committee),
        ] {
            let (cose, key, _) = build_role_proof(0x60, &role_payload(&g, &a, tok));
            assert_eq!(verify_bind_proof_role(&cose, &key, 0).unwrap().role, want);
        }
    });
}

#[test]
fn role_proof_rejects_unknown_role_and_bind_domain() {
    ext().execute_with(|| {
        let g = [0x27u8; 32];
        let a = [0x30u8; 32];
        // An unknown role token ⇒ BadRolePayload.
        let (cose, key, _) = build_role_proof(0x60, &role_payload(&g, &a, "admin"));
        assert_eq!(
            verify_bind_proof_role(&cose, &key, 0),
            Err(Cip8Error::BadRolePayload)
        );
        // A payment/stake BIND payload can never satisfy the role grammar (domain separation).
        let bind = format!(
            "cogno-chain/bind/v1;genesis={};account={};nonce={}",
            rep("27", 32),
            rep("30", 32),
            rep("ab", 16),
        );
        let (cose2, key2, _) = build_role_proof(0x60, bind.as_bytes());
        assert_eq!(
            verify_bind_proof_role(&cose2, &key2, 0),
            Err(Cip8Error::BadRolePayload)
        );
    });
}

#[test]
fn role_proof_rejects_wrong_network_tamper_and_swapped_key() {
    ext().execute_with(|| {
        let (cose, key, _) = build_role_proof(0x60, &role_payload(&[0x27u8; 32], &[0x30u8; 32], "spo"));
        // The synthetic enterprise address is network 0; verifying for mainnet (1) ⇒ WrongNetwork.
        assert_eq!(
            verify_bind_proof_role(&cose, &key, 1),
            Err(Cip8Error::WrongNetwork)
        );
        // Flip a signature bit ⇒ SignatureInvalid.
        let mut bad = cose.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0x01;
        assert_eq!(
            verify_bind_proof_role(&bad, &key, 0),
            Err(Cip8Error::SignatureInvalid)
        );
        // A different COSE_Key: the signed protected header's KID == the real pubkey, so the
        // single-key-source rule rejects BEFORE ed25519_verify.
        let other = hx("a40101032720062158200000000000000000000000000000000000000000000000000000000000000001");
        assert_eq!(
            verify_bind_proof_role(&cose, &other, 0),
            Err(Cip8Error::KeyMismatch)
        );
    });
}

#[test]
fn parse_role_payload_enforces_the_pinned_grammar() {
    let g = [0x27u8; 32];
    let a = [0x30u8; 32];
    let (gg, aa, role) = parse_role_payload(&role_payload(&g, &a, "drep")).unwrap();
    assert_eq!(gg, g);
    assert_eq!(aa, a);
    assert_eq!(role, RoleClass::DRep);
    // wrong domain (a bind payload) ⇒ BadRolePayload
    assert_eq!(
        parse_role_payload(b"cogno-chain/bind/v1;genesis=deadbeef").err(),
        Some(Cip8Error::BadRolePayload)
    );
    // trailing byte after the role token ⇒ BadRolePayload
    let mut trail = role_payload(&g, &a, "spo");
    trail.push(b'x');
    assert_eq!(
        parse_role_payload(&trail).err(),
        Some(Cip8Error::BadRolePayload)
    );
    // uppercase hex rejected (same [0-9a-f] strictness as the bind payload)
    let up = format!(
        "cogno-chain/role/v1;genesis={};account={};nonce={};role=spo",
        rep("2A", 32),
        rep("30", 32),
        rep("ab", 16),
    );
    assert_eq!(
        parse_role_payload(up.as_bytes()).err(),
        Some(Cip8Error::BadRolePayload)
    );
}
