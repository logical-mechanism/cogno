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
//! each is a currently-live pool / dRep / seated CC member, resolves the display id (the **poolID**
//! for SPO; the drepID / hot credential for dRep / CC), and writes the account's full observed set —
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

pub mod weights;
pub use weights::*;

/// Log target for this pallet's operational diagnostics (off-chain node logs only — the on-chain
/// audit trail is the `RoleClaimed`/`RoleRevoked`/`RolesUpdated` events, NOT these logs).
pub const LOG_TARGET: &str = "runtime::cardano-roles";

/// A 28-byte Cardano credential (a blake2b-224 key hash): the claimed role-key hash on the claim side
/// (Calidus-key hash / drep ID / committee hot credential), and the observer-resolved display id on
/// the observed side (the 28-byte poolID for SPO; the same drep ID / hot credential for dRep / CC).
pub type RoleCredential = [u8; 28];

/// The maximum number of observed role BADGES one account can display at once. An account holds at most
/// one dRep and one CC badge, but can hold SEVERAL SPO badges — one per pool it operates via a Calidus
/// key and/or owns — so this is deliberately well above the three [`RoleKind`]s. The observer truncates
/// to this cap (the runtime `RoleApply` sink keeps the first N in the deterministic observed order); the
/// set is display-only, so a cap is a UI bound, not an economic one.
pub const MAX_OBSERVED_ROLES_PER_ACCOUNT: u32 = 16;

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

    /// One entry in an account's observed-role set: a currently-live role + its display id (the
    /// observer-resolved 28-byte poolID for SPO; the drep ID / hot credential for dRep / CC).
    #[derive(
        Clone,
        PartialEq,
        Eq,
        Encode,
        Decode,
        DecodeWithMemTracking,
        MaxEncodedLen,
        TypeInfo,
        Debug,
    )]
    pub struct ObservedRole {
        pub kind: RoleKind,
        pub id: RoleCredential,
    }

    /// An account's full observed-role set (≤ one dRep and one CC, but possibly several SPO). The profile
    /// badge reads it.
    pub type ObservedRoleSet = BoundedVec<ObservedRole, ConstU32<MAX_OBSERVED_ROLES_PER_ACCOUNT>>;

    #[pallet::pallet]
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

    /// The call-less OBSERVED-role ledger: `account → its currently-live role set`. Written ONLY by
    /// the cardano-observer inherent (via the runtime `RoleSink` → [`Pallet::apply_roles`]).
    /// `ValueQuery` ⇒ an account with no live role reads the empty set for free. THE map the profile
    /// badge reads.
    #[pallet::storage]
    pub type ObservedRoles<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, ObservedRoleSet, ValueQuery>;

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
    }

    #[pallet::error]
    pub enum Error<T> {
        /// The submitted CIP-8 role self-proof failed verification (signature / address-key bind /
        /// format / bad role payload). The node log carries the specific `Cip8Error` variant.
        ProofInvalid,
        /// The proof commits a different chain's genesis hash (anti-cross-chain replay).
        WrongGenesis,
        /// The account must be payment-bound (an onboarded identity) before it can claim a role.
        NotPaymentBound,
        /// This account has already claimed this role (1:1, account side).
        AccountAlreadyClaimedRole,
        /// This role credential is already claimed by an account (1:1, credential side).
        RoleCredAlreadyClaimed,
        /// This role credential was permanently banned (revoked) and cannot be re-claimed (the tombstone).
        RoleCredTombstoned,
        /// No claim exists for this `(account, role)` (unclaim / revoke target not found).
        NotClaimed,
    }

    /// Genesis seed for the OBSERVED ledger on chains with no Cardano to observe (`--dev` / `local`),
    /// so a badge renders with no db-sync. EMPTY on preprod/mainnet (the observer credits real roles
    /// from block 0). Genesis is NOT an extrinsic, so this preserves "the observer is the only setter".
    /// The role is given as its `#[codec(index)]` value (0 = SPO, 1 = dRep, 2 = CC) so the genesis
    /// config stays serde-serializable without deriving serde on the on-wire types.
    #[pallet::genesis_config]
    #[derive(frame_support::DefaultNoBound)]
    pub struct GenesisConfig<T: Config> {
        #[allow(clippy::type_complexity)]
        pub initial_observed_roles: Vec<(T::AccountId, Vec<(u8, RoleCredential)>)>,
    }

    #[pallet::genesis_build]
    impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
        fn build(&self) {
            for (who, roles) in &self.initial_observed_roles {
                let set: Vec<ObservedRole> = roles
                    .iter()
                    .map(|(ix, id)| ObservedRole {
                        kind: RoleKind::from_index(*ix)
                            .expect("genesis role index must be 0 (SPO), 1 (dRep) or 2 (CC)"),
                        id: *id,
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
            let (account, role, credential) = Self::verify_role_proof(&cose_sign1, &cose_key)?;
            log::debug!(target: LOG_TARGET, "claim_role_signed: verified {role:?} proof for {account:?}");
            Self::do_claim(&account, role, credential)
        }

        /// Self-service release of a role claim. Signed by the claiming account. Removes both claim
        /// maps; the observer drops the account's badge for that role on its next observation (the
        /// credential is no longer in the scoping set). Does NOT tombstone (that is the committee ban).
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
            log::debug!(target: LOG_TARGET, "unclaim_role: {who:?} released {role:?}");
            Self::deposit_event(Event::RoleUnclaimed { who, role });
            Ok(())
        }

        /// Revoke an account's role claim + tombstone the credential (the committee moderation ban).
        /// Gated by `RoleAuthorityOrigin` (3-of-5). Removes both claim maps and permanently tombstones
        /// `(role, credential)` so it cannot be re-claimed by anyone (ban-the-key). The observer drops
        /// the badge on its next observation.
        #[pallet::call_index(2)]
        #[pallet::weight(T::WeightInfo::revoke_role())]
        pub fn revoke_role(
            origin: OriginFor<T>,
            account: T::AccountId,
            role: RoleKind,
        ) -> DispatchResult {
            T::RoleAuthorityOrigin::ensure_origin(origin)?;
            let credential = RoleClaimOf::<T>::take(&account, role).ok_or(Error::<T>::NotClaimed)?;
            RoleCredIndex::<T>::remove(role, credential);
            TombstonedRoleCred::<T>::insert(role, credential, ());
            log::debug!(target: LOG_TARGET, "revoke_role: {account:?} {role:?} revoked + credential tombstoned");
            Self::deposit_event(Event::RoleRevoked {
                who: account,
                role,
            });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
        /// The 28-byte credential `who` has claimed for `role`, if any (read-only helper).
        pub fn claim_of(who: &T::AccountId, role: RoleKind) -> Option<RoleCredential> {
            RoleClaimOf::<T>::get(who, role)
        }

        /// `who`'s currently-live observed role set (read-only helper for the badge / node-served
        /// ProfileView). Empty if the account holds no live role.
        pub fn observed_roles(who: &T::AccountId) -> Vec<ObservedRole> {
            ObservedRoles::<T>::get(who).into_inner()
        }

        /// Every credential currently CLAIMED for `role` — the enumeration the cardano-observer scopes
        /// its db-sync read to (the `bound_role_credentials` runtime API). Bounded by the number of
        /// claims, not by all Cardano pools / dReps.
        pub fn claimed_credentials(role: RoleKind) -> Vec<RoleCredential> {
            RoleCredIndex::<T>::iter_key_prefix(role).collect()
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
        ) -> Result<(T::AccountId, RoleKind, RoleCredential), Error<T>> {
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
            Ok((account, RoleKind::from_class(proof.role), proof.credential))
        }

        /// The shared 1:1 claim body: the payment-bound precondition, the ban tombstone, both directional
        /// claim maps, and the `RoleClaimed` event. NOT a dispatchable — no origin check; the caller
        /// authorizes via the cryptographically-verified role proof.
        pub(crate) fn do_claim(
            account: &T::AccountId,
            role: RoleKind,
            credential: RoleCredential,
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
                    let (account, role, credential) =
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
