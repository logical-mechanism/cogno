//! # Cogno-gate pallet (cogno-chain)
//!
//! **The anti-Sybil identity anchor (M2): a hard 1:1 binding between a Cardano owner
//! Address and a Substrate posting account.** This is the "Cardano READ link" — the gate that
//! turns an anonymous sr25519 key into a Cardano-anchored identity so that one Cardano owner
//! Address maps to exactly one posting account, and back (DR-01/DR-02/DR-07/DR-14).
//!
//! ## What is bound (DR-01)
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
//! ## Loose coupling (the M2 architectural gotcha)
//! cogno-gate calls **into** `pallet-microblog` ([`pallet_microblog::OnIdentityBind`] →
//! `on_first_bind`) at link, and microblog calls **into** cogno-gate
//! ([`pallet_microblog::IsAllowed`] → `is_allowed`) at post. Implementing that literally would
//! make each pallet Cargo-depend on the other (a cycle). It is broken by two traits that BOTH
//! live in `pallet-microblog` (the depended-upon crate): cogno-gate *implements* `IsAllowed`
//! and *consumes* `OnIdentityBind` (wired to `Microblog` in the runtime). Neither pallet names
//! the other's crate in a trait bound.
//!
//! ## Trust posture (D1 — named honestly)
//! The bind is permissionless + cryptographic: [`Call::link_identity_signed`] removes the operator
//! from the identity-correctness path entirely (every full node re-verifies the proof). `FollowerOrigin`
//! (a single trusted key + `EnsureRoot` sudo escape hatch in v1 dev, an `EnsureOrigin` that widens to a
//! 3-of-5 committee signature-free) now gates ONLY [`Call::revoke`] — the manual-operator-ban moderation
//! lever (DR-14), which tombstones an identity permanently. ⚠ The verifier itself is the anti-Sybil crown
//! jewel — a bug forges any identity; it is hardened by an adversarial threat-model + tests but is NOT
//! externally audited (MAINNET PREREQUISITE, see [`cip8`]).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

/// The on-chain CIP-8 (COSE_Sign1) identity self-proof verifier (D1 — trustless identity).
pub mod cip8;

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

/// The on-chain identity key: the 32-byte `blake2b_256` of the serialized owner Cardano
/// Address (== the L1 beacon `token_name`, DR-01). A fixed `[u8; 32]` (not a `BoundedVec`):
/// it is exactly a hash, so the codec enforces the length for free and the `AccountOf` key is
/// the raw 32 bytes with no length prefix — the client's `AccountOf` readback keys on the
/// identical bytes.
pub type IdentityHash = [u8; 32];

/// The voting-power identity key: the 28-byte stake credential (a reward address's key hash) proven
/// via [`cip8::verify_bind_proof_stake`]. Distinct from [`IdentityHash`] (the 32-byte full-Address
/// beacon that anchors POSTING/deposit): this anchors VOTING POWER — the account's total Cardano
/// stake — 1:1 to the proven STAKE key, so many payment keys cannot multiply one staker's vote weight.
pub type StakeCredential = [u8; 28];

#[frame_support::pallet]
pub mod pallet {
    use super::*;
    use alloc::vec::Vec;
    use frame_support::{pallet_prelude::*, sp_runtime::traits::Zero};
    use frame_system::{ensure_none, pallet_prelude::*};
    // The two cross-pallet traits live in microblog (the depended-upon crate) to avoid a
    // dependency cycle — see the module docs. cogno-gate implements `IsAllowed` and consumes
    // `OnIdentityBind`.
    use pallet_microblog::{IsAllowed, OnIdentityBind};

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// The authority allowed to [`Call::revoke`] (the manual-operator-ban moderation lever, DR-14):
        /// a single trusted key **plus `EnsureRoot`/sudo escape hatch** in v1 dev (DR-07). An
        /// `EnsureOrigin` (never `ensure_signed`) — the public pool must not be able to ban identities —
        /// so the widen to a 3-of-5 k-of-t committee is signature-free. NOTE: binding is no longer gated
        /// by this; it is the permissionless cryptographic [`Call::link_identity_signed`] (D1).
        type FollowerOrigin: EnsureOrigin<Self::RuntimeOrigin>;
        /// Bind/revoke lifecycle hook into `pallet-microblog`: `on_bind` primes the capacity row + a
        /// provider reference so a freshly-bound feeless poster's first post is not rejected by
        /// `CheckNonce` (issue #3991), and `on_revoke` releases that ref. Wired to `Microblog` in the
        /// runtime. Defined in microblog (not here) to avoid a Cargo dependency cycle. `on_bind` owns
        /// the single `inc_providers` call (balanced by one `dec_providers` in `on_revoke`) — do not
        /// increment providers again here.
        type OnBind: OnIdentityBind<Self::AccountId>;
        /// The Cardano network the trustless self-proof ([`Call::link_identity_signed`]) binds for — the
        /// low nibble of the address header byte (0 = testnet, 1 = mainnet). The beacon-name identity
        /// carries NO network byte, so this pins which network's addresses may bind (else a mainnet and a
        /// testnet address with the same credentials would collide on the identical identity). See [`cip8`].
        #[pallet::constant]
        type CardanoNetwork: Get<u8>;
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
    /// client's bind readback queries this by the 32-byte key (DR-01). Load-bearing for the 1:1
    /// invariant: a second account cannot claim an already-bound identity.
    #[pallet::storage]
    pub type AccountOf<T: Config> =
        StorageMap<_, Blake2_128Concat, IdentityHash, T::AccountId, OptionQuery>;

    /// Optional cogno_v3 thread pointer (5 raw bytes / 10 hex chars — `ConstU32<10>`, **never**
    /// `<4>`, DR-23) bound to a posting account, for joining the live cogno_v3 forum. Kept in the
    /// on-wire interface even though the v1 UX may defer the thread join — a settled field is not
    /// silently dropped.
    #[pallet::storage]
    pub type ThreadOf<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BoundedVec<u8, ConstU32<10>>, OptionQuery>;

    /// Permanently-banned identities — the manual-operator-ban tombstone (DR-14). [`Call::revoke`]
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

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A Cardano identity was bound 1:1 to a posting account (the D0 per-bind audit record,
        /// DR-07). `identity` is `blake2b_256(serialized owner Address)`.
        IdentityLinked {
            who: T::AccountId,
            identity: IdentityHash,
        },
        /// A binding was revoked (the v1 manual-operator-ban path, DR-14). The provider ref is
        /// released and the banked capacity zeroed; the capacity row itself is kept (relock-farm
        /// guard) — see [`pallet_microblog::OnIdentityBind::on_revoke`] (gate-1).
        Revoked {
            who: T::AccountId,
            identity: IdentityHash,
        },
        /// A stake credential was bound 1:1 to a posting account as its voting-power anchor (the
        /// stake-key self-proof, [`Call::link_stake_signed`]). `stake_cred` is the 28-byte
        /// reward-address key hash; the account's vote weight is then the total Cardano stake of it.
        StakeLinked {
            who: T::AccountId,
            stake_cred: StakeCredential,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        /// This posting account is already bound to an identity (1:1, account side).
        AccountAlreadyBound,
        /// This Cardano identity is already bound to an account (1:1, identity side). Named
        /// `PkhAlreadyBound` for cross-doc continuity; the key is the 32-byte Address hash.
        PkhAlreadyBound,
        /// The supplied thread pointer exceeded 10 bytes (5 raw bytes / 10 hex chars, DR-23).
        BadThread,
        /// No binding exists for this account (revoke target not found).
        NotBound,
        /// The submitted CIP-8 self-proof failed verification (signature / address-key bind / format /
        /// unsupported address). The node log carries the specific [`cip8::Cip8Error`] variant.
        ProofInvalid,
        /// The proof commits a different chain's genesis hash (anti-cross-chain replay).
        WrongGenesis,
        /// This Cardano identity was permanently banned (revoked) and cannot be re-bound (the tombstone).
        IdentityTombstoned,
        /// The account must be payment-bound ([`Call::link_identity_signed`]) before it can stake-bind —
        /// voting power attaches only to an existing posting identity.
        NotPaymentBound,
        /// This account already has a bound stake credential (1:1, account side).
        AccountAlreadyStakeBound,
        /// This stake credential is already bound to an account (1:1, stake side).
        StakeCredAlreadyBound,
        /// This stake credential was permanently banned (revoked) and cannot be re-bound (ban-the-key).
        StakeCredTombstoned,
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
        /// `ed25519` verify it forces. See the PR's DoS analysis.
        ///
        /// ⚠ The verifier is the anti-Sybil crown jewel — a bug forges any identity. It is hardened by an
        /// adversarial threat-model + tests but has NOT had a formal external audit:
        /// **MAINNET PREREQUISITE — independent verifier audit** before real value.
        #[pallet::call_index(2)]
        #[pallet::weight(T::WeightInfo::link_identity_signed())]
        pub fn link_identity_signed(
            origin: OriginFor<T>,
            cose_sign1: BoundedVec<u8, ConstU32<512>>,
            cose_key: BoundedVec<u8, ConstU32<128>>,
            thread_pointer: Option<Vec<u8>>,
        ) -> DispatchResult {
            // Unsigned: the CIP-8 proof is the authorization (no fee, no nonce). Pool admission
            // (`validate_unsigned`) already verified the proof + cheap-rejected junk before this runs;
            // re-verify here authoritatively to derive the bound account + identity for the write.
            ensure_none(origin)?;
            let (account, identity) = Self::verify_identity_proof(&cose_sign1, &cose_key)?;
            log::debug!(target: LOG_TARGET, "link_identity_signed: verified proof for identity={identity:?}");
            Self::do_bind(&account, identity, thread_pointer)
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
            let (account, stake_credential) = Self::verify_stake_proof(&cose_sign1, &cose_key)?;
            log::debug!(target: LOG_TARGET, "link_stake_signed: verified stake proof for {account:?}");
            Self::do_bind_stake(&account, stake_credential)
        }

        /// Revoke an account's binding (the v1 manual-operator-ban path, DR-14). Gated by
        /// `FollowerOrigin`. Removes both directional maps + the thread pointer, so `is_allowed`
        /// flips to `false` and the account can no longer post.
        ///
        /// Calls [`OnIdentityBind::on_revoke`] so the bind/revoke lifecycle is symmetric (`gate-1`):
        /// the provider reference taken at `link_identity` is released and the banked capacity is
        /// zeroed, while the `Capacity` row itself is KEPT (microblog's never-delete relock-farm
        /// invariant — a relock must not read a fresh first-touch bucket).
        #[pallet::call_index(1)]
        #[pallet::weight(T::WeightInfo::revoke())]
        pub fn revoke(origin: OriginFor<T>, substrate_account: T::AccountId) -> DispatchResult {
            T::FollowerOrigin::ensure_origin(origin)?;
            // A revoke of a never-bound account is REJECTED with NotBound (no state change, no event) —
            // it is NOT a silent success. Log it at debug so a relayer/operator can tell a stale/retried
            // revoke from a real one without scraping for the (deliberately absent) event.
            let identity = match PkhOf::<T>::take(&substrate_account) {
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
            ThreadOf::<T>::remove(&substrate_account);
            // Tombstone the identity PERMANENTLY: the permissionless `link_identity_signed` path consults
            // `Tombstoned` and refuses to re-bind it, so a ban cannot be undone by replaying an
            // (eternally-valid) CIP-8 proof. A tombstone is never removed (your "ban means ban" decision).
            Tombstoned::<T>::insert(identity, ());
            // Ban-the-key: if the account had a stake (voting-power) bind, tear it down AND tombstone the
            // stake credential permanently, so a banned operator cannot grind a fresh payment identity to
            // re-bind the SAME on-chain stake and keep voting.
            if let Some(stake_cred) = StakeCredOf::<T>::take(&substrate_account) {
                AccountOfStakeCred::<T>::remove(stake_cred);
                TombstonedStakeCred::<T>::insert(stake_cred, ());
                log::debug!(target: LOG_TARGET, "revoke: stake credential unbound + tombstoned (ban-the-key)");
            }
            // Symmetric teardown (gate-1): release the provider ref taken at bind + zero the banked
            // capacity, while microblog KEEPS the (relock-safe) capacity row. NOTE: `on_revoke` is
            // infallible today; if it is ever made fallible, an Err here would leak the bind/revoke
            // provider-ref symmetry (the count stays incremented) — it MUST be error-checked then.
            T::OnBind::on_revoke(&substrate_account);
            log::debug!(
                target: LOG_TARGET,
                "revoke ok: identity={:?} unbound, provider ref released + banked capacity zeroed via on_revoke",
                identity,
            );
            Self::deposit_event(Event::Revoked {
                who: substrate_account,
                identity,
            });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
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
        ) -> Result<(T::AccountId, StakeCredential), Error<T>> {
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
            Ok((account, proof.stake_credential))
        }

        /// The shared 1:1 bind body, called by BOTH the trusted [`Call::link_identity`] and the trustless
        /// [`Call::link_identity_signed`]: the tombstone + double-bind checks, the thread-pointer
        /// validation, the two directional maps, the microblog `on_bind` (provider ref + capacity row),
        /// and the `IdentityLinked` event. NOT a dispatchable — it performs no origin check; each caller
        /// authorizes per its own rule (FollowerOrigin vs a verified cryptographic proof).
        pub(crate) fn do_bind(
            account: &T::AccountId,
            identity: IdentityHash,
            thread_pointer: Option<Vec<u8>>,
        ) -> DispatchResult {
            // A permanently-banned (revoked) identity can never be re-bound (the tombstone, DR-14).
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
            // Validate the optional thread pointer up front (fallible) before any write.
            let thread = match thread_pointer {
                Some(ptr) => {
                    let len = ptr.len();
                    Some(BoundedVec::<u8, ConstU32<10>>::try_from(ptr).map_err(|_| {
						log::warn!(target: LOG_TARGET, "do_bind rejected: thread pointer too long ({len} bytes > 10)");
						Error::<T>::BadThread
					})?)
                }
                None => None,
            };
            PkhOf::<T>::insert(account, identity);
            AccountOf::<T>::insert(identity, account);
            if let Some(t) = thread {
                ThreadOf::<T>::insert(account, t);
            }
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
            // 1:1 enforcement — reject a second bind on EITHER side (the voting anti-Sybil anchor).
            if StakeCredOf::<T>::contains_key(account) {
                log::warn!(target: LOG_TARGET, "do_bind_stake rejected: account already stake-bound");
                return Err(Error::<T>::AccountAlreadyStakeBound.into());
            }
            if AccountOfStakeCred::<T>::contains_key(stake_cred) {
                log::warn!(target: LOG_TARGET, "do_bind_stake rejected: stake credential already bound");
                return Err(Error::<T>::StakeCredAlreadyBound.into());
            }
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

        /// Benchmark-only (DR-05): bind `who` to a dummy identity so `microblog::post_message`
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
                    ..
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
                    let (account, stake_cred) = Self::verify_stake_proof(cose_sign1, cose_key)
                        .map_err(|_| InvalidTransaction::BadProof)?;
                    // Voting power attaches only to a participant: the committed account must already be
                    // payment-bound. The frontend submits the stake bind only after the identity bind is
                    // in a block, so this holds in practice; a stake bind that arrives first is rejected
                    // (Custom 1) and the browser re-submits once the payment bind has landed.
                    if !PkhOf::<T>::contains_key(&account) {
                        return Err(InvalidTransaction::Custom(1).into());
                    }
                    // Mirror `do_bind_stake`'s rejections at the pool: a banned (tombstoned) stake key, or
                    // either side of the 1:1 stake anchor already bound, is Stale.
                    if TombstonedStakeCred::<T>::contains_key(stake_cred)
                        || StakeCredOf::<T>::contains_key(&account)
                        || AccountOfStakeCred::<T>::contains_key(stake_cred)
                    {
                        log::debug!(target: LOG_TARGET, "validate_unsigned: stake bind rejected at pool (tombstoned/already-bound)");
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
