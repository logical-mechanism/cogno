// This is free and unencumbered software released into the public domain.
//
// Anyone is free to copy, modify, publish, use, compile, sell, or
// distribute this software, either in source code form or as a compiled
// binary, for any purpose, commercial or non-commercial, and by any
// means.
//
// In jurisdictions that recognize copyright laws, the author or authors
// of this software dedicate any and all copyright interest in the
// software to the public domain. We make this dedication for the benefit
// of the public at large and to the detriment of our heirs and
// successors. We intend this dedication to be an overt act of
// relinquishment in perpetuity of all present and future rights to this
// software under copyright law.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
// OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
//
// For more information, please refer to <http://unlicense.org>

// External crates imports
use alloc::vec::Vec;
use frame_support::{
    genesis_builder_helper::{build_state, get_preset},
    weights::Weight,
};
use pallet_grandpa::AuthorityId as GrandpaId;
use sp_api::impl_runtime_apis;
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_core::{crypto::KeyTypeId, OpaqueMetadata};
use sp_runtime::{
    traits::{Block as BlockT, NumberFor},
    transaction_validity::{TransactionSource, TransactionValidity},
    ApplyExtrinsicResult,
};
use sp_session::OpaqueGeneratedSessionKeys;
use sp_version::RuntimeVersion;

// Local module imports
use super::{
    AccountId, Aura, Balance, Block, Executive, Grandpa, InherentDataExt, Nonce, Runtime,
    RuntimeCall, RuntimeGenesisConfig, SessionKeys, System, TransactionPayment, VERSION,
};

// spec-120 node-served reads: fill one enriched post's author `display_name`/`avatar` (and its
// one-level quoted author's) from pallet-profile — the cross-pallet enrichment pallet-microblog
// deliberately leaves to the runtime so it carries no profile dependency (the same no-Cargo-cycle
// posture as its cogno-gate seam). An unset profile keeps the empty default.
fn enrich_author_profile(p: &mut pallet_microblog::EnrichedPost<AccountId>) {
    if let Some(prof) = pallet_profile::Profiles::<Runtime>::get(&p.author) {
        p.author_display_name = prof.display_name.into_inner();
        p.author_avatar = prof.avatar.into_inner();
    }
    if let Some(q) = p.quoted.as_mut() {
        if let Some(prof) = pallet_profile::Profiles::<Runtime>::get(&q.author) {
            q.author_display_name = prof.display_name.into_inner();
            q.author_avatar = prof.avatar.into_inner();
        }
    }
}

/// The pallet-profile display fields for `who` (empty when no profile row), memoized in `cache` so a
/// page whose posts share an author (author feed / replies) does ONE `Profiles::get` for that author
/// instead of one per post.
fn profile_fields(
    cache: &mut alloc::collections::BTreeMap<AccountId, (Vec<u8>, Vec<u8>)>,
    who: &AccountId,
) -> (Vec<u8>, Vec<u8>) {
    cache
        .entry(who.clone())
        .or_insert_with(|| match pallet_profile::Profiles::<Runtime>::get(who) {
            Some(prof) => (prof.display_name.into_inner(), prof.avatar.into_inner()),
            None => (Vec::new(), Vec::new()),
        })
        .clone()
}

/// Fill author profiles across a slice of enriched posts (see [`enrich_author_profile`]), memoizing the
/// pallet-profile read per distinct account so an author-scoped page (whose posts all share one author)
/// pays a single `Profiles::get` for that author rather than one per post.
fn enrich_author_profiles(posts: &mut [pallet_microblog::EnrichedPost<AccountId>]) {
    let mut cache: alloc::collections::BTreeMap<AccountId, (Vec<u8>, Vec<u8>)> =
        alloc::collections::BTreeMap::new();
    for p in posts.iter_mut() {
        let (name, avatar) = profile_fields(&mut cache, &p.author);
        if !name.is_empty() {
            p.author_display_name = name;
        }
        if !avatar.is_empty() {
            p.author_avatar = avatar;
        }
        if let Some(q) = p.quoted.as_mut() {
            let (qn, qa) = profile_fields(&mut cache, &q.author);
            if !qn.is_empty() {
                q.author_display_name = qn;
            }
            if !qa.is_empty() {
                q.author_avatar = qa;
            }
        }
    }
}

// The people-search / who-to-follow reads iterate a whole pallet map (a linear scan). Cap the
// candidates examined per `state_call` so a large corpus can't run the node's read budget away.
// The scan is the known ceiling on these two reads — see `docs/SCALE-NODE-READS.md`.
const MAX_PEOPLE_SCAN: u32 = 10_000;

/// Cross-pallet fold: build a [`pallet_microblog::PersonSummary`] for `account` — display/avatar from
/// pallet-profile, `weight` from talk-stake `AllowedStake`, `follower_count` from microblog. The runtime
/// does these cross-pallet reads the microblog pallet deliberately cannot (no profile/talk-stake dep).
fn person_summary(
    account: AccountId,
    prof: Option<&pallet_profile::Profile<Runtime>>,
) -> pallet_microblog::PersonSummary<AccountId> {
    let (display_name, avatar) = match prof {
        Some(p) => (p.display_name.to_vec(), p.avatar.to_vec()),
        None => (Vec::new(), Vec::new()),
    };
    pallet_microblog::PersonSummary {
        weight: pallet_talk_stake::AllowedStake::<Runtime>::get(&account),
        follower_count: pallet_microblog::FollowerCount::<Runtime>::get(&account),
        account_tally: pallet_microblog::AccountVoteTally::<Runtime>::get(&account),
        display_name,
        avatar,
        account,
    }
}

impl_runtime_apis! {
    impl sp_api::Core<Block> for Runtime {
        fn version() -> RuntimeVersion {
            VERSION
        }

        fn execute_block(block: <Block as BlockT>::LazyBlock) {
            Executive::execute_block(block);
        }

        fn initialize_block(header: &<Block as BlockT>::Header) -> sp_runtime::ExtrinsicInclusionMode {
            Executive::initialize_block(header)
        }
    }

    impl sp_api::Metadata<Block> for Runtime {
        fn metadata() -> OpaqueMetadata {
            OpaqueMetadata::new(Runtime::metadata().into())
        }

        fn metadata_at_version(version: u32) -> Option<OpaqueMetadata> {
            Runtime::metadata_at_version(version)
        }

        fn metadata_versions() -> Vec<u32> {
            Runtime::metadata_versions()
        }
    }

    impl frame_support::view_functions::runtime_api::RuntimeViewFunction<Block> for Runtime {
        fn execute_view_function(id: frame_support::view_functions::ViewFunctionId, input: Vec<u8>) -> Result<Vec<u8>, frame_support::view_functions::ViewFunctionDispatchError> {
            Runtime::execute_view_function(id, input)
        }
    }

    impl sp_block_builder::BlockBuilder<Block> for Runtime {
        fn apply_extrinsic(extrinsic: <Block as BlockT>::Extrinsic) -> ApplyExtrinsicResult {
            Executive::apply_extrinsic(extrinsic)
        }

        fn finalize_block() -> <Block as BlockT>::Header {
            Executive::finalize_block()
        }

        fn inherent_extrinsics(data: sp_inherents::InherentData) -> Vec<<Block as BlockT>::Extrinsic> {
            data.create_extrinsics()
        }

        fn check_inherents(
            block: <Block as BlockT>::LazyBlock,
            data: sp_inherents::InherentData,
        ) -> sp_inherents::CheckInherentsResult {
            data.check_extrinsics(&block)
        }
    }

    impl sp_transaction_pool::runtime_api::TaggedTransactionQueue<Block> for Runtime {
        fn validate_transaction(
            source: TransactionSource,
            tx: <Block as BlockT>::Extrinsic,
            block_hash: <Block as BlockT>::Hash,
        ) -> TransactionValidity {
            Executive::validate_transaction(source, tx, block_hash)
        }
    }

    impl sp_offchain::OffchainWorkerApi<Block> for Runtime {
        fn offchain_worker(header: &<Block as BlockT>::Header) {
            Executive::offchain_worker(header)
        }
    }

    impl sp_consensus_aura::AuraApi<Block, AuraId> for Runtime {
        fn slot_duration() -> sp_consensus_aura::SlotDuration {
            sp_consensus_aura::SlotDuration::from_millis(Aura::slot_duration())
        }

        fn authorities() -> Vec<AuraId> {
            pallet_aura::Authorities::<Runtime>::get().into_inner()
        }
    }

    impl sp_session::SessionKeys<Block> for Runtime {
        fn generate_session_keys(owner: Vec<u8>, seed: Option<Vec<u8>>) -> OpaqueGeneratedSessionKeys {
            SessionKeys::generate(&owner, seed).into()
        }

        fn decode_session_keys(
            encoded: Vec<u8>,
        ) -> Option<Vec<(Vec<u8>, KeyTypeId)>> {
            SessionKeys::decode_into_raw_public_keys(&encoded)
        }
    }

    impl sp_consensus_grandpa::GrandpaApi<Block> for Runtime {
        fn grandpa_authorities() -> sp_consensus_grandpa::AuthorityList {
            Grandpa::grandpa_authorities()
        }

        fn current_set_id() -> sp_consensus_grandpa::SetId {
            Grandpa::current_set_id()
        }

        fn submit_report_equivocation_unsigned_extrinsic(
            _equivocation_proof: sp_consensus_grandpa::EquivocationProof<
                <Block as BlockT>::Hash,
                NumberFor<Block>,
            >,
            _key_owner_proof: sp_consensus_grandpa::OpaqueKeyOwnershipProof,
        ) -> Option<()> {
            None
        }

        fn generate_key_ownership_proof(
            _set_id: sp_consensus_grandpa::SetId,
            _authority_id: GrandpaId,
        ) -> Option<sp_consensus_grandpa::OpaqueKeyOwnershipProof> {
            // NOTE: this is the only implementation possible since we've
            // defined our key owner proof type as a bottom type (i.e. a type
            // with no values).
            None
        }
    }

    impl frame_system_rpc_runtime_api::AccountNonceApi<Block, AccountId, Nonce> for Runtime {
        fn account_nonce(account: AccountId) -> Nonce {
            System::account_nonce(account)
        }
    }

    // in-protocol-observation (D4): the node-side observation InherentDataProvider reads the
    // consensus-pinned config (anchors, stability window, vault policy id) through this API, so the
    // node and the runtime cannot drift on what/how to observe.
    impl pallet_cardano_observer::CardanoObserverApi<Block> for Runtime {
        fn observer_config() -> pallet_cardano_observer::ObserverConfig {
            pallet_cardano_observer::Pallet::<Runtime>::observer_config()
        }
        fn bound_stake_credentials() -> alloc::vec::Vec<[u8; 28]> {
            use pallet_cardano_observer::BoundStakeCredentials;
            crate::configs::BoundStakeCreds::bound_stake_credentials()
        }
    }

    // spec-120 node-served reads: the runtime folds a whole enriched, viewer-aware feed / thread page
    // into one `state_call`. The microblog pallet builds the page from its own storage; the runtime
    // fills each post's author profile from pallet-profile here (no profile dependency in the pallet —
    // the same no-Cargo-cycle posture as its cogno-gate seam). See `docs/SCALE-NODE-READS.md`.
    impl pallet_microblog::MicroblogApi<Block, AccountId> for Runtime {
        fn feed_page(
            before: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> pallet_microblog::FeedPage<AccountId> {
            let mut page = pallet_microblog::Pallet::<Runtime>::feed_page(before, limit, viewer);
            enrich_author_profiles(&mut page.posts);
            page
        }

        fn author_feed_page(
            author: AccountId,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> pallet_microblog::FeedPage<AccountId> {
            let mut page =
                pallet_microblog::Pallet::<Runtime>::author_feed_page(author, before_id, limit, viewer);
            enrich_author_profiles(&mut page.posts);
            page
        }

        fn following_feed_page(
            viewer: AccountId,
            before: Option<u64>,
            limit: u32,
        ) -> pallet_microblog::FeedPage<AccountId> {
            let mut page =
                pallet_microblog::Pallet::<Runtime>::following_feed_page(viewer, before, limit);
            enrich_author_profiles(&mut page.posts);
            page
        }

        fn thread(focal: u64, viewer: Option<AccountId>) -> pallet_microblog::Thread<AccountId> {
            let mut t = pallet_microblog::Pallet::<Runtime>::thread(focal, viewer);
            enrich_author_profiles(&mut t.ancestors);
            if let Some(focal_post) = t.focal.as_mut() {
                enrich_author_profile(focal_post);
            }
            enrich_author_profiles(&mut t.replies);
            t
        }

        // spec-121: the author's TOP-LEVEL post count (replies excluded) for a correct profile postCount.
        fn author_post_count(author: AccountId) -> u32 {
            pallet_microblog::Pallet::<Runtime>::top_level_post_count(&author)
        }

        // ── The read paths a separate indexer used to serve, folded into the node ──
        // The post-returning reads run in the pallet, then the runtime fills author profiles (same
        // no-Cargo-cycle seam as the feed reads); the people/profile/identity reads are cross-pallet, so
        // the runtime does them here, reading pallet-profile / talk-stake / cogno-gate directly.
        fn author_replies_page(
            author: AccountId,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> pallet_microblog::FeedPage<AccountId> {
            let mut page =
                pallet_microblog::Pallet::<Runtime>::author_replies_page(author, before_id, limit, viewer);
            enrich_author_profiles(&mut page.posts);
            page
        }

        fn likes_page(
            who: AccountId,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> pallet_microblog::FeedPage<AccountId> {
            let mut page =
                pallet_microblog::Pallet::<Runtime>::likes_page(who, before_id, limit, viewer);
            enrich_author_profiles(&mut page.posts);
            page
        }

        fn search_posts(
            term: Vec<u8>,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> pallet_microblog::FeedPage<AccountId> {
            let mut page =
                pallet_microblog::Pallet::<Runtime>::search_posts(term, before_id, limit, viewer);
            enrich_author_profiles(&mut page.posts);
            page
        }

        fn poll(host_id: u64) -> Option<pallet_microblog::PollView> {
            pallet_microblog::Pallet::<Runtime>::poll(host_id)
        }

        fn poll_choice(who: AccountId, host_id: u64) -> Option<u8> {
            pallet_microblog::Pallet::<Runtime>::poll_choice(who, host_id)
        }

        fn viewer_states(who: AccountId, ids: Vec<u64>) -> Vec<pallet_microblog::ViewerState> {
            pallet_microblog::Pallet::<Runtime>::viewer_states(who, ids)
        }

        fn follow_edges(who: AccountId) -> pallet_microblog::FollowEdges<AccountId> {
            pallet_microblog::Pallet::<Runtime>::follow_edges(who)
        }

        fn profile(who: AccountId) -> pallet_microblog::ProfileView<AccountId> {
            // cogno-gate: the bound identity hash IS the live post gate (`is_allowed == PkhOf` present).
            let identity_hash = pallet_cogno_gate::PkhOf::<Runtime>::get(&who);
            let is_allowed = identity_hash.is_some();
            // pallet-profile: presentation fields (empty when no profile row exists).
            let (display_name, bio, avatar, banner, location, website) =
                match pallet_profile::Profiles::<Runtime>::get(&who) {
                    Some(p) => (
                        p.display_name.into_inner(),
                        p.bio.into_inner(),
                        p.avatar.into_inner(),
                        p.banner.into_inner(),
                        p.location.into_inner(),
                        p.website.into_inner(),
                    ),
                    None => (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
                };
            pallet_microblog::ProfileView {
                identity_hash,
                is_allowed,
                weight: pallet_talk_stake::AllowedStake::<Runtime>::get(&who),
                voting_power: pallet_talk_stake::VotingPower::<Runtime>::get(&who),
                account_tally: pallet_microblog::AccountVoteTally::<Runtime>::get(&who),
                display_name,
                bio,
                avatar,
                banner,
                location,
                website,
                pinned_post_id: pallet_profile::PinnedPost::<Runtime>::get(&who),
                post_count: pallet_microblog::Pallet::<Runtime>::top_level_post_count(&who),
                follower_count: pallet_microblog::FollowerCount::<Runtime>::get(&who),
                following_count: pallet_microblog::FollowingCount::<Runtime>::get(&who),
                account: who,
            }
        }

        fn resolve_identity(identity_hash: [u8; 32]) -> Option<AccountId> {
            pallet_cogno_gate::AccountOf::<Runtime>::get(identity_hash)
        }

        fn search_people(term: Vec<u8>, limit: u32) -> Vec<pallet_microblog::PersonSummary<AccountId>> {
            let limit = limit.clamp(1, pallet_microblog::MAX_PAGE) as usize;
            // Collect name-matches with the ranking scalar (follower_count); the display fields are already in
            // `prof` (read for the name filter). Rank + truncate FIRST, then hydrate only the top `limit` via
            // `person_summary` (which reads AllowedStake) — so a ≤10k scan doesn't pay a weight read per match.
            let mut matches: Vec<(AccountId, u32, pallet_profile::Profile<Runtime>)> = Vec::new();
            let mut examined: u32 = 0;
            for (account, prof) in pallet_profile::Profiles::<Runtime>::iter() {
                if examined >= MAX_PEOPLE_SCAN {
                    break;
                }
                examined = examined.saturating_add(1);
                // Only currently-bound people appear (the indexer's `banned == false` ⇒ is_allowed).
                if !pallet_cogno_gate::PkhOf::<Runtime>::contains_key(&account) {
                    continue;
                }
                if !pallet_microblog::contains_ci(&prof.display_name, &term) {
                    continue;
                }
                let follower_count = pallet_microblog::FollowerCount::<Runtime>::get(&account);
                matches.push((account, follower_count, prof));
            }
            matches.sort_unstable_by(|a, b| b.1.cmp(&a.1));
            matches.truncate(limit);
            matches.into_iter().map(|(account, _, prof)| person_summary(account, Some(&prof))).collect()
        }

        fn who_to_follow(limit: u32) -> Vec<pallet_microblog::PersonSummary<AccountId>> {
            let limit = limit.clamp(1, pallet_microblog::MAX_PAGE) as usize;
            // Rank on the cheap FollowerCount scalar FIRST, then hydrate only the top `limit` — so the ≤10k
            // scan does not pay a Profiles::get + AllowedStake::get for every candidate it will discard.
            // ByAuthor membership IS `postCount > 0` (an author with ANY post — incl. replies/quotes/polls
            // — matching the indexer's `postCount greaterThan 0`; a reply-only author is a valid suggestion).
            let mut ranked: Vec<(AccountId, u32)> = Vec::new();
            let mut examined: u32 = 0;
            for (account, _ids) in pallet_microblog::ByAuthor::<Runtime>::iter() {
                if examined >= MAX_PEOPLE_SCAN {
                    break;
                }
                examined = examined.saturating_add(1);
                if !pallet_cogno_gate::PkhOf::<Runtime>::contains_key(&account) {
                    continue;
                }
                let follower_count = pallet_microblog::FollowerCount::<Runtime>::get(&account);
                ranked.push((account, follower_count));
            }
            ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1));
            ranked.truncate(limit);
            ranked
                .into_iter()
                .map(|(account, _)| {
                    let prof = pallet_profile::Profiles::<Runtime>::get(&account);
                    person_summary(account, prof.as_ref())
                })
                .collect()
        }
    }

    impl pallet_transaction_payment_rpc_runtime_api::TransactionPaymentApi<Block, Balance> for Runtime {
        fn query_info(
            uxt: <Block as BlockT>::Extrinsic,
            len: u32,
        ) -> pallet_transaction_payment_rpc_runtime_api::RuntimeDispatchInfo<Balance> {
            TransactionPayment::query_info(uxt, len)
        }
        fn query_fee_details(
            uxt: <Block as BlockT>::Extrinsic,
            len: u32,
        ) -> pallet_transaction_payment::FeeDetails<Balance> {
            TransactionPayment::query_fee_details(uxt, len)
        }
        fn query_weight_to_fee(weight: Weight) -> Balance {
            TransactionPayment::weight_to_fee(weight)
        }
        fn query_length_to_fee(length: u32) -> Balance {
            TransactionPayment::length_to_fee(length)
        }
    }

    impl pallet_transaction_payment_rpc_runtime_api::TransactionPaymentCallApi<Block, Balance, RuntimeCall>
        for Runtime
    {
        fn query_call_info(
            call: RuntimeCall,
            len: u32,
        ) -> pallet_transaction_payment::RuntimeDispatchInfo<Balance> {
            TransactionPayment::query_call_info(call, len)
        }
        fn query_call_fee_details(
            call: RuntimeCall,
            len: u32,
        ) -> pallet_transaction_payment::FeeDetails<Balance> {
            TransactionPayment::query_call_fee_details(call, len)
        }
        fn query_weight_to_fee(weight: Weight) -> Balance {
            TransactionPayment::weight_to_fee(weight)
        }
        fn query_length_to_fee(length: u32) -> Balance {
            TransactionPayment::length_to_fee(length)
        }
    }

    #[cfg(feature = "runtime-benchmarks")]
    impl frame_benchmarking::Benchmark<Block> for Runtime {
        fn benchmark_metadata(extra: bool) -> (
            Vec<frame_benchmarking::BenchmarkList>,
            Vec<frame_support::traits::StorageInfo>,
        ) {
            use frame_benchmarking::{baseline, BenchmarkList};
            use frame_support::traits::StorageInfoTrait;
            use frame_system_benchmarking::Pallet as SystemBench;
            use frame_system_benchmarking::extensions::Pallet as SystemExtensionsBench;
            use baseline::Pallet as BaselineBench;
            use super::*;

            let mut list = Vec::<BenchmarkList>::new();
            list_benchmarks!(list, extra);

            let storage_info = AllPalletsWithSystem::storage_info();

            (list, storage_info)
        }

        #[allow(non_local_definitions)]
        fn dispatch_benchmark(
            config: frame_benchmarking::BenchmarkConfig
        ) -> Result<Vec<frame_benchmarking::BenchmarkBatch>, alloc::string::String> {
            use frame_benchmarking::{baseline, BenchmarkBatch};
            use sp_storage::TrackedStorageKey;
            use frame_system_benchmarking::Pallet as SystemBench;
            use frame_system_benchmarking::extensions::Pallet as SystemExtensionsBench;
            use baseline::Pallet as BaselineBench;
            use super::*;

            impl frame_system_benchmarking::Config for Runtime {}
            impl baseline::Config for Runtime {}

            use frame_support::traits::WhitelistedStorageKeys;
            let whitelist: Vec<TrackedStorageKey> = AllPalletsWithSystem::whitelisted_storage_keys();

            let mut batches = Vec::<BenchmarkBatch>::new();
            let params = (&config, &whitelist);
            add_benchmarks!(params, batches);

            Ok(batches)
        }
    }

    #[cfg(feature = "try-runtime")]
    impl frame_try_runtime::TryRuntime<Block> for Runtime {
        fn on_runtime_upgrade(checks: frame_try_runtime::UpgradeCheckSelect) -> (Weight, Weight) {
            // NOTE: intentional unwrap: we don't want to propagate the error backwards, and want to
            // have a backtrace here. If any of the pre/post migration checks fail, we shall stop
            // right here and right now.
            let weight = Executive::try_runtime_upgrade(checks).unwrap();
            (weight, super::configs::RuntimeBlockWeights::get().max_block)
        }

        fn execute_block(
            block: <Block as BlockT>::LazyBlock,
            state_root_check: bool,
            signature_check: bool,
            select: frame_try_runtime::TryStateSelect
        ) -> Weight {
            // NOTE: intentional unwrap: we don't want to propagate the error backwards, and want to
            // have a backtrace here.
            Executive::try_execute_block(block, state_root_check, signature_check, select).expect("execute-block failed")
        }
    }

    impl sp_genesis_builder::GenesisBuilder<Block> for Runtime {
        fn build_state(config: Vec<u8>) -> sp_genesis_builder::Result {
            build_state::<RuntimeGenesisConfig>(config)
        }

        fn get_preset(id: &Option<sp_genesis_builder::PresetId>) -> Option<Vec<u8>> {
            get_preset::<RuntimeGenesisConfig>(id, crate::genesis_config_presets::get_preset)
        }

        fn preset_names() -> Vec<sp_genesis_builder::PresetId> {
            crate::genesis_config_presets::preset_names()
        }
    }
}
