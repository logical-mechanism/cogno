//! The retired on-chain storage SHAPE of the three observation bases, owned by the era it belongs to
//! rather than by the migration that happens to retire it. Same layout, and same reasoning, as
//! `pallets/microblog/src/migrations/legacy.rs`.
//!
//! ⚠ NOT `#[storage_alias]`. That macro takes the on-chain STORAGE ITEM NAME from the ALIAS TYPE NAME, so
//! a `LastObservedV0` alias silently addresses `twox128("CardanoObserver") ++ twox128("LastObservedV0")` —
//! a prefix nothing has ever written. The migration then iterates zero rows, reports success, and leaves
//! every real row orphaned under the prefix where the new shape cannot decode it. That is not
//! hypothetical: it is what the first cut of microblog's `v10` did, it passed its own unit tests (which
//! wrote and read through the same wrong prefix, so they agreed with themselves), and only the
//! `try-runtime` dry-run against real preprod state caught it.
//!
//! So every prefix below is spelled out. `STORAGE_PREFIX` is the REAL item name; the Rust type carries the
//! era in its name so it is obvious at the call site which shape is meant.
//! `legacy_prefixes_match_the_live_items` in the pallet tests pins the two together against the pallet's
//! own items.

/// The **pre-spec-215** shape of the three observation bases: one whole-set blob per axis, in a
/// `StorageValue`, bounded by the `MaxObserved` population ceiling that no longer exists.
///
/// Retired by [`super::v1`], which repages all three into StorageMaps. The alias values are plain `Vec`,
/// not `BoundedVec<_, MaxObserved>`: the two are SCALE-identical, and the plain `Vec` sidesteps a bound
/// the `Config` no longer has. That also means these decode a live vec of ANY length, which matters — a
/// `BoundedVec` alias would fail to decode an over-long value and `ValueQuery` would answer with an empty
/// blob, migrating zero rows while reporting success.
pub mod blob {
    use crate::{BeaconName, Config, Pallet, StakeCredential};
    use alloc::vec::Vec;
    use frame_support::{
        pallet_prelude::ValueQuery,
        storage::types::StorageValue as RawStorageValue,
        traits::{PalletInfoAccess, StorageInstance},
    };

    /// Addresses the `CardanoObserver::LastObserved` prefix with the blob value shape.
    pub struct LastObservedPrefix<T>(core::marker::PhantomData<T>);
    impl<T: Config> StorageInstance for LastObservedPrefix<T> {
        fn pallet_prefix() -> &'static str {
            <Pallet<T> as PalletInfoAccess>::name()
        }
        const STORAGE_PREFIX: &'static str = "LastObserved";
    }

    /// Addresses the `CardanoObserver::LastObservedStake` prefix with the blob value shape.
    pub struct LastObservedStakePrefix<T>(core::marker::PhantomData<T>);
    impl<T: Config> StorageInstance for LastObservedStakePrefix<T> {
        fn pallet_prefix() -> &'static str {
            <Pallet<T> as PalletInfoAccess>::name()
        }
        const STORAGE_PREFIX: &'static str = "LastObservedStake";
    }

    /// Addresses the `CardanoObserver::LastObservedRoles` prefix with the blob value shape.
    pub struct LastObservedRolesPrefix<T>(core::marker::PhantomData<T>);
    impl<T: Config> StorageInstance for LastObservedRolesPrefix<T> {
        fn pallet_prefix() -> &'static str {
            <Pallet<T> as PalletInfoAccess>::name()
        }
        const STORAGE_PREFIX: &'static str = "LastObservedRoles";
    }

    /// The vault basis as one `(beacon, account)` blob. Note it carries NO weight — the pre-215 basis only
    /// recorded WHICH identities were credited, because absence from the next full snapshot was the entire
    /// unlock signal and the applied value never had to be remembered.
    pub type LastObserved<T> = RawStorageValue<
        LastObservedPrefix<T>,
        Vec<(BeaconName, <T as frame_system::Config>::AccountId)>,
        ValueQuery,
    >;

    /// The voting-power basis as one `(stake_credential, account)` blob. Also weightless.
    pub type LastObservedStake<T> = RawStorageValue<
        LastObservedStakePrefix<T>,
        Vec<(StakeCredential, <T as frame_system::Config>::AccountId)>,
        ValueQuery,
    >;

    /// The role basis as one blob of ACCOUNTS. It never recorded the sets themselves, only who held
    /// something, for the same reason.
    pub type LastObservedRoles<T> = RawStorageValue<
        LastObservedRolesPrefix<T>,
        Vec<<T as frame_system::Config>::AccountId>,
        ValueQuery,
    >;
}
