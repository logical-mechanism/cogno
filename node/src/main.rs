//! cogno-chain node CLI.
#![warn(missing_docs)]

// The benchmark builders are a dev/CI tool — compiled only with the `runtime-benchmarks` feature (the
// `benchmark` subcommand that uses them is likewise feature-gated). See cli.rs / command.rs.
#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;
mod cardano_observer;
mod chain_spec;
mod cli;
mod command;
mod config_check;
mod consensus;
mod gen_chainspec;
mod key;
mod metrics;
mod rpc;
mod service;

fn main() -> sc_cli::Result<()> {
    command::run()
}
