//! The committee governance driver — `propose → vote×k → close`.
//!
//! Invariants (do not lose these):
//! - **`resolve_committee` threshold = `ceil(n·3/5)`** from LIVE on-chain `FollowerCommittee::Members` —
//!   never a hardcoded 3 (`EnsureProportionAtLeast<3,5>` needs `ceil(n·3/5)` ayes). `threshold == 1`
//!   executes on `propose` (no separate motion).
//! - **`ensure_executed` inner-revert detection** — a motion can close `Approved` + emit `Executed` while
//!   the wrapped call returned `Err`. That MUST surface as an error (non-zero exit), not silent success.
//! - **Privileged writes resolve on FINALIZATION** (re-org safety); events are read from the finalized
//!   block; Dropped/Invalid/Usurped/FinalityTimeout are terminal (the wait can't hang) — in [`crate::rpc`].
//!
//! Because the CLI reuses the runtime's `RuntimeEvent`, events are decoded TYPED — `ensure_executed`
//! inspects `RuntimeEvent::FollowerCommittee(Executed { result, .. })` directly, no metadata lookup needed.

use anyhow::Context;
use codec::{Decode, Encode};
use cogno_chain_runtime::{RuntimeCall, RuntimeEvent};
use frame_support::weights::Weight;
use frame_system::EventRecord;
use pallet_collective::{Event as CommitteeEvent, Instance1};
use sp_core::{crypto::Ss58Codec, H256};
use sp_crypto_hashing::twox_128;
use sp_runtime::{AccountId32, DispatchError, ModuleError};

use crate::calls;
use crate::key::Signer;
use crate::rpc::Rpc;
use crate::tx::{self, ChainCtx};

/// The close weight bound. `pallet_collective::close` requires `proposal_weight_bound >=` the inner call's
/// DECLARED dispatch weight (else `WrongProposalWeight`). Most governed calls are tiny, but `set_members`
/// declares its weight over the WORST-CASE `MaxProposals` — far above a small fixed bound — so a
/// `members set`/`add`/`remove` close would silently revert at any multi-member committee. The runtime caps
/// every PROPOSABLE call at `MaxProposalWeight` (50% of the max block), so binding to exactly that ceiling
/// is always sufficient for any present or future governed call. We read it STRAIGHT FROM THE RUNTIME (the
/// CLI already links `cogno-chain-runtime`) so the bound can never drift from the on-chain value.
fn close_weight_bound() -> Weight {
    <cogno_chain_runtime::configs::MaxProposalWeight as frame_support::traits::Get<Weight>>::get()
}

/// `twox_128(pallet) ++ twox_128(item)` — the prefix of a storage value / map.
pub fn storage_prefix(pallet: &str, item: &str) -> Vec<u8> {
    let mut k = twox_128(pallet.as_bytes()).to_vec();
    k.extend_from_slice(&twox_128(item.as_bytes()));
    k
}

/// The live committee membership (`FollowerCommittee::Members`, an ordered `Vec<AccountId>`).
pub async fn committee_members(rpc: &Rpc) -> anyhow::Result<Vec<AccountId32>> {
    let key = storage_prefix("FollowerCommittee", "Members");
    Ok(rpc
        .storage_decode::<Vec<AccountId32>>(&key, None)
        .await?
        .unwrap_or_default())
}

// ── Proposal discovery (`committee list`) + the standalone-close length bound ──
//
// `pallet-collective` keys `ProposalOf`/`Voting` with the `Identity` hasher: the storage map key is the
// 32-byte proposal hash VERBATIM (no extra hashing/length prefix), so the full key is just
// `twox128(FollowerCommittee) ++ twox128(item) ++ hash`.

/// The full storage key for a `FollowerCommittee` `Identity`-hashed map entry (`ProposalOf`/`Voting`).
fn committee_map_key(item: &str, hash: &H256) -> Vec<u8> {
    let mut k = storage_prefix("FollowerCommittee", item);
    k.extend_from_slice(hash.as_bytes());
    k
}

/// The open proposal hashes (`FollowerCommittee::Proposals`, a `BoundedVec` decoded as `Vec`).
pub async fn proposal_hashes(rpc: &Rpc) -> anyhow::Result<Vec<H256>> {
    let key = storage_prefix("FollowerCommittee", "Proposals");
    Ok(rpc
        .storage_decode::<Vec<H256>>(&key, None)
        .await?
        .unwrap_or_default())
}

/// `FollowerCommittee::ProposalOf[hash]` — the inner call of an open motion (`None` if closed/absent).
pub async fn proposal_of(rpc: &Rpc, hash: &H256) -> anyhow::Result<Option<RuntimeCall>> {
    rpc.storage_decode::<RuntimeCall>(&committee_map_key("ProposalOf", hash), None)
        .await
}

/// A read-only view of `FollowerCommittee::Voting[hash]`. `pallet_collective::Votes`' fields are private,
/// so this mirrors its exact SCALE layout (`index, threshold, ayes, nays, end`) to decode the same bytes.
#[derive(Decode)]
pub struct VotesView {
    /// The proposal's unique index.
    pub index: u32,
    /// Ayes needed to pass (= the motion threshold).
    pub threshold: u32,
    /// Accounts that have voted aye.
    pub ayes: Vec<AccountId32>,
    /// Accounts that have voted nay.
    pub nays: Vec<AccountId32>,
    /// The block by which the motion lapses if undecided.
    pub end: u32,
}

/// `FollowerCommittee::Voting[hash]` decoded into [`VotesView`] (`None` if closed/absent).
pub async fn voting_of(rpc: &Rpc, hash: &H256) -> anyhow::Result<Option<VotesView>> {
    rpc.storage_decode::<VotesView>(&committee_map_key("Voting", hash), None)
        .await
}

/// A concise, human description of a governed inner call for `committee list` — so a co-signer can see WHAT
/// they're voting on without an explorer. Falls back to the SCALE pallet/call index for any call outside
/// the curated governance surface.
pub fn describe_call(call: &RuntimeCall) -> String {
    let ss58 = |a: &AccountId32| a.to_ss58check_with_version(42u16.into());
    match call {
        RuntimeCall::ValidatorSet(pallet_validator_set::Call::add_validator { validator_id }) => {
            format!("ValidatorSet.add_validator({})", ss58(validator_id))
        }
        RuntimeCall::ValidatorSet(pallet_validator_set::Call::remove_validator {
            validator_id,
        }) => {
            format!("ValidatorSet.remove_validator({})", ss58(validator_id))
        }
        RuntimeCall::FollowerCommittee(pallet_collective::Call::set_members {
            new_members,
            prime,
            old_count,
        }) => format!(
            "FollowerCommittee.set_members([{}], prime={}, old_count={old_count})",
            new_members.iter().map(ss58).collect::<Vec<_>>().join(", "),
            prime.as_ref().map(ss58).unwrap_or_else(|| "none".into()),
        ),
        RuntimeCall::CognoGate(pallet_cogno_gate::Call::revoke { substrate_account }) => {
            format!("CognoGate.revoke({})", ss58(substrate_account))
        }
        RuntimeCall::CardanoObserver(pallet_cardano_observer::Call::set_enforcement {
            enabled,
        }) => {
            format!("CardanoObserver.set_enforcement({enabled})")
        }
        RuntimeCall::GovernedUpgrade(pallet_governed_upgrade::Call::authorize_upgrade {
            code_hash,
        }) => format!("GovernedUpgrade.authorize_upgrade(code_hash={code_hash:#x})"),
        other => {
            let b = other.encode();
            format!(
                "<pallet {} call {} — {} bytes>",
                b.first().copied().unwrap_or(0),
                b.get(1).copied().unwrap_or(0),
                b.len()
            )
        }
    }
}

/// Read the (typed) runtime events at a block (`System::Events`; `ValueQuery` ⇒ empty when absent).
pub async fn events_at(rpc: &Rpc, at: H256) -> anyhow::Result<Vec<RuntimeEvent>> {
    Ok(events_with_phase_at(rpc, at)
        .await?
        .into_iter()
        .map(|(_, e)| e)
        .collect())
}

/// Read the events at a block keeping each record's `Phase` — needed to attribute an `ExtrinsicFailed` to a
/// SPECIFIC extrinsic index (so an unrelated failure in the same block isn't misread as ours).
pub async fn events_with_phase_at(
    rpc: &Rpc,
    at: H256,
) -> anyhow::Result<Vec<(frame_system::Phase, RuntimeEvent)>> {
    let key = storage_prefix("System", "Events");
    let recs: Vec<EventRecord<RuntimeEvent, H256>> = rpc
        .storage_decode(&key, Some(at))
        .await?
        .unwrap_or_default();
    Ok(recs.into_iter().map(|r| (r.phase, r.event)).collect())
}

/// `ceil(n·3/5)` via integer `div_ceil` — the `EnsureProportionAtLeast<3,5>` floor.
pub fn threshold_for(n: usize) -> u32 {
    (3 * n as u64).div_ceil(5) as u32
}

/// The outcome of resolving the committee against live membership.
pub struct Resolved {
    /// The required aye threshold = `ceil(n·3/5)` (or an explicit override ≥ that).
    pub threshold: u32,
    /// The number of on-chain members `n`.
    pub onchain_count: usize,
    /// The indices (into the caller's local signer list) of the seats that ARE on-chain members.
    pub eligible: Vec<usize>,
}

/// Resolve the committee: read live membership, compute `ceil(n·3/5)`, and reconcile the local seat signers
/// against the on-chain set — failing loudly when too few local seats are on-chain members to reach the
/// threshold (a stale/mismatched key set).
pub async fn resolve_committee(
    rpc: &Rpc,
    local_signers: &[Signer],
    explicit_threshold: Option<u32>,
) -> anyhow::Result<Resolved> {
    let onchain = committee_members(rpc).await?;
    anyhow::ensure!(
		!onchain.is_empty(),
		"FollowerCommittee has no on-chain members — seat the committee at genesis before driving a committee call."
	);
    let min = threshold_for(onchain.len());
    let threshold = match explicit_threshold {
        None => min,
        Some(t) => {
            anyhow::ensure!(t >= 1, "--threshold must be a positive integer (got {t})");
            anyhow::ensure!(
				t >= min,
				"--threshold {t} is below the 3/5 minimum {min} for this committee of {} — the inner call \
				 would BadOrigin. Use >= {min}.",
				onchain.len()
			);
            t
        }
    };
    // Dedup by on-chain account: two key files for the SAME member account must not both count toward the
    // threshold (they would pass this check, then fail at vote time with DuplicateVote). Keep the first
    // local seat index per distinct member account.
    let mut seen = std::collections::BTreeSet::new();
    let eligible: Vec<usize> = local_signers
        .iter()
        .enumerate()
        .filter(|(_, s)| onchain.contains(&s.account_id()) && seen.insert(s.account_id()))
        .map(|(i, _)| i)
        .collect();
    anyhow::ensure!(
		eligible.len() >= threshold as usize,
		"committee: {} of your local seat(s) are on-chain members, but the 3/5 origin needs {} ayes of {} \
		 members — your key files do not match the on-chain committee.",
		eligible.len(),
		threshold,
		onchain.len()
	);
    Ok(Resolved {
        threshold,
        onchain_count: onchain.len(),
        eligible,
    })
}

/// Format a `DispatchError`, decoding a `Module` error into its typed pallet error name for the pallets the
/// CLI drives (so `inner call REVERTED (ValidatorSet.Duplicate)` reads clearly), without metadata.
pub fn format_dispatch_error(err: &DispatchError) -> String {
    if let DispatchError::Module(ModuleError { index, error, .. }) = err {
        let name = decode_module_error(*index, error);
        return name.unwrap_or_else(|| format!("Module {{ index: {index}, error: {error:?} }}"));
    }
    format!("{err:?}")
}

/// Decode the typed pallet `Error` for a `Module` error of a pallet the CLI drives. Returns
/// `Pallet.Variant` or `None` for an unrecognized pallet index.
fn decode_module_error(index: u8, error: &[u8; 4]) -> Option<String> {
    use cogno_chain_runtime::Runtime;
    let mut input = &error[..];
    let name = match index {
        0 => format!(
            "System.{:?}",
            frame_system::Error::<Runtime>::decode(&mut input).ok()?
        ),
        8 => format!(
            "CognoGate.{:?}",
            pallet_cogno_gate::Error::<Runtime>::decode(&mut input).ok()?
        ),
        13 => format!(
            "FollowerCommittee.{:?}",
            pallet_collective::Error::<Runtime, Instance1>::decode(&mut input).ok()?
        ),
        14 => format!(
            "ValidatorSet.{:?}",
            pallet_validator_set::Error::<Runtime>::decode(&mut input).ok()?
        ),
        15 => format!(
            "Session.{:?}",
            pallet_session::Error::<Runtime>::decode(&mut input).ok()?
        ),
        16 => format!(
            "CardanoObserver.{:?}",
            pallet_cardano_observer::Error::<Runtime>::decode(&mut input).ok()?
        ),
        _ => return None,
    };
    Some(name)
}

/// `ensure_executed` — scan a block's events for the committee `Executed` of our motion and FAIL if the
/// wrapped inner call reverted. `proposal_hash == None` matches any `Executed` (the threshold==1 path, where
/// exactly one executed). A motion can "succeed" (Approved) while the inner call returns `Err`; this is the
/// single most important correctness check.
pub fn ensure_executed(
    events: &[RuntimeEvent],
    proposal_hash: Option<H256>,
    label: &str,
) -> anyhow::Result<()> {
    let mut found = false;
    for ev in events {
        if let RuntimeEvent::FollowerCommittee(CommitteeEvent::Executed {
            proposal_hash: h,
            result,
        }) = ev
        {
            if proposal_hash.map(|want| want == *h).unwrap_or(true) {
                found = true;
                if let Err(e) = result {
                    anyhow::bail!(
						"{label}: inner call REVERTED ({}) — the motion executed but the wrapped call failed",
						format_dispatch_error(e)
					);
                }
            }
        }
    }
    anyhow::ensure!(
		found,
		"{label}: no FollowerCommittee.Executed event for the motion (the inner call did not execute)"
	);
    Ok(())
}

/// Assert OUR submitted extrinsic succeeded in `block`: locate it by its encoded bytes in the block body to
/// get its index, then surface a `System::ExtrinsicFailed` ONLY if it is at that index's
/// `Phase::ApplyExtrinsic` (so an unrelated extrinsic failing in the same block can't be misattributed).
pub async fn assert_extrinsic_ok(
    rpc: &Rpc,
    block: H256,
    xt: &[u8],
    label: &str,
) -> anyhow::Result<()> {
    let body = rpc.block_extrinsics(block).await?;
    let idx = match body.iter().position(|x| x.as_slice() == xt) {
        Some(i) => i as u32,
        // Our xt isn't in this block (a re-org moved it, or finalize landed it elsewhere) — skip the
        // best-effort check rather than risk a misattribution. The downstream committee assertions remain
        // the authoritative success gate.
        None => return Ok(()),
    };
    for (phase, ev) in events_with_phase_at(rpc, block).await? {
        if let (
            frame_system::Phase::ApplyExtrinsic(i),
            RuntimeEvent::System(frame_system::Event::ExtrinsicFailed { dispatch_error, .. }),
        ) = (&phase, &ev)
        {
            if *i == idx {
                anyhow::bail!(
                    "{label}: extrinsic FAILED ({})",
                    format_dispatch_error(dispatch_error)
                );
            }
        }
    }
    Ok(())
}

/// Find the proposal index the pallet assigned to our motion, by matching the computed proposal hash
/// against the `FollowerCommittee::Proposed` events in the propose block.
fn proposal_index_for(events: &[RuntimeEvent], proposal_hash: H256) -> Option<u32> {
    events.iter().find_map(|ev| match ev {
        RuntimeEvent::FollowerCommittee(CommitteeEvent::Proposed {
            proposal_index,
            proposal_hash: h,
            ..
        }) if *h == proposal_hash => Some(*proposal_index),
        _ => None,
    })
}

fn has_approved(events: &[RuntimeEvent], proposal_hash: H256) -> bool {
    events.iter().any(|ev| {
		matches!(ev, RuntimeEvent::FollowerCommittee(CommitteeEvent::Approved { proposal_hash: h }) if *h == proposal_hash)
	})
}

fn has_disapproved(events: &[RuntimeEvent], proposal_hash: H256) -> bool {
    events.iter().any(|ev| {
		matches!(ev, RuntimeEvent::FollowerCommittee(CommitteeEvent::Disapproved { proposal_hash: h }) if *h == proposal_hash)
	})
}

/// How a `close` resolved the motion — `pallet_collective::close` either executes an approved motion or
/// REMOVES one that can no longer pass. Both are successful outcomes of the same call.
pub enum CloseOutcome {
    /// Threshold reached — the inner call executed (already checked for an inner revert).
    Approved,
    /// The motion could not reach threshold and was removed WITHOUT executing (enough nays, or it lapsed).
    Disapproved,
}

/// The outcome of a `propose_motion`.
pub enum ProposeOutcome {
    /// `threshold == 1`: the inner call executed ON propose (no separate motion); finalized + checked.
    ExecutedOnPropose {
        /// The finalized block the execution landed in.
        block: H256,
    },
    /// `threshold > 1`: the motion is open. Co-signers `vote_motion` then someone `close_motion`.
    Open {
        /// The motion hash (`blake2_256` of the inner call) — the `Voting`/`ProposalOf` key.
        proposal_hash: H256,
        /// The pallet-assigned motion index (needed by `vote`/`close`).
        index: u32,
    },
}

/// Submit `FollowerCommittee::propose(threshold, inner, length_bound)` as ONE seat (`proposer`). For
/// `threshold == 1` the inner call executes on propose (resolved on finalization + `ensure_executed`); for
/// `threshold > 1` the motion opens and the pallet-assigned `(hash, index)` is returned. The proposer is NOT
/// auto-counted as an aye by `pallet-collective` — it must also `vote_motion` to contribute its aye.
pub async fn propose_motion(
    rpc: &Rpc,
    ctx: &ChainCtx,
    inner: RuntimeCall,
    proposer: &Signer,
    threshold: u32,
) -> anyhow::Result<ProposeOutcome> {
    let length_bound = tx::length_bound(&inner);
    let phash = tx::proposal_hash(&inner);
    let propose_call = calls::propose(threshold, inner, length_bound);
    let nonce = rpc.account_nonce(&proposer.ss58()).await?;
    let xt = tx::build_signed(propose_call, proposer, nonce, 0, ctx);

    // ── threshold==1 executes the inner call ON propose (no motion) → finalize + ensure_executed.
    if threshold == 1 {
        eprintln!(
            "propose (threshold 1 — executes on propose) as {}",
            proposer.ss58()
        );
        let block = rpc.submit_and_watch(&xt, true, "propose").await?;
        let events = events_at(rpc, block).await?;
        ensure_executed(&events, None, "propose")?;
        eprintln!("✓ executed on propose (finalized in {block:#x})");
        return Ok(ProposeOutcome::ExecutedOnPropose { block });
    }

    // ── threshold>1: propose (in-block), collect the pallet-assigned index.
    eprintln!(
        "propose motion (threshold {threshold}) as {}",
        proposer.ss58()
    );
    let block = rpc.submit_and_watch(&xt, false, "propose").await?;
    assert_extrinsic_ok(rpc, block, &xt, "propose").await?;
    let pevents = events_at(rpc, block).await?;
    let index = proposal_index_for(&pevents, phash).context(
        "no FollowerCommittee.Proposed event for our motion (is the proposer a committee member?)",
    )?;
    eprintln!("proposed motion #{index} ({phash:#x})");
    Ok(ProposeOutcome::Open {
        proposal_hash: phash,
        index,
    })
}

/// Cast ONE seat's vote on an open motion (`FollowerCommittee::vote`, in-block, asserted ok — a
/// landed-but-reverted vote like `DuplicateVote`/`NotMember` surfaces here, matched to OUR extrinsic).
pub async fn vote_motion(
    rpc: &Rpc,
    ctx: &ChainCtx,
    proposal_hash: H256,
    index: u32,
    approve: bool,
    voter: &Signer,
) -> anyhow::Result<H256> {
    let nonce = rpc.account_nonce(&voter.ss58()).await?;
    let vote_call = calls::vote(proposal_hash, index, approve);
    let xt = tx::build_signed(vote_call, voter, nonce, 0, ctx);
    let label = format!("vote {} on #{index}", if approve { "aye" } else { "nay" });
    eprintln!("  {label} by {}", voter.ss58());
    let block = rpc.submit_and_watch(&xt, false, &label).await?;
    assert_extrinsic_ok(rpc, block, &xt, &label).await?;
    Ok(block)
}

/// Close a motion as ONE seat (`FollowerCommittee::close`, finalized). `close` resolves EITHER way: it
/// executes a motion that reached threshold ([`CloseOutcome::Approved`] — asserts `Executed`, surfacing an
/// inner revert), or it REMOVES one that can no longer pass ([`CloseOutcome::Disapproved`]). If the motion
/// is still undecided AND its voting window hasn't elapsed, the pallet rejects the close with
/// `FollowerCommittee.TooEarly` — surfaced verbatim. The closer needn't hold the inner call — it is read
/// from `ProposalOf` to size `length_bound` exactly.
pub async fn close_motion(
    rpc: &Rpc,
    ctx: &ChainCtx,
    proposal_hash: H256,
    index: u32,
    closer: &Signer,
) -> anyhow::Result<CloseOutcome> {
    let inner = proposal_of(rpc, &proposal_hash).await?.with_context(|| {
        format!(
            "close: no open proposal {proposal_hash:#x} (already closed/executed, or wrong hash?)"
        )
    })?;
    let length_bound = tx::length_bound(&inner);
    let nonce = rpc.account_nonce(&closer.ss58()).await?;
    let close_call = calls::close(proposal_hash, index, close_weight_bound(), length_bound);
    let xt = tx::build_signed(close_call, closer, nonce, 0, ctx);
    eprintln!("close motion #{index} as {}", closer.ss58());
    let block = rpc.submit_and_watch(&xt, true, "close").await?;
    // The close itself can be rejected — `FollowerCommittee.TooEarly`, or a weight/length-bound mismatch.
    assert_extrinsic_ok(rpc, block, &xt, "close").await?;
    let cevents = events_at(rpc, block).await?;
    if has_approved(&cevents, proposal_hash) {
        ensure_executed(&cevents, Some(proposal_hash), "close")?;
        eprintln!("✓ close → Approved + Executed (finalized in {block:#x})");
        Ok(CloseOutcome::Approved)
    } else if has_disapproved(&cevents, proposal_hash) {
        eprintln!(
            "✓ close → Disapproved — motion removed without executing (finalized in {block:#x})"
        );
        Ok(CloseOutcome::Disapproved)
    } else {
        anyhow::bail!(
            "close: motion #{index} did not resolve — no Approved/Disapproved event in {block:#x}"
        )
    }
}

/// Drive a governed inner call through the committee in ONE process (the bundled, single-host path behind
/// every governed verb): `propose → vote×threshold → close`, resolving the privileged write on
/// finalization. `signers[eligible[..]]` are the local seats that are on-chain members; the first
/// `threshold` of them vote (incl. the proposer — propose does NOT auto-count it), and the last eligible
/// seat closes. For TRUE multi-custody run the same verb with `--propose`.
pub async fn via_committee(
    rpc: &Rpc,
    ctx: &ChainCtx,
    inner: RuntimeCall,
    signers: &[Signer],
    resolved: &Resolved,
) -> anyhow::Result<()> {
    let threshold = resolved.threshold;
    let voters: Vec<&Signer> = resolved
        .eligible
        .iter()
        .take(threshold as usize)
        .map(|&i| &signers[i])
        .collect();
    anyhow::ensure!(
        voters.len() == threshold as usize,
        "via_committee: only {} eligible voter(s) for a {threshold}-of-{} threshold",
        voters.len(),
        resolved.onchain_count
    );
    let proposer = voters[0];
    let closer = &signers[*resolved.eligible.last().unwrap()];

    match propose_motion(rpc, ctx, inner, proposer, threshold).await? {
        ProposeOutcome::ExecutedOnPropose { .. } => Ok(()),
        ProposeOutcome::Open {
            proposal_hash,
            index,
        } => {
            // All `threshold` eligible seats vote aye (propose did not pre-count the proposer).
            for v in &voters {
                vote_motion(rpc, ctx, proposal_hash, index, true, v).await?;
            }
            // The bundled path just cast `threshold` ayes, so close MUST approve+execute. A Disapproved here
            // means the intended governance write did NOT happen — fail loudly.
            match close_motion(rpc, ctx, proposal_hash, index, closer).await? {
                CloseOutcome::Approved => Ok(()),
                CloseOutcome::Disapproved => anyhow::bail!(
					"via_committee: close DISAPPROVED motion #{index} despite {threshold} ayes — the \
					 governance call did not execute (concurrent nay vote or membership change?)"
				),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_ceil_3_5() {
        // ceil(n·3/5): 1→1, 3→2, 5→3, 6→4, 7→5.
        assert_eq!(threshold_for(1), 1);
        assert_eq!(threshold_for(2), 2); // ceil(6/5)=2
        assert_eq!(threshold_for(3), 2);
        assert_eq!(threshold_for(4), 3); // ceil(12/5)=3
        assert_eq!(threshold_for(5), 3);
        assert_eq!(threshold_for(6), 4);
        assert_eq!(threshold_for(7), 5);
    }

    #[test]
    fn ensure_executed_flags_inner_revert() {
        let phash = H256::repeat_byte(9);
        let err = DispatchError::Module(ModuleError {
            index: 14,
            error: [0, 0, 0, 0],
            message: None,
        });
        let bad = vec![RuntimeEvent::FollowerCommittee(CommitteeEvent::Executed {
            proposal_hash: phash,
            result: Err(err),
        })];
        assert!(ensure_executed(&bad, Some(phash), "close").is_err());
        let ok = vec![RuntimeEvent::FollowerCommittee(CommitteeEvent::Executed {
            proposal_hash: phash,
            result: Ok(()),
        })];
        assert!(ensure_executed(&ok, Some(phash), "close").is_ok());
        assert!(ensure_executed(&[], Some(phash), "close").is_err());
    }

    #[test]
    fn describe_call_is_human_readable() {
        let up = crate::calls::authorize_upgrade(H256::repeat_byte(0xaa));
        assert!(
            describe_call(&up).starts_with("GovernedUpgrade.authorize_upgrade(code_hash=0x"),
            "{}",
            describe_call(&up)
        );
        let av = crate::calls::add_validator(AccountId32::new([1u8; 32]));
        assert!(describe_call(&av).starts_with("ValidatorSet.add_validator("));
        let rv = crate::calls::revoke(AccountId32::new([2u8; 32]));
        assert!(describe_call(&rv).starts_with("CognoGate.revoke("));
    }

    #[test]
    fn votesview_mirrors_collective_votes_layout() {
        // VotesView must decode the exact SCALE bytes pallet_collective::Votes encodes (its fields are
        // private). A struct encodes field-in-order identically to the equivalent tuple.
        let ayes = vec![AccountId32::new([1u8; 32]), AccountId32::new([2u8; 32])];
        let nays: Vec<AccountId32> = vec![];
        let encoded = (7u32, 3u32, ayes.clone(), nays.clone(), 99u32).encode();
        let view = VotesView::decode(&mut &encoded[..]).expect("decodes the Votes layout");
        assert_eq!(view.index, 7);
        assert_eq!(view.threshold, 3);
        assert_eq!(view.ayes, ayes);
        assert_eq!(view.nays, nays);
        assert_eq!(view.end, 99);
    }
}
