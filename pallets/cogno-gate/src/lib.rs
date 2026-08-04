//! # Cogno-gate pallet (cogno-chain)
//!
//! **The anti-Sybil identity anchor: a hard 1:1 binding between a Cardano owner Address and a
//! Substrate posting account.** This is the "Cardano READ link" — the gate that turns an anonymous
//! sr25519 key into a Cardano-anchored identity so that one Cardano owner Address maps to exactly
//! one posting account, and back.
//!
//! ## What is bound
//! The key is the **32-byte `blake2b_256` of the serialized owner Cardano Address** (== the L1
//! beacon `token_name`), NOT a bare 28-byte payment-key-hash. Identity is the *whole* CIP-19
//! Address (payment + stake credential). The bind is **trustless (D1)**: a user submits the CIP-8
//! (COSE_Sign1) `signData` proof their wallet produced over the pinned bind payload, and the RUNTIME
//! verifies it on-chain ([`cip8::verify_bind_proof`] → `sp_io::crypto::ed25519_verify`) — no trusted
//! writer. The old `FollowerOrigin`-gated `link_identity` (which trusted an off-chain `pycardano`
//! verify) is REMOVED; its `call_index(0)` is permanently vacant.
//!
//! ## The 1:1 Sybil invariant (do not break it)
//! [`do_bind`](Pallet::do_bind) (the shared bind body) rejects a second bind on **either** side —
//! [`PkhOf`] (account → identity) and [`AccountOf`] (identity → account) are both checked. Skipping
//! the reverse-map check would let one identity bind many accounts → multiply talk capacity → defeat
//! the entire anti-Sybil purpose of the chain.
//!
//! ## Loose coupling (the architectural gotcha)
//! cogno-gate calls **into** `pallet-microblog` ([`pallet_microblog::OnIdentityBind`] →
//! `on_first_bind`) at link, and microblog calls **into** cogno-gate
//! ([`pallet_microblog::IsAllowed`] → `is_allowed`) at post. Implementing that literally would
//! make each pallet Cargo-depend on the other (a cycle). It is broken by two traits that BOTH
//! live in `pallet-microblog` (the depended-upon crate): cogno-gate *implements* `IsAllowed`
//! and *consumes* `OnIdentityBind` (wired to `Microblog` in the runtime). Neither pallet names
//! the other's crate in a trait bound.
//!
//! ## Trust posture
//! The bind is permissionless + cryptographic: [`Call::link_identity_signed`] removes the operator
//! from the identity-correctness path entirely (every full node re-verifies the proof). `FollowerOrigin`
//! gates ONLY [`Call::revoke`] — the manual-operator-ban moderation lever, which tombstones an identity
//! permanently. In the runtime that origin is the 3-of-5 FollowerCommittee: cogno-chain is sudo-free from
//! genesis, so there is no `EnsureRoot` fallback behind it. ⚠ The verifier itself is the anti-Sybil crown
//! jewel — a bug forges any identity; it is pinned by the negative tests in [`cip8`] but is NOT externally
//! audited (MAINNET PREREQUISITE).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

/// The on-chain CIP-8 (COSE_Sign1) identity self-proof verifier.
pub mod cip8;

/// Storage migrations. Register the versioned wrappers in the runtime's `SingleBlockMigrations` —
/// a migration that is not in that tuple never runs.
pub mod migrations;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// Log target for operator-facing diagnostics on the identity-gate edge paths (rejections,
/// idempotent revoke no-ops, the bind/revoke provider-ref lifecycle). These are `log::` lines
/// only — the on-chain audit trail is still the `IdentityLinked`/`Revoked` events, NOT logs.
pub const LOG_TARGET: &str = "runtime::cogno-gate";

/// The most rotation slots [`Pallet::drain_rotation_backfill`] fills in one block, and the most
/// `PkhOf` rows it walks looking for them. Two writes plus two reads each, so a full batch is ~64
/// storage operations of a block's LEFTOVER weight — small enough that the drain never competes with
/// real traffic, large enough that even a `MAX_ACCOUNTS`-sized overrun clears in a couple of minutes.
///
/// Small on purpose. The drain only ever runs after a backfill that could not finish in one block,
/// which is a rare and already-degraded state; finishing it in 60 blocks rather than 6 costs nothing
/// that matters, and taking a big bite out of `on_idle` on a chain this quiet would be the only thing
/// competing for that weight.
pub const BACKFILL_BATCH: u32 = 64;

/// The on-chain identity key: the 32-byte `blake2b_256` of the serialized owner Cardano
/// Address (== the L1 beacon `token_name`). A fixed `[u8; 32]` (not a `BoundedVec`):
/// it is exactly a hash, so the codec enforces the length for free and the `AccountOf` key is
/// the raw 32 bytes with no length prefix — the client's `AccountOf` readback keys on the
/// identical bytes.
pub type IdentityHash = [u8; 32];

/// The voting-power identity key: the 28-byte stake credential (a reward address's key hash) proven
/// via [`cip8::verify_bind_proof_stake`]. Distinct from [`IdentityHash`] (the 32-byte full-Address
/// beacon that anchors POSTING/deposit): this anchors VOTING POWER — the account's total Cardano
/// stake — 1:1 to the proven STAKE key, so many payment keys cannot multiply one staker's vote weight.
pub type StakeCredential = [u8; 28];

/// Drop the observed state an account or a credential still holds, at the moment its bind goes away.
///
/// Wired in the runtime to `pallet-cardano-observer` plus its two sinks; `()` elsewhere, so a test or a
/// runtime that does not model the observer is unaffected. Declared HERE rather than in the observer
/// because cogno-gate is the caller and neither pallet may depend on the other (the same no-cycle
/// posture as [`pallet_microblog::OnIdentityBind`], inverted).
///
/// ⚠ WHY THIS EXISTS AT ALL — spec 220. Until the scan became a rotating window, teardown needed no
/// hook: an unbound credential simply fell out of the node's scan, `derive_call` found its basis row
/// absent from the observation, and the next block cleared it. That inference is exactly what the
/// window removes. Absence now means "not scanned this block" for the majority of the ledger, so the
/// observer HOLDS an out-of-window basis row instead of clearing it — and an account whose bind is gone
/// is never in any window again, so its row and its voting power would be held FOREVER. The teardown
/// has to be explicit or it does not happen.
///
/// It also closes a hazard that predates the window and was recorded rather than fixed: nothing ever
/// removed a `VotingPower` row, and the two teardown sites deliberately left one standing on the
/// grounds that "the observer clears it next block". A paged `close_poll` tallies by VOTER, reads
/// `VotingPower` directly, and will count a stale row through any observer freeze or stall.
pub trait OnBindTeardown<AccountId> {
    /// The account's identity bind is gone: drop every observed row it holds, on every axis.
    fn forget_account(who: &AccountId);
    /// Only the account's STAKE bind is gone (`unlink_stake`): drop the voting-power basis row for
    /// `stake_cred` and zero the account's weight. Its identity, badges and posting capacity stand.
    fn forget_stake(who: &AccountId, stake_cred: &StakeCredential);
}

impl<AccountId> OnBindTeardown<AccountId> for () {
    fn forget_account(_who: &AccountId) {}
    fn forget_stake(_who: &AccountId, _stake_cred: &StakeCredential) {}
}

#[frame_support::pallet]
pub mod pallet {
    use super::*;
    use frame_support::{pallet_prelude::*, sp_runtime::traits::Zero};
    use frame_system::{ensure_none, pallet_prelude::*};
    // The two cross-pallet traits live in microblog (the depended-upon crate) to avoid a
    // dependency cycle — see the module docs. cogno-gate implements `IsAllowed` and consumes
    // `OnIdentityBind`.
    use pallet_microblog::{IsAllowed, OnIdentityBind};

    /// Storage version 1 (spec 212). The pallet declared NO version through spec 211, so every live
    /// chain sits at the implicit 0 — which is exactly what `migrations::v1::MigrateV0ToV1` gates on
    /// when it sweeps the retired `ThreadOf` rows. A fresh genesis writes 1 directly and self-skips it.
    ///
    /// Storage version 2 (spec 220): the observer's scan rotation arrives ([`ScanSlotCount`],
    /// [`AccountAtScanSlot`], [`ScanSlotOf`]) and `migrations::v2::MigrateV1ToV2` enrols every
    /// already-bound account in it. That backfill is load-bearing, not tidy — see that module.
    pub const STORAGE_VERSION: StorageVersion = StorageVersion::new(2);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// The authority allowed to [`Call::revoke`] (the manual-operator-ban moderation lever). An
        /// `EnsureOrigin`, never `ensure_signed` — the public pool must not be able to ban identities.
        /// The runtime wires it to the 3-of-5 FollowerCommittee; there is no sudo fallback behind it.
        /// NOTE: binding is NOT gated by this; it is the permissionless cryptographic
        /// [`Call::link_identity_signed`].
        type FollowerOrigin: EnsureOrigin<Self::RuntimeOrigin>;
        /// Bind/revoke lifecycle hook into `pallet-microblog`: `on_bind` primes the capacity row + a
        /// provider reference so a freshly-bound feeless poster's first post is not rejected by
        /// `CheckNonce` (issue #3991), and `on_revoke` releases that ref. Wired to `Microblog` in the
        /// runtime. Defined in microblog (not here) to avoid a Cargo dependency cycle. `on_bind` owns
        /// the single `inc_providers` call (balanced by one `dec_providers` in `on_revoke`) — do not
        /// increment providers again here.
        type OnBind: OnIdentityBind<Self::AccountId>;
        /// Observed-state teardown hook, invoked when a bind goes away. Wired to the observer in the
        /// runtime; `()` in tests. See [`OnBindTeardown`] for why a rotating scan window makes this
        /// mandatory rather than an optimisation.
        type OnTeardown: OnBindTeardown<Self::AccountId>;
        /// The Cardano network the trustless self-proof ([`Call::link_identity_signed`]) binds for — the
        /// low nibble of the address header byte (0 = testnet, 1 = mainnet). The beacon-name identity
        /// carries NO network byte, so this pins which network's addresses may bind (else a mainnet and a
        /// testnet address with the same credentials would collide on the identical identity). See [`cip8`].
        #[pallet::constant]
        type CardanoNetwork: Get<u8>;
        /// The most targets one [`Call::revoke_many`] motion may carry.
        ///
        /// Bounded by `pallet-collective`'s `MaxProposalWeight`, NOT by the block's `max_extrinsic`.
        /// Collective checks `call_weight.all_lte(MaxProposalWeight)` at PROPOSE, and that bound (1 s)
        /// is lower than the Normal class limit (1.29989 s) — so a batch that fits a block can still be
        /// unproposable, which is a dead call rather than a failed one. (At CLOSE the comparison is
        /// against the closer's own `proposal_weight_bound` argument, which the CLI derives from the
        /// same constant.) The runtime asserts the fit; see `revoke_many_batch_fits_a_committee_motion`.
        #[pallet::constant]
        type MaxBatchTargets: Get<u32>;
        /// Weight information for this pallet's dispatchables.
        type WeightInfo: WeightInfo;
    }

    /// Forward map: posting account → its bound 32-byte Cardano identity hash. `is_allowed`
    /// (the microblog post gate) is `contains_key` on this map. `OptionQuery` ⇒ an unbound
    /// account reads `None` ⇒ cannot post.
    #[pallet::storage]
    pub type PkhOf<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, IdentityHash, OptionQuery>;

    /// Reverse map: 32-byte Cardano identity hash → the one posting account it is bound to. The
    /// client's bind readback queries this by the 32-byte key. Load-bearing for the 1:1
    /// invariant: a second account cannot claim an already-bound identity.
    #[pallet::storage]
    pub type AccountOf<T: Config> =
        StorageMap<_, Blake2_128Concat, IdentityHash, T::AccountId, OptionQuery>;

    // The retired `ThreadOf` storage (the optional cogno_v3 thread pointer) lived HERE. It was
    // dropped in spec 211 together with `link_identity_signed`'s `thread_pointer` argument: the
    // pointer was never committed by the CIP-8 signed payload, so any submitter of a valid proof
    // could attach an arbitrary pointer — an authorization break on the crown-jewel path. It had
    // no readers. `migrations::v1` (spec 212) SWEEPS the rows the live chain already held, so the
    // prefix is genuinely empty rather than merely undeclared. Do not re-declare it.

    /// Permanently-banned identities — the manual-operator-ban tombstone. [`Call::revoke`]
    /// inserts here; the permissionless [`Call::link_identity_signed`] refuses to (re)bind a tombstoned
    /// identity, so an eternally-valid CIP-8 proof replayed after a ban does NOT resurrect the binding.
    /// Never removed (a tombstone is permanent — your "ban means ban" decision).
    #[pallet::storage]
    pub type Tombstoned<T: Config> = StorageMap<_, Blake2_128Concat, IdentityHash, (), OptionQuery>;

    /// Forward map: posting account → its bound 28-byte stake credential (the voting-power anchor).
    /// Set by [`Call::link_stake_signed`] once the stake-key CIP-8 proof verifies. `OptionQuery` ⇒
    /// an account with no stake bind has zero observed voting power (its votes carry no weight).
    #[pallet::storage]
    pub type StakeCredOf<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, StakeCredential, OptionQuery>;

    /// Reverse map: 28-byte stake credential → the one account it is bound to. Load-bearing for the
    /// 1:1 voting invariant: a stake credential is claimed once, by the account whose owner proved the
    /// stake key — so a second account (a "franken" payment key reusing this stake) cannot ride the
    /// same on-chain stake.
    #[pallet::storage]
    pub type AccountOfStakeCred<T: Config> =
        StorageMap<_, Blake2_128Concat, StakeCredential, T::AccountId, OptionQuery>;

    /// Permanently-banned stake credentials — the ban-the-key tombstone. [`Call::revoke`] inserts the
    /// revoked account's stake credential here so a banned operator cannot grind a fresh address /
    /// payment identity and re-bind the same stake key. Never removed (a tombstone is permanent).
    #[pallet::storage]
    pub type TombstonedStakeCred<T: Config> =
        StorageMap<_, Blake2_128Concat, StakeCredential, (), OptionQuery>;

    /// Nonce SPENT by the most recent accepted stake bind for this account. Deliberately survives
    /// [`Call::unlink_stake`] — that is the whole point of it.
    ///
    /// Added with `unlink_stake` in spec 218, because that call is what made the hazard real. A stake
    /// proof carries no expiry and commits no chain state that moves, so its bytes stay valid forever,
    /// and [`Call::link_stake_signed`] is bare-unsigned — anyone may submit anyone's proof. While the
    /// bind was irrevocable that was harmless: a replay could only re-assert a binding that already
    /// existed. `unlink_stake` restores exactly the pre-bind conditions `do_bind_stake` checks, so a
    /// third party who saw the original extrinsic on chain could re-attach the bind the holder had just
    /// removed. Worse than a nuisance: a holder rotating a stake credential to a NEW account is blocked
    /// by the 1:1 rule for as long as the replayer keeps re-binding the old one.
    ///
    /// Spending the nonce closes it — the replayed bytes carry the same nonce, so the re-bind is
    /// rejected. A genuine re-bind needs a fresh proof with a new nonce, which only the stake key can
    /// sign, so there is no usability cost.
    ///
    /// ⚠ RESIDUAL, inherited knowingly from `pallet_cardano_roles::SpentRoleNonce` (which documents the
    /// same one): this remembers the LAST nonce, not every nonce. The client mints a fresh random nonce
    /// per proof, so a second bind displaces the first — an account past two or more bind/unlink cycles
    /// can still be hit by a replay of a proof OLDER than its most recent one. The two closes are the
    /// same as there (key the map by the nonce too, or require a strictly increasing nonce) and neither
    /// needs the `cogno-chain/bind/v1` GRAMMAR to move. Griefing-only meanwhile: the replay re-binds the
    /// holder's OWN credential to the account the holder committed, `unlink_stake` stays free for the
    /// holder, and observed voting power still tracks live Cardano stake.
    ///
    /// ⚠ SECOND RESIDUAL, specific to the upgrade and NOT fixable by a migration: a bind made BEFORE
    /// spec 218 has no row here, because the nonce it spent was only ever in the extrinsic — which lives
    /// in a block body, not in state. So for each account already stake-bound at the upgrade, the FIRST
    /// `unlink_stake` leaves its original proof replayable exactly once; re-binding writes a row and the
    /// guard holds from then on. Deliberately not papered over with a sentinel: nothing on chain can tell
    /// a fresh proof from the old one for those accounts, so a sentinel would either block the holder's
    /// own legitimate re-bind or protect nothing. Bounded (the live chain has ~13 stake binds), opt-in
    /// (it needs the holder to unlink first), and griefing-only in the same way as the residual above.
    ///
    /// Bounded as written: one 16-byte entry per account that has ever stake-bound — the same growth as
    /// the bind itself, and the same shape the role axis already carries.
    #[pallet::storage]
    pub type SpentStakeNonce<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, [u8; 16], OptionQuery>;

    /// How many accounts the observer's scan rotation holds — exactly the number of rows in
    /// [`AccountAtScanSlot`], and exactly the number of identity-bound accounts.
    ///
    /// The three rotation items ([`ScanSlotCount`], [`AccountAtScanSlot`], [`ScanSlotOf`]) are one
    /// data structure: a DENSE slot table over `[0, ScanSlotCount)` plus its inverse. Spec 220 added
    /// them so the observer's per-block credential scan can be a rotating WINDOW over the whole
    /// population instead of a hash-ordered PREFIX of it. See [`Pallet::scan_window`].
    #[pallet::storage]
    pub type ScanSlotCount<T: Config> = StorageValue<_, u64, ValueQuery>;

    /// The scan rotation's slot table: `slot → account`, dense over `[0, ScanSlotCount)`.
    ///
    /// ⚠ DENSE IS THE WHOLE POINT, and it is why removal is a SWAP-remove rather than a plain one.
    /// The window is read by point lookup (`slot`, `slot+1`, …) and the cursor advances by plain
    /// arithmetic, so a full sweep costs `ScanSlotCount / window` blocks. Let holes accumulate and
    /// that denominator becomes accounts-ever-bound rather than accounts-bound-now — a ratchet of
    /// exactly the kind `docs/OBSERVATION-READ-SHAPE-PLAN.md` exists to remove, and one that no
    /// amount of pruning would ever undo. Slots are therefore REUSED: see [`Pallet::leave_rotation`].
    ///
    /// Not iterated, so the hasher is free to be the cheap one. (An ITERATED integer-keyed map would
    /// need `Identity` over big-endian bytes to make trie order numeric order — SCALE encodes `u64`
    /// little-endian, so `Identity<u64>` iterates in a shuffled order that merely looks sorted.)
    #[pallet::storage]
    pub type AccountAtScanSlot<T: Config> =
        StorageMap<_, Twox64Concat, u64, T::AccountId, OptionQuery>;

    /// The inverse of [`AccountAtScanSlot`]: `account → its slot`. Read on teardown, to find the hole
    /// the swap-remove has to fill.
    #[pallet::storage]
    pub type ScanSlotOf<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u64, OptionQuery>;

    /// Resume point for an UNFINISHED rotation backfill, as the raw [`PkhOf`] storage key the last
    /// enrolment pass stopped at. `Some` ⇒ the rotation does not yet hold every bound account and
    /// [`Pallet::drain_rotation_backfill`] has work to do; `None` (the normal state, and the state of
    /// every chain that has never overrun a backfill) ⇒ nothing owed and the drain is a single read.
    ///
    /// A backfill enrols in `PkhOf` iteration order and appends to the tail of the slot table, so the
    /// resume point is the iterator's own key and nothing about the partially-filled table is
    /// inconsistent — it is dense, it is a bijection, and `ScanSlotCount` is its true length throughout.
    /// It is simply SHORT, and the accounts not yet reached read `ScanCoverage::Absent` until they are.
    ///
    /// ⚠ A raw storage key, so it is only meaningful against the `PkhOf` prefix it was taken from. The
    /// 128-byte bound is generous: the key is `twox128(pallet) ++ twox128(item) ++
    /// blake2_128concat(AccountId)`, which is 80 bytes for a 32-byte account id. A key that somehow
    /// exceeded it would be refused at write time and the backfill would restart from the beginning
    /// (correct, merely slower — enrolment skips accounts that already hold a slot).
    #[pallet::storage]
    pub type RotationBackfillCursor<T: Config> =
        StorageValue<_, BoundedVec<u8, ConstU32<128>>, OptionQuery>;

    // Variant indices are ON-WIRE (SCALE indexes enum variants by declaration order), so they are
    // pinned explicitly at their pre-pin ordinals — the encoding is byte-identical. Never renumber;
    // a new variant takes the next free index (6).
    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A Cardano identity was bound 1:1 to a posting account — the per-bind audit record.
        /// `identity` is `blake2b_256(serialized owner Address)`.
        #[codec(index = 0)]
        IdentityLinked {
            who: T::AccountId,
            identity: IdentityHash,
        },
        /// A binding was revoked (the manual-operator-ban path). The provider ref is
        /// released and the banked capacity zeroed; the capacity row itself is kept (relock-farm
        /// guard) — see [`pallet_microblog::OnIdentityBind::on_revoke`].
        #[codec(index = 1)]
        Revoked {
            who: T::AccountId,
            identity: IdentityHash,
        },
        /// A stake credential was bound 1:1 to a posting account as its voting-power anchor (the
        /// stake-key self-proof, [`Call::link_stake_signed`]). `stake_cred` is the 28-byte
        /// reward-address key hash; the account's vote weight is then the total Cardano stake of it.
        #[codec(index = 2)]
        StakeLinked {
            who: T::AccountId,
            stake_cred: StakeCredential,
        },
        /// A [`Call::revoke_many`] motion finished. `applied` targets were bound and were torn down
        /// (each also emitted its own [`Event::Revoked`]); `skipped` were already unbound and were
        /// passed over. Emitted so the committee's audit log records the split — a batch that silently
        /// applied nothing must not look like one that applied everything.
        #[codec(index = 3)]
        RevokedMany { applied: u32, skipped: u32 },
        /// An account released its OWN stake (voting-power) bind ([`Call::unlink_stake`]). NOT a ban:
        /// the credential is not tombstoned and may be bound again with a fresh proof. Observed voting
        /// power zeroes on the observer's next block, not in this one.
        #[codec(index = 4)]
        StakeUnlinked {
            who: T::AccountId,
            stake_cred: StakeCredential,
        },
        /// A stake credential was permanently banned by the committee without reference to any bound
        /// account ([`Call::tombstone_stake_cred`]). Distinct from the `Revoked` path's implicit
        /// tombstone, which only ever reaches a credential its target still held.
        #[codec(index = 5)]
        StakeCredTombstonedByAuthority { stake_cred: StakeCredential },
    }

    // Variant indices are ON-WIRE (the index IS the wire format of a `DispatchError::Module`), so
    // they are pinned explicitly at their pre-pin ordinals — the encoding is byte-identical. Never
    // renumber; a new variant takes the next free index (13).
    #[pallet::error]
    pub enum Error<T> {
        /// This posting account is already bound to an identity (1:1, account side).
        #[codec(index = 0)]
        AccountAlreadyBound,
        /// This Cardano identity is already bound to an account (1:1, identity side). Named
        /// `PkhAlreadyBound` for cross-doc continuity; the key is the 32-byte Address hash.
        #[codec(index = 1)]
        PkhAlreadyBound,
        // index 2 is PERMANENTLY VACANT: `BadThread` (retired in spec 211 with the unauthenticated
        // `thread_pointer` argument and the `ThreadOf` storage). Never reuse it.
        /// No binding exists for this account (revoke target not found).
        #[codec(index = 3)]
        NotBound,
        /// The submitted CIP-8 self-proof failed verification (signature / address-key bind / format /
        /// unsupported address). The node log carries the specific [`cip8::Cip8Error`] variant.
        #[codec(index = 4)]
        ProofInvalid,
        /// The proof commits a different chain's genesis hash (anti-cross-chain replay).
        #[codec(index = 5)]
        WrongGenesis,
        /// This Cardano identity was permanently banned (revoked) and cannot be re-bound (the tombstone).
        #[codec(index = 6)]
        IdentityTombstoned,
        /// The account must be payment-bound ([`Call::link_identity_signed`]) before it can stake-bind —
        /// voting power attaches only to an existing posting identity.
        #[codec(index = 7)]
        NotPaymentBound,
        /// This account already has a bound stake credential (1:1, account side).
        #[codec(index = 8)]
        AccountAlreadyStakeBound,
        /// This stake credential is already bound to an account (1:1, stake side).
        #[codec(index = 9)]
        StakeCredAlreadyBound,
        /// This stake credential was permanently banned (revoked) and cannot be re-bound (ban-the-key).
        #[codec(index = 10)]
        StakeCredTombstoned,
        /// This account has no stake (voting-power) bind to release ([`Call::unlink_stake`]).
        #[codec(index = 11)]
        NoStakeBind,
        /// This stake proof's nonce was already spent by an accepted bind for this account — the bytes
        /// are single-use. Re-bind with a fresh proof. See [`SpentStakeNonce`].
        #[codec(index = 12)]
        StakeProofReplayed,
    }

    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        /// Drain an unfinished rotation backfill, a bounded batch a block, out of the block's LEFTOVER
        /// weight. A single storage read on every chain that has nothing owed, which is every chain
        /// that has never overrun a backfill.
        ///
        /// ⚠⚠ `on_idle` AND NOT `on_initialize`, and this is a fork-class choice rather than a stylistic
        /// one. `pallet_cardano_observer::derive_call` reads [`ScanSlotOf`] (through `ScanWindow::
        /// coverage`) and [`ScanSlotCount`] (the wrap modulus in [`Pallet::slot_in_window`]), and it is
        /// evaluated by the AUTHOR after `initialize_block` but by every IMPORTER against raw parent
        /// state. Anything `on_initialize` writes is therefore visible to one side and not the other,
        /// `check_inherent` byte-compares the two derived deltas, and every importer rejects every block
        /// the author produces. `on_idle` runs after the extrinsics, so its writes land in THIS block's
        /// post-state — which is the next block's parent state, read identically by node, author and
        /// importer. Same reason `ScanCursor` is advanced inside `observe` and nowhere else.
        ///
        /// Not a `MultiBlockMigration` either, and that one is a brick risk rather than a fork. While an
        /// MBM is ongoing `frame_system::can_set_code` returns `MultiBlockMigrationsOngoing`, so the
        /// chain cannot be upgraded; and every one of `pallet-migrations`' four recovery calls is
        /// `ensure_root`. This chain is sudo-free — its only upgrade path is the committee's
        /// `authorize_upgrade` plus the permissionless `apply_authorized_upgrade`, both of which route
        /// through `can_set_code`, and it has no root origin to reach the recovery calls with. A stuck
        /// MBM would be unrecoverable. An `on_idle` drain that stalls merely leaves the tail
        /// un-enrolled, which is the state it was already in, and a later runtime upgrade can fix it.
        fn on_idle(_now: BlockNumberFor<T>, remaining: Weight) -> Weight {
            Self::drain_rotation_backfill(remaining)
        }

        /// The scan rotation's table invariants. `try-runtime` / test only.
        ///
        /// These are worth asserting rather than trusting because a torn table is a SILENT fault with
        /// consensus reach: `scan_window` reads it on the inherent path of every node every block, so a
        /// duplicated slot double-scans an account, a hole shortens the window, and a count that
        /// disagrees with the table changes where the cursor wraps. None of that surfaces as an error —
        /// it surfaces as an account whose voting power quietly stops being observed.
        #[cfg(feature = "try-runtime")]
        fn try_state(_: BlockNumberFor<T>) -> Result<(), sp_runtime::TryRuntimeError> {
            let count = ScanSlotCount::<T>::get();
            let rows = AccountAtScanSlot::<T>::iter_keys().count() as u64;
            ensure!(
                rows == count,
                "the scan rotation's slot table and its count disagree"
            );
            ensure!(
                ScanSlotOf::<T>::iter_keys().count() as u64 == count,
                "the scan rotation's inverse index and its count disagree"
            );
            // DENSE over [0, count) — the property the swap-remove exists to preserve, and the one that
            // stops a full sweep taking accounts-ever-bound blocks instead of accounts-bound-now.
            for slot in 0..count {
                let who = AccountAtScanSlot::<T>::get(slot)
                    .ok_or("the scan rotation's slot table has a hole below its count")?;
                ensure!(
                    ScanSlotOf::<T>::get(&who) == Some(slot),
                    "the scan rotation's two maps are not each other's inverse"
                );
                ensure!(
                    PkhOf::<T>::contains_key(&who),
                    "an unbound account is still enrolled in the scan rotation"
                );
            }
            // Every identity-bound account is IN the rotation. The converse of the check above, and the
            // one that actually carries the coverage guarantee: an account missing from the table is
            // never scanned, and it does not merely stall — the observer reads it as
            // `ScanCoverage::Absent` (no window can ever reach it) and CLEARS its basis rows on sight,
            // so its voting power and every badge are zeroed.
            //
            // Relaxed to `<=` while a backfill is in flight, because that is precisely the state a
            // resumable backfill is: short, and getting shorter every block. The equality is still the
            // steady-state invariant and is asserted the moment the cursor clears. The `<=` half is not
            // slack — a count EXCEEDING the bound population means the table holds an unbound account,
            // which the per-slot `PkhOf::contains_key` above already rejects.
            let bound = PkhOf::<T>::iter_keys().count() as u64;
            if RotationBackfillCursor::<T>::get().is_some() {
                ensure!(
                    count <= bound,
                    "the scan rotation holds more accounts than are bound"
                );
            } else {
                ensure!(
                    bound == count,
                    "a bound account is missing from the scan rotation"
                );
            }
            Ok(())
        }
    }

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        // `call_index(0)` is PERMANENTLY VACANT: it held the trusted `FollowerOrigin`-gated
        // `link_identity` (which trusted an off-chain `pycardano` CIP-8 verify), REMOVED for D1 in favour
        // of the permissionless on-chain self-proof `link_identity_signed` (@2). On-wire call indices are
        // a contract — the index is never reused (FRAME allows gaps).

        /// **Trustless bind (D1) — FEELESS, unsigned.** Anyone submits the CIP-8 (COSE_Sign1) `signData`
        /// proof their Cardano wallet produced over the pinned bind payload, and the RUNTIME verifies it
        /// on-chain ([`cip8::verify_bind_proof`]) — **no trusted writer, no fee payer**. The CIP-8 proof
        /// IS the authorization, so the call is **unsigned** (`ensure_none`): it carries no signing account,
        /// no nonce and no fee, which is what lets a brand-new sign-to-derived account (zero balance, zero
        /// provider refs) complete its FIRST on-chain action with no funded sponsor. The BOUND account +
        /// identity come from the cryptographically-verified proof, so no one can bind a victim's key and
        /// the submitter cannot retarget it (front-running merely completes the intended bind). The payload
        /// must commit THIS chain's genesis (anti-cross-chain); a tombstoned (revoked) identity is refused.
        ///
        /// **Spam resistance without a fee** — see [`Pallet::validate_unsigned`]: junk is rejected at POOL
        /// admission (before gossip/inclusion), and an already-bound / tombstoned proof is rejected there
        /// too (not only at dispatch). A bind grants NOTHING actionable on its own (talk-capacity and voting
        /// power come from observed Cardano stake keyed on the bound credential), so flooding empty binds
        /// buys an attacker no posting/voting amplification — only the per-block-weight-bounded cost of the
        /// `ed25519` verify it forces. See docs/TRUSTLESS-IDENTITY.md.
        ///
        /// ⚠ The verifier is the anti-Sybil crown jewel — a bug forges any identity. Its invariants are
        /// pinned by the negative tests in [`cip8`], but it has NOT had a formal external audit:
        /// **MAINNET PREREQUISITE — independent verifier audit** before real value.
        // (spec 211: the third `thread_pointer: Option<Vec<u8>>` argument was REMOVED — it was never
        // committed by the CIP-8 signed payload, so any submitter of a valid proof could attach an
        // arbitrary pointer. Removing a call ARGUMENT changes the on-wire extrinsic encoding, so this
        // moved `transaction_version` 6 → 7. The call keeps `call_index(2)`.)
        #[pallet::call_index(2)]
        // WEIGHT: the benchmark predates spec 211 and its declared storage list is now STALE — it still
        // names `CognoGate::ThreadOf (r:0 w:1)`, an item this pallet no longer has. It therefore
        // OVER-declares by one write, which is the safe direction, and the figure is left as measured.
        // Do NOT re-derive a delta by reading the storage list out of `weights.rs`: it describes the
        // spec-210 call. Re-run the benchmark instead.
        #[pallet::weight(T::WeightInfo::link_identity_signed())]
        pub fn link_identity_signed(
            origin: OriginFor<T>,
            cose_sign1: BoundedVec<u8, ConstU32<512>>,
            cose_key: BoundedVec<u8, ConstU32<128>>,
        ) -> DispatchResult {
            // Unsigned: the CIP-8 proof is the authorization (no fee, no nonce). Pool admission
            // (`validate_unsigned`) already verified the proof + cheap-rejected junk before this runs;
            // re-verify here authoritatively to derive the bound account + identity for the write.
            ensure_none(origin)?;
            let (account, identity) = Self::verify_identity_proof(&cose_sign1, &cose_key)?;
            log::debug!(target: LOG_TARGET, "link_identity_signed: verified proof for identity={identity:?}");
            Self::do_bind(&account, identity)
        }

        /// **Trustless stake bind (voting power) — FEELESS, unsigned.** Anyone submits the CIP-8
        /// (COSE_Sign1) `signData` proof their wallet produced over its REWARD address, signed with the
        /// STAKE key, and the RUNTIME verifies it on-chain ([`cip8::verify_bind_proof_stake`]). The proven
        /// 28-byte stake credential is bound 1:1 to the committed account as its voting-power anchor, so a
        /// whale's stake can be voted ONLY by whoever holds its stake key, and only once. The account must
        /// already be payment-bound ([`Call::link_identity_signed`]) — voting power attaches only to a
        /// participant. Like the identity bind it is **unsigned** (`ensure_none`): the proof is the
        /// authorization, so the same zero-balance derived account that posts feelessly can stake-bind with
        /// no fee and no sponsor. The bound account comes from the verified proof, so the submitter cannot
        /// retarget it. The payload must commit THIS chain's genesis; a tombstoned (banned) stake credential
        /// is refused — all enforced at POOL admission too (see [`Pallet::validate_unsigned`]).
        ///
        /// ⚠ Reuses the same crown-jewel verifier plumbing as [`Call::link_identity_signed`]; the same
        /// MAINNET PREREQUISITE (independent audit) applies (see [`cip8`]).
        #[pallet::call_index(3)]
        #[pallet::weight(T::WeightInfo::link_identity_signed())]
        pub fn link_stake_signed(
            origin: OriginFor<T>,
            cose_sign1: BoundedVec<u8, ConstU32<512>>,
            cose_key: BoundedVec<u8, ConstU32<128>>,
        ) -> DispatchResult {
            // Unsigned: the CIP-8 stake proof is the authorization (no fee, no nonce). Pool admission
            // re-verified + cheap-rejected already; re-verify here authoritatively for the write.
            ensure_none(origin)?;
            let (account, stake_credential, nonce) =
                Self::verify_stake_proof(&cose_sign1, &cose_key)?;
            log::debug!(target: LOG_TARGET, "link_stake_signed: verified stake proof for {account:?}");
            Self::do_bind_stake(&account, stake_credential, nonce)
        }

        /// Revoke an account's binding (the manual-operator-ban path). Gated by
        /// `FollowerOrigin`. Removes both directional maps, so `is_allowed`
        /// flips to `false` and the account can no longer post.
        ///
        /// Calls [`OnIdentityBind::on_revoke`] so the bind/revoke lifecycle is symmetric (`gate-1`):
        /// the provider reference taken at `link_identity` is released and the banked capacity is
        /// zeroed, while the `Capacity` row itself is KEPT (microblog's never-delete relock-farm
        /// invariant — a relock must not read a fresh first-touch bucket).
        #[pallet::call_index(1)]
        // The benchmark seeds ONE payment-bound account and nothing else — no stake bind, no role
        // claims, no badges, and therefore no second rotation slot. Everything that costs is on a
        // branch it cannot enter, so it is covered here as an explicit `DbWeight` term. That is the
        // correct use of a hand-written addend (storage the benchmark does NOT reach), and the
        // generated `/// Storage:` list in `weights.rs` is the authority for which is which — read it
        // before touching a number here.
        //
        //   - the STAKE teardown, 2 reads / 6 writes. `StakeCredOf` is listed `r:1 w:0`, so the read
        //     is measured and the `take`'s write is not; `AccountOfStakeCred::remove` +
        //     `TombstonedStakeCred::insert` + `OnTeardown::forget_stake` (which removes the observer's
        //     `LastObservedStake` row, then reads `VotingPower`, writes it, and bumps
        //     `TalkStake::VotingPowerSeq`) are absent entirely. Taken whenever the account had a
        //     voting-power bind, which every real participant does.
        //   - `OnTeardown::forget_account`'s badge clear, 1 read / 2 writes. `CardanoRoles::ObservedRoles`
        //     is listed `r:1 w:0` — `w:0` is the proof that `apply_roles` short-circuited on the
        //     benchmark's empty badge set, so neither the `ObservedRoles` removal nor the
        //     `ObservedRolesSeq` bump was measured.
        //   - `leave_rotation`'s SWAP arm, 1 read / 2 writes. `CognoGate::AccountAtScanSlot` is listed
        //     `r:0 w:1` — `r:0` is the proof that `AccountAtScanSlot::get(last)` never ran, because a
        //     one-account rotation has `slot == last` and skips the swap. A real revoke also writes
        //     `AccountAtScanSlot[slot]` and `ScanSlotOf[moved]`, both distinct keys from the measured
        //     ones. (`revoke_many` DOES reach this: its list shows `r:32 w:64` on both.)
        //   - the `OnBind::on_revoke` fan-out, 1 read / 7 writes. Its cost belongs to the runtime's
        //     impl and cannot be named from this crate (no Cargo edge). Today it purges
        //     pallet-cardano-roles' claims — at most 3 `RoleClaimOf` + 3 `RoleCredIndex` writes,
        //     bounded by `RoleKind` having three variants, with the reads already measured at `r:3` —
        //     and releases the provider reference, which `revoke`'s list does not show but
        //     `revoke_many`'s does at `System::Account (r:64 w:64)`.
        //
        // ⚠ THIS COMMENT USED TO CLAIM the benchmark reached `leave_rotation` and `forget_account`.
        // It does not, and the two `r:0` / `w:0` entries above are why. If the runtime's
        // `OnIdentityBind` impl grows a fan-out beyond the above, raise this term.
        #[pallet::weight(T::WeightInfo::revoke()
            .saturating_add(<T as frame_system::Config>::DbWeight::get().reads_writes(5, 17)))]
        pub fn revoke(origin: OriginFor<T>, substrate_account: T::AccountId) -> DispatchResult {
            T::FollowerOrigin::ensure_origin(origin)?;
            Self::do_revoke(&substrate_account)
        }

        /// Revoke up to [`Config::MaxBatchTargets`] bindings in ONE committee motion. Same authority,
        /// same per-target teardown and same per-target [`Event::Revoked`] as [`Call::revoke`] — the
        /// difference is only that the committee pays for one motion instead of N.
        ///
        /// **Skips missing targets instead of failing on them**, and that is a correctness requirement
        /// rather than a convenience. FRAME wraps every dispatchable in `with_storage_layer`, and
        /// `pallet_collective::do_approve_proposal` SWALLOWS a dispatch error into
        /// `Event::Executed { result: Err(..) }` while `close` still returns `Ok`. So a naive
        /// `for t in targets { do_revoke(t)? }` over a list with one stale entry produces: motion
        /// approved, motion executed, motion removed, **every real revoke rolled back, and no
        /// extrinsic-level failure anywhere for the committee to notice**. One stale account in a
        /// cleanup list would silently void the whole cleanup. `governance_fuel::revoke` is the in-repo
        /// precedent for an idempotent revoke verb; this reports the split as
        /// [`Event::RevokedMany`] `{ applied, skipped }` so the outcome is on-chain and legible.
        ///
        /// Unused weight is refunded, so a motion sized for the worst case does not charge for it.
        #[pallet::call_index(4)]
        // Priced per TARGET: the benchmarked slope plus a hand-written addend, multiplied out rather
        // than applied once. What that addend buys, precisely, since it is the thing CONTRIBUTING warns
        // turns into a double count after a re-measure:
        //   - MEASURED by this benchmark (it seeds a payment AND a stake bind per target through the
        //     real `do_bind` / `do_bind_stake`): the stake teardown's own maps, the `LastObservedStake`
        //     removal, the rotation slot's swap-remove, `LastObservedRoles`, and the `OnBind::on_revoke`
        //     fan-out into `System::Account` and `Microblog::Capacity`.
        //   - NOT measured, 3 reads / 12 writes per target:
        //       · `TalkStake::VotingPower` is listed `r:64 w:0` — the seeded targets already hold 0, so
        //         the sink's `previous != weight` guard skipped both the write and the
        //         `VotingPowerSeq` bump. Real: 1 read + 2 writes.
        //       · `CardanoRoles::ObservedRoles` is listed `r:64 w:0` for the same reason (empty badge
        //         set). Real: 1 read + 2 writes, counting `ObservedRolesSeq`.
        //       · `purge_account_roles`' `RoleClaimOf` + `RoleCredIndex` writes, up to 3 + 3 per target
        //         (reads already measured at `r:192`), because the seeded targets hold no ROLE CLAIMS.
        //       · the swap-remove's SECOND key. The list shows `ScanSlotOf (r:32 w:64)` and
        //         `AccountAtScanSlot (r:32 w:64)` — `r:32` rather than `r:64` because in this benchmark
        //         each target IS the account the previous swap moved, so the tracker dedups the key. In
        //         a production-sized rotation the moved account is a distinct key every time: 1 more
        //         read and 2 more writes per target.
        // Kept whole rather than trimmed: the fan-out lives in the runtime's `OnIdentityBind` impl,
        // which this crate cannot name and which has already grown once (microblog, then cardano-roles
        // as well), and a committee-only call that runs it N times is the wrong place to price tightly.
        // A full 64-target batch still declares ~5x under `MaxProposalWeight`, and the refund below uses
        // the identical formula so the charge tracks what actually ran.
        #[pallet::weight(T::WeightInfo::revoke_many(targets.len() as u32)
            .saturating_add(<T as frame_system::Config>::DbWeight::get()
                .reads_writes(4u64.saturating_mul(targets.len() as u64),
                              12u64.saturating_mul(targets.len() as u64))))]
        pub fn revoke_many(
            origin: OriginFor<T>,
            targets: BoundedVec<T::AccountId, T::MaxBatchTargets>,
        ) -> DispatchResultWithPostInfo {
            T::FollowerOrigin::ensure_origin(origin)?;
            let len = targets.len() as u32;
            let mut applied = 0u32;
            for who in targets.iter() {
                // The only error `do_revoke` returns is `NotBound`, and it returns it BEFORE any
                // write, so a skip leaves no partial teardown behind.
                if Self::do_revoke(who).is_ok() {
                    applied = applied.saturating_add(1);
                }
            }
            let skipped = len.saturating_sub(applied);
            log::debug!(
                target: LOG_TARGET,
                "revoke_many: {applied} applied, {skipped} skipped (already unbound)",
            );
            Self::deposit_event(Event::RevokedMany { applied, skipped });
            // Refund down to what actually ran: the benchmarked cost of `applied` teardowns plus their
            // per-target addend, plus ONE read for each skipped target (the `PkhOf` lookup that returned
            // `None` and stopped). Monotone in `applied`, so this can never exceed the declaration.
            let actual = T::WeightInfo::revoke_many(applied)
                .saturating_add(<T as frame_system::Config>::DbWeight::get().reads_writes(
                    4u64.saturating_mul(applied as u64),
                    12u64.saturating_mul(applied as u64),
                ))
                .saturating_add(<T as frame_system::Config>::DbWeight::get().reads(skipped as u64));
            Ok(Some(actual).into())
        }

        /// Release your OWN stake (voting-power) bind. Signed by the bound account.
        ///
        /// The stake bind had no shrink path at all: it was permanent and irrevocable except by a
        /// committee [`Call::revoke`], which also permanently tombstones the identity. That left a
        /// legitimate user who mis-bound a stake key — or who rotated their Cardano stake — with no way
        /// to correct it, and left `AccountOfStakeCred` a monotone map. This is the self-service
        /// counterpart, modelled on `pallet_cardano_roles::unclaim_role`.
        ///
        /// Does **not** tombstone: this is the user's own housekeeping, not a ban. The credential
        /// becomes claimable again — by this account with a fresh CIP-8 proof, or by whoever else holds
        /// the stake key, which is exactly the 1:1 property `link_stake_signed` already enforces.
        ///
        /// **Feeless** when the caller actually holds a stake bind (`feeless_if` + the runtime's
        /// `SkipCheckIfFeeless`), so a zero-balance posting account can undo its own bind. A no-op
        /// unlink is NOT subsidised — it falls back to `ChargeTransactionPayment`, which a zero-balance
        /// account cannot pay. That is the spam control, and it is the same one `unclaim_role` uses.
        ///
        /// The account's `VotingPower` is zeroed in THIS call, not on the observer's next pass.
        ///
        /// It used to be the other way round, and spec 220 is what made that untenable. The old note
        /// here read "the observer clears it next block: once `AccountOfStakeCred` no longer resolves
        /// the credential, `derive_call` reads it as absent and emits a clear". That inference was the
        /// scan's, and the scan is a rotating window now — absence means "not covered this block" for
        /// most of the ledger, so the released credential's basis row is HELD rather than cleared, and
        /// the account keeps its weight until its slot comes round. A paged `close_poll` tallies by
        /// voter and reads `VotingPower` directly, so that stale row is a wrong vote weight, not merely
        /// a stale display. Tearing it down here also removes the wait entirely.
        #[pallet::call_index(5)]
        // One read and two writes, covering storage the benchmark provably cannot reach. `forget_stake`
        // ends at `VotingPowerApply::set_voting_power(who, 0)`, which is guarded by `previous != weight`
        // — and the benchmarked account's voting power is already 0, so the guard SKIPS the whole branch
        // there and every real caller takes it. Not a double count: the benchmark's storage list is
        // exactly four rows, and `TalkStake::VotingPower (r:1 w:0)` is the read without the write.
        //
        // ⚠ The branch is TWO items, not one, and this addend used to name only the first. Past the
        // guard, `talk_stake::apply_voting_power` writes `VotingPower` AND bumps `VotingPowerSeq` — the
        // counter spec 219 added so a paged `close_poll` can tell that its tally spanned a weight
        // movement. `TalkStake::VotingPowerSeq` appears nowhere in the measured list.
        #[pallet::weight(T::WeightInfo::unlink_stake()
            .saturating_add(<T as frame_system::Config>::DbWeight::get().reads_writes(1, 2)))]
        #[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
            frame_system::ensure_signed(origin.clone())
                .is_ok_and(|who| StakeCredOf::<T>::contains_key(&who))
        })]
        pub fn unlink_stake(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            let stake_cred = StakeCredOf::<T>::take(&who).ok_or(Error::<T>::NoStakeBind)?;
            AccountOfStakeCred::<T>::remove(stake_cred);
            // The account KEEPS its rotation slot — its identity bind stands and its role claims are
            // still scannable. Only the voting-power axis is torn down.
            T::OnTeardown::forget_stake(&who, &stake_cred);
            log::debug!(target: LOG_TARGET, "unlink_stake: {who:?} released its stake bind");
            Self::deposit_event(Event::StakeUnlinked { who, stake_cred });
            Ok(())
        }

        /// Permanently tombstone a stake credential, with no bound account required.
        ///
        /// This exists because [`Call::unlink_stake`] would otherwise punch a hole in `revoke`'s
        /// ban-the-key guarantee. `revoke` tombstones whatever credential the account holds AT THAT
        /// MOMENT, and a committee motion is public for as long as it takes to reach threshold — so an
        /// operator who sees a ban coming could `unlink_stake` first, let the revoke find nothing to
        /// tombstone, and re-bind the same stake key to a fresh identity. Ban-the-key exists precisely
        /// to stop that, and stake is the scarce thing it protects.
        ///
        /// So the committee gets the verb directly: name the credential, not the account. It composes
        /// with [`Call::revoke_many`] in one motion and is also usable pre-emptively.
        ///
        /// Idempotent — tombstoning an already-tombstoned credential succeeds and re-emits, because the
        /// state it asserts is already true and failing would only re-introduce the swallowed-error
        /// problem [`Call::revoke_many`] documents. It does NOT unbind: if the credential is currently
        /// bound, tear that down with [`Call::revoke`] (which tombstones anyway); this call only makes
        /// the credential permanently unclaimable going forward.
        #[pallet::call_index(6)]
        #[pallet::weight(T::WeightInfo::tombstone_stake_cred())]
        pub fn tombstone_stake_cred(
            origin: OriginFor<T>,
            stake_cred: StakeCredential,
        ) -> DispatchResult {
            T::FollowerOrigin::ensure_origin(origin)?;
            TombstonedStakeCred::<T>::insert(stake_cred, ());
            log::debug!(
                target: LOG_TARGET,
                "tombstone_stake_cred: credential permanently banned (ban-the-key, account-independent)",
            );
            Self::deposit_event(Event::StakeCredTombstonedByAuthority { stake_cred });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
        /// The full identity teardown, shared by [`Call::revoke`] and [`Call::revoke_many`] so the two
        /// can never diverge. NO origin check — every caller has already done its own.
        ///
        /// Returns `Err(NotBound)` BEFORE any write when the account is not bound, which is what lets
        /// `revoke_many` treat a missing target as a skip: there is no partial teardown to unwind.
        fn do_revoke(substrate_account: &T::AccountId) -> DispatchResult {
            // A revoke of a never-bound account is REJECTED with NotBound (no state change, no event) —
            // it is NOT a silent success. Log it at debug so a relayer/operator can tell a stale/retried
            // revoke from a real one without scraping for the (deliberately absent) event.
            let identity = match PkhOf::<T>::take(substrate_account) {
                Some(id) => id,
                None => {
                    log::debug!(
                        target: LOG_TARGET,
                        "revoke rejected: account not bound (NotBound) — nothing to release",
                    );
                    return Err(Error::<T>::NotBound.into());
                }
            };
            AccountOf::<T>::remove(identity);
            // Tombstone the identity PERMANENTLY: the permissionless `link_identity_signed` path consults
            // `Tombstoned` and refuses to re-bind it, so a ban cannot be undone by replaying an
            // (eternally-valid) CIP-8 proof. A tombstone is never removed (your "ban means ban" decision).
            Tombstoned::<T>::insert(identity, ());
            // Ban-the-key: if the account had a stake (voting-power) bind, tear it down AND tombstone the
            // stake credential permanently, so a banned operator cannot grind a fresh payment identity to
            // re-bind the SAME on-chain stake and keep voting.
            //
            // ⚠ This only reaches a credential the account still HOLDS. Since spec 218 an account can
            // release its own bind with `unlink_stake`, so an operator who front-runs a public committee
            // motion can arrive here holding nothing. `tombstone_stake_cred` is the answer to that — it
            // names the credential directly and needs no bound account.
            if let Some(stake_cred) = StakeCredOf::<T>::take(substrate_account) {
                AccountOfStakeCred::<T>::remove(stake_cred);
                TombstonedStakeCred::<T>::insert(stake_cred, ());
                // While the credential is still in hand — `forget_account` below could not find it.
                T::OnTeardown::forget_stake(substrate_account, &stake_cred);
                log::debug!(target: LOG_TARGET, "revoke: stake credential unbound + tombstoned (ban-the-key)");
            }
            // Drop the rest of the observed state, then leave the observer's scan rotation. Both halves
            // are needed and neither is optional since spec 220: an account outside the rotation is
            // covered by no scan window ever again, and an out-of-window basis row is HELD rather than
            // re-derived — so anything not torn down here is held at its last value permanently, and a
            // paged `close_poll` would keep counting it.
            T::OnTeardown::forget_account(substrate_account);
            Self::leave_rotation(substrate_account);
            // Symmetric teardown: release the provider ref taken at bind + zero the banked
            // capacity, while microblog KEEPS the (relock-safe) capacity row. NOTE: `on_revoke` is
            // infallible today; if it is ever made fallible, an Err here would leak the bind/revoke
            // provider-ref symmetry (the count stays incremented) — it MUST be error-checked then.
            T::OnBind::on_revoke(substrate_account);
            log::debug!(
                target: LOG_TARGET,
                "revoke ok: identity={:?} unbound, provider ref released + banked capacity zeroed via on_revoke",
                identity,
            );
            Self::deposit_event(Event::Revoked {
                who: substrate_account.clone(),
                identity,
            });
            Ok(())
        }

        /// The identity hash bound to `who`, if any. Read-only helper for tooling/readback.
        pub fn identity_of(who: &T::AccountId) -> Option<IdentityHash> {
            PkhOf::<T>::get(who)
        }

        /// The stake credential bound to `who`, if any (the voting-power anchor). Read-only helper
        /// for tooling and for the weight pipeline (resolve account → stake credential → observed stake).
        pub fn stake_credential_of(who: &T::AccountId) -> Option<StakeCredential> {
            StakeCredOf::<T>::get(who)
        }

        /// Verify a CIP-8 PAYMENT-key bind proof and resolve `(bound account, identity)`. The single,
        /// shared crown-jewel call path for the IDENTITY bind: it runs the audited [`cip8::verify_bind_proof`]
        /// (the `ed25519` verify + address-key bind), the anti-cross-chain genesis check, and the account
        /// decode — and is invoked from BOTH [`Call::link_identity_signed`]'s dispatch body (authoritative)
        /// and [`Pallet::validate_unsigned`] (pool admission), so the two can never diverge. PURE w.r.t.
        /// storage except the one genesis read. Does NOT do the tombstone / 1:1 checks — those live in
        /// `do_bind` (dispatch) and are mirrored in `validate_unsigned` (pool).
        pub(crate) fn verify_identity_proof(
            cose_sign1: &[u8],
            cose_key: &[u8],
        ) -> Result<(T::AccountId, IdentityHash), Error<T>> {
            let proof = cip8::verify_bind_proof(cose_sign1, cose_key, T::CardanoNetwork::get())
                .map_err(|e| {
                    log::warn!(target: LOG_TARGET, "verify_identity_proof: proof rejected: {e:?}");
                    Error::<T>::ProofInvalid
                })?;
            // Anti-cross-chain: the signed payload must commit THIS chain's genesis hash (block 0).
            let genesis = frame_system::Pallet::<T>::block_hash(BlockNumberFor::<T>::zero());
            ensure!(
                genesis.as_ref() == proof.genesis.as_slice(),
                Error::<T>::WrongGenesis
            );
            // The bound account is the 32-byte sr25519 key the PROOF commits — never any submitter.
            let account = T::AccountId::decode(&mut &proof.account[..])
                .map_err(|_| Error::<T>::ProofInvalid)?;
            Ok((account, proof.identity))
        }

        /// Verify a CIP-8 STAKE-key bind proof and resolve `(bound account, stake credential)` — the stake
        /// (voting-power) analog of [`Self::verify_identity_proof`], shared by the dispatch body and the
        /// pool gate so the audited [`cip8::verify_bind_proof_stake`] + genesis check + account decode run
        /// identically in both. Does NOT do the participation / tombstone / 1:1 checks (those live in
        /// `do_bind_stake` and are mirrored in `validate_unsigned`).
        pub(crate) fn verify_stake_proof(
            cose_sign1: &[u8],
            cose_key: &[u8],
        ) -> Result<(T::AccountId, StakeCredential, [u8; 16]), Error<T>> {
            let proof =
                cip8::verify_bind_proof_stake(cose_sign1, cose_key, T::CardanoNetwork::get())
                    .map_err(|e| {
                        log::warn!(target: LOG_TARGET, "verify_stake_proof: proof rejected: {e:?}");
                        Error::<T>::ProofInvalid
                    })?;
            let genesis = frame_system::Pallet::<T>::block_hash(BlockNumberFor::<T>::zero());
            ensure!(
                genesis.as_ref() == proof.genesis.as_slice(),
                Error::<T>::WrongGenesis
            );
            let account = T::AccountId::decode(&mut &proof.account[..])
                .map_err(|_| Error::<T>::ProofInvalid)?;
            Ok((account, proof.stake_credential, proof.nonce))
        }

        /// Put `account` at the TAIL of the observer's scan rotation. Idempotent — an already-enrolled
        /// account keeps the slot it has, so a re-bind never jumps the queue.
        ///
        /// Arrival order is the whole security property here. The alternative the rotation replaces was
        /// a `blake2_128` hash-ordered walk, and hash order is grindable offline: an attacker can mint a
        /// credential whose hash lands anywhere it likes, including immediately ahead of the scan cursor,
        /// and refill that gap every block for as long as it cares to. Under a hash-ordered cursor that
        /// rebuilds permanent targeted denial of observation — the exact defect spec 217 pinned the
        /// already-credited set against and explicitly did not fix for the rest. A flood cannot move an
        /// existing account's slot, so the worst it can do is queue behind everyone already bound and
        /// lengthen the sweep for everybody equally.
        ///
        /// ⚠ `pub` only so the runtime's own scan tests can build a rotation through the REAL
        /// maintenance code rather than hand-writing the three storage items (which is how a test comes
        /// to agree with itself about a table it built wrongly). It is NOT a general-purpose entry
        /// point: `do_bind` is the single production caller, and pairing it with anything other than
        /// [`Self::leave_rotation`] tears the table.
        pub fn join_rotation(account: &T::AccountId) {
            if ScanSlotOf::<T>::contains_key(account) {
                return;
            }
            let slot = ScanSlotCount::<T>::get();
            AccountAtScanSlot::<T>::insert(slot, account);
            ScanSlotOf::<T>::insert(account, slot);
            ScanSlotCount::<T>::put(slot.saturating_add(1));
        }

        /// Take `account` out of the scan rotation, keeping the slot table DENSE by moving the last
        /// account into the hole. A no-op for an account that was never enrolled.
        ///
        /// The swap is what stops the sweep length ratcheting: see [`AccountAtScanSlot`]. It moves
        /// exactly one OTHER account — the one that happens to hold the last slot — to a LOWER slot
        /// index.
        ///
        /// ⚠ A lower index is not the same as "closer to the cursor", and this comment used to claim it
        /// was. Window membership is a forward WRAP distance (`(slot − cursor) mod count`, see
        /// [`Self::slot_in_window`]), so moving an account to a slot BEHIND the cursor increases its
        /// distance: with `count` 1000 and the cursor at 500, an account at slot 999 is 499 away and due
        /// this sweep; revoke the account at slot 499 and it moves there, `count` becomes 999, and its
        /// distance is now `(499 − 500) mod 999` = 998 — it just missed this sweep and waits nearly a
        /// whole further one. So a teardown CAN push one other account further from the cursor.
        ///
        /// Bounded and acceptable rather than fixed: the cost is at most one extra sweep for at most one
        /// account per teardown, the account is `Deferred` throughout so its basis row is HELD rather
        /// than cleared, and `leave_rotation` is reachable only from `do_revoke` — a committee call, not
        /// something an attacker can drive. It is also entirely inert while the population fits one
        /// window, since `take = min(budget, count)` then covers every slot every block. Fixing it would
        /// mean choosing the moved account rather than taking the last one, which reintroduces the
        /// grindable ordering that arrival order exists to prevent.
        ///
        /// ⚠ `pub` for the same reason as [`Self::join_rotation`], and with the same warning:
        /// `do_revoke` is the single production caller.
        pub fn leave_rotation(account: &T::AccountId) {
            let Some(slot) = ScanSlotOf::<T>::take(account) else {
                return;
            };
            // A row in `ScanSlotOf` means a row in the table, so the count is ≥ 1 and `last` is real.
            let last = ScanSlotCount::<T>::get().saturating_sub(1);
            if slot < last {
                match AccountAtScanSlot::<T>::get(last) {
                    Some(moved) => {
                        AccountAtScanSlot::<T>::insert(slot, &moved);
                        ScanSlotOf::<T>::insert(&moved, slot);
                    }
                    None => {
                        // Unreachable while the table is consistent (these two functions are its only
                        // writers and they move all three items together). Clear the vacated slot
                        // rather than leaving a torn-down account readable in it, and let `try_state`
                        // report the inconsistency — silently carrying on with a stale row would put an
                        // account into the scan window that no longer exists.
                        log::error!(
                            target: LOG_TARGET,
                            "scan rotation is inconsistent: slot {last} is empty while the count says \
                             it is occupied. The window will be short by one until this is repaired.",
                        );
                        AccountAtScanSlot::<T>::remove(slot);
                    }
                }
            }
            AccountAtScanSlot::<T>::remove(last);
            ScanSlotCount::<T>::put(last);
        }

        /// Enrol up to [`BACKFILL_BATCH`] not-yet-enrolled bound accounts in the scan rotation, resuming
        /// from [`RotationBackfillCursor`], and clear the cursor when the walk is exhausted. Returns the
        /// weight consumed. A no-op costing ONE READ when no backfill is owed.
        ///
        /// This is the resumable half of a backfill whose first pass could not finish in one block.
        /// `migrations::v2` enrols under a cap because a single-block migration must not run a block
        /// past its budget; before this existed, overrunning that cap was silent in production
        /// (`post_upgrade` is try-runtime-only) and PERMANENT — the stranded tail read
        /// `ScanCoverage::Absent`, `derive_call` cleared its basis rows on sight, and nothing could ever
        /// re-enrol it because `do_bind` is the only other caller of [`Self::join_rotation`] and it
        /// refuses an account that is already bound. The tail's wipe is now TRANSIENT: it is re-enrolled
        /// within `ceil(stranded / BACKFILL_BATCH)` blocks, lands in a window, and the next observation's
        /// forward pass re-credits it from db-sync because its basis row is empty and its desired set is
        /// not.
        ///
        /// Deliberately does NOT teach `ScanWindow::coverage` to answer `Deferred` for an un-enrolled
        /// account while a backfill is in flight, which would avoid the transient clear altogether.
        /// `Absent ⇒ clear on sight` is the backstop that makes `OnBindTeardown` safe: hold it instead
        /// and a committee-BANNED account keeps its weight for the whole backfill. Under-crediting a
        /// tail that self-heals in a bounded number of blocks is the better failure than over-crediting
        /// a ban.
        ///
        /// The walk is bounded by RESULTS as well as by rows: `take` counts enrolments and `walked`
        /// counts iterator steps, and BOTH are capped. Capping only enrolments would let a long run of
        /// already-enrolled accounts — exactly what a resumed backfill walks over if the cursor is ever
        /// re-based — spend unbounded weight finding nothing.
        pub fn drain_rotation_backfill(remaining: Weight) -> Weight {
            let db = T::DbWeight::get();
            let probe = db.reads(1);
            let Some(cursor) = RotationBackfillCursor::<T>::get() else {
                return probe; // the steady state: one read, nothing owed
            };
            // Per account: one `PkhOf` key from the iterator + one `ScanSlotOf` probe, then two writes
            // when it enrols. Price every step at the enrolling rate so the budget can never be
            // overspent by a batch that happens to enrol more than it skipped.
            let per_account = db.reads_writes(2, 2);
            // A runtime that prices storage at ZERO — every pallet mock, and any chain that deliberately
            // does so — has no weight constraint to divide by, and `checked_div_per_component` answers
            // `None` when EVERY component divides by zero. Treating that as "afford nothing" would make
            // the drain a permanent silent no-op: the cursor never clears, the tail never enrols, and
            // nothing says so. Zero cost means only the batch cap applies.
            let budget = if per_account.is_zero() {
                BACKFILL_BATCH as u64
            } else {
                remaining
                    .saturating_sub(probe)
                    .saturating_sub(db.writes(2)) // the cursor + `ScanSlotCount` write-back
                    .checked_div_per_component(&per_account)
                    .unwrap_or(0)
                    .min(BACKFILL_BATCH as u64)
            };
            if budget == 0 {
                return probe; // no idle weight this block; try again next one
            }

            let mut slot = ScanSlotCount::<T>::get();
            let mut walked = 0u64;
            let mut enrolled = 0u64;
            let mut last_key: Option<BoundedVec<u8, ConstU32<128>>> = None;
            let mut exhausted = true;
            for who in PkhOf::<T>::iter_keys_from(cursor.to_vec()) {
                if walked >= budget {
                    exhausted = false;
                    break;
                }
                walked = walked.saturating_add(1);
                last_key = BoundedVec::try_from(PkhOf::<T>::hashed_key_for(&who)).ok();
                if ScanSlotOf::<T>::contains_key(&who) {
                    continue; // already enrolled — never a second slot
                }
                AccountAtScanSlot::<T>::insert(slot, &who);
                ScanSlotOf::<T>::insert(&who, slot);
                slot = slot.saturating_add(1);
                enrolled = enrolled.saturating_add(1);
            }
            if enrolled > 0 {
                ScanSlotCount::<T>::put(slot);
            }
            match (exhausted, last_key) {
                // Walked to the end of `PkhOf`: the rotation now holds every bound account.
                (true, _) => {
                    RotationBackfillCursor::<T>::kill();
                    log::info!(
                        target: LOG_TARGET,
                        "rotation backfill COMPLETE: {enrolled} account(s) enrolled in the final \
                         batch, {slot} slot(s) total",
                    );
                }
                // More to do next block.
                (false, Some(key)) => {
                    RotationBackfillCursor::<T>::put(key);
                    log::debug!(
                        target: LOG_TARGET,
                        "rotation backfill: {enrolled} account(s) enrolled ({walked} walked), {slot} \
                         slot(s) so far",
                    );
                }
                // Unreachable: `exhausted == false` means the loop ran its body at least once, which
                // always sets `last_key`. Leaving the cursor where it is retries the same batch next
                // block rather than skipping it, which is the safe direction — a backfill that repeats
                // work still terminates, one that skips strands an account for ever.
                (false, None) => {
                    log::error!(
                        target: LOG_TARGET,
                        "rotation backfill: stopped without a resume key; retrying from the same \
                         cursor next block",
                    );
                }
            }
            probe
                .saturating_add(db.writes(2))
                .saturating_add(per_account.saturating_mul(walked.max(1)))
        }

        /// The accounts the observer's credential scan covers THIS block: `budget` consecutive rotation
        /// slots from `cursor`, wrapping at the end of the table.
        ///
        /// This is the fix for the last population ceiling on the stake and role axes. The scan used to
        /// be a hash-ordered PREFIX, so a credential past the cap was never scanned, never observed, and
        /// therefore silently held no voting power and no role badge — with a `blake2_128` walk deciding
        /// who. It is a WINDOW now: per-block work is still bounded by `budget`, but every account is
        /// covered within `ceil(ScanSlotCount / budget)` blocks, whatever the population is. A bound on
        /// work per block is correct and necessary; a bound on population was the defect.
        ///
        /// ⚠ PURE FUNCTION OF PARENT STATE AND `cursor`, and it has to stay one. `check_inherent`
        /// BYTE-COMPARES the delta the author derived against the delta the importer re-derives, and both
        /// sides run this against the same parent state — so anything that differs between the two
        /// vantage points forks the chain. In particular: no block number, no parent hash, no digest, no
        /// randomness (`frame_system::initialize` writes all four between the importer's read and the
        /// author's), and no hash-ordered iteration.
        ///
        /// An account occupying a slot but holding no credential at all costs a slot and yields nothing.
        /// That is deliberate: the alternative is to keep walking until `budget` credential-bearing
        /// accounts are found, which is the "budget counts results, not rows walked" shape — and here it
        /// would make the walk length depend on the CONTENT of the table rather than on the cursor,
        /// which an attacker chooses. A fixed stride is what keeps the sweep provably bounded.
        pub fn scan_window(cursor: u64, budget: u32) -> alloc::vec::Vec<T::AccountId> {
            let count = ScanSlotCount::<T>::get();
            if count == 0 || budget == 0 {
                return alloc::vec::Vec::new();
            }
            let take = u64::from(budget).min(count);
            let start = cursor % count;
            let mut out = alloc::vec::Vec::with_capacity(take as usize);
            for i in 0..take {
                // `start + i < 2·count`, so one conditional subtraction is the whole wrap.
                let slot = match start.saturating_add(i) {
                    s if s >= count => s - count,
                    s => s,
                };
                if let Some(account) = AccountAtScanSlot::<T>::get(slot) {
                    out.push(account);
                }
            }
            out
        }

        /// Whether `slot` falls inside the window of `budget` slots starting at `cursor`. The membership
        /// half of [`Self::scan_window`], as a predicate, so the observer can ask about ONE account
        /// without materializing the window — which is what it wants, since it asks only about basis
        /// rows it is on the point of clearing.
        ///
        /// Deliberately expressed as a forward DISTANCE rather than as a range test. `cursor + budget`
        /// can run past the end of the table, and comparing `slot` against an unwrapped upper bound is
        /// the classic off-by-a-wrap: it silently excludes exactly the slots at the start of the table
        /// on every window that straddles the end, so those accounts would be scanned by the node and
        /// then judged out of scope by `derive_call`, which reads as "held" for ever.
        pub fn slot_in_window(slot: u64, cursor: u64, budget: u32) -> bool {
            let count = ScanSlotCount::<T>::get();
            if count == 0 || budget == 0 || slot >= count {
                return false;
            }
            let take = u64::from(budget).min(count);
            let start = cursor % count;
            let distance = if slot >= start {
                slot - start
            } else {
                count - start + slot
            };
            distance < take
        }

        /// The cursor the NEXT window starts at. One read, no walk — which is what lets `observe` advance
        /// the rotation inside the weighed Mandatory dispatch without paying for the window twice.
        pub fn next_scan_cursor(cursor: u64, budget: u32) -> u64 {
            let count = ScanSlotCount::<T>::get();
            if count == 0 {
                return 0;
            }
            let take = u64::from(budget).min(count);
            (cursor % count).saturating_add(take) % count
        }

        /// How many blocks a complete sweep of the rotation takes at `budget` accounts a block. The
        /// honest statement of how stale an out-of-window basis row may be; surfaced to the node so the
        /// operator alarm can be about rotation LATENCY rather than about a cap being full (under a
        /// window, full is the normal state).
        pub fn scan_sweep_blocks(budget: u32) -> u64 {
            let count = ScanSlotCount::<T>::get();
            if count == 0 || budget == 0 {
                return 0;
            }
            count.div_ceil(u64::from(budget))
        }

        /// The bound stake credentials inside a scan window: the credential of every account in it that
        /// holds one. Canonically sorted and deduped, so the scoping set is a pure function of WHICH
        /// accounts are in the window and never of the order they came out of it.
        pub fn stake_credentials_of(accounts: &[T::AccountId]) -> alloc::vec::Vec<StakeCredential> {
            accounts
                .iter()
                .filter_map(StakeCredOf::<T>::get)
                .collect::<alloc::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        }

        /// The shared 1:1 bind body for the trustless [`Call::link_identity_signed`]: the tombstone +
        /// double-bind checks, the two directional maps, the microblog `on_bind` (provider ref +
        /// capacity row), and the `IdentityLinked` event. NOT a dispatchable — it performs no origin
        /// check; the caller authorizes via the cryptographically-verified proof.
        pub(crate) fn do_bind(account: &T::AccountId, identity: IdentityHash) -> DispatchResult {
            // A permanently-banned (revoked) identity can never be re-bound (the tombstone).
            ensure!(
                !Tombstoned::<T>::contains_key(identity),
                Error::<T>::IdentityTombstoned
            );
            // 1:1 enforcement — reject a second bind on EITHER side (the anti-Sybil anchor). A rejected
            // bind is an operator-visible anomaly — warn so it surfaces in the node logs.
            if PkhOf::<T>::contains_key(account) {
                log::warn!(target: LOG_TARGET, "do_bind rejected: account already bound; identity={identity:?}");
                return Err(Error::<T>::AccountAlreadyBound.into());
            }
            if AccountOf::<T>::contains_key(identity) {
                log::warn!(target: LOG_TARGET, "do_bind rejected: identity already bound; identity={identity:?}");
                return Err(Error::<T>::PkhAlreadyBound.into());
            }
            PkhOf::<T>::insert(account, identity);
            AccountOf::<T>::insert(identity, account);
            // Enrol in the observer's scan rotation at the tail. The identity bind is the right hook for
            // it because it is the FIRST thing every scannable credential needs — `link_stake_signed`
            // requires a payment bind and so does every role claim — so one rotation over accounts
            // covers all four credential axes, and an account is either wholly inside a window or wholly
            // outside it. That is what keeps the role sink's whole-set overwrite correct under a partial
            // scan: a half-covered account would be written back with half its badges.
            Self::join_rotation(account);
            // on_bind owns the single inc_providers (balanced by on_revoke's dec) — the gate-1 invariant.
            T::OnBind::on_bind(account);
            log::debug!(target: LOG_TARGET, "do_bind ok: identity={identity:?} bound 1:1, provider ref taken");
            Self::deposit_event(Event::IdentityLinked {
                who: account.clone(),
                identity,
            });
            Ok(())
        }

        /// The 1:1 stake-credential bind body for [`Call::link_stake_signed`]: requires the account to
        /// be payment-bound, consults the ban-the-key tombstone + both directional stake maps, writes
        /// them, and emits `StakeLinked`. NOT a dispatchable — no origin check; the caller authorizes
        /// via the cryptographically-verified stake proof. No microblog `on_bind` hook: this grants
        /// VOTING POWER, not posting capacity (the provider ref / capacity row belong to the payment
        /// bind), so it stays out of the gate-1 provider-ref lifecycle.
        pub(crate) fn do_bind_stake(
            account: &T::AccountId,
            stake_cred: StakeCredential,
            nonce: [u8; 16],
        ) -> DispatchResult {
            // Voting power attaches only to a participant: the account must already be payment-bound.
            ensure!(
                PkhOf::<T>::contains_key(account),
                Error::<T>::NotPaymentBound
            );
            // A permanently-banned (revoked) stake credential can never be re-bound (ban-the-key).
            ensure!(
                !TombstonedStakeCred::<T>::contains_key(stake_cred),
                Error::<T>::StakeCredTombstoned
            );
            // Single-use bytes. See `SpentStakeNonce` for why this is load-bearing rather than belt
            // and braces: `unlink_stake` restores every other precondition in this function, so
            // without it any third party who saw the original bare-unsigned extrinsic could re-attach
            // the bind the holder just released — and keep a credential rotation blocked indefinitely.
            if SpentStakeNonce::<T>::get(account) == Some(nonce) {
                log::warn!(target: LOG_TARGET, "do_bind_stake rejected: stake proof nonce already spent (replay)");
                return Err(Error::<T>::StakeProofReplayed.into());
            }
            // 1:1 enforcement — reject a second bind on EITHER side (the voting anti-Sybil anchor).
            if StakeCredOf::<T>::contains_key(account) {
                log::warn!(target: LOG_TARGET, "do_bind_stake rejected: account already stake-bound");
                return Err(Error::<T>::AccountAlreadyStakeBound.into());
            }
            if AccountOfStakeCred::<T>::contains_key(stake_cred) {
                log::warn!(target: LOG_TARGET, "do_bind_stake rejected: stake credential already bound");
                return Err(Error::<T>::StakeCredAlreadyBound.into());
            }
            SpentStakeNonce::<T>::insert(account, nonce);
            StakeCredOf::<T>::insert(account, stake_cred);
            AccountOfStakeCred::<T>::insert(stake_cred, account);
            log::debug!(target: LOG_TARGET, "do_bind_stake ok: stake credential bound 1:1 for voting power");
            Self::deposit_event(Event::StakeLinked {
                who: account.clone(),
                stake_cred,
            });
            Ok(())
        }
    }

    /// The microblog post gate: an account may post iff it has a live 1:1 binding. This is the
    /// authoritative on-chain Sybil gate (the capacity pool extension is separate spam control).
    impl<T: Config> IsAllowed<T::AccountId> for Pallet<T> {
        fn is_allowed(who: &T::AccountId) -> bool {
            PkhOf::<T>::contains_key(who)
        }

        /// Benchmark-only: bind `who` to a dummy identity so `microblog::post_message`
        /// can be benchmarked through the real gate. Writes only the forward map (`PkhOf`, which
        /// `is_allowed` reads) — NOT `AccountOf` — so repeated calls with the same dummy hash do
        /// not trip the 1:1 reverse-side invariant across benchmark iterations.
        #[cfg(feature = "runtime-benchmarks")]
        fn benchmark_set_allowed(who: &T::AccountId) {
            PkhOf::<T>::insert(who, [0u8; 32]);
        }
    }

    /// Pool priority for the feeless unsigned bind transactions — deliberately LOW so a bind never
    /// starves the feeless posting hot path (whose `CheckCapacity` priority scales with capacity
    /// headroom). A bind is an infrequent onboarding action; it only needs to eventually land.
    const BIND_TX_PRIORITY: u64 = 100;
    /// Pool longevity (in blocks) for a bind transaction: short, so a bind that cannot yet be included
    /// ages out of the pool quickly rather than camping. The browser re-submits on demand.
    const BIND_TX_LONGEVITY: u64 = 32;

    /// **The feeless-bind spam gate.** Both binds ([`Call::link_identity_signed`] /
    /// [`Call::link_stake_signed`]) are UNSIGNED — the CIP-8 proof is the authorization, so there is no
    /// fee or nonce to gate them. This `ValidateUnsigned` impl is therefore the WHOLE pool-admission
    /// defence: every full node runs it at gossip AND at block inclusion (via `pre_dispatch`, which is
    /// consensus-enforced — an importer re-runs it and rejects a block carrying a junk bind), so junk is
    /// rejected BEFORE it is gossiped or included for free, and an already-bound / tombstoned proof is
    /// rejected HERE (not only at dispatch).
    ///
    /// Check ordering / cost (see the PR DoS analysis): oversized blobs are already rejected at SCALE
    /// decode (the `BoundedVec<.., 512/128>` call args); a malformed COSE structure is rejected by the
    /// verifier's own pre-`ed25519` parse — so only a well-formed proof reaches the (unavoidable, audited)
    /// `ed25519` verify. After it, cheap storage reads reject a tombstoned / already-bound / non-participant
    /// proof. `provides` a per-credential tag so the pool dedupes repeats; a short `longevity` ages
    /// stragglers out. A bind grants nothing actionable without observed Cardano stake, so a flood of valid
    /// empty binds gains no posting/voting amplification — only the per-block-weight-bounded verify cost.
    // MIGRATION (stable2606): `ValidateUnsigned` + `#[pallet::validate_unsigned]` are DEPRECATED (removal
    // scheduled after April 2027) in favour of `#[pallet::authorize]` + `frame_system::AuthorizeCall`
    // (Extrinsic Horizon phase 2, paritytech/polkadot-sdk#2415). We deliberately keep the deprecated-but-
    // still-supported mechanism for this SDK bump: migrating to `AuthorizeCall` adds a transaction
    // extension to the runtime's `TxExtension` tuple → it is ENCODING-AFFECTING (a tx_version bump + PAPI
    // regen) and warrants its own PR + acceptance run, out of scope for a dependency upgrade. `#[allow(
    // deprecated)]` suppresses the deprecation lint (which the `-D warnings` CI gate would otherwise fail).
    #[allow(deprecated)]
    #[pallet::validate_unsigned]
    impl<T: Config> ValidateUnsigned for Pallet<T> {
        type Call = Call<T>;

        fn validate_unsigned(_source: TransactionSource, call: &Self::Call) -> TransactionValidity {
            match call {
                Call::link_identity_signed {
                    cose_sign1,
                    cose_key,
                } => {
                    // Verify the proof (audited crown jewel) + genesis + decode the committed account.
                    // A bad / cross-chain proof is a hard, non-retried reject.
                    let (account, identity) = Self::verify_identity_proof(cose_sign1, cose_key)
                        .map_err(|_| InvalidTransaction::BadProof)?;
                    // Mirror `do_bind`'s rejections AT THE POOL so a doomed bind is never gossiped or
                    // included: a tombstoned identity, or either side of the 1:1 already bound, is Stale
                    // (already settled — drop it, do not retry).
                    if Tombstoned::<T>::contains_key(identity)
                        || AccountOf::<T>::contains_key(identity)
                        || PkhOf::<T>::contains_key(&account)
                    {
                        log::debug!(target: LOG_TARGET, "validate_unsigned: identity bind rejected at pool (tombstoned/already-bound) identity={identity:?}");
                        return Err(InvalidTransaction::Stale.into());
                    }
                    ValidTransaction::with_tag_prefix("CognoGateBindIdentity")
                        .priority(BIND_TX_PRIORITY)
                        .and_provides(identity)
                        .longevity(BIND_TX_LONGEVITY)
                        .propagate(true)
                        .build()
                }
                Call::link_stake_signed {
                    cose_sign1,
                    cose_key,
                } => {
                    let (account, stake_cred, nonce) =
                        Self::verify_stake_proof(cose_sign1, cose_key)
                            .map_err(|_| InvalidTransaction::BadProof)?;
                    // Voting power attaches only to a participant: the committed account must already be
                    // payment-bound. The frontend submits the stake bind only after the identity bind is
                    // in a block, so this holds in practice; a stake bind that arrives first is rejected
                    // (Custom 1) and the browser re-submits once the payment bind has landed.
                    if !PkhOf::<T>::contains_key(&account) {
                        return Err(InvalidTransaction::Custom(1).into());
                    }
                    // Mirror `do_bind_stake`'s rejections at the pool: a banned (tombstoned) stake key, or
                    // either side of the 1:1 stake anchor already bound, is Stale. Since spec 218 a SPENT
                    // nonce is too — that is the replay path `unlink_stake` opened, and the whole point of
                    // the guard is that a replayed bind never reaches a block, let alone gets gossiped.
                    // `Stale` (not `BadProof`): the bytes verified fine, they are simply already settled.
                    if TombstonedStakeCred::<T>::contains_key(stake_cred)
                        || StakeCredOf::<T>::contains_key(&account)
                        || AccountOfStakeCred::<T>::contains_key(stake_cred)
                        || SpentStakeNonce::<T>::get(&account) == Some(nonce)
                    {
                        log::debug!(target: LOG_TARGET, "validate_unsigned: stake bind rejected at pool (tombstoned/already-bound/replayed)");
                        return Err(InvalidTransaction::Stale.into());
                    }
                    ValidTransaction::with_tag_prefix("CognoGateBindStake")
                        .priority(BIND_TX_PRIORITY)
                        .and_provides(stake_cred)
                        .longevity(BIND_TX_LONGEVITY)
                        .propagate(true)
                        .build()
                }
                // Every other call (e.g. `revoke`) is origin-gated and must NOT be accepted unsigned.
                _ => Err(InvalidTransaction::Call.into()),
            }
        }
    }
}
