//! Substrate Node Template CLI library.
#![warn(missing_docs)]

mod benchmarking;
mod cardano_observer;
mod chain_spec;
mod cli;
mod command;
mod consensus;
mod dbsync;
mod rpc;
mod service;

fn main() -> sc_cli::Result<()> {
	command::run()
}
