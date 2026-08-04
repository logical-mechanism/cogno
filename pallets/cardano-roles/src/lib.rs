//! # Cardano-roles pallet (cogno-chain)
//!
//! **Verifiable Cardano role tags on profiles** — stake pool operator (**SPO**), delegated
//! representative (**dRep**), and Cardano Constitutional Committee member (**CC**). It is two ledgers
//! in one pallet, mirroring how the identity system is split across cogno-gate (proof) + talk-stake
//! (observer-written weight):
//!
//! ## 1. The CLAIM ledger (permissionless, CIP-8-proven)
//! A user proves control of a raw Cardano role key (a Calidus pool key / a key-based dRep key / a
//! committee hot key) with a CIP-8 self-proof over a SYNTHETIC enterprise address, verified on-chain
//! by the audited [`pallet_cogno_gate::cip8::verify_bind_proof_role`] (the crown jewel — a bug forges
//! a role). [`Call::claim_role_signed`] is UNSIGNED + FEELESS (the proof is the authorization, exactly
//! like the cogno-gate binds); the account must already be **payment-bound** (`IdentityGate`), so this
//! is a Settings add-on, never part of onboarding. The claim binds `(account, role) ↔ credential`
//! 1:1 on each side, tombstonable by the committee.
//!
//! Proving control of the key is the WHOLE job of the claim — it does NOT interpret any Cardano
//! registration. "Is this credential actually a live pool / dRep / CC member?" is answered entirely
//! off the claim, by the cardano-observer (below).
//!
//! ## 2. The OBSERVED-role ledger (call-less, the observer is the ONLY writer)
//! [`ObservedRoles`] is written ONLY by the `cardano-observer` inherent (via the runtime's `RoleSink`
//! → [`Pallet::apply_roles`]). Each block the observer reads db-sync, scoped to the CLAIMED
//! credentials ([`Pallet::claimed_credentials`] → the `bound_role_credentials` runtime API), confirms
//! each is a currently-live pool / dRep / seated CC member, resolves the display id (a **poolID** for BOTH
//! SPO sources — ownership names its owned pool, and a Calidus SPO names the live pool whose cold key
//! authorized its key, so an mSPO yields one entry per pool; the drepID / hot credential for dRep / CC),
//! and writes the account's full observed set —
//! auto-revoking (clamp to empty) when a pool retires / a dRep deregisters / a CC term expires. The
//! profile badge reads THIS map, so a badge only ever reflects a currently-live Cardano role.
//! `ValueQuery` ⇒ an account with no live role reads the empty set for free. A fresh chain with no
//! Cardano (`--dev`/`local`) seeds it via [`GenesisConfig`] (genesis ≠ an extrinsic, so "the observer
//! is the only runtime setter" holds).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod migrations;

pub mod weights;
pub use weights::*;

/// Log target for this pallet's operational diagnostics (off-chain node logs only — the on-chain
/// audit trail is the `RoleClaimed`/`RoleRevoked`/`RolesUpdated` events, NOT these logs).
pub const LOG_TARGET: &str = "runtime::cardano-roles";

/// A 28-byte Cardano credential (a blake2b-224 key hash): the claimed role-key hash on the claim side
/// (Calidus-key hash / drep ID / committee hot credential), and the observer-resolved display id on the
/// observed side (a poolID for EITHER SPO source — ownership names its owned pool, Calidus names the live
/// pool whose cold key authorized its key; the same drep ID / hot credential for dRep / CC).
pub type RoleCredential = [u8; 28];

/// The maximum number of observed role BADGES one account can display at once. An account holds at most
/// one dRep and one CC badge, but can hold SEVERAL SPO badges — one per pool it operates via a Calidus
/// key and/or owns (an mSPO consumes one slot PER declaring pool) — so this is deliberately well above
/// the three [`RoleKind`]s.
///
/// NOT display-only, which is the thing to know before touching it. `poll_chamber_weights` reads this
/// set for the governance-poll chamber tallies: it dedups by pool id and SUMS delegated stake, and it
/// counts distinct roles as the "N SPOs voted" figure. So a truncated mSPO under-reports BOTH its own
/// chamber weight and its participation — and `close_poll` FREEZES the result into `PollResult` with no
/// re-pricing path, so for a poll closed while truncated the under-count is permanent. (An OPEN poll
/// re-prices on every read, so only closed ones fossilize it.)
///
/// Truncation order (spec 211): [`Pallet::bound_observed_roles`] fills NON-SPO roles (dRep, CC) FIRST —
/// bounded to a small fixed reserve, so badges can never starve the pools either — then the SPO
/// entries, so a large mSPO past the cap loses only surplus SPO pools, never its dRep/CC badge or its
/// dRep-chamber weight. (Before spec 211 it kept the first N in the canonical order, which sorts every
/// SPO entry ahead of dRep/CC — so one Calidus key declared by ~14+ live pools silently truncated the
/// operator's dRep badge away.)
///
/// Spec 217 raised this 16 → 32, which is the observer's `MaxRolesPerAccount` and therefore the largest
/// set the sink can ever be handed. At 16 the reserve left 12..=16 usable SPO slots, and live preprod
/// already holds a credential owning 17 pools while mainnet mSPOs run 20-30 — so the cap was a latent
/// under-count waiting on a real operator, and truncation was SILENT (no log, no event field, no
/// counter, with `RolesUpdated` carrying only the survivors as though complete).
///
/// RAISING it needs no storage migration: [`ObservedRoleSet`] is a `BoundedVec`, whose `Decode` reads a
/// compact length and then bound-checks it, so every stored row (len ≤ the old bound ≤ the new one)
/// decodes unchanged and byte-identically. What a raise DOES need is a re-apply — see
/// `pallet_cardano_observer::migrations::v2` — because `derive_call` diffs against the observer's own
/// basis, which the sink cap never touched, so an already-truncated row is not rewritten by itself.
///
/// ⚠ NARROWING it is a different matter and is genuinely unsafe: [`ObservedRoles`] is `ValueQuery`, so a
/// stored row longer than a lowered bound fails to decode and hands back the DEFAULT — a silently empty
/// badge set, with the account's chamber weight silently gone. That needs a migration.
pub const MAX_OBSERVED_ROLES_PER_ACCOUNT: u32 = 32;

/// The role axis's half of an explicit observed-state teardown: drop the OBSERVER's diff basis for an
/// account whose badge set this pallet has just cleared. The analogue of
/// `pallet_cogno_gate::OnBindTeardown` for the role-level verbs, and it exists as a seam for the same
/// reason that one does — this pallet owns [`ObservedRoles`] but has no Cargo edge to
/// `pallet-cardano-observer`, so it cannot reach `LastObservedRoles` itself. The runtime wires the two
/// halves together.
///
/// ⚠ THE TWO LEDGERS MOVE TOGETHER OR NOT AT ALL, and forgetting the basis is the expensive direction.
/// `derive_call`'s forward pass writes a change only when the recomputed set DIFFERS from
/// `LastObservedRoles`. Clear the badge row while leaving the basis listing the released badges and the
/// next observation short-circuits as unchanged — so the badge row stays empty FOR EVER, with no event
/// and nothing to re-derive it. Clearing the basis is also what makes the clear survive the scan window:
/// with the row gone the account drops out of the drop-out loop's `iter_keys()` entirely, so an
/// out-of-window account is held at ZERO rather than held at a stale value.
///
/// Spec 220 made this necessary. Before the rotating window, "the observer clears it next block" was
/// true; now absence outside the window HOLDS a basis row, so a released or committee-banned badge can
/// keep its governance-poll chamber weight for up to a full sweep — and a paged `close_poll` can freeze
/// it there.
pub trait OnObservedRolesCleared<AccountId> {
    /// Drop the observer's `LastObservedRoles` basis row for `who`. Called unconditionally by every
    /// site that clears this pallet's badge set: the basis and the badge row can legitimately disagree
    /// (an out-of-window hold moves neither, a truncating sink moves only one), so gating this on the
    /// badge row having existed would leave a basis row standing in exactly the case that matters.
    fn forget_role_basis(who: &AccountId);
}

impl<AccountId> OnObservedRolesCleared<AccountId> for () {
    fn forget_role_basis(_who: &AccountId) {}
}

#[frame_support::pallet]
pub mod pallet {
    use super::*;
    use alloc::vec::Vec;
    use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
    use frame_support::{pallet_prelude::*, sp_runtime::traits::Zero};
    use frame_system::{ensure_none, ensure_signed, pallet_prelude::*};
    // The identity gate (a role claim requires a payment-bound account) is the microblog `IsAllowed`
    // trait — the same seam pallet-profile uses. Lives in the depended-upon crate, so no Cargo cycle.
    use pallet_microblog::IsAllowed;

    /// The Cardano role a claim / observation is for. `#[codec(index)]` PINS the on-wire discriminant
    /// (this enum rides in storage keys, the claim/observed ledgers, events, and call args) — never
    /// renumber; append only.
    #[derive(
        Clone,
        Copy,
        PartialEq,
        Eq,
        PartialOrd,
        Ord,
        Encode,
        Decode,
        DecodeWithMemTracking,
        MaxEncodedLen,
        TypeInfo,
        Debug,
    )]
    pub enum RoleKind {
        /// Stake pool operator (proven via a Calidus pool key; the observer links it to a pool).
        #[codec(index = 0)]
        Spo,
        /// Delegated representative (key-based dRep; the credential IS the dRep ID).
        #[codec(index = 1)]
        DRep,
        /// Constitutional Committee member (the credential IS the committee hot credential).
        #[codec(index = 2)]
        Committee,
    }

    impl RoleKind {
        /// Map the pure-verifier's [`pallet_cogno_gate::cip8::RoleClass`] (the `role=` field the proof
        /// committed) to the on-wire `RoleKind`.
        fn from_class(class: pallet_cogno_gate::cip8::RoleClass) -> Self {
            use pallet_cogno_gate::cip8::RoleClass;
            match class {
                RoleClass::Spo => RoleKind::Spo,
                RoleClass::DRep => RoleKind::DRep,
                RoleClass::Committee => RoleKind::Committee,
            }
        }

        /// The `#[codec(index)]` value (0 = SPO, 1 = dRep, 2 = CC) as a plain `u8`. Used to fold an
        /// observed role into the microblog `ProfileView` / `EnrichedPost` as a primitive `(u8, id)` — the
        /// runtime cannot name this on-wire type there without a Cargo cycle (microblog ← cardano-roles).
        /// Mirrors the observer's `RoleSource::kind_index`.
        pub fn index(self) -> u8 {
            match self {
                RoleKind::Spo => 0,
                RoleKind::DRep => 1,
                RoleKind::Committee => 2,
            }
        }

        /// Map a `#[codec(index)]` value (0/1/2) back to a `RoleKind` — used only by the `--dev`
        /// genesis seed. `None` for any other value.
        fn from_index(ix: u8) -> Option<Self> {
            match ix {
                0 => Some(RoleKind::Spo),
                1 => Some(RoleKind::DRep),
                2 => Some(RoleKind::Committee),
                _ => None,
            }
        }
    }

    /// One entry in an account's observed-role set: a currently-live role + its display id (a poolID for
    /// EITHER SPO source — ownership names its owned pool, Calidus names the live pool whose cold key
    /// authorized its key; the drep ID / hot credential for dRep / CC) + the `weight` a GOVERNANCE-POLL
    /// chamber weights this role's vote by (spec 207). An mSPO holds one entry per declaring pool.
    ///
    /// `weight` is the role's delegated Cardano stake at the observed epoch: an SPO's named pool's total
    /// delegated (block-production) stake, a dRep's total delegated voting stake; `0` for CC and for a pool
    /// with no delegators. It is DISPLAY-ONLY chamber input for governance polls — it does NOT touch
    /// talk-stake `VotingPower` (a regular stake vote is unchanged), and a non-governance poll never reads
    /// it. The observer overwrites the whole set each epoch, so it tracks the live delegation.
    #[derive(
        Clone, PartialEq, Eq, Encode, Decode, DecodeWithMemTracking, MaxEncodedLen, TypeInfo, Debug,
    )]
    pub struct ObservedRole {
        pub kind: RoleKind,
        pub id: RoleCredential,
        pub weight: u128,
    }

    /// An account's full observed-role set (≤ one dRep and one CC, but possibly several SPO). The profile
    /// badge reads it.
    pub type ObservedRoleSet = BoundedVec<ObservedRole, ConstU32<MAX_OBSERVED_ROLES_PER_ACCOUNT>>;

    /// Storage version. `1` (spec 207) adds the governance-poll chamber `weight` to every
    /// [`ObservedRole`]; the pallet shipped (spec 206) without an explicit version, i.e. the implicit `0`,
    /// so [`migrations::MigrateV0ToV1`] moves it `0 → 1` (a no-op when `ObservedRoles` is empty).
    const STORAGE_VERSION: StorageVersion = StorageVersion::new(1);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// The authority for [`Call::revoke_role`] (the committee moderation ban). An `EnsureOrigin`,
        /// never `ensure_signed` — the public pool must not be able to ban roles. Wired to the 3-of-5
        /// FollowerCommittee; no sudo fallback. Claiming is NOT gated by this (it is the permissionless
        /// cryptographic [`Call::claim_role_signed`]).
        type RoleAuthorityOrigin: EnsureOrigin<Self::RuntimeOrigin>;
        /// The identity gate: a role claim requires an account that is already payment-bound (`is_allowed`).
        /// Wired to `CognoGate` — the same seam pallet-profile / pallet-microblog use.
        type IdentityGate: IsAllowed<Self::AccountId>;
        /// The Cardano network the CIP-8 role proof binds for (0 = testnet, 1 = mainnet), passed to the
        /// verifier — the synthetic enterprise address must be on this network.
        #[pallet::constant]
        type CardanoNetwork: Get<u8>;
        /// The ceiling on how many claimed credentials the per-block observer scan may return — the
        /// cardano-observer's `MaxScanned`. Not a `#[pallet::constant]`: it bounds a runtime-API read,
        /// not anything on the wire.
        ///
        /// `claimed_credentials` runs on the inherent-data path of every node on every block and feeds a
        /// db-sync query under a timeout, while the map it scans is grown by the bare-unsigned, feeless
        /// `claim_role_signed`. Unbounded, that is a free way to stop the sole weight writer for
        /// everyone.
        ///
        /// ⚠ Since spec 215 this cap is a REAL ceiling on what gets observed, where it used to be
        /// redundant with one the observation already had. The observation is a delta now and nothing
        /// bounds its size, so a credential past this cap is simply never scanned, never observed, and
        /// never badged — a per-identity omission the warnings below exist to catch.
        ///
        /// ⚠ Since spec 217 that omission can no longer take a badge AWAY. The scan pins every claim
        /// whose account already holds a live observed-role row, so the cap falls only on claims that
        /// have never been confirmed. See [`Pallet::claimed_credentials`].
        type MaxScanned: Get<u32>;
        /// The most `(account, role)` targets one [`Call::revoke_role_many`] motion may carry.
        ///
        /// Shared with `pallet_cogno_gate::Config::MaxBatchTargets` in the runtime so the two committee
        /// cleanup verbs cannot be sized apart. Bounded by `pallet-collective`'s `MaxProposalWeight`
        /// (checked at PROPOSE), not by the block's `max_extrinsic` — an oversized batch is a call
        /// nobody can propose rather than one that fails late.
        #[pallet::constant]
        type MaxBatchTargets: Get<u32>;
        /// The observer's half of the role teardown: see [`OnObservedRolesCleared`]. `()` in tests that
        /// do not care, but NOT in this pallet's own mock — the failure it guards against (a basis row
        /// left standing, so the badge set never comes back) is invisible to any test that stubs it out.
        type OnRoleTeardown: OnObservedRolesCleared<Self::AccountId>;
        /// Weight information for this pallet's dispatchables.
        type WeightInfo: WeightInfo;
    }

    /// Forward claim map: `(account, role) → the proven 28-byte role credential`. `OptionQuery` ⇒ an
    /// account that has not claimed that role reads `None`. At most one credential per (account, role).
    #[pallet::storage]
    pub type RoleClaimOf<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Twox64Concat,
        RoleKind,
        RoleCredential,
        OptionQuery,
    >;

    /// Reverse claim index: `(role, credential) → the one account that claimed it`. Enforces the
    /// per-role 1:1 (a credential is claimed once) AND is the enumeration source the observer scopes
    /// its db-sync read to (`iter_key_prefix(role)` = every claimed credential for that role).
    #[pallet::storage]
    pub type RoleCredIndex<T: Config> = StorageDoubleMap<
        _,
        Twox64Concat,
        RoleKind,
        Blake2_128Concat,
        RoleCredential,
        T::AccountId,
        OptionQuery,
    >;

    /// Permanently-banned role credentials — the committee moderation tombstone. [`Call::revoke_role`]
    /// inserts here; [`Call::claim_role_signed`] refuses to (re)claim a tombstoned `(role, credential)`,
    /// so an eternally-valid CIP-8 proof replayed after a ban does not resurrect the claim. Never
    /// removed (a tombstone is permanent — the same "ban means ban" rule as cogno-gate).
    #[pallet::storage]
    pub type TombstonedRoleCred<T: Config> = StorageDoubleMap<
        _,
        Twox64Concat,
        RoleKind,
        Blake2_128Concat,
        RoleCredential,
        (),
        OptionQuery,
    >;

    /// Nonce SPENT by the most recent accepted claim for `(account, role)`. Deliberately survives
    /// `unclaim_role` — that is the whole point of it.
    ///
    /// A role proof carries no expiry and commits no chain state that moves, so its bytes stay valid
    /// forever. `unclaim_role` frees both claim maps, which restores exactly the pre-claim conditions
    /// `do_claim` checks — so ANY third party who saw the original `claim_role_signed` extrinsic on
    /// chain could re-submit those same bytes and silently re-attach the badge the holder had just
    /// removed (the calls are bare-unsigned, so no signature of theirs is needed). Worse than the
    /// nuisance: a holder rotating a credential to a new account is blocked by the 1:1 rule for as
    /// long as the replayer keeps re-binding the old one.
    ///
    /// Spending the nonce closes that: the replayed bytes carry the same nonce, so the re-claim is
    /// rejected. A genuine re-claim needs a fresh proof with a new nonce, which only the role key can
    /// sign — no usability cost.
    ///
    /// ⚠ RESIDUAL, stated honestly: this remembers the LAST nonce, not every nonce. The client mints
    /// a fresh random nonce per proof, so a second claim displaces the first — an account past two or
    /// more claim/unclaim cycles can still be hit by a replay of a proof OLDER than its most recent
    /// one. Two closes exist, and NEITHER needs the `cogno-chain/role/v1` GRAMMAR to move: key this
    /// map by the nonce as well (correct, but it turns one row per `(account, role)` into an
    /// append-only map with no prune verb, written by a feeless bare-unsigned call), or require the
    /// nonce to be strictly INCREASING (O(1) storage and every older proof dies for good, but the
    /// client can no longer mint a uniformly random nonce — a lockstep frontend rule, plus a re-sign
    /// whenever a signer raced a stale read). That lockstep is why the second is deferred, not the
    /// grammar. Griefing-only meanwhile: the replay re-binds the holder's OWN credential to the
    /// account the holder committed, `unclaim_role` stays free for the holder, and the observer still
    /// gates the badge on live Cardano state.
    /// Bounded as written: one 16-byte entry per `(account, role)`, the same growth as the claim.
    #[pallet::storage]
    pub type SpentRoleNonce<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Twox64Concat,
        RoleKind,
        [u8; 16],
        OptionQuery,
    >;

    /// The call-less OBSERVED-role ledger: `account → its currently-live role set`. Written ONLY by
    /// the cardano-observer inherent (via the runtime `RoleSink` → [`Pallet::apply_roles`]).
    /// `ValueQuery` ⇒ an account with no live role reads the empty set for free. THE map the profile
    /// badge reads.
    #[pallet::storage]
    pub type ObservedRoles<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, ObservedRoleSet, ValueQuery>;

    /// A monotone counter bumped every time [`ObservedRoles`] actually CHANGES for any account. The role
    /// axis mirror of `pallet_talk_stake::VotingPowerSeq`, and the same contract: not a count of anything
    /// on its own, just a cheap way to ask "did the chamber inputs move since I last looked?".
    ///
    /// Spec 219 added it for `pallet-microblog`'s PAGED `close_poll`, whose SPO/dRep chamber freeze reads
    /// this map across several blocks. It is deliberately SEPARATE from the stake counter rather than one
    /// shared sequence: a `PollKind::Stake` poll never touches the chamber lens, so a role observation must
    /// not mark a stake-only tally as smeared (and vice versa). Two `StorageValue`s cost nothing and
    /// halve the false-report rate.
    ///
    /// ⚠ It must be bumped by EVERY writer of the chamber inputs, not only the observer. `apply_roles` is
    /// the inherent's path; [`Pallet::purge_account_roles`] is an ORDINARY extrinsic path, reached from the
    /// committee's cogno-gate `revoke` / `revoke_many`. Missing that second one would let a revoke silently
    /// change a chamber mid-count without invalidating the tally.
    #[pallet::storage]
    pub type ObservedRolesSeq<T: Config> = StorageValue<_, u64, ValueQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A role credential was claimed 1:1 by an account (the CIP-8 self-proof landed). The tag is
        /// NOT yet shown — the observer must still confirm the credential is a live Cardano role.
        #[codec(index = 0)]
        RoleClaimed {
            who: T::AccountId,
            role: RoleKind,
            credential: RoleCredential,
        },
        /// An account self-service released a role claim ([`Call::unclaim_role`]).
        #[codec(index = 1)]
        RoleUnclaimed { who: T::AccountId, role: RoleKind },
        /// A role claim was revoked + the credential tombstoned by the committee ([`Call::revoke_role`]).
        #[codec(index = 2)]
        RoleRevoked { who: T::AccountId, role: RoleKind },
        /// The observer wrote `who`'s live role set (idempotent overwrite; empty = fully clamped). The
        /// per-account audit record for the observed ledger.
        #[codec(index = 3)]
        RolesUpdated {
            who: T::AccountId,
            roles: ObservedRoleSet,
        },
        /// A [`Call::revoke_role_many`] motion finished. `applied` targets held the claim and were
        /// revoked + tombstoned (each also emitted its own [`Event::RoleRevoked`]); `skipped` had no
        /// such claim and were passed over. Emitted so a batch that silently applied nothing cannot
        /// look like one that applied everything.
        #[codec(index = 4)]
        RolesRevokedMany { applied: u32, skipped: u32 },
    }

    // Variant indices are ON-WIRE (the index IS the wire format of a `DispatchError::Module`), so
    // they are pinned explicitly at their pre-pin ordinals — the encoding is byte-identical. Never
    // renumber; a new variant takes the next free index (8). (The Event enum above is pinned the
    // same way; its next free index is 5.)
    #[pallet::error]
    pub enum Error<T> {
        /// The submitted CIP-8 role self-proof failed verification (signature / address-key bind /
        /// format / bad role payload). The node log carries the specific `Cip8Error` variant.
        #[codec(index = 0)]
        ProofInvalid,
        /// The proof commits a different chain's genesis hash (anti-cross-chain replay).
        #[codec(index = 1)]
        WrongGenesis,
        /// The account must be payment-bound (an onboarded identity) before it can claim a role.
        #[codec(index = 2)]
        NotPaymentBound,
        /// This account has already claimed this role (1:1, account side).
        #[codec(index = 3)]
        AccountAlreadyClaimedRole,
        /// This role credential is already claimed by an account (1:1, credential side).
        #[codec(index = 4)]
        RoleCredAlreadyClaimed,
        /// This role credential was permanently banned (revoked) and cannot be re-claimed (the tombstone).
        #[codec(index = 5)]
        RoleCredTombstoned,
        /// No claim exists for this `(account, role)` (unclaim / revoke target not found).
        #[codec(index = 6)]
        NotClaimed,
        /// This exact proof was already spent for this `(account, role)` — a replay of bytes that were
        /// accepted once before. See [`SpentRoleNonce`].
        #[codec(index = 7)]
        RoleProofReplayed,
    }

    /// Genesis seed for the OBSERVED ledger on chains with no Cardano to observe (`--dev` / `local`),
    /// so a badge renders with no db-sync. EMPTY on preprod/mainnet (the observer credits real roles
    /// from block 0). Genesis is NOT an extrinsic, so this preserves "the observer is the only setter".
    /// The role is given as its `#[codec(index)]` value (0 = SPO, 1 = dRep, 2 = CC) so the genesis
    /// config stays serde-serializable without deriving serde on the on-wire types. Each role also carries
    /// its chamber `weight` (spec 207) — the delegated stake a governance poll weights it by; seed a
    /// non-zero value on a `--dev`/`local` chain to exercise the SPO/dRep chambers with no db-sync.
    #[pallet::genesis_config]
    #[derive(frame_support::DefaultNoBound)]
    pub struct GenesisConfig<T: Config> {
        #[allow(clippy::type_complexity)]
        pub initial_observed_roles: Vec<(T::AccountId, Vec<(u8, RoleCredential, u128)>)>,
    }

    #[pallet::genesis_build]
    impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
        fn build(&self) {
            for (who, roles) in &self.initial_observed_roles {
                let set: Vec<ObservedRole> = roles
                    .iter()
                    .map(|(ix, id, weight)| ObservedRole {
                        kind: RoleKind::from_index(*ix)
                            .expect("genesis role index must be 0 (SPO), 1 (dRep) or 2 (CC)"),
                        id: *id,
                        weight: *weight,
                    })
                    .collect();
                let bounded = ObservedRoleSet::try_from(set)
                    .expect("genesis role set exceeds MAX_OBSERVED_ROLES_PER_ACCOUNT");
                if !bounded.is_empty() {
                    ObservedRoles::<T>::insert(who, bounded);
                }
            }
        }
    }

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Claim a Cardano role by a CIP-8 role-key self-proof. UNSIGNED + FEELESS: the proof is the
        /// authorization (no fee, no nonce), exactly like the cogno-gate binds; pool admission
        /// ([`Pallet::validate_unsigned`]) re-verifies + cheap-rejects a doomed claim first, then this
        /// re-verifies authoritatively for the write. The role comes from the signed payload's `role=`
        /// field, not a call arg, so one call covers all three roles. Requires the committed account be
        /// payment-bound (`NotPaymentBound`).
        ///
        /// ⚠ Reuses the crown-jewel verifier ([`pallet_cogno_gate::cip8::verify_bind_proof_role`]); the
        /// same MAINNET PREREQUISITE (independent audit) applies.
        #[pallet::call_index(0)]
        #[pallet::weight(T::WeightInfo::claim_role_signed())]
        pub fn claim_role_signed(
            origin: OriginFor<T>,
            cose_sign1: BoundedVec<u8, ConstU32<512>>,
            cose_key: BoundedVec<u8, ConstU32<128>>,
        ) -> DispatchResult {
            ensure_none(origin)?;
            let (account, role, credential, nonce) =
                Self::verify_role_proof(&cose_sign1, &cose_key)?;
            log::debug!(target: LOG_TARGET, "claim_role_signed: verified {role:?} proof for {account:?}");
            Self::do_claim(&account, role, credential, nonce)
        }

        /// Self-service release of a role claim. Signed by the claiming account. Removes both claim
        /// maps and, since spec 221, tears the account's observed badge set down explicitly rather than
        /// waiting for the observer to notice. Does NOT tombstone (that is the committee ban).
        ///
        /// The teardown is WHOLE-ACCOUNT, so releasing one role also drops the account's other badges
        /// until the next observation covers it — one block while the bound population fits a single
        /// scan window. [`Pallet::drop_observed_badges`] carries the reasoning, and the short version is
        /// that a per-role filter is not expressible from what [`ObservedRoles`] stores.
        ///
        /// **Feeless** when the caller actually holds this claim (`feeless_if` below + the runtime's
        /// `SkipCheckIfFeeless`) — so the same zero-balance posting account that CLAIMED can release its
        /// own role, exactly like every other user write on this feeless chain. Unlike the claim (an
        /// unsigned, `validate_unsigned`-gated call), this one is signed and NOT capacity-metered (the
        /// runtime's `ForeignCost` prices only profile writes), so gating the fee waiver on an existing
        /// claim IS its spam control: a no-op unclaim (no claim) is not subsidised — it falls back to
        /// `ChargeTransactionPayment`, which a zero-balance account cannot pay. At most one free unclaim
        /// per claim; re-claiming needs a fresh CIP-8 proof.
        #[pallet::call_index(1)]
        #[pallet::weight(T::WeightInfo::unclaim_role())]
        #[pallet::feeless_if(|origin: &OriginFor<T>, role: &RoleKind| -> bool {
            frame_system::ensure_signed(origin.clone())
                .is_ok_and(|who| RoleClaimOf::<T>::contains_key(&who, *role))
        })]
        pub fn unclaim_role(origin: OriginFor<T>, role: RoleKind) -> DispatchResult {
            let who = ensure_signed(origin)?;
            let credential = RoleClaimOf::<T>::take(&who, role).ok_or(Error::<T>::NotClaimed)?;
            RoleCredIndex::<T>::remove(role, credential);
            Self::drop_observed_badges(&who);
            log::debug!(target: LOG_TARGET, "unclaim_role: {who:?} released {role:?}");
            Self::deposit_event(Event::RoleUnclaimed { who, role });
            Ok(())
        }

        /// Revoke an account's role claim + tombstone the credential (the committee moderation ban).
        /// Gated by `RoleAuthorityOrigin` (3-of-5). Removes both claim maps and permanently tombstones
        /// `(role, credential)` so it cannot be re-claimed by anyone (ban-the-key).
        ///
        /// Since spec 221 the banned account's observed badges and their governance-poll chamber weight
        /// go in the SAME block, via [`Pallet::drop_observed_badges`] — they used to survive until the
        /// account's rotation slot re-entered the scan window, which meant a ban could lose the very
        /// vote it was called for. The teardown is whole-account, so it also drops the account's other
        /// roles' badges until the next observation re-credits them; for a moderation verb that
        /// over-removal is the correct direction.
        #[pallet::call_index(2)]
        #[pallet::weight(T::WeightInfo::revoke_role())]
        pub fn revoke_role(
            origin: OriginFor<T>,
            account: T::AccountId,
            role: RoleKind,
        ) -> DispatchResult {
            T::RoleAuthorityOrigin::ensure_origin(origin)?;
            Self::do_revoke_role(&account, role)
        }

        /// Revoke up to [`Config::MaxBatchTargets`] `(account, role)` claims in ONE committee motion.
        /// Same authority, same per-target tombstone and same per-target [`Event::RoleRevoked`] as
        /// [`Call::revoke_role`] — the committee just pays for one motion instead of N.
        ///
        /// **Skips missing targets instead of failing on them.** FRAME wraps every dispatchable in
        /// `with_storage_layer` and `pallet_collective::do_approve_proposal` swallows a dispatch error
        /// into `Event::Executed { result: Err(..) }` while `close` still returns `Ok`, so a naive
        /// `?`-chained batch containing one already-unclaimed target would roll back every real
        /// revoke while reporting nothing. The split is reported as [`Event::RolesRevokedMany`]
        /// `{ applied, skipped }`. See `pallet_cogno_gate::Call::revoke_many`, which is the same verb
        /// on the identity axis and carries the full rationale.
        ///
        /// A target is `(account, role)` rather than an account, because an account holds up to three
        /// independent claims and a committee ban is per role. Revoking every role an account holds is
        /// the identity-revoke path (`purge_account_roles`), not this one.
        ///
        /// Unused weight is refunded, so a motion sized for the worst case does not charge for it.
        #[pallet::call_index(3)]
        #[pallet::weight(T::WeightInfo::revoke_role_many(targets.len() as u32))]
        pub fn revoke_role_many(
            origin: OriginFor<T>,
            targets: BoundedVec<(T::AccountId, RoleKind), T::MaxBatchTargets>,
        ) -> DispatchResultWithPostInfo {
            T::RoleAuthorityOrigin::ensure_origin(origin)?;
            let len = targets.len() as u32;
            let mut applied = 0u32;
            for (account, role) in targets.iter() {
                // The only error `do_revoke_role` returns is `NotClaimed`, and it returns it BEFORE
                // any write, so a skip leaves no partial teardown behind.
                if Self::do_revoke_role(account, *role).is_ok() {
                    applied = applied.saturating_add(1);
                }
            }
            let skipped = len.saturating_sub(applied);
            log::debug!(
                target: LOG_TARGET,
                "revoke_role_many: {applied} applied, {skipped} skipped (already unclaimed)",
            );
            Self::deposit_event(Event::RolesRevokedMany { applied, skipped });
            // Refund to what ran: the applied teardowns, plus one read for each skipped target (the
            // `RoleClaimOf` lookup that returned `None` and stopped).
            let actual = T::WeightInfo::revoke_role_many(applied)
                .saturating_add(<T as frame_system::Config>::DbWeight::get().reads(skipped as u64));
            Ok(Some(actual).into())
        }
    }

    /// What [`Pallet::verify_role_proof`] extracts from an accepted proof: the account the payload
    /// COMMITS (never the submitter), the role, the 28-byte credential, and the 16-byte nonce the
    /// caller spends to make the proof single-use.
    pub(crate) type VerifiedRoleClaim<T> = (
        <T as frame_system::Config>::AccountId,
        RoleKind,
        RoleCredential,
        [u8; 16],
    );

    impl<T: Config> Pallet<T> {
        /// The single-claim committee teardown, shared by [`Call::revoke_role`] and
        /// [`Call::revoke_role_many`] so the two can never diverge. NO origin check — every caller has
        /// already done its own.
        ///
        /// Returns `Err(NotClaimed)` BEFORE any write when the claim is absent, which is what lets
        /// `revoke_role_many` treat a missing target as a skip.
        fn do_revoke_role(account: &T::AccountId, role: RoleKind) -> DispatchResult {
            let credential = RoleClaimOf::<T>::take(account, role).ok_or(Error::<T>::NotClaimed)?;
            RoleCredIndex::<T>::remove(role, credential);
            TombstonedRoleCred::<T>::insert(role, credential, ());
            Self::drop_observed_badges(account);
            log::debug!(target: LOG_TARGET, "revoke_role: {account:?} {role:?} revoked + credential tombstoned");
            Self::deposit_event(Event::RoleRevoked {
                who: account.clone(),
                role,
            });
            Ok(())
        }

        /// Drop `who`'s ENTIRE observed badge set plus the observer's diff basis for it, and invalidate
        /// any `close_poll` mid-tally on the chamber axis. The next observation that covers `who`
        /// re-credits, from scratch, whatever is still legitimately claimed or owned.
        ///
        /// **Whole-account, not per-role, and that is deliberate.** [`ObservedRoles`] stores each badge's
        /// DISPLAY id (a pool id for BOTH SPO sources) and not the credential it was scanned through, so
        /// there is no key to filter one claim's badges out by — and `derive_call` dedups by `(kind, id)`,
        /// so a pool reached via ownership AND a Calidus key is ONE row backed by two independent
        /// credentials. Filtering by `RoleKind` would therefore strip an mSPO's legitimate owner-path
        /// badges, which is the wrongness this used to avoid by doing nothing at all. Clearing everything
        /// is the honest version of the same conservatism: it UNDER-credits for the length of one scan
        /// window and never over-credits, which is the right direction for a moderation ban and merely
        /// self-inflicted for a voluntary release.
        ///
        /// Exposure is `ObserverConfig::scan_sweep_blocks` — ONE BLOCK while the bound population fits a
        /// single window, which is every chain up to `MaxScanned` accounts. Removing that ceiling too
        /// needs provenance on each badge (which credential justified which `(kind, id)`), a storage
        /// shape change with a migration and a `transaction_version` move; the trigger for spending it is
        /// `scan_sweep_blocks` leaving 1.
        fn drop_observed_badges(who: &T::AccountId) {
            // `contains_key`, NOT `get` or a route through `apply_roles(who, &[])`. [`ObservedRoles`] is
            // `ValueQuery`, so a row that fails to DECODE reads back as the empty default — and
            // `apply_roles` short-circuits on `roles == previous`, which would then leave the undecodable
            // row standing while reporting success. Key existence is decode-independent and `remove` does
            // not care what the value was.
            if ObservedRoles::<T>::contains_key(who) {
                ObservedRoles::<T>::remove(who);
                // Every writer of the chamber inputs must move this, not only the observer: a paged
                // `close_poll` compares it per resumed page and reports `PollTallySmeared`. Gated with
                // the removal so a teardown on an account that held no badge is not a spurious
                // invalidation of every in-flight tally.
                ObservedRolesSeq::<T>::mutate(|s| *s = s.saturating_add(1));
                Self::deposit_event(Event::RolesUpdated {
                    who: who.clone(),
                    roles: Default::default(),
                });
            }
            // UNCONDITIONAL, outside the guard above: see [`OnObservedRolesCleared::forget_role_basis`].
            // A basis row can outlive the badge row, and that pairing is exactly the one that would
            // otherwise never re-derive.
            T::OnRoleTeardown::forget_role_basis(who);
        }

        /// Tear down EVERY role `who` holds — both claim maps and the observer-written badge set.
        ///
        /// Called from the identity lifecycle when a binding is revoked (the runtime wires this behind
        /// `pallet_cogno_gate`'s `OnBind` seam, which is why it lives here rather than being reached
        /// across a Cargo edge). Without it a committee ban left the account's `RoleClaimOf` /
        /// `RoleCredIndex` / `ObservedRoles` rows completely untouched: `MicroblogApi::profile` returned
        /// `is_allowed: false` alongside a live verified SPO/dRep badge, every post the banned account
        /// ever wrote kept rendering that badge, and its credential stayed locked 1:1 so the real holder
        /// could not claim it either.
        ///
        /// NOT a tombstone, deliberately. `revoke_role` is the committee's ban-the-key verb and stays
        /// the way to make a credential permanently unclaimable; an identity ban is about the ACCOUNT,
        /// and permanently burning a legitimate pool's Calidus key as a side effect would be a
        /// punishment the committee never voted for. Freeing the credential is safe because `do_claim`
        /// requires `IdentityGate::is_allowed` — a revoked account cannot re-claim what it just lost,
        /// and only a properly bound account can pick the credential up.
        ///
        /// Bounded by construction: `RoleClaimOf` is keyed `(account, RoleKind)` and `RoleKind` has
        /// three variants, so this is at most 3 claim rows + 3 index rows + 1 badge row regardless of
        /// state. Returns the number of claims cleared so the caller can price it.
        pub fn purge_account_roles(who: &T::AccountId) -> u32 {
            let mut cleared = 0u32;
            for role in [RoleKind::Spo, RoleKind::DRep, RoleKind::Committee] {
                if let Some(credential) = RoleClaimOf::<T>::take(who, role) {
                    RoleCredIndex::<T>::remove(role, credential);
                    cleared = cleared.saturating_add(1);
                }
            }
            // The observer-written badge set is what the profile/chamber reads actually render, and it
            // is NOT derived from the claim maps at read time — the observer only rewrites it when its
            // next observation differs. Clearing the claims alone would leave the badge on screen until
            // (and unless) an observation happened to move.
            //
            // This is an ORDINARY extrinsic path (the committee's cogno-gate `revoke` / `revoke_many`
            // reach it), not the inherent, so it is the second writer the chamber sequence has to cover —
            // a revoke mid-tally changes the chamber inputs exactly as an observation does.
            //
            // Shares [`Self::drop_observed_badges`] with the role-level verbs so the three can never
            // diverge. Reaching here through cogno-gate's `revoke`, the observer's own
            // `ObservedTeardown::forget_account` has ALREADY run — so the badge row is gone, the
            // `contains_key` guard makes this a no-op on the sequence, and the basis removal is
            // idempotent. Harmlessly redundant, and correct if that ordering ever changes.
            Self::drop_observed_badges(who);
            if cleared > 0 {
                log::debug!(
                    target: LOG_TARGET,
                    "purge_account_roles: cleared {cleared} role claim(s) + the observed badge set for {who:?}",
                );
            }
            cleared
        }

        /// The 28-byte credential `who` has claimed for `role`, if any (read-only helper).
        pub fn claim_of(who: &T::AccountId, role: RoleKind) -> Option<RoleCredential> {
            RoleClaimOf::<T>::get(who, role)
        }

        /// `who`'s currently-live observed role set (read-only helper for the badge / node-served
        /// ProfileView). Empty if the account holds no live role.
        pub fn observed_roles(who: &T::AccountId) -> Vec<ObservedRole> {
            ObservedRoles::<T>::get(who).into_inner()
        }

        /// Fit the observer's `(kind_index, id, weight)` slice into an [`ObservedRoleSet`], reserving the
        /// non-SPO badges — the whole of what the runtime's `RoleSink` adapter does before writing.
        ///
        /// Lives HERE, next to [`MAX_OBSERVED_ROLES_PER_ACCOUNT`], for two reasons. The reserve only
        /// makes sense as a defence of that cap, so the two drifting apart would be silent; and the
        /// truncation now has a `LOG_TARGET` to announce itself on. Before spec 217 it happened in the
        /// runtime adapter with no log, no event field and no counter, and `RolesUpdated` carried only
        /// the survivors as though the set were complete — so an mSPO's chamber weight could be under-
        /// reported for ever with nothing anywhere saying so.
        ///
        /// TWO PASSES, truncating not clearing: NON-SPO roles (dRep, CC) first, then the SPO entries.
        /// The observer's canonical `role_entries` order sorts on `RoleSource` first, which puts EVERY
        /// SPO entry ahead of every dRep/CC one — so a single pass truncating at the cap silently dropped
        /// a large mSPO's dRep badge AND its dRep-chamber weight once its pool count neared the cap
        /// (spec 211's fix). Both passes are deterministic and preserve the slice order within each
        /// class, so every node stores the identical set.
        ///
        /// The first pass is itself capped, at `NON_SPO_RESERVE`. "At most one dRep and one CC" is what
        /// the reduction emits today, but nothing in this signature enforces it — and if a future
        /// reduction ever emitted a handful of dRep/CC credentials for one account, an uncapped first
        /// pass would fill every slot and drop EVERY SPO badge: the exact inverse of the bug the two
        /// passes fix, and just as silent. Reserving a small fixed prefix bounds the trade both ways.
        ///
        /// (The pre-211 `try_from(set).unwrap_or_default()` was all-or-nothing — one badge over the cap
        /// wiped the ENTIRE set to empty. `weight` is the governance-poll chamber weight, carried
        /// through verbatim.)
        pub fn bound_observed_roles(roles: &[(u8, RoleCredential, u128)]) -> ObservedRoleSet {
            const NON_SPO_RESERVE: usize = 4;

            let mut bounded = ObservedRoleSet::default();
            let mut truncated = false;
            let mut reserve_dropped = 0u32;
            'fill: for pass_spo in [false, true] {
                for (kind_ix, id, weight) in roles {
                    let kind = match kind_ix {
                        0 if pass_spo => RoleKind::Spo,
                        1 if !pass_spo => RoleKind::DRep,
                        2 if !pass_spo => RoleKind::Committee,
                        _ => continue,
                    };
                    if !pass_spo && bounded.len() >= NON_SPO_RESERVE {
                        // The non-SPO prefix is full — leave the rest of the set for pools. COUNTED, not
                        // just skipped: this is a drop, and it happens well below the `BoundedVec` bound,
                        // so `try_push` never fails and the truncation warning below would never fire for
                        // it. That is the same silence the two passes exist to remove, on the other side.
                        reserve_dropped = reserve_dropped.saturating_add(1);
                        continue;
                    }
                    if bounded
                        .try_push(ObservedRole {
                            kind,
                            id: *id,
                            weight: *weight,
                        })
                        .is_err()
                    {
                        // At the cap — keep what fits (deterministically), drop the rest. Break out of
                        // BOTH loops: a plain `break` would only end this pass and then re-walk the whole
                        // slice in the next one, every `try_push` failing, inside a Mandatory inherent.
                        truncated = true;
                        break 'fill;
                    }
                }
            }
            if truncated {
                // Not an event: this rides a Mandatory inherent that must stay cheap and
                // encoding-neutral, and it is an operator signal rather than an on-chain fact. It is a
                // WARN because the consequence is not cosmetic — the dropped pools are missing from this
                // account's governance-poll chamber weight AND from the distinct-role count, and any
                // poll closed while it is truncated freezes that under-count permanently.
                log::warn!(
                    target: LOG_TARGET,
                    "observed roles TRUNCATED for one account: {} of {} entries kept (cap {}). The \
                     dropped pools are absent from its chamber weight and participation count; a poll \
                     closed now freezes that under-count. Raise MAX_OBSERVED_ROLES_PER_ACCOUNT.",
                    bounded.len(),
                    roles.len(),
                    MAX_OBSERVED_ROLES_PER_ACCOUNT,
                );
            }
            if reserve_dropped > 0 {
                // The other direction, and it needs its OWN message: raising
                // `MAX_OBSERVED_ROLES_PER_ACCOUNT` does nothing for it. The reserve is what bounds the
                // trade between the two classes, and only the reserve can widen it. Unreachable while the
                // reduction emits at most one dRep and one CC per account — which is exactly why it has
                // to say something if it ever does happen.
                log::warn!(
                    target: LOG_TARGET,
                    "{reserve_dropped} non-SPO role(s) dropped for one account: the dRep/CC reserve \
                     ({NON_SPO_RESERVE}) is full. Those badges are absent from its chamber weight and \
                     participation count. Raise NON_SPO_RESERVE, not MAX_OBSERVED_ROLES_PER_ACCOUNT.",
                );
            }
            bounded
        }

        /// The claimed credentials for `role` inside a scan window: the claim of every account in it
        /// that holds one. Canonically sorted and deduped, so the scoping set is a pure function of
        /// WHICH accounts are in the window and never of the order they came out of it.
        ///
        /// ⚠ THIS REPLACED A HASH-ORDERED PREFIX in spec 220, and the replacement is what removes the
        /// last population ceiling on this axis. The old shape walked `RoleCredIndex` by hashed key and
        /// stopped at `MaxScanned`, so a claim past the cap was never scanned and its account therefore
        /// held no badge at all — silently, with `blake2_128` deciding who, and `claim_role_signed`
        /// bare-unsigned and feeless so a flood could target a specific operator by grinding hashes.
        /// Spec 217 pinned the already-observed claims against eviction and left the starvation half
        /// open; a rotating window closes it, because coverage becomes complete within
        /// `ceil(rotation / MaxScanned)` blocks rather than never.
        ///
        /// The db-sync bound that motivated the cap is unchanged: this feeds a `= ANY(…)` array into a
        /// query under a 2 s timeout on every node every block, and the window size is what bounds it.
        ///
        /// The eviction pin is gone with the prefix. Nothing can be evicted from a window — an
        /// out-of-window account's badge set is HELD by `derive_call` rather than cleared — so there is
        /// no longer anything for a pin to protect.
        pub fn claimed_credentials_of(
            role: RoleKind,
            accounts: &[T::AccountId],
        ) -> Vec<RoleCredential> {
            accounts
                .iter()
                .filter_map(|who| RoleClaimOf::<T>::get(who, role))
                .collect::<alloc::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        }

        /// Verify a CIP-8 role-key proof and resolve `(bound account, role, credential)`. The shared
        /// crown-jewel call path for claiming — the audited [`pallet_cogno_gate::cip8::verify_bind_proof_role`]
        /// (ed25519 + address-key bind), the anti-cross-chain genesis check, and the account decode — run
        /// from BOTH the dispatch body (authoritative) and [`Pallet::validate_unsigned`] (pool), so the two
        /// can never diverge. Does NOT do the tombstone / 1:1 checks (those live in `do_claim`, mirrored in
        /// `validate_unsigned`).
        pub(crate) fn verify_role_proof(
            cose_sign1: &[u8],
            cose_key: &[u8],
        ) -> Result<VerifiedRoleClaim<T>, Error<T>> {
            let proof = pallet_cogno_gate::cip8::verify_bind_proof_role(
                cose_sign1,
                cose_key,
                T::CardanoNetwork::get(),
            )
            .map_err(|e| {
                log::warn!(target: LOG_TARGET, "verify_role_proof: proof rejected: {e:?}");
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
            Ok((
                account,
                RoleKind::from_class(proof.role),
                proof.credential,
                proof.nonce,
            ))
        }

        /// The shared 1:1 claim body: the payment-bound precondition, the ban tombstone, both directional
        /// claim maps, and the `RoleClaimed` event. NOT a dispatchable — no origin check; the caller
        /// authorizes via the cryptographically-verified role proof.
        pub(crate) fn do_claim(
            account: &T::AccountId,
            role: RoleKind,
            credential: RoleCredential,
            nonce: [u8; 16],
        ) -> DispatchResult {
            // A role attaches only to an onboarded identity: the account must already be payment-bound.
            ensure!(
                T::IdentityGate::is_allowed(account),
                Error::<T>::NotPaymentBound
            );
            // A permanently-banned (revoked) credential can never be re-claimed (the tombstone).
            ensure!(
                !TombstonedRoleCred::<T>::contains_key(role, credential),
                Error::<T>::RoleCredTombstoned
            );
            // 1:1 enforcement — reject a second claim on EITHER side (per role).
            if RoleClaimOf::<T>::contains_key(account, role) {
                log::warn!(target: LOG_TARGET, "do_claim rejected: account already claimed {role:?}");
                return Err(Error::<T>::AccountAlreadyClaimedRole.into());
            }
            if RoleCredIndex::<T>::contains_key(role, credential) {
                log::warn!(target: LOG_TARGET, "do_claim rejected: {role:?} credential already claimed");
                return Err(Error::<T>::RoleCredAlreadyClaimed.into());
            }
            // Single-use: a role proof never expires, and `unclaim_role` restores every other condition
            // checked above — so without this the same bytes could be re-submitted by anyone to undo an
            // unclaim. See [`SpentRoleNonce`] for the residual this does and does not cover.
            if SpentRoleNonce::<T>::get(account, role) == Some(nonce) {
                log::warn!(target: LOG_TARGET, "do_claim rejected: {role:?} proof replayed (nonce already spent)");
                return Err(Error::<T>::RoleProofReplayed.into());
            }
            SpentRoleNonce::<T>::insert(account, role, nonce);
            RoleClaimOf::<T>::insert(account, role, credential);
            RoleCredIndex::<T>::insert(role, credential, account);
            log::debug!(target: LOG_TARGET, "do_claim ok: {role:?} credential claimed 1:1");
            Self::deposit_event(Event::RoleClaimed {
                who: account.clone(),
                role,
                credential,
            });
            Ok(())
        }

        /// Write `who`'s full observed-role set (idempotent overwrite; empty = fully clamped/removed).
        /// Emits `RolesUpdated` only on a real change (no per-block event spam on an unchanged re-derive).
        ///
        /// ⚠ **Do NOT call this directly.** It is `pub` only because the writer lives in another crate.
        /// The single legal caller is the runtime's `RoleSink` adapter, driven by the consensus-verified
        /// cardano-observer inherent (the sole writer of the observed ledger — the same invariant
        /// talk-stake holds for weight). The observer passes the account's FULLY-recomputed live set, so
        /// a partial loss (SPO kept, dRep dropped) is handled by always overwriting the complete set.
        pub fn apply_roles(who: &T::AccountId, roles: ObservedRoleSet) {
            let previous = ObservedRoles::<T>::get(who);
            if roles == previous {
                return; // idempotent re-derive — no write, no event
            }
            if roles.is_empty() {
                ObservedRoles::<T>::remove(who);
                log::debug!(target: LOG_TARGET, "apply_roles: {who:?} CLEARED (all roles clamped)");
            } else {
                ObservedRoles::<T>::insert(who, &roles);
                log::debug!(target: LOG_TARGET, "apply_roles: {who:?} set {} live role(s)", roles.len());
            }
            // Past the unchanged-re-derive short-circuit above, so this is always a real change: invalidate
            // any paged `close_poll` mid-tally on the chamber axis.
            ObservedRolesSeq::<T>::mutate(|s| *s = s.saturating_add(1));
            Self::deposit_event(Event::RolesUpdated {
                who: who.clone(),
                roles,
            });
        }
    }

    /// Pool-admission gate for the unsigned, feeless [`Call::claim_role_signed`] — the ONLY spam
    /// control for it (no fee/nonce). Mirrors cogno-gate's bind gate: verify the crown-jewel proof
    /// (rejecting a malformed / cross-chain proof BEFORE gossip), then cheap storage reads reject a
    /// non-participant / already-claimed / tombstoned claim as Stale. `and_provides((role, credential))`
    /// dedupes repeats; a short longevity ages stragglers out. A claim grants nothing actionable until
    /// the observer confirms the credential is a live Cardano role, so a flood of valid claims gains no
    /// amplification — only the per-block-weight-bounded verify cost.
    #[allow(deprecated)]
    #[pallet::validate_unsigned]
    impl<T: Config> ValidateUnsigned for Pallet<T> {
        type Call = Call<T>;

        fn validate_unsigned(_source: TransactionSource, call: &Self::Call) -> TransactionValidity {
            /// Priority + longevity for the unsigned claim (mirrors cogno-gate's bind gate).
            const CLAIM_TX_PRIORITY: u64 = 100;
            const CLAIM_TX_LONGEVITY: u64 = 32;
            match call {
                Call::claim_role_signed {
                    cose_sign1,
                    cose_key,
                } => {
                    // Verify the proof (audited crown jewel) + genesis + decode the committed account.
                    let (account, role, credential, nonce) =
                        Self::verify_role_proof(cose_sign1, cose_key)
                            .map_err(|_| InvalidTransaction::BadProof)?;
                    // A role attaches only to an onboarded identity — reject a non-participant at the pool
                    // (Custom 1; the FE submits a role claim only after onboarding, so this holds).
                    if !T::IdentityGate::is_allowed(&account) {
                        return Err(InvalidTransaction::Custom(1).into());
                    }
                    // Mirror `do_claim`'s rejections at the pool: a tombstoned credential, or either side
                    // of the per-role 1:1 already claimed, is Stale (already settled — drop, do not retry).
                    if TombstonedRoleCred::<T>::contains_key(role, credential)
                        || RoleClaimOf::<T>::contains_key(&account, role)
                        || RoleCredIndex::<T>::contains_key(role, credential)
                        // A replayed proof is settled, not retryable — drop it at the pool so the
                        // gossip never carries it and no block wastes a full verify on it.
                        || SpentRoleNonce::<T>::get(&account, role) == Some(nonce)
                    {
                        log::debug!(target: LOG_TARGET, "validate_unsigned: role claim rejected at pool (tombstoned/already-claimed) role={role:?}");
                        return Err(InvalidTransaction::Stale.into());
                    }
                    ValidTransaction::with_tag_prefix("CardanoRolesClaim")
                        .priority(CLAIM_TX_PRIORITY)
                        .and_provides((role, credential))
                        .longevity(CLAIM_TX_LONGEVITY)
                        .propagate(true)
                        .build()
                }
                // Every other call (unclaim / revoke) is origin-gated and must NOT be accepted unsigned.
                _ => Err(InvalidTransaction::Call.into()),
            }
        }
    }
}
