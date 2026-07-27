//! Retired on-chain storage SHAPES, owned by the era they belong to rather than by whichever
//! migration happens to touch them.
//!
//! A migration that reads a shape the current pallet no longer declares has to re-declare it. The
//! obvious place is the migration itself, and that works right up until a SECOND migration needs the
//! same shape: `v4` (which BACKFILLS the per-author blob) and `v10` (which RETIRES it) both address
//! `TopLevelByAuthor` in its pre-v10 form, and having `v4` import from `v10` would make an older
//! migration depend on the alias declared by the one that ends that shape's life — so a later `v11`
//! repaging these items again would silently redefine what `v4` writes. The shape lives here instead:
//! `blob` is the v4..=v9 era, and nothing that retires it can move it.
//!
//! ⚠ NOT `#[storage_alias]`. That macro takes the on-chain STORAGE ITEM NAME from the ALIAS TYPE
//! NAME, so a `ByAuthorV9` alias silently addresses `twox128("Microblog") ++ twox128("ByAuthorV9")` —
//! a prefix nothing has ever written. A migration then iterates zero rows, reports success, and
//! leaves every real row orphaned under the prefix where the new shape cannot decode it. (That is not
//! hypothetical: it is what the first cut of `v10` did, it passed its own unit tests — which wrote and
//! read through the same wrong prefix, so they were self-fulfilling — and only the `try-runtime`
//! dry-run against real preprod state caught it.)
//!
//! So every prefix below is spelled out. `STORAGE_PREFIX` is the REAL item name; the Rust type carries
//! the era in its name so it is obvious at every call site which shape is meant.
//! `alias_prefixes_match_the_live_items` in the pallet tests pins the two together against the
//! pallet's own items.

/// The **v4..=v9** shape of the two per-author indexes: one `Vec<u64>` blob of post ids per author.
///
/// Retired by [`super::v10`], which repages both items into a seq-keyed double map beside an explicit
/// counter. The alias values are `Vec<u64>`, not `BoundedVec<u64, _>`: the two are SCALE-identical,
/// and the plain `Vec` sidesteps the `MaxPostsPerAuthor` bound that v10 removes from `Config`.
pub mod blob {
    use crate::{Config, Pallet};
    use alloc::vec::Vec;
    use frame_support::{
        pallet_prelude::ValueQuery,
        storage::types::StorageMap as RawStorageMap,
        traits::{PalletInfoAccess, StorageInstance},
        Blake2_128Concat,
    };

    /// Addresses the `Microblog::ByAuthor` prefix with the blob value shape.
    pub struct ByAuthorPrefix<T>(core::marker::PhantomData<T>);
    impl<T: Config> StorageInstance for ByAuthorPrefix<T> {
        fn pallet_prefix() -> &'static str {
            <Pallet<T> as PalletInfoAccess>::name()
        }
        const STORAGE_PREFIX: &'static str = "ByAuthor";
    }

    /// Addresses the `Microblog::TopLevelByAuthor` prefix with the blob value shape.
    pub struct TopLevelByAuthorPrefix<T>(core::marker::PhantomData<T>);
    impl<T: Config> StorageInstance for TopLevelByAuthorPrefix<T> {
        fn pallet_prefix() -> &'static str {
            <Pallet<T> as PalletInfoAccess>::name()
        }
        const STORAGE_PREFIX: &'static str = "TopLevelByAuthor";
    }

    /// `ByAuthor` as one blob of post ids per author.
    pub type ByAuthor<T> = RawStorageMap<
        ByAuthorPrefix<T>,
        Blake2_128Concat,
        <T as frame_system::Config>::AccountId,
        Vec<u64>,
        ValueQuery,
    >;

    /// `TopLevelByAuthor` as the same blob, reply-free.
    pub type TopLevelByAuthor<T> = RawStorageMap<
        TopLevelByAuthorPrefix<T>,
        Blake2_128Concat,
        <T as frame_system::Config>::AccountId,
        Vec<u64>,
        ValueQuery,
    >;
}
