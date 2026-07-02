//! `cogno-chain-node key …` — key & keystore management, with a file-based `insert-file`.
//!
//! The admin CLI (`cogno-chain-cli`) links every key BY FILE PATH; the SDK's `key insert` instead takes a
//! `--suri`, which forces operators to `--suri 0x"$(jq -r .secretHex …)"` a session secret out of its
//! envelope. `insert-file` closes that gap: it reads the `cogno-chain-cli key gen` envelope via the shared
//! [`cogno_keyfile`] crate (the same reader `gen-chainspec` uses), derives the SURI + scheme FROM the file,
//! and inserts it into the keystore exactly as [`sc_cli::InsertKeyCmd`] does. The SDK utilities (including
//! the raw `--suri` `insert`) are flattened in unchanged, so `key generate` / `key insert` / … still work.

use std::path::PathBuf;

use cogno_keyfile::Scheme;
use sc_cli::{Error, KeystoreParams, SharedParams, SubstrateCli};
use sc_keystore::LocalKeystore;
use sc_service::config::{BasePath, KeystoreConfig};
use sp_core::crypto::{ByteArray, KeyTypeId};
use sp_core::Pair as _; // `.public()` on the sr25519/ed25519 Pair (trait method).
use sp_keystore::{Keystore, KeystorePtr};

/// The node's key subcommand set: the SDK key utilities (flattened in verbatim) plus the file-based
/// `insert-file`. Flattening [`sc_cli::KeySubcommand`] keeps `generate-node-key` / `generate` / `inspect` /
/// `inspect-node-key` / `insert` (the raw `--suri` insert, kept as an advanced escape hatch) as direct
/// `key …` children, so existing invocations are unchanged.
#[derive(Debug, clap::Subcommand)]
pub enum KeyCmd {
	#[command(flatten)]
	#[allow(missing_docs)]
	Sc(sc_cli::KeySubcommand),

	/// Insert a session secret into the keystore from a `cogno-chain-cli key gen` key FILE (no jq/--suri;
	/// the scheme is read from the envelope) — the file-path analogue of the SDK's `key insert`.
	InsertFile(InsertFileCmd),
}

impl KeyCmd {
	/// Dispatch a key subcommand.
	pub fn run<C: SubstrateCli>(&self, cli: &C) -> Result<(), Error> {
		match self {
			KeyCmd::Sc(cmd) => cmd.run(cli),
			KeyCmd::InsertFile(cmd) => cmd.run(cli),
		}
	}
}

/// `key insert-file` — insert a session secret from a `cogno-chain-cli key gen` envelope by FILE PATH.
#[derive(Debug, clap::Args)]
pub struct InsertFileCmd {
	/// The `cogno-chain-cli key gen` key FILE whose secret to insert (its scheme is read from the file).
	#[arg(long, value_name = "PATH")]
	pub key_file: PathBuf,

	/// The keystore key-type: `aura` (block sealing, sr25519) or `gran` (finality, ed25519). `grandpa` is
	/// accepted as a friendly alias for `gran`.
	#[arg(long, value_name = "TYPE")]
	pub key_type: String,

	#[allow(missing_docs)]
	#[clap(flatten)]
	pub shared_params: SharedParams,

	#[allow(missing_docs)]
	#[clap(flatten)]
	pub keystore_params: KeystoreParams,
}

impl InsertFileCmd {
	/// Run the command — mirrors [`sc_cli::InsertKeyCmd::run`], substituting the envelope read for `--suri`.
	pub fn run<C: SubstrateCli>(&self, cli: &C) -> Result<(), Error> {
		// Canonical keystore key-type — four ASCII bytes the runtime's session machinery keys off. We accept
		// `grandpa` as a friendly alias; `aura`/`gran` are wire values and are NOT renamed.
		let key_type_str = match self.key_type.as_str() {
			"grandpa" => "gran",
			other => other,
		};

		// Read the SURI (0x-hex secret) + scheme from the envelope. The secret stays inside the audited
		// cogno-keyfile crate; we re-derive the public key from the SURI below, exactly as `key insert`.
		let (scheme, suri) = cogno_keyfile::load_secret_suri(&self.key_file)
			.map_err(|e| Error::Input(format!("{e:#}")))?;

		// Guard the common mistake: the envelope's scheme must match the key-type's required scheme
		// (aura ⇒ sr25519, gran ⇒ ed25519), or the keystore entry would be unusable.
		if let Some(want) = required_scheme(key_type_str) {
			if scheme != want {
				return Err(Error::Input(format!(
					"key file {} is {}, but --key-type {} needs {} — refusing to write an unusable keystore \
					 entry",
					self.key_file.display(),
					scheme.as_str(),
					self.key_type,
					want.as_str()
				)));
			}
		} else {
			// Not one of this chain's session key-types (aura/gran): we can't validate the scheme, so a typo
			// (e.g. `--key-type aur`) would silently insert an entry the node never reads. Warn loudly.
			eprintln!(
				"warning: --key-type {} is not a known session key-type (expected `aura` or `gran`); \
				 inserting a {} key WITHOUT scheme validation — double-check this is intended",
				key_type_str,
				scheme.as_str()
			);
		}

		// Locate the keystore exactly as InsertKeyCmd does (base-path + chain → config dir → keystore).
		let base_path = self
			.shared_params
			.base_path()?
			.unwrap_or_else(|| BasePath::from_project("", "", &C::executable_name()));
		let chain_id = self.shared_params.chain_id(self.shared_params.is_dev());
		let chain_spec = cli.load_spec(&chain_id)?;
		let config_dir = base_path.config_dir(chain_spec.id());

		let (keystore, public) = match self.keystore_params.keystore_config(&config_dir)? {
			KeystoreConfig::Path { path, password } => {
				let public = match scheme {
					Scheme::Sr25519 => sc_cli::commands::utils::pair_from_suri::<sp_core::sr25519::Pair>(
						&suri,
						password.clone(),
					)?
					.public()
					.to_raw_vec(),
					Scheme::Ed25519 => sc_cli::commands::utils::pair_from_suri::<sp_core::ed25519::Pair>(
						&suri,
						password.clone(),
					)?
					.public()
					.to_raw_vec(),
				};
				let keystore: KeystorePtr = LocalKeystore::open(path, password)?.into();
				(keystore, public)
			},
			_ => unreachable!("keystore_config always returns path and password; qed"),
		};

		let key_type = KeyTypeId::try_from(key_type_str).map_err(|_| Error::KeyTypeInvalid)?;

		keystore.insert(key_type, &suri, &public[..]).map_err(|_| Error::KeystoreOperation)?;

		eprintln!(
			"✓ inserted {} key (key-type {}) into the keystore from {}",
			scheme.as_str(),
			key_type_str,
			self.key_file.display()
		);
		Ok(())
	}
}

/// The keystore scheme a well-known session key-type requires, so a mismatched envelope is refused. `None`
/// for key-types outside the chain's session set (they trust the envelope's scheme).
fn required_scheme(key_type: &str) -> Option<Scheme> {
	match key_type {
		"aura" => Some(Scheme::Sr25519),
		"gran" => Some(Scheme::Ed25519),
		_ => None,
	}
}
