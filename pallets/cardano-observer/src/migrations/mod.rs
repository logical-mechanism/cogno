//! Storage migrations for pallet-cardano-observer.
//!
//! Each version-guarded migration must be registered in the runtime's `SingleBlockMigrations`
//! (`runtime/src/configs/mod.rs`) or it never runs — the on-chain `StorageVersion` silently stays put
//! while the code declares the new one, and `post_upgrade` never fires.

pub mod legacy;
pub mod v1;
pub mod v2;
