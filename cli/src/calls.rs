//! Typed `RuntimeCall` constructors for the governance + identity surface — one per CLI verb.
//!
//! Because the CLI reuses the runtime's own `RuntimeCall` (not subxt metadata), calls are built from the
//! typed pallet `Call` variants — the compiler guarantees correct pallet/call indices + arg types. There
//! is **deliberately no talk-stake call** here: `TalkStake@9` has no extrinsic (the cardano-observer
//! inherent is the sole writer), so the CLI literally cannot construct one.
//!
//! The committee path governs ONLY: validator add/remove, committee self-rotation (`set_members`),
//! cogno-gate `revoke`, and the committee-governed runtime-upgrade authorization
//! (`GovernedUpgrade::authorize_upgrade`). There is **no raw `set_code`**: the
//! committee authorizes only the 32-byte code hash, and the WASM is uploaded permissionlessly via the
//! EXISTING `System::apply_authorized_upgrade` (which refuses a non-increasing `spec_version`). The two
//! CIP-8 identity binds are **BARE/unsigned** — the proof is the authorization, so they are self-service,
//! never a committee or self-signed call.

use anyhow::Context;
use cogno_chain_runtime::{Runtime, RuntimeCall, SessionKeys};
use frame_support::weights::Weight;
use pallet_collective::Instance1;
use sp_core::{crypto::Ss58Codec, ed25519, sr25519, H256};
use sp_runtime::AccountId32;

/// Parse an SS58 account string into an `AccountId32` (the runtime's `AccountId`).
pub fn parse_account(s: &str) -> anyhow::Result<AccountId32> {
    AccountId32::from_ss58check(s.trim())
        .map_err(|e| anyhow::anyhow!("invalid SS58 account {s:?}: {e:?}"))
}

/// Parse a 32-byte hash from hex (`0x`-optional) into an `H256`. Used by `authorize_upgrade` for the
/// runtime `code_hash` (= `blake2_256(wasm)`).
pub fn parse_hash32(s: &str) -> anyhow::Result<H256> {
    let h = s.trim().strip_prefix("0x").unwrap_or(s.trim());
    let b = hex::decode(h).with_context(|| format!("invalid hex {s:?}"))?;
    anyhow::ensure!(
        b.len() == 32,
        "expected a 32-byte code hash, got {} bytes",
        b.len()
    );
    Ok(H256::from_slice(&b))
}

// ── Inner (committee-governed) calls — wrapped by the committee `propose` ──────────────────────────

/// `ValidatorSet::add_validator(validator_id)`.
pub fn add_validator(validator: AccountId32) -> RuntimeCall {
    RuntimeCall::ValidatorSet(pallet_validator_set::Call::<Runtime>::add_validator {
        validator_id: validator,
    })
}

/// `ValidatorSet::remove_validator(validator_id)`.
pub fn remove_validator(validator: AccountId32) -> RuntimeCall {
    RuntimeCall::ValidatorSet(pallet_validator_set::Call::<Runtime>::remove_validator {
        validator_id: validator,
    })
}

/// `FollowerCommittee::set_members(new_members, prime, old_count)` — committee self-rotation (the
/// decentralization path). Itself `AuthorityOrigin`-gated, so it routes through `propose`.
pub fn set_members(
    new_members: Vec<AccountId32>,
    prime: Option<AccountId32>,
    old_count: u32,
) -> RuntimeCall {
    RuntimeCall::FollowerCommittee(pallet_collective::Call::<Runtime, Instance1>::set_members {
        new_members,
        prime,
        old_count,
    })
}

/// `CognoGate::revoke(substrate_account)` — the manual-operator-ban path (DR-14). `FollowerOrigin`-gated
/// (= the 3/5 committee), so it routes through `propose`. Flips `is_allowed` to false for the account.
pub fn revoke(substrate_account: AccountId32) -> RuntimeCall {
    RuntimeCall::CognoGate(pallet_cogno_gate::Call::<Runtime>::revoke { substrate_account })
}

/// `GovernedUpgrade::authorize_upgrade(code_hash)` — the committee-governed runtime-upgrade authorization.
/// `AuthorityOrigin`-gated, so it routes through `propose`. The motion carries only the
/// 32-byte `code_hash` (= `blake2_256(wasm)`); the WASM itself is uploaded later, permissionlessly, via
/// [`apply_authorized_upgrade`] (which refuses a non-increasing `spec_version`).
pub fn authorize_upgrade(code_hash: H256) -> RuntimeCall {
    RuntimeCall::GovernedUpgrade(
        pallet_governed_upgrade::Call::<Runtime>::authorize_upgrade { code_hash },
    )
}

// ── Self-signed calls (NOT committee motions) ──────────────────────────────────────────────────────

/// `System::apply_authorized_upgrade(code)` — supply the WASM for a previously-authorized upgrade.
/// **Permissionless** (any signer; `Pays::No`) and NOT a committee call, so it is driven directly like
/// `set_keys`. `frame_system` re-derives `blake2_256(code)`, checks it matches the authorized hash, and —
/// because the authorization was created with version-checking on — refuses a changed spec-name or a
/// non-increasing `spec_version`.
pub fn apply_authorized_upgrade(code: Vec<u8>) -> RuntimeCall {
    RuntimeCall::System(frame_system::Call::<Runtime>::apply_authorized_upgrade { code })
}

/// `Session::set_keys(keys, proof)` — the validator self-onboards its session keys. NOT a committee call
/// (it's `ensure_signed` by the validator's own account); driven directly, before `add_validator`.
pub fn set_keys(aura: sr25519::Public, grandpa: ed25519::Public, proof: Vec<u8>) -> RuntimeCall {
    // The SessionKeys fields are app-crypto wrappers (AuraId / GrandpaId); convert the raw publics.
    RuntimeCall::Session(pallet_session::Call::<Runtime>::set_keys {
        keys: SessionKeys {
            aura: aura.into(),
            grandpa: grandpa.into(),
        },
        proof,
    })
}

// ── BARE (unsigned) CIP-8 identity binds — the proof is the authorization ───────────────────────────

/// `CognoGate::link_identity_signed(cose_sign1, cose_key, thread_pointer)` — the feeless, **unsigned**
/// (`ensure_none`) CIP-8 payment-key identity bind. The COSE proof (produced OFF-chain in the wallet)
/// commits the bound account, so the submitter cannot retarget it. Built into a BARE extrinsic (no signer,
/// no nonce, no `TxExtension`) by [`crate::tx::build_bare`].
pub fn link_identity_signed(
    cose_sign1: Vec<u8>,
    cose_key: Vec<u8>,
    thread_pointer: Option<Vec<u8>>,
) -> anyhow::Result<RuntimeCall> {
    if let Some(t) = &thread_pointer {
        anyhow::ensure!(
            t.len() <= 10,
            "thread pointer exceeds the 10-byte on-chain bound (BoundedVec<u8, 10>), got {} bytes",
            t.len()
        );
    }
    Ok(RuntimeCall::CognoGate(
        pallet_cogno_gate::Call::<Runtime>::link_identity_signed {
            cose_sign1: cose_sign1
                .try_into()
                .map_err(|_| anyhow::anyhow!("cose_sign1 exceeds the 512-byte bound"))?,
            cose_key: cose_key
                .try_into()
                .map_err(|_| anyhow::anyhow!("cose_key exceeds the 128-byte bound"))?,
            thread_pointer,
        },
    ))
}

/// `CognoGate::link_stake_signed(cose_sign1, cose_key)` — the feeless, **unsigned** CIP-8 stake-key bind
/// (voting power). The account must already be payment-bound. Built into a BARE extrinsic like the identity
/// bind — the stake-key proof is the authorization.
pub fn link_stake_signed(cose_sign1: Vec<u8>, cose_key: Vec<u8>) -> anyhow::Result<RuntimeCall> {
    Ok(RuntimeCall::CognoGate(
        pallet_cogno_gate::Call::<Runtime>::link_stake_signed {
            cose_sign1: cose_sign1
                .try_into()
                .map_err(|_| anyhow::anyhow!("cose_sign1 exceeds the 512-byte bound"))?,
            cose_key: cose_key
                .try_into()
                .map_err(|_| anyhow::anyhow!("cose_key exceeds the 128-byte bound"))?,
        },
    ))
}

// ── Committee wrappers (the motion lifecycle calls) ─────────────────────────────────────────────────

/// `FollowerCommittee::propose(threshold, proposal, length_bound)`.
pub fn propose(threshold: u32, inner: RuntimeCall, length_bound: u32) -> RuntimeCall {
    RuntimeCall::FollowerCommittee(pallet_collective::Call::<Runtime, Instance1>::propose {
        threshold,
        proposal: Box::new(inner),
        length_bound,
    })
}

/// `FollowerCommittee::vote(proposal_hash, index, approve)`.
pub fn vote(proposal_hash: H256, index: u32, approve: bool) -> RuntimeCall {
    RuntimeCall::FollowerCommittee(pallet_collective::Call::<Runtime, Instance1>::vote {
        proposal: proposal_hash,
        index,
        approve,
    })
}

/// `FollowerCommittee::close(proposal_hash, index, proposal_weight_bound, length_bound)`.
pub fn close(proposal_hash: H256, index: u32, weight: Weight, length_bound: u32) -> RuntimeCall {
    RuntimeCall::FollowerCommittee(pallet_collective::Call::<Runtime, Instance1>::close {
        proposal_hash,
        index,
        proposal_weight_bound: weight,
        length_bound,
    })
}

// NOTE: there is deliberately NO generic string→call dispatcher. Every governed call is a TYPED
// constructor above, reached only through a typed CLI verb. The absence of a raw dispatcher is the security
// boundary: there is no talk-stake / sudo / raw `set_code` constructor here, so the CLI cannot build one —
// a runtime upgrade is the committee authorizing a 32-byte code hash + the permissionless
// `apply_authorized_upgrade`, and the identity binds are self-service BARE calls, never committee ones.

#[cfg(test)]
mod tests {
    use super::*;
    use codec::Encode;

    #[test]
    fn add_validator_encodes_at_pallet_14_call_0() {
        let acct = AccountId32::new([7u8; 32]);
        let bytes = add_validator(acct).encode();
        assert_eq!(bytes[0], 14, "ValidatorSet pallet index");
        assert_eq!(bytes[1], 0, "add_validator call index");
        assert_eq!(&bytes[2..34], &[7u8; 32]);
    }

    #[test]
    fn remove_validator_encodes_at_pallet_14_call_1() {
        let bytes = remove_validator(AccountId32::new([8u8; 32])).encode();
        assert_eq!(bytes[0], 14, "ValidatorSet pallet index");
        assert_eq!(bytes[1], 1, "remove_validator call index");
    }

    #[test]
    fn set_members_encodes_at_committee_pallet_13() {
        let members = vec![AccountId32::new([1u8; 32]), AccountId32::new([2u8; 32])];
        let bytes = set_members(members, None, 2).encode();
        assert_eq!(bytes[0], 13, "FollowerCommittee pallet index");
        assert_eq!(bytes[1], 0, "set_members call index");
    }

    #[test]
    fn revoke_encodes_at_cognogate_pallet_8_call_1() {
        let bytes = revoke(AccountId32::new([3u8; 32])).encode();
        assert_eq!(bytes[0], 8, "CognoGate pallet index");
        assert_eq!(bytes[1], 1, "revoke call index");
    }

    #[test]
    fn identity_binds_encode_at_cognogate_pallet_8_calls_2_and_3() {
        let id = link_identity_signed(vec![1, 2, 3], vec![4, 5], None)
            .unwrap()
            .encode();
        assert_eq!(id[0], 8, "CognoGate pallet index");
        assert_eq!(id[1], 2, "link_identity_signed call index");
        let stake = link_stake_signed(vec![1, 2, 3], vec![4, 5])
            .unwrap()
            .encode();
        assert_eq!(stake[0], 8, "CognoGate pallet index");
        assert_eq!(stake[1], 3, "link_stake_signed call index");
    }

    #[test]
    fn identity_bind_rejects_oversized_cose() {
        // The COSE_Sign1 arg is bounded at 512 bytes; an oversized blob is rejected at construction.
        assert!(link_identity_signed(vec![0u8; 513], vec![4, 5], None).is_err());
        assert!(link_identity_signed(vec![1, 2], vec![0u8; 129], None).is_err());
    }

    #[test]
    fn authorize_upgrade_encodes_at_pallet_7_call_0() {
        let bytes = authorize_upgrade(H256::repeat_byte(0xcd)).encode();
        assert_eq!(bytes[0], 7, "GovernedUpgrade pallet index");
        assert_eq!(bytes[1], 0, "authorize_upgrade call index");
        assert_eq!(&bytes[2..34], &[0xcd; 32], "the 32-byte code hash");
    }

    #[test]
    fn apply_authorized_upgrade_encodes_at_system_pallet_0() {
        let bytes = apply_authorized_upgrade(vec![1, 2, 3]).encode();
        assert_eq!(bytes[0], 0, "System pallet index");
    }
}
