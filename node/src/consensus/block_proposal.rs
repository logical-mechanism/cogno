// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 LogicalMechanism. Reimplemented from the Apache-2.0 partner-chains
// `sp-partner-chains-consensus-aura` crate (see the repo NOTICE file for attribution).
//! `PartnerChainsProposerFactory`: wraps any `Environment` (here the stock
//! `sc_basic_authorship::ProposerFactory`) and APPENDS an [`InherentDigest`]'s items to the proposed
//! block's header. Passed to the STOCK `sc_consensus_aura::start_aura` (which is generic over the proposer
//! factory), so NO `start_aura`/`import_queue`/verifier fork is needed (Architecture A).
//!
//! Reimplemented from the Apache-2.0 partner-chains `sp-partner-chains-consensus-aura` primitives and
//! PINNED to cogno's polkadot-stable2603-3 `sp-consensus` 0.47.0, whose `Proposer` trait differs from the
//! archived upstream: `propose` takes a single `ProposeArgs<B>` (not 4 positional args) and the trait no
//! longer has `ProofRecording`/`Proof` associated types (proof recording moved into
//! `ProposeArgs::storage_proof_recorder`). ONE deliberate behavioural change from upstream: the
//! `.expect("InherentDigest can be created from inherent data")` is replaced with a logged-empty fallback
//! — a db-sync-lagging author that legitimately abstains (no inherent data) must NEVER panic the essential
//! authoring task.
//!
//! Why the appended `PreRuntime` item survives `Executive::final_checks`: `frame_system::initialize`
//! stores the FULL incoming header digest (`<Digest<T>>::put(digest)`) and `finalize` reproduces it, so
//! the sealed item is carried through `execute_block` exactly like the Aura slot pre-digest — no runtime
//! change is needed for the digest itself (in-protocol-observation §4.4).

use crate::consensus::InherentDigest;
use futures::FutureExt;
use sp_consensus::{Environment, ProposeArgs, Proposer};
use sp_runtime::traits::Block as BlockT;
use sp_runtime::{Digest, DigestItem};
use std::future::Future;
use std::marker::PhantomData;

/// Proposer factory for [`PartnerChainsProposer`]. Carries the `ID: InherentDigest` type parameter and
/// wraps an inner `Environment` (the stock `sc_basic_authorship::ProposerFactory`).
pub struct PartnerChainsProposerFactory<B: BlockT, E: Environment<B>, ID> {
    env: E,
    _phantom: PhantomData<(B, ID)>,
}

impl<B: BlockT, E: Environment<B>, ID> PartnerChainsProposerFactory<B, E, ID> {
    /// Wrap an inner proposer environment (e.g. `sc_basic_authorship::ProposerFactory`).
    pub fn new(env: E) -> Self {
        Self {
            env,
            _phantom: PhantomData,
        }
    }
}

impl<B: BlockT, E: Environment<B>, ID: InherentDigest + Send + Sync + 'static> Environment<B>
    for PartnerChainsProposerFactory<B, E, ID>
{
    type Proposer = PartnerChainsProposer<B, E::Proposer, ID>;
    type CreateProposer =
        Box<dyn Future<Output = Result<Self::Proposer, Self::Error>> + Send + Unpin + 'static>;
    type Error = <E as Environment<B>>::Error;

    fn init(&mut self, parent_header: &<B as BlockT>::Header) -> Self::CreateProposer {
        Box::new(
            self.env
                .init(parent_header)
                .map(|res| res.map(PartnerChainsProposer::<B, E::Proposer, ID>::new)),
        )
    }
}

/// Wraps a `Proposer`. Appends the [`InherentDigest`]'s items to the block's header logs, then delegates
/// to the inner proposer. Forwards the `Error`/`Proposal` associated types unchanged (so the Aura
/// pre-digest, the GRANDPA consensus digests, and the seal are untouched — the seal is a post-proposal
/// digest added by the slot worker, never seen here).
pub struct PartnerChainsProposer<B: BlockT, P: Proposer<B>, ID: InherentDigest> {
    proposer: P,
    _phantom: PhantomData<(B, ID)>,
}

impl<B: BlockT, P: Proposer<B>, ID: InherentDigest> PartnerChainsProposer<B, P, ID> {
    fn new(proposer: P) -> Self {
        Self {
            proposer,
            _phantom: PhantomData,
        }
    }
}

impl<B: BlockT, P: Proposer<B>, ID: InherentDigest> Proposer<B>
    for PartnerChainsProposer<B, P, ID>
{
    type Error = <P as Proposer<B>>::Error;
    type Proposal = <P as Proposer<B>>::Proposal;

    fn propose(self, mut args: ProposeArgs<B>) -> Self::Proposal {
        let mut logs: Vec<DigestItem> = Vec::from(args.inherent_digests.logs());
        // Append the sealed header digest. Unlike upstream's `.expect()`, a failure here is LOGGED and the
        // block is proposed WITHOUT the seal — `from_inherent_data` is total over missing inherent data
        // (Ok(vec![]) on the db-sync-lag abstain path), and an Err only on genuinely-corrupt local data, which
        // must still never wedge the essential authoring task.
        match ID::from_inherent_data(&args.inherent_data) {
            Ok(mut inherent_logs) => logs.append(&mut inherent_logs),
            Err(e) => log::warn!(
                target: "cardano-observer",
                "InherentDigest::from_inherent_data failed ({e}) — proposing without the cobs header seal",
            ),
        }
        args.inherent_digests = Digest { logs };
        self.proposer.propose(args)
    }
}
