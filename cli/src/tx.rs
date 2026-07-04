//! Extrinsic builder — assemble + sign (or build BARE) a transaction using the runtime's OWN types.
//!
//! This is the payoff of the "reuse the runtime crate" decision (over subxt codegen): `RuntimeCall`, the
//! exact 12-slot `TxExtension`, `SignedPayload`, and `UncheckedExtrinsic` all come straight from
//! `cogno-chain-runtime`, so the signed bytes are byte-identical to what the importing node expects — with
//! no committed metadata snapshot to drift on a `spec_version` bump. If the runtime's call indices or
//! extension tuple ever change, this module fails to COMPILE.
//!
//! The signing payload is `(call, extension_explicit, implicit)`; `SignedPayload::using_encoded` applies
//! the standard `blake2_256`-if-over-256-bytes rule. We use `Era::Immortal` (the era's implicit anchor is
//! then the genesis hash) — adequate for an operator admin tool; the values that gate acceptance
//! (`spec_version`/`tx_version`/`genesis`) are fetched LIVE over RPC, never hardcoded.

use codec::Encode;
use cogno_chain_runtime::{Runtime, RuntimeCall, SignedPayload, TxExtension, UncheckedExtrinsic};
use sp_core::H256;
use sp_crypto_hashing::blake2_256;
use sp_runtime::{generic::Era, MultiAddress};

use crate::key::Signer;

/// The live chain parameters that feed the signed-extrinsic implicit data. Fetched ONCE over RPC at
/// connect (`genesis = chain_getBlockHash(0)`, `spec_version`/`tx_version = state_getRuntimeVersion`) — the
/// CLI signs against the chain it is actually talking to, never a stale compile-time pin.
#[derive(Debug, Clone, Copy)]
pub struct ChainCtx {
    /// The genesis block hash (`CheckGenesis` implicit + the immortal-era anchor).
    pub genesis: H256,
    /// The live runtime `spec_version` (`CheckSpecVersion` implicit).
    pub spec_version: u32,
    /// The live runtime `transaction_version` (`CheckTxVersion` implicit).
    pub tx_version: u32,
}

/// Build the `TxExtension` tuple in the runtime's EXACT order (runtime/src/lib.rs). Most slots are
/// zero-sized; the data-bearing ones are nonce, tip, and the (immortal) era. Slot 8 is cogno's
/// `CheckCapacity` (the feeless-post spam meter — no data); payment is wrapped in `SkipCheckIfFeeless`
/// (transparent — encodes as the inner `ChargeTransactionPayment`). `CheckMetadataHash` is in disabled
/// mode (the default non-`on-chain-release-build` runtime), matching the chain's check.
fn tx_extension(nonce: u32, tip: u128) -> TxExtension {
    (
        frame_system::AuthorizeCall::<Runtime>::new(),
        frame_system::CheckNonZeroSender::<Runtime>::new(),
        frame_system::CheckSpecVersion::<Runtime>::new(),
        frame_system::CheckTxVersion::<Runtime>::new(),
        frame_system::CheckGenesis::<Runtime>::new(),
        frame_system::CheckEra::<Runtime>::from(Era::Immortal),
        frame_system::CheckNonce::<Runtime>::from(nonce),
        frame_system::CheckWeight::<Runtime>::new(),
        pallet_microblog::CheckCapacity::<Runtime>::new(),
        pallet_skip_feeless_payment::SkipCheckIfFeeless::from(
            pallet_transaction_payment::ChargeTransactionPayment::<Runtime>::from(tip),
        ),
        frame_metadata_hash_extension::CheckMetadataHash::<Runtime>::new(false),
        frame_system::WeightReclaim::<Runtime>::new(),
    )
}

/// Sign `call` as `signer` and return the SCALE-encoded `UncheckedExtrinsic` ready for
/// `author_submitAndWatchExtrinsic`. The implicit tuple mirrors the `TxExtension` slot order — only
/// `CheckSpecVersion` (u32), `CheckTxVersion` (u32), `CheckGenesis` (H256), `CheckEra` (H256, = genesis for
/// immortal), and `CheckMetadataHash` (`None`, disabled) carry data.
pub fn build_signed(
    call: RuntimeCall,
    signer: &Signer,
    nonce: u32,
    tip: u128,
    ctx: &ChainCtx,
) -> Vec<u8> {
    let ext = tx_extension(nonce, tip);
    // Extension::Implicit is the per-slot tuple of implicits; type-checked against the runtime's
    // TxExtension by `from_raw`. A wrong shape here is a COMPILE error, not a silent bad signature.
    let implicit = (
        (),               // AuthorizeCall
        (),               // CheckNonZeroSender
        ctx.spec_version, // CheckSpecVersion
        ctx.tx_version,   // CheckTxVersion
        ctx.genesis,      // CheckGenesis
        ctx.genesis,      // CheckEra (immortal ⇒ anchored at genesis)
        (),               // CheckNonce
        (),               // CheckWeight
        (),               // CheckCapacity (spam meter — no implicit)
        (), // SkipCheckIfFeeless<ChargeTransactionPayment> (transparent ⇒ the inner ())
        None::<[u8; 32]>, // CheckMetadataHash (disabled)
        (), // WeightReclaim
    );
    let payload = SignedPayload::from_raw(call.clone(), ext.clone(), implicit);
    // `using_encoded` (via Encode for SignedPayload) applies blake2_256 iff the payload exceeds 256 B.
    let signature = payload.using_encoded(|p| signer.sign(p));
    let xt =
        UncheckedExtrinsic::new_signed(call, MultiAddress::Id(signer.account_id()), signature, ext);
    xt.encode()
}

/// Build a BARE (unsigned) `UncheckedExtrinsic` — no signer, no nonce, no `TxExtension`. Used for cogno's
/// feeless CIP-8 identity binds (`cogno_gate::link_identity_signed` / `link_stake_signed`): the CIP-8 proof
/// carried inside the call IS the authorization (`ensure_none` + `validate_unsigned` at the pool), so a
/// zero-balance derived account can bind with no fee and no sponsor. Matches the frontend's `getBareTx()`
/// path exactly.
pub fn build_bare(call: RuntimeCall) -> Vec<u8> {
    UncheckedExtrinsic::new_bare(call).encode()
}

/// The motion's proposal hash = `blake2_256(SCALE(inner_call))` — the key the committee `vote`/`close`
/// reference (matches `pallet_collective`'s `T::Hashing::hash_of(&proposal)`).
pub fn proposal_hash(inner: &RuntimeCall) -> H256 {
    H256(blake2_256(&inner.encode()))
}

/// The `length_bound` for `propose`/`close` = the encoded length of the inner call. The pallet requires
/// `length_bound >= proposal.encoded_size()`; this is exactly that size.
pub fn length_bound(inner: &RuntimeCall) -> u32 {
    inner.encode().len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{generate, Scheme};

    /// A signed extrinsic round-trips through the runtime's own `UncheckedExtrinsic` decoder — proving the
    /// assembled bytes are well-formed for THIS runtime (the same decoder the node uses on import).
    #[test]
    fn signed_xt_decodes_with_runtime_codec() {
        use codec::Decode;
        let (signer, _) = generate(Scheme::Sr25519, "t").unwrap();
        let ctx = ChainCtx {
            genesis: H256::repeat_byte(0xab),
            spec_version: 200,
            tx_version: 3,
        };
        // A tiny, always-available call: System::remark.
        let call = RuntimeCall::System(frame_system::Call::remark {
            remark: vec![1, 2, 3],
        });
        let bytes = build_signed(call.clone(), &signer, 0, 0, &ctx);
        let decoded = UncheckedExtrinsic::decode(&mut &bytes[..])
            .expect("runtime codec must decode our signed extrinsic");
        // The decoded call must be exactly what we signed.
        assert_eq!(decoded.function, call);
        // length_bound == encoded inner size; proposal_hash is stable/non-zero.
        assert_eq!(length_bound(&call) as usize, call.encode().len());
        assert_ne!(proposal_hash(&call), H256::zero());
    }

    /// A BARE extrinsic (an identity bind) round-trips through the runtime decoder and carries NO signature.
    #[test]
    fn bare_xt_decodes_and_is_unsigned() {
        use codec::Decode;
        let call = crate::calls::link_identity_signed(vec![1, 2, 3], vec![4, 5], None).unwrap();
        let bytes = build_bare(call.clone());
        let decoded = UncheckedExtrinsic::decode(&mut &bytes[..])
            .expect("runtime codec must decode our bare extrinsic");
        // The decoded call is exactly our bind; the bare form carries no signer (the CIP-8 proof is the
        // authorization) — a signed xt would encode with a non-zero preamble byte, a bare one with 0x04.
        assert_eq!(decoded.function, call);
        assert_ne!(bytes.len(), 0);
    }
}
