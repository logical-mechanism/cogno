//! `cogno-chain-node gen-chainspec` — build an **operator-keyed** chain spec from key FILES.
//!
//! The production-genesis gap was that all presets seat the public dev keys (`//Alice..`). This subcommand
//! closes it: the operator generates real keys with `cogno-chain-cli key gen` (cardano-cli-style envelopes,
//! BY FILE PATH — never seed phrases), and this command reads their PUBLIC keys (recomputed from the
//! envelope via the shared [`cogno_keyfile`] crate — the same definition the CLI signs with, so the format
//! can't drift) and seats them into an operator-keyed genesis. It writes a plain (inspectable) + raw
//! (sealed) chain spec; the raw one is what the node runs with `--chain`. Dev keys are REFUSED by default
//! (`--allow-dev-keys` to opt out for a dev-keyed test spec).
//!
//! It seats only PUBLIC keys into genesis; the validator's Aura/GRANDPA SESSION secrets are inserted into
//! the node keystore separately (`key insert`), and the committee/account secrets stay in their files
//! for `cogno-chain-cli`.

use std::path::{Path, PathBuf};

use crate::chain_spec::ChainSpec; // the `GenericChainSpec` alias (resolves the generic params)
use cogno_chain_runtime::{genesis_config_presets::operator_genesis, AccountId, WASM_BINARY};
use cogno_keyfile::{assert_key_file_secure, assert_not_dev_key, load_signer, Signer};
use sc_service::config::MultiaddrWithPeerId;
use sc_service::{ChainType, Properties};
use sp_core::crypto::Ss58Codec;
use sp_runtime::AccountId32;

/// The SS58 prefix (42) — matches `runtime::configs::SS58Prefix`, for the printed addresses.
const SS58_PREFIX: u16 = 42;

/// Build an operator-keyed chain spec from `cogno-chain-cli key gen` key files.
#[derive(Debug, clap::Args)]
pub struct GenChainSpecCmd {
    /// The base network shape: `cogno-preprod` (ChainType::Live, the live-preprod-observing chain) or
    /// `cogno-dev` (ChainType::Development). The observer's Cardano params (Shelley anchor, vault policy) are
    /// compile-time constants in the runtime, so `--base` selects only the chain type + name/id.
    #[arg(long, default_value = "cogno-preprod", value_parser = ["cogno-preprod", "cogno-dev"])]
    pub base: String,

    /// The validator's account/identity key file (sr25519) — its account is the validator id (and the
    /// account `cogno-chain-cli validator set-keys`/governance later signs with).
    #[arg(long, value_name = "PATH")]
    pub validator_account_key: PathBuf,
    /// The validator's Aura session key file (sr25519) — the hot block-sealing key (also keystore-inserted).
    #[arg(long, value_name = "PATH")]
    pub validator_aura_key: PathBuf,
    /// The validator's GRANDPA session key file (ed25519) — the hot finality key (also keystore-inserted).
    #[arg(long, value_name = "PATH")]
    pub validator_grandpa_key: PathBuf,

    /// A committee member account key file (sr25519, repeatable). Defaults to the validator account when
    /// omitted (the single-operator bootstrap).
    #[arg(long = "committee-key", value_name = "PATH")]
    pub committee_keys: Vec<PathBuf>,

    /// Extra account(s) to endow (SS58), beyond the validator + committee (which are always endowed).
    #[arg(long = "endow", value_name = "SS58")]
    pub endow: Vec<String>,

    /// A published bootnode multiaddr including /p2p/<PeerId>, repeatable. Baked into the chain spec's
    /// `bootNodes` so nodes bootstrap off these dedicated nodes, not the validator. NETWORK metadata only —
    /// it does NOT affect genesis state, so it needs no `spec_version` bump.
    #[arg(long = "bootnode", value_name = "MULTIADDR")]
    pub bootnodes: Vec<String>,

    /// Chain spec human name (default: derived from --base).
    #[arg(long)]
    pub name: Option<String>,
    /// Chain spec id — the on-disk identifier used for the data/keystore dir (default: derived from
    /// --base). This is NOT the libp2p protocol id, which this tool does not set.
    #[arg(long)]
    pub id: Option<String>,

    /// Output path for the human-readable (plain) chain spec.
    #[arg(long, default_value = "cogno-operator.plain.json")]
    pub out_plain: PathBuf,
    /// Output path for the raw (sealed) chain spec the node runs with `--chain`.
    #[arg(long, default_value = "cogno-operator.raw.json")]
    pub out_raw: PathBuf,

    /// Allow the well-known dev keys (//Alice..) — OFF by default (an operator spec must use real keys).
    #[arg(long)]
    pub allow_dev_keys: bool,
}

/// Load a key file and refuse a dev key (and, unless `--allow-dev-keys`, a group/other-accessible key
/// file) — an operator chain spec must use real keys stored 0600.
fn load(path: &Path, allow_dev: bool) -> Result<Signer, String> {
    let s = load_signer(path).map_err(|e| e.to_string())?;
    assert_not_dev_key(&s, !allow_dev).map_err(|e| e.to_string())?;
    assert_key_file_secure(path, !allow_dev).map_err(|e| e.to_string())?;
    Ok(s)
}

/// Run `gen-chainspec`.
pub fn run(cmd: &GenChainSpecCmd) -> Result<(), String> {
    let allow_dev = cmd.allow_dev_keys;

    // The validator: account (sr25519) = validator-id; aura (sr25519) + grandpa (ed25519) = the hot session
    // keys. We seat only their PUBLIC keys here.
    let acct = load(&cmd.validator_account_key, allow_dev)?;
    let validator_account: AccountId = acct.account_id();
    let aura_pub = load(&cmd.validator_aura_key, allow_dev)?
        .require_sr25519_public()
        .map_err(|e| format!("{}: {e}", cmd.validator_aura_key.display()))?
        .0;
    let grandpa_pub = load(&cmd.validator_grandpa_key, allow_dev)?
        .require_ed25519_public()
        .map_err(|e| format!("{}: {e}", cmd.validator_grandpa_key.display()))?
        .0;

    // The committee (defaults to the validator account — the single-operator bootstrap).
    let committee: Vec<AccountId> = if cmd.committee_keys.is_empty() {
        vec![validator_account.clone()]
    } else {
        let mut v = Vec::with_capacity(cmd.committee_keys.len());
        for p in &cmd.committee_keys {
            let s = load(p, allow_dev)?;
            s.require_sr25519_public()
                .map_err(|e| format!("committee key {}: {e}", p.display()))?;
            v.push(s.account_id());
        }
        v
    };
    // Guard BEFORE the genesis build: pallet-collective's genesis `build()` PANICS with an opaque backtrace
    // (mid `spec.as_json`) on a DUPLICATE member, leaving a half-written pair of specs. Catch the common
    // scripting slip (the same --committee-key passed twice) here with a clean, actionable CLI error. (An
    // over-`MaxMembers` set is still caught by the pallet's own assert, which names that limit.)
    {
        let mut seen = std::collections::BTreeSet::new();
        for a in &committee {
            if !seen.insert(a) {
                return Err(format!(
					"duplicate committee account {} — the FollowerCommittee genesis members must be distinct \
					 (drop the repeated --committee-key)",
					a.to_ss58check_with_version(SS58_PREFIX.into())
				));
            }
        }
    }

    // Extra endowed accounts (SS58).
    let mut extra = Vec::with_capacity(cmd.endow.len());
    for e in &cmd.endow {
        extra.push(
            AccountId32::from_ss58check(e.trim())
                .map_err(|err| format!("--endow {e:?}: {err:?}"))?,
        );
    }

    // Published bootnodes (NETWORK metadata, not genesis storage). `MultiaddrWithPeerId: FromStr` requires
    // the trailing /p2p/<PeerId>; parse now so a bad value fails with a clear message naming the offender.
    let mut boot_nodes = Vec::with_capacity(cmd.bootnodes.len());
    for b in &cmd.bootnodes {
        boot_nodes.push(
            b.parse::<MultiaddrWithPeerId>()
                .map_err(|err| format!("--bootnode {b:?}: {err}"))?,
        );
    }

    let genesis = operator_genesis(
        vec![(validator_account.clone(), aura_pub, grandpa_pub)],
        committee.clone(),
        extra,
    );

    let wasm = WASM_BINARY.ok_or_else(|| "runtime WASM not available in this build".to_string())?;
    let dev_base = cmd.base == "cogno-dev";
    let name = cmd.name.clone().unwrap_or_else(|| {
        if dev_base {
            "Cogno Dev (operator)".into()
        } else {
            "Cogno Preprod (operator)".into()
        }
    });
    let id = cmd.id.clone().unwrap_or_else(|| {
        if dev_base {
            "cogno-dev-operator".into()
        } else {
            "cogno-preprod-operator".into()
        }
    });
    let chain_type = if dev_base {
        ChainType::Development
    } else {
        ChainType::Live
    };
    let chain_type_label = format!("{chain_type:?}");
    let mut props = Properties::new();
    // ADA/lovelace is 6-decimal (the on-chain weight is buried lovelace).
    props.insert("tokenDecimals".into(), 6.into());
    // The native token is governance FUEL — a non-transferable, committee-granted, REGENERATING budget
    // that pays the fee-bearing admin extrinsics (Session::set_keys, committee propose/vote/close). It is
    // NOT money and NOT vote-weight (the committee is 1-member-1-vote) and can NEVER post (the social layer
    // never reads Balances). Naming it makes tooling (polkadot-js) render balances legibly instead of a
    // nameless unit. tokenSymbol/tokenDecimals are non-consensus chainspec `properties` (display only).
    props.insert("tokenSymbol".into(), "FUEL".into());

    let spec = ChainSpec::builder(wasm, None)
        .with_name(&name)
        .with_id(&id)
        .with_chain_type(chain_type)
        .with_genesis_config_patch(genesis)
        .with_properties(props)
        .with_boot_nodes(boot_nodes.clone())
        .build();

    std::fs::write(&cmd.out_plain, spec.as_json(false)?)
        .map_err(|e| format!("writing {}: {e}", cmd.out_plain.display()))?;
    std::fs::write(&cmd.out_raw, spec.as_json(true)?)
        .map_err(|e| format!("writing {}: {e}", cmd.out_raw.display()))?;

    let ss58 = |a: &AccountId| a.to_ss58check_with_version(SS58_PREFIX.into());
    eprintln!("✓ operator-keyed chain spec written ({name}, id={id}, {chain_type_label}):");
    eprintln!("    plain: {}", cmd.out_plain.display());
    eprintln!(
        "    raw:   {}   ← run the node with `--chain` this",
        cmd.out_raw.display()
    );
    eprintln!("  validator: {}", ss58(&validator_account));
    eprintln!(
        "  committee ({}): {}",
        committee.len(),
        committee.iter().map(ss58).collect::<Vec<_>>().join(", ")
    );
    if boot_nodes.is_empty() {
        eprintln!("  bootnodes: none (relays will need an explicit --bootnodes)");
    } else {
        eprintln!("  bootnodes ({}):", boot_nodes.len());
        for b in &boot_nodes {
            eprintln!("    {b}");
        }
    }
    eprintln!();
    eprintln!("NEXT — on the validator host, insert its SESSION secrets into the node keystore FROM the key");
    eprintln!("files (the scheme is read from each envelope — no jq/--suri):");
    eprintln!(
        "  cogno-chain-node key insert --base-path <PATH> --chain {} --key-file {} --key-type aura",
        cmd.out_raw.display(),
        cmd.validator_aura_key.display()
    );
    eprintln!(
        "  cogno-chain-node key insert --base-path <PATH> --chain {} --key-file {} --key-type gran",
        cmd.out_raw.display(),
        cmd.validator_grandpa_key.display()
    );
    eprintln!();
    eprintln!("Then mint the validator's libp2p node (p2p) key — a --validator node will NOT auto-generate");
    eprintln!("one (it fails with NetworkKeyNotFound); pass it to `run` with --node-key-file:");
    eprintln!("  cogno-chain-cli key generate-node-key --out node-p2p.key");
    eprintln!(
		"then run: cogno-chain-node run --chain {} --base-path <PATH> --validator --force-authoring --node-key-file node-p2p.key",
		cmd.out_raw.display()
	);
    Ok(())
}
