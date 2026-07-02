use crate::{
	chain_spec,
	cli::{Cli, Subcommand},
	service,
};
use sc_cli::SubstrateCli;

// Benchmarking is a dev/CI tool — its imports + command arm exist only under `runtime-benchmarks`
// (the `benchmark` subcommand that uses them is likewise feature-gated). See cli.rs.
#[cfg(feature = "runtime-benchmarks")]
use crate::benchmarking::{inherent_benchmark_data, RemarkBuilder, TransferKeepAliveBuilder};
#[cfg(feature = "runtime-benchmarks")]
use cogno_chain_runtime::{Block, EXISTENTIAL_DEPOSIT};
#[cfg(feature = "runtime-benchmarks")]
use frame_benchmarking_cli::{BenchmarkCmd, ExtrinsicFactory, SUBSTRATE_REFERENCE_HARDWARE};
#[cfg(feature = "runtime-benchmarks")]
use sc_service::PartialComponents;
#[cfg(feature = "runtime-benchmarks")]
use sp_keyring::Sr25519Keyring;

impl SubstrateCli for Cli {
	fn impl_name() -> String {
		"cogno-chain-node".into()
	}

	fn impl_version() -> String {
		env!("SUBSTRATE_CLI_IMPL_VERSION").into()
	}

	fn description() -> String {
		env!("CARGO_PKG_DESCRIPTION").into()
	}

	fn author() -> String {
		env!("CARGO_PKG_AUTHORS").into()
	}

	fn support_url() -> String {
		"https://github.com/LogicalMechanism/cogno-chain/issues".into()
	}

	fn copyright_start_year() -> i32 {
		2026
	}

	fn load_spec(&self, id: &str) -> Result<Box<dyn sc_service::ChainSpec>, String> {
		Ok(match id {
			"dev" => Box::new(chain_spec::development_chain_spec()?),
			"" | "local" => Box::new(chain_spec::local_chain_spec()?),
			path => {
				Box::new(chain_spec::ChainSpec::from_json_file(std::path::PathBuf::from(path))?)
			},
		})
	}
}

/// Parse and run command line arguments
pub fn run() -> sc_cli::Result<()> {
	let cli = Cli::from_args();

	match &cli.subcommand {
		Subcommand::Run(cmd) => {
			let runner = cli.create_runner(cmd)?;
			runner.run_node_until_exit(|config| async move {
				match config.network.network_backend {
					sc_network::config::NetworkBackendType::Libp2p => service::new_full::<
						sc_network::NetworkWorker<
							cogno_chain_runtime::opaque::Block,
							<cogno_chain_runtime::opaque::Block as sp_runtime::traits::Block>::Hash,
						>,
					>(config)
					.map_err(sc_cli::Error::Service),
					sc_network::config::NetworkBackendType::Litep2p =>
						service::new_full::<sc_network::Litep2pNetworkBackend>(config)
							.map_err(sc_cli::Error::Service),
				}
			})
		},
		Subcommand::Key(cmd) => cmd.run(&cli),
		Subcommand::ExportChainSpec(cmd) => {
			let chain_spec = cli.load_spec(&cmd.chain)?;
			cmd.run(chain_spec)
		},
		Subcommand::GenChainSpec(cmd) => {
			crate::gen_chainspec::run(cmd).map_err(|e| sc_cli::Error::Application(e.into()))
		},
		#[cfg(feature = "runtime-benchmarks")]
		Subcommand::Benchmark(cmd) => {
			let runner = cli.create_runner(cmd)?;

			runner.sync_run(|config| {
				// This switch needs to be in the client, since the client decides
				// which sub-commands it wants to support.
				match cmd {
					BenchmarkCmd::Pallet(cmd) => cmd
						.run_with_spec::<sp_runtime::traits::HashingFor<Block>, ()>(Some(
							config.chain_spec,
						)),
					BenchmarkCmd::Block(cmd) => {
						let PartialComponents { client, .. } = service::new_partial(&config)?;
						cmd.run(client)
					},
					BenchmarkCmd::Storage(cmd) => {
						let PartialComponents { client, backend, .. } =
							service::new_partial(&config)?;
						let db = backend.expose_db();
						let storage = backend.expose_storage();
						let shared_cache = backend.expose_shared_trie_cache();

						cmd.run(config, client, db, storage, shared_cache)
					},
					BenchmarkCmd::Overhead(cmd) => {
						let PartialComponents { client, .. } = service::new_partial(&config)?;
						let ext_builder = RemarkBuilder::new(client.clone());

						cmd.run(
							config.chain_spec.name().into(),
							client,
							inherent_benchmark_data()?,
							Vec::new(),
							&ext_builder,
							false,
						)
					},
					BenchmarkCmd::Extrinsic(cmd) => {
						let PartialComponents { client, .. } = service::new_partial(&config)?;
						// Register the *Remark* and *TKA* builders.
						let ext_factory = ExtrinsicFactory(vec![
							Box::new(RemarkBuilder::new(client.clone())),
							Box::new(TransferKeepAliveBuilder::new(
								client.clone(),
								Sr25519Keyring::Alice.to_account_id(),
								EXISTENTIAL_DEPOSIT,
							)),
						]);

						cmd.run(client, inherent_benchmark_data()?, Vec::new(), &ext_factory)
					},
					BenchmarkCmd::Machine(cmd) => {
						cmd.run(&config, SUBSTRATE_REFERENCE_HARDWARE.clone())
					},
				}
			})
		},
	}
}
