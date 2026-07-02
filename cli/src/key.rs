//! Key handling for the CLI — re-exported from the shared [`cogno_keyfile`] crate.
//!
//! The cardano-cli-style key-file format (envelope load/recompute, `key gen`, the `--prod` dev-key
//! denylist) is defined ONCE in `cogno-keyfile` so the CLI (writer/signer) and the node's `gen-chainspec`
//! (reader of operator public keys) share a single, drift-free definition — the same shared-lib pattern as
//! `cogno-dbsync`. The CLI's call sites keep using `crate::key::…` unchanged.

// Glob re-export so every key-file item is reachable as `crate::key::…` unchanged (and a binary crate
// doesn't warn on the ones a given build doesn't name directly).
pub use cogno_keyfile::*;
