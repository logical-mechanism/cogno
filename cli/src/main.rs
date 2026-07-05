//! `cogno-chain-cli` — the cogno-chain operator/committee admin CLI (the `cardano-cli` analogue to the
//! `cogno-chain-node` daemon). Drives **committee-governed** extrinsics (propose/vote/close)
//! with secret keys linked **by file path**, the self-service **BARE** CIP-8 identity
//! binds, plus read-only `query` diagnostics. It CANNOT set talk-stake weight — the observation inherent is
//! the sole writer.
//!
//! The surface is **noun-first** (cardano-cli style): each domain is a group (`validator`/`committee`/
//! `upgrade`/`gate`/`observer`/`identity`/`query`/`key`) holding its verbs. Custody is signalled by the
//! verb + which key flag it takes: a **committee-governed** verb takes `--committee-signing-key-file`
//! (bundle every seat on this host, or pass one seat + `--propose` for true multi-custody, then co-sign with
//! `committee vote`/`committee close`); a **self-signed** verb takes `--account-signing-key-file`; a **BARE**
//! identity bind takes NO key (the CIP-8 proof is the authorization).
#![warn(missing_docs)]

mod calls;
mod committee;
mod identity;
mod key;
mod query;
mod rpc;
mod tx;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use sp_core::H256;

use crate::committee::{assert_extrinsic_ok, resolve_committee, via_committee};
use crate::key::{load_signer, Scheme, Signer};
use crate::rpc::Rpc;
use crate::tx::{build_signed, ChainCtx};

/// The default node RPC endpoint.
const DEFAULT_WS: &str = "ws://127.0.0.1:9944";

#[derive(Parser)]
#[command(
    name = "cogno-chain-cli",
    version,
    about = "cogno-chain operator/committee admin CLI. Keys by file path. Cannot set talk-stake weight — it \
	         is observed from Cardano, never set by a command."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
}

/// Shared options for the committee-governed write verbs. Default (bundled single-host): pass one
/// `--committee-signing-key-file` per seat (repeatable) and the whole `propose → vote×k → close` runs on
/// this host. With `--propose`: pass exactly ONE seat key to open the motion (true multi-custody), then
/// co-signers run `committee vote` / `committee close` from their own hosts.
#[derive(Args, Clone)]
struct GovOpts {
    /// Node RPC ws endpoint.
    #[arg(long, default_value = DEFAULT_WS)]
    ws: String,
    /// A committee seat secret-key file (repeatable — one per seat for bundled single-host custody; pass
    /// exactly one with `--propose` for true multi-custody).
    #[arg(
        long = "committee-signing-key-file",
        value_name = "PATH",
        required = true
    )]
    committee_keys: Vec<PathBuf>,
    /// True multi-custody: propose the motion with ONE seat key and print co-sign instructions, instead of
    /// bundling every seat on this host. Co-signers then run `committee vote` / `committee close`.
    #[arg(long)]
    propose: bool,
    /// Prod profile: refuse well-known dev keys (//Alice..).
    #[arg(long)]
    prod: bool,
    /// Assert the connected chain's genesis hash matches this 0x-hex (refuse the wrong chain).
    #[arg(long)]
    genesis: Option<String>,
    /// Override the number of approving committee seats required (default: the on-chain 3-of-5
    /// supermajority for the current membership; an override may only be stricter).
    #[arg(long)]
    threshold: Option<u32>,
}

/// Shared options for a SINGLE-seat committee co-sign command: exactly one key file, never loading the whole
/// committee into one process. Used by `committee vote`/`close`.
#[derive(Args, Clone)]
struct SeatOpts {
    /// Node RPC ws endpoint.
    #[arg(long, default_value = DEFAULT_WS)]
    ws: String,
    /// THIS seat's secret-key file (one key per host — keys never leave their owner).
    #[arg(long = "committee-signing-key-file", value_name = "PATH")]
    committee_key: PathBuf,
    /// Prod profile: refuse well-known dev keys (//Alice..).
    #[arg(long)]
    prod: bool,
    /// Assert the connected chain's genesis hash matches this 0x-hex (refuse the wrong chain). Also the
    /// genesis embedded into an `--offline` signature (where it can't be fetched).
    #[arg(long)]
    genesis: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Key-file utilities (offline; cardano-cli-style JSON envelopes).
    Key {
        #[command(subcommand)]
        cmd: KeyCmd,
    },
    /// Read-only chain inspection (no keys, no writes).
    Query {
        #[command(subcommand)]
        cmd: QueryCmd,
    },
    /// Block-producing validator set: committee `add`/`remove` + the validator's own `set-keys`.
    Validator {
        #[command(subcommand)]
        cmd: ValidatorCmd,
    },
    /// Committee governance: the motion lifecycle (`list`/`vote`/`close`/`submit`) + `members` self-rotation.
    Committee {
        #[command(subcommand)]
        cmd: CommitteeCmd,
    },
    /// Runtime upgrade: committee `authorize` of a code hash + permissionless `apply`.
    Upgrade {
        #[command(subcommand)]
        cmd: UpgradeCmd,
    },
    /// CIP-8 identity: self-service BARE binds, read-only resolvers, and the committee-governed `revoke`.
    Identity {
        #[command(subcommand)]
        cmd: IdentityCmd,
    },
    /// Governance fuel: the committee-administered REGENERATING admin-fee budget (`set-allowance`/`revoke`).
    Fuel {
        #[command(subcommand)]
        cmd: FuelCmd,
    },
}

#[derive(Subcommand)]
enum KeyCmd {
    /// Generate a fresh signing-key file (cardano-cli-style JSON envelope).
    Gen {
        /// Key scheme: sr25519 (accounts, committee, Aura) or ed25519 (GRANDPA).
        #[arg(long)]
        scheme: String,
        /// Output key-file path (refuses to overwrite; written 0600).
        #[arg(long)]
        out: PathBuf,
        /// Optional free-text description.
        #[arg(long, default_value = "")]
        description: String,
    },
    /// Generate a libp2p node (p2p) key file — the node's stable NETWORK identity (peer id), NOT a
    /// session/account key. A `--validator` node REQUIRES one (it will not auto-mint it — the SDK
    /// refuses, so an authority can't silently adopt an unstable peer id); pass the file to
    /// `cogno-chain-node run --node-key-file <FILE>`. Prints the derived peer id + bootnode multiaddr.
    GenerateNodeKey {
        /// Output node-key file path (raw hex ed25519 secret; refuses to overwrite; written 0600).
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Subcommand)]
enum QueryCmd {
    /// Read-only: chain genesis/spec, committee, validators, observer enforcement + last reference, a
    /// talk-stake summary, and the identity-binding count.
    State {
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
    },
    /// Read-only: the on-chain talk-stake ledger (posting weight + voting power per account), read from the
    /// node over RPC.
    Weight {
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
    },
    /// Read-only: tally who authored blocks (the Aura validators) over a range. Derives each block's author
    /// from its header (the `aura` slot digest → `Session::Validators[slot % n]`) — no runtime support
    /// needed. Range is `[--from, --to]` block heights; `--from-time`/`--to-time` (unix SECONDS) resolve to
    /// heights. Defaults: from block 1 to the latest finalized block.
    Authors {
        /// Range start block height (default: 1). Mutually exclusive with --from-time.
        #[arg(long)]
        from: Option<u32>,
        /// Range end block height (default: the latest finalized block). Mutually exclusive with --to-time.
        #[arg(long)]
        to: Option<u32>,
        /// Range start as a unix timestamp in SECONDS (resolved to a height). Mutually exclusive with --from.
        #[arg(long)]
        from_time: Option<i64>,
        /// Range end as a unix timestamp in SECONDS (resolved to a height). Mutually exclusive with --to.
        #[arg(long)]
        to_time: Option<i64>,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
    },
}

#[derive(Subcommand)]
enum ValidatorCmd {
    /// Committee motion: add a block-producing validator (bundled, or `--propose` for multi-custody).
    Add {
        /// The validator account (SS58).
        #[arg(long)]
        validator: String,
        #[command(flatten)]
        gov: GovOpts,
    },
    /// Committee motion: remove a validator (bundled, or `--propose` for multi-custody).
    Remove {
        /// The validator account (SS58).
        #[arg(long)]
        validator: String,
        #[command(flatten)]
        gov: GovOpts,
    },
    /// Self-signed: register the validator's OWN session keys (Aura sr25519 + GRANDPA ed25519). The
    /// validator signs this itself — not a committee motion.
    SetKeys {
        /// The validator's own account signing-key file (sr25519) — signs this registration.
        #[arg(long = "account-signing-key-file")]
        account_key: PathBuf,
        /// The Aura session-key file (sr25519).
        #[arg(long = "aura-signing-key-file")]
        aura_key: PathBuf,
        /// The GRANDPA session-key file (ed25519).
        #[arg(long = "grandpa-signing-key-file")]
        grandpa_key: PathBuf,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
        /// Prod profile: refuse well-known dev keys (//Alice..).
        #[arg(long)]
        prod: bool,
        /// Assert the connected chain's genesis hash matches this 0x-hex (refuse the wrong chain).
        #[arg(long)]
        genesis: Option<String>,
    },
}

#[derive(Subcommand)]
enum FuelCmd {
    /// Committee motion: set an account's standing REGENERATING fuel allowance (fund / top-up / regulate).
    /// Mints the account up to `max` now and regenerates it toward `max` each period. Bundled, or
    /// `--propose` for multi-custody.
    SetAllowance {
        /// The account to fund (SS58) — a validator candidate, or a committee member.
        #[arg(long)]
        account: String,
        /// The standing allowance ceiling, in base units (planck). Must be ≤ the runtime `MaxAllowance`
        /// and ≥ the existential deposit.
        #[arg(long)]
        max: String,
        #[command(flatten)]
        gov: GovOpts,
    },
    /// Committee motion: revoke an account's fuel — drop its allowance (stop regeneration) and claw back
    /// its balance. The hard cut for a spamming / offboarded member. Bundled, or `--propose` for
    /// multi-custody.
    Revoke {
        /// The account to cut off (SS58).
        #[arg(long)]
        account: String,
        #[command(flatten)]
        gov: GovOpts,
    },
}

#[derive(Subcommand)]
enum CommitteeCmd {
    /// Read-only: list open committee motions (index, hash, ayes/threshold, nays, end block, decoded inner
    /// call) — so a co-signer can discover what to vote on without out-of-band coordination.
    List {
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
    },
    /// Committee seat: cast YOUR seat's vote on an open motion. Online by default; `--offline` signs without
    /// a connection (air-gapped seat) and prints the signed extrinsic to broadcast with `submit`.
    Vote {
        /// The motion hash (0x-hex, 32 bytes) from `committee list`.
        #[arg(long)]
        proposal: String,
        /// The motion index from `committee list`.
        #[arg(long)]
        index: u32,
        /// Vote NAY instead of aye (default: aye).
        #[arg(long)]
        reject: bool,
        #[command(flatten)]
        seat: SeatOpts,
        /// Air-gapped: build + sign the vote WITHOUT connecting, and print the signed extrinsic hex.
        /// Requires --genesis, --spec-version, --tx-version, --nonce (none can be fetched offline).
        #[arg(long)]
        offline: bool,
        /// (offline) the chain's spec_version.
        #[arg(long)]
        spec_version: Option<u32>,
        /// (offline) the chain's transaction_version.
        #[arg(long)]
        tx_version: Option<u32>,
        /// (offline) this seat's account nonce.
        #[arg(long)]
        nonce: Option<u32>,
    },
    /// Committee seat: close a motion. If it reached threshold the inner call executes; if it can no longer
    /// pass (enough nays, or it lapsed) it is REMOVED without executing. Rejected with
    /// `FollowerCommittee.TooEarly` if still undecided and inside its voting window.
    Close {
        /// The motion hash (0x-hex, 32 bytes).
        #[arg(long)]
        proposal: String,
        /// The motion index.
        #[arg(long)]
        index: u32,
        #[command(flatten)]
        seat: SeatOpts,
    },
    /// Broadcast a pre-signed extrinsic (e.g. a `committee vote --offline` output) to the chain.
    Submit {
        /// The signed extrinsic hex (0x-optional).
        #[arg(long)]
        tx: String,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
        /// Return on first inclusion instead of waiting for finalization.
        #[arg(long)]
        no_finalize: bool,
    },
    /// Committee membership self-rotation (`add`/`remove` a member, or `set` the whole set).
    Members {
        #[command(subcommand)]
        cmd: MembersCmd,
    },
}

#[derive(Subcommand)]
enum MembersCmd {
    /// Committee motion: ADD a committee member (client-side `set_members` delta = current ∪ {member}).
    /// Bundled, or `--propose` for multi-custody.
    Add {
        /// The account (SS58) to add.
        #[arg(long)]
        member: String,
        #[command(flatten)]
        gov: GovOpts,
    },
    /// Committee motion: REMOVE a committee member (client-side delta = current \ {member}; refuses to
    /// remove the last member). Bundled, or `--propose` for multi-custody.
    Remove {
        /// The account (SS58) to remove.
        #[arg(long)]
        member: String,
        #[command(flatten)]
        gov: GovOpts,
    },
    /// Committee motion: SET the whole committee (bulk `set_members`; the decentralization path). Bundled,
    /// or `--propose` for multi-custody.
    Set {
        /// Comma-separated new member accounts (SS58).
        #[arg(long)]
        members: String,
        /// Optional prime member (SS58).
        #[arg(long)]
        prime: Option<String>,
        #[command(flatten)]
        gov: GovOpts,
    },
}

#[derive(Subcommand)]
enum UpgradeCmd {
    /// Committee motion: authorize a runtime upgrade. The motion records the 32-byte code hash
    /// on-chain; the WASM is uploaded afterwards with `upgrade apply`. Refuses a non-increasing spec_version
    /// (enforced on-chain at apply time). Bundled, or `--propose` for multi-custody.
    Authorize {
        /// The compiled runtime WASM to authorize — its `blake2_256` hash is what the committee approves.
        /// (Use the compact-compressed wasm.) Mutually exclusive with `--code-hash`.
        #[arg(long, value_name = "PATH")]
        wasm: Option<PathBuf>,
        /// Or authorize a code hash directly (0x-hex, 32 bytes). Mutually exclusive with `--wasm`.
        #[arg(long)]
        code_hash: Option<String>,
        #[command(flatten)]
        gov: GovOpts,
    },
    /// Self-signed (PERMISSIONLESS — any account, not a committee motion): upload the WASM for a
    /// previously-authorized upgrade. Enacts it if the hash matches and spec_version increases.
    Apply {
        /// The signing-key file of any account that submits the upload (no committee membership needed).
        #[arg(long = "account-signing-key-file")]
        account_key: PathBuf,
        /// The compiled runtime WASM (must hash to the authorized code hash).
        #[arg(long, value_name = "PATH")]
        wasm: PathBuf,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
        /// Prod profile: refuse well-known dev keys (//Alice..).
        #[arg(long)]
        prod: bool,
        /// Assert the connected chain's genesis hash matches this 0x-hex (refuse the wrong chain).
        #[arg(long)]
        genesis: Option<String>,
    },
}

#[derive(Subcommand)]
enum IdentityCmd {
    /// Read-only: print the EXACT CIP-8 bind-challenge payload to sign in your Cardano wallet (CIP-30
    /// signData), for the given account on the connected chain. Reads the live genesis; signs nothing.
    Prove {
        /// The chain account to bind (SS58). The payload commits its 32-byte AccountId.
        #[arg(long)]
        account: String,
        /// Optional 16-byte freshness nonce as 32 lowercase-hex chars (default: a fixed zero nonce).
        #[arg(long)]
        nonce: Option<String>,
        /// Node RPC ws endpoint (to fetch the live genesis the payload must commit).
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
    },
    /// BARE (unsigned): submit a wallet-produced CIP-8 PAYMENT-key proof. No key file — the COSE proof is
    /// the authorization, and the bound account is the one the proof commits.
    Bind {
        /// The COSE_Sign1 bytes (hex, 0x-optional) your wallet's signData returned (its `signature`).
        #[arg(long)]
        cose_sign1: String,
        /// The COSE_Key bytes (hex, 0x-optional) your wallet's signData returned (its `key`).
        #[arg(long)]
        cose_key: String,
        /// Optional cogno_v3 thread pointer (hex, 0x-optional; at most 10 bytes on-chain).
        #[arg(long)]
        thread: Option<String>,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
        /// Assert the connected chain's genesis hash matches this 0x-hex (refuse the wrong chain).
        #[arg(long)]
        genesis: Option<String>,
    },
    /// BARE (unsigned): submit a wallet-produced CIP-8 STAKE-key proof (voting power). The committed account
    /// must already be payment-bound (`identity bind`). No key file — the stake-key proof is the auth.
    BindStake {
        /// The COSE_Sign1 bytes (hex, 0x-optional) — the stake-key signData `signature`.
        #[arg(long)]
        cose_sign1: String,
        /// The COSE_Key bytes (hex, 0x-optional) — the stake-key signData `key`.
        #[arg(long)]
        cose_key: String,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
        /// Assert the connected chain's genesis hash matches this 0x-hex (refuse the wrong chain).
        #[arg(long)]
        genesis: Option<String>,
    },
    /// Read-only: resolve a bound account (SS58) → its 32-byte identity hash + 28-byte stake credential.
    Show {
        /// The chain account (SS58) to resolve.
        #[arg(long)]
        account: String,
        /// Node RPC ws endpoint.
        #[arg(long, default_value = DEFAULT_WS)]
        ws: String,
    },
    /// Committee motion: REVOKE an account's identity binding (the manual-operator-ban path). Flips
    /// `is_allowed` to false so the account can no longer post. Bundled, or `--propose` for multi-custody.
    Revoke {
        /// The account (SS58) to revoke.
        #[arg(long)]
        account: String,
        #[command(flatten)]
        gov: GovOpts,
    },
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // Surface the full error chain (incl. an inner-call revert) and exit non-zero.
            eprintln!("Error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.cmd {
        Command::Key { cmd } => match cmd {
            KeyCmd::Gen {
                scheme,
                out,
                description,
            } => cmd_key_gen(&scheme, &out, &description),
            KeyCmd::GenerateNodeKey { out } => cmd_generate_node_key(&out),
        },
        Command::Query { cmd } => match cmd {
            QueryCmd::State { ws } => query::run_state(&ws).await,
            QueryCmd::Weight { ws } => query::run_weight(&ws).await,
            QueryCmd::Authors {
                from,
                to,
                from_time,
                to_time,
                ws,
            } => query::run_authors(&ws, from, to, from_time, to_time).await,
        },
        Command::Validator { cmd } => match cmd {
            ValidatorCmd::Add { validator, gov } => {
                drive_governed(
                    &gov,
                    calls::add_validator(calls::parse_account(&validator)?),
                )
                .await
            }
            ValidatorCmd::Remove { validator, gov } => {
                drive_governed(
                    &gov,
                    calls::remove_validator(calls::parse_account(&validator)?),
                )
                .await
            }
            ValidatorCmd::SetKeys {
                account_key,
                aura_key,
                grandpa_key,
                ws,
                prod,
                genesis,
            } => {
                cmd_set_keys(
                    &account_key,
                    &aura_key,
                    &grandpa_key,
                    &ws,
                    prod,
                    genesis.as_deref(),
                )
                .await
            }
        },
        Command::Fuel { cmd } => match cmd {
            FuelCmd::SetAllowance { account, max, gov } => {
                drive_governed(
                    &gov,
                    calls::set_allowance(
                        calls::parse_account(&account)?,
                        calls::parse_balance(&max)?,
                    ),
                )
                .await
            }
            FuelCmd::Revoke { account, gov } => {
                drive_governed(&gov, calls::revoke_fuel(calls::parse_account(&account)?)).await
            }
        },
        Command::Committee { cmd } => match cmd {
            CommitteeCmd::List { ws } => cmd_committee_list(&ws).await,
            CommitteeCmd::Vote {
                proposal,
                index,
                reject,
                seat,
                offline,
                spec_version,
                tx_version,
                nonce,
            } => {
                cmd_committee_vote(
                    &seat,
                    &proposal,
                    index,
                    reject,
                    offline,
                    spec_version,
                    tx_version,
                    nonce,
                )
                .await
            }
            CommitteeCmd::Close {
                proposal,
                index,
                seat,
            } => cmd_committee_close(&seat, &proposal, index).await,
            CommitteeCmd::Submit {
                tx,
                ws,
                no_finalize,
            } => cmd_committee_submit(&tx, &ws, no_finalize).await,
            CommitteeCmd::Members { cmd } => match cmd {
                MembersCmd::Add { member, gov } => {
                    cmd_members(&gov, MemberAction::Add(&member)).await
                }
                MembersCmd::Remove { member, gov } => {
                    cmd_members(&gov, MemberAction::Remove(&member)).await
                }
                MembersCmd::Set {
                    members,
                    prime,
                    gov,
                } => {
                    cmd_members(
                        &gov,
                        MemberAction::Set {
                            members: &members,
                            prime: prime.as_deref(),
                        },
                    )
                    .await
                }
            },
        },
        Command::Upgrade { cmd } => match cmd {
            UpgradeCmd::Authorize {
                wasm,
                code_hash,
                gov,
            } => cmd_authorize_upgrade(wasm.as_deref(), code_hash.as_deref(), &gov).await,
            UpgradeCmd::Apply {
                account_key,
                wasm,
                ws,
                prod,
                genesis,
            } => cmd_apply_upgrade(&account_key, &wasm, &ws, prod, genesis.as_deref()).await,
        },
        Command::Identity { cmd } => match cmd {
            IdentityCmd::Prove { account, nonce, ws } => {
                identity::run_prove(&account, nonce.as_deref(), &ws).await
            }
            IdentityCmd::Bind {
                cose_sign1,
                cose_key,
                thread,
                ws,
                genesis,
            } => {
                identity::run_bind(
                    &cose_sign1,
                    &cose_key,
                    thread.as_deref(),
                    &ws,
                    genesis.as_deref(),
                )
                .await
            }
            IdentityCmd::BindStake {
                cose_sign1,
                cose_key,
                ws,
                genesis,
            } => identity::run_bind_stake(&cose_sign1, &cose_key, &ws, genesis.as_deref()).await,
            IdentityCmd::Show { account, ws } => identity::run_show(&account, &ws).await,
            IdentityCmd::Revoke { account, gov } => {
                drive_governed(&gov, calls::revoke(calls::parse_account(&account)?)).await
            }
        },
    }
}

fn cmd_key_gen(scheme: &str, out: &Path, description: &str) -> anyhow::Result<()> {
    let scheme = match scheme {
        "sr25519" => Scheme::Sr25519,
        "ed25519" => Scheme::Ed25519,
        other => anyhow::bail!("--scheme must be sr25519|ed25519 (got {other:?})"),
    };
    let (signer, env) = key::generate(scheme, description)?;
    key::write_envelope(out, &env)?;
    println!(
        "wrote {} key {} to {}",
        scheme.as_str(),
        signer.ss58(),
        out.display()
    );
    Ok(())
}

/// `key generate-node-key` — mint a libp2p ed25519 node (p2p) key file (raw hex secret, 0600) and print
/// its peer id + bootnode multiaddr. This is the node's stable NETWORK identity, NOT a session/account
/// key: a `--validator` node will not auto-generate one (the SDK refuses, to avoid an authority silently
/// adopting an unstable identity), so it is minted here — all key material in this workspace is minted by
/// the CLI, by file — and consumed by the node via `run --node-key-file`. Mirrors the SDK's own
/// `generate-node-key` (same `libp2p-identity` crate + on-disk hex format the node reads back).
fn cmd_generate_node_key(out: &Path) -> anyhow::Result<()> {
    use libp2p_identity::{ed25519, Keypair};
    use zeroize::Zeroize;

    let ed = ed25519::Keypair::generate();
    let secret = ed.secret(); // owned SecretKey (borrows &self); zeroized on drop
    let peer_id = Keypair::from(ed).public().to_peer_id();
    let mut secret_hex = hex::encode(secret.as_ref()); // 64 lowercase hex chars, no 0x — what --node-key-file reads
    key::write_secret_0600(out, secret_hex.as_bytes())?;
    secret_hex.zeroize();
    println!("wrote libp2p node key to {}", out.display());
    println!("peer id:  {peer_id}");
    println!("bootnode: /ip4/<PUBLIC_IP>/tcp/30333/p2p/{peer_id}");
    println!(
        "run it with:  cogno-chain-node run --validator … --node-key-file {}",
        out.display()
    );
    Ok(())
}

/// Parse an optional `--genesis 0x..` into an `H256`.
pub(crate) fn parse_genesis(s: &str) -> anyhow::Result<H256> {
    let h = s.trim().strip_prefix("0x").unwrap_or(s.trim());
    let b = hex::decode(h).context("--genesis must be hex")?;
    anyhow::ensure!(b.len() == 32, "--genesis must be a 32-byte hash");
    Ok(H256::from_slice(&b))
}

/// Connect, run `assertGenesis` if requested, and build the `ChainCtx` from the LIVE runtime version.
pub(crate) async fn connect_and_ctx(
    ws: &str,
    genesis: Option<&str>,
) -> anyhow::Result<(Rpc, ChainCtx)> {
    let rpc = Rpc::connect(ws).await?;
    let chain_genesis = rpc.genesis_hash().await?;
    if let Some(want) = genesis {
        let want = parse_genesis(want)?;
        anyhow::ensure!(
			chain_genesis == want,
			"genesis mismatch: connected chain {chain_genesis:#x} != expected {want:#x} — refusing to act \
			 against the wrong chain."
		);
    }
    let (spec_version, tx_version) = rpc.runtime_version().await?;
    eprintln!(
		"connected: genesis={chain_genesis:#x} spec_version={spec_version} transaction_version={tx_version}"
	);
    Ok((
        rpc,
        ChainCtx {
            genesis: chain_genesis,
            spec_version,
            tx_version,
        },
    ))
}

/// Load + dev-key-check the committee seat key files.
fn load_committee_signers(paths: &[PathBuf], prod: bool) -> anyhow::Result<Vec<Signer>> {
    let mut signers = Vec::with_capacity(paths.len());
    for p in paths {
        let s = load_signer(p)?;
        key::assert_not_dev_key(&s, prod)?;
        key::assert_key_file_secure(p, prod)?;
        signers.push(s);
    }
    Ok(signers)
}

/// Drive a typed governed inner call through the committee (the shared path for every committee-governed
/// verb). Loads the seat key(s), connects, and dispatches on `--propose`.
async fn drive_governed(
    gov: &GovOpts,
    inner: cogno_chain_runtime::RuntimeCall,
) -> anyhow::Result<()> {
    let signers = load_committee_signers(&gov.committee_keys, gov.prod)?;
    let (rpc, ctx) = connect_and_ctx(&gov.ws, gov.genesis.as_deref()).await?;
    drive_inner(&rpc, &ctx, inner, &signers, gov.propose, gov.threshold).await
}

/// Dispatch a typed governed inner call: with `propose` (exactly ONE seat), open the motion as one seat and
/// print co-sign instructions (true multi-custody); otherwise drive the whole bundled
/// `propose → vote×k → close` with the provided seats. Both faces feed the SAME lifecycle helpers.
async fn drive_inner(
    rpc: &Rpc,
    ctx: &ChainCtx,
    inner: cogno_chain_runtime::RuntimeCall,
    signers: &[Signer],
    propose: bool,
    threshold: Option<u32>,
) -> anyhow::Result<()> {
    if propose {
        anyhow::ensure!(
			signers.len() == 1,
			"--propose signs with exactly ONE committee seat (true multi-custody): pass a single \
			 --committee-signing-key-file (got {}). Co-signers then run `committee vote` / `committee close` \
			 from their own hosts.",
			signers.len()
		);
        return propose_one_seat(rpc, ctx, inner, &signers[0], threshold).await;
    }
    let resolved = resolve_committee(rpc, signers, threshold).await?;
    eprintln!(
        "committee threshold: {}-of-{} (from on-chain membership)",
        resolved.threshold, resolved.onchain_count
    );
    via_committee(rpc, ctx, inner, signers, &resolved).await
}

/// Propose a typed governed inner call as ONE seat (true multi-custody): verify this seat is an on-chain
/// member, compute the motion threshold (on-chain 3/5 unless overridden, never below it), propose, and print
/// the co-sign instructions for the other seats.
async fn propose_one_seat(
    rpc: &Rpc,
    ctx: &ChainCtx,
    inner: cogno_chain_runtime::RuntimeCall,
    signer: &Signer,
    explicit_threshold: Option<u32>,
) -> anyhow::Result<()> {
    let members = committee::committee_members(rpc).await?;
    anyhow::ensure!(
        !members.is_empty(),
        "FollowerCommittee has no on-chain members — seat it at genesis first."
    );
    anyhow::ensure!(
        members.contains(&signer.account_id()),
        "{} is not an on-chain committee member — only a member can propose.",
        signer.ss58()
    );
    let min = committee::threshold_for(members.len());
    let thr = resolve_motion_threshold(explicit_threshold, min, members.len())?;
    eprintln!(
        "committee: {} member(s); motion threshold {thr}",
        members.len()
    );
    match committee::propose_motion(rpc, ctx, inner, signer, thr).await? {
        committee::ProposeOutcome::ExecutedOnPropose { block } => {
            println!("✓ executed on propose (finalized {block:#x})")
        }
        committee::ProposeOutcome::Open {
            proposal_hash,
            index,
        } => {
            println!("✓ proposed motion #{index} {proposal_hash:#x}");
            println!("  co-sign: cogno-chain-cli committee vote  --proposal {proposal_hash:#x} --index {index} --committee-signing-key-file <seat>");
            println!("  close:   cogno-chain-cli committee close --proposal {proposal_hash:#x} --index {index} --committee-signing-key-file <seat>");
        }
    }
    Ok(())
}

/// The motion threshold: the on-chain 3/5 minimum, or a stricter explicit override (never below it).
fn resolve_motion_threshold(explicit: Option<u32>, min: u32, n: usize) -> anyhow::Result<u32> {
    match explicit {
        None => Ok(min),
        Some(t) => {
            anyhow::ensure!(
				t >= 1 && t >= min,
				"--threshold {t} is below the 3/5 minimum {min} for this committee of {n} — the inner call \
				 would BadOrigin. Use >= {min}."
			);
            Ok(t)
        }
    }
}

/// The committee-membership delta a `committee members` verb applies.
enum MemberAction<'a> {
    /// Add one member (`current ∪ {m}`).
    Add(&'a str),
    /// Remove one member (`current \ {m}`).
    Remove(&'a str),
    /// Replace the whole set with `members` (comma-separated SS58), optional `prime`.
    Set {
        members: &'a str,
        prime: Option<&'a str>,
    },
}

/// Propose/drive a committee-membership change as a `set_members` motion. The new set is computed
/// client-side from the live `FollowerCommittee::Members` (pallet-collective has no incremental add/remove
/// call), then routed through the same bundled/`--propose` path as every other governed call.
async fn cmd_members(gov: &GovOpts, action: MemberAction<'_>) -> anyhow::Result<()> {
    let signers = load_committee_signers(&gov.committee_keys, gov.prod)?;
    let (rpc, ctx) = connect_and_ctx(&gov.ws, gov.genesis.as_deref()).await?;
    let mut members = committee::committee_members(&rpc).await?;
    anyhow::ensure!(
        !members.is_empty(),
        "FollowerCommittee has no on-chain members — seat it at genesis first."
    );
    // `set_members` needs `old_count` = the CURRENT membership size (advisory weight hint).
    let old_count = members.len() as u32;
    let (new_members, prime) = match action {
        MemberAction::Add(m) => {
            let target = calls::parse_account(m)?;
            anyhow::ensure!(
                !members.contains(&target),
                "{m} is already a committee member."
            );
            members.push(target);
            (members, None)
        }
        MemberAction::Remove(m) => {
            let target = calls::parse_account(m)?;
            let before = members.len();
            members.retain(|x| x != &target);
            anyhow::ensure!(members.len() < before, "{m} is not a committee member.");
            anyhow::ensure!(
                !members.is_empty(),
                "refusing to remove the last committee member (would brick governance)."
            );
            (members, None)
        }
        MemberAction::Set {
            members: list,
            prime,
        } => {
            let new = list
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(calls::parse_account)
                .collect::<anyhow::Result<Vec<_>>>()?;
            anyhow::ensure!(
				!new.is_empty(),
				"--members must list at least one account (an empty committee would brick governance)."
			);
            let prime = prime.map(calls::parse_account).transpose()?;
            (new, prime)
        }
    };
    let inner = calls::set_members(new_members, prime, old_count);
    drive_inner(&rpc, &ctx, inner, &signers, gov.propose, gov.threshold).await
}

/// Load THIS seat's single signing key + dev-key-check it (for `committee vote`/`close`).
fn load_seat_signer(seat: &SeatOpts) -> anyhow::Result<Signer> {
    let signer = load_signer(&seat.committee_key)?;
    key::assert_not_dev_key(&signer, seat.prod)?;
    key::assert_key_file_secure(&seat.committee_key, seat.prod)?;
    Ok(signer)
}

#[allow(clippy::too_many_arguments)]
async fn cmd_committee_vote(
    seat: &SeatOpts,
    proposal: &str,
    index: u32,
    reject: bool,
    offline: bool,
    spec_version: Option<u32>,
    tx_version: Option<u32>,
    nonce: Option<u32>,
) -> anyhow::Result<()> {
    let signer = load_seat_signer(seat)?;
    let phash = calls::parse_hash32(proposal)?;
    let approve = !reject;
    if offline {
        // Air-gapped: no RPC. genesis/spec/tx/nonce must be supplied; we sign and print the extrinsic.
        let genesis = seat
            .genesis
            .as_deref()
            .context("--offline requires --genesis (it cannot be fetched without a connection)")?;
        let ctx = ChainCtx {
            genesis: parse_genesis(genesis)?,
            spec_version: spec_version.context("--offline requires --spec-version")?,
            tx_version: tx_version.context("--offline requires --tx-version")?,
        };
        let n = nonce.context("--offline requires --nonce")?;
        let xt = build_signed(calls::vote(phash, index, approve), &signer, n, 0, &ctx);
        eprintln!(
			"offline-signed vote ({} on motion #{index}) as {} — broadcast with `committee submit --tx <hex>`",
			if approve { "aye" } else { "nay" },
			signer.ss58()
		);
        println!("0x{}", hex::encode(&xt));
        return Ok(());
    }
    let (rpc, ctx) = connect_and_ctx(&seat.ws, seat.genesis.as_deref()).await?;
    committee::vote_motion(&rpc, &ctx, phash, index, approve, &signer).await?;
    println!(
        "✓ vote ({}) recorded on motion #{index}",
        if approve { "aye" } else { "nay" }
    );
    Ok(())
}

async fn cmd_committee_close(seat: &SeatOpts, proposal: &str, index: u32) -> anyhow::Result<()> {
    let signer = load_seat_signer(seat)?;
    let phash = calls::parse_hash32(proposal)?;
    let (rpc, ctx) = connect_and_ctx(&seat.ws, seat.genesis.as_deref()).await?;
    committee::close_motion(&rpc, &ctx, phash, index, &signer).await?;
    Ok(())
}

async fn cmd_committee_list(ws: &str) -> anyhow::Result<()> {
    let rpc = Rpc::connect(ws).await?;
    let members = committee::committee_members(&rpc).await?;
    let hashes = committee::proposal_hashes(&rpc).await?;
    let min = if members.is_empty() {
        0
    } else {
        committee::threshold_for(members.len())
    };
    if hashes.is_empty() {
        println!(
            "no open committee motions ({} member(s), 3/5 threshold {min})",
            members.len()
        );
        return Ok(());
    }
    println!(
        "{} open committee motion(s) ({} member(s), 3/5 threshold {min}):",
        hashes.len(),
        members.len()
    );
    for h in &hashes {
        match (
            committee::voting_of(&rpc, h).await?,
            committee::proposal_of(&rpc, h).await?,
        ) {
            (Some(v), Some(c)) => {
                println!("  motion #{} {h:#x}", v.index);
                println!(
                    "    ayes {}/{} | nays {} | end block {}",
                    v.ayes.len(),
                    v.threshold,
                    v.nays.len(),
                    v.end
                );
                println!("    call: {}", committee::describe_call(&c));
            }
            _ => println!("  {h:#x}  (no Voting/ProposalOf entry — closing or just executed)"),
        }
    }
    Ok(())
}

async fn cmd_committee_submit(tx: &str, ws: &str, no_finalize: bool) -> anyhow::Result<()> {
    let h = tx.trim().strip_prefix("0x").unwrap_or(tx.trim());
    let bytes = hex::decode(h).context("--tx must be hex")?;
    let rpc = Rpc::connect(ws).await?;
    let block = rpc.submit_and_watch(&bytes, !no_finalize, "submit").await?;
    // Surface a landed-but-REVERTED extrinsic (e.g. a stale/duplicate vote that passes pool validation but
    // fails at dispatch) — matching every other write verb, all of which assert the extrinsic didn't revert.
    // Without this, `submit` prints success for an extrinsic that silently failed on-chain.
    assert_extrinsic_ok(&rpc, block, &bytes, "submit").await?;
    println!("✓ extrinsic included in {block:#x}");
    Ok(())
}

/// Authorize a committee-governed runtime upgrade: derive the 32-byte `code_hash` (from the
/// compiled WASM, or taken directly), then drive `GovernedUpgrade::authorize_upgrade` through the committee.
async fn cmd_authorize_upgrade(
    wasm: Option<&Path>,
    code_hash: Option<&str>,
    gov: &GovOpts,
) -> anyhow::Result<()> {
    let hash = match (wasm, code_hash) {
        (Some(path), None) => {
            let code = std::fs::read(path)
                .with_context(|| format!("reading runtime WASM {}", path.display()))?;
            anyhow::ensure!(!code.is_empty(), "runtime WASM {} is empty", path.display());
            let h = H256::from(sp_crypto_hashing::blake2_256(&code));
            eprintln!(
                "upgrade authorize: code_hash {h:#x} (blake2_256 of {} bytes from {})",
                code.len(),
                path.display()
            );
            h
        }
        (None, Some(s)) => {
            let h = calls::parse_hash32(s)?;
            eprintln!("upgrade authorize: code_hash {h:#x} (from --code-hash)");
            h
        }
        (Some(_), Some(_)) => anyhow::bail!("pass exactly one of --wasm or --code-hash, not both"),
        (None, None) => {
            anyhow::bail!("pass --wasm <path> (to hash the compiled runtime) or --code-hash <0x..>")
        }
    };
    drive_governed(gov, calls::authorize_upgrade(hash)).await
}

/// Upload the WASM for a previously-authorized upgrade — a PERMISSIONLESS, self-signed extrinsic (any
/// account). `frame_system` re-derives the hash and refuses a mismatched blob or a non-increasing
/// spec_version. An invalid-version upgrade does NOT fail the extrinsic (it emits
/// `RejectedInvalidAuthorizedUpgrade` and pays no fee), so success is confirmed via `System::CodeUpdated`.
async fn cmd_apply_upgrade(
    account_key: &Path,
    wasm: &Path,
    ws: &str,
    prod: bool,
    genesis: Option<&str>,
) -> anyhow::Result<()> {
    let account = load_signer(account_key)?;
    key::assert_not_dev_key(&account, prod)?;
    key::assert_key_file_secure(account_key, prod)?;
    let code =
        std::fs::read(wasm).with_context(|| format!("reading runtime WASM {}", wasm.display()))?;
    anyhow::ensure!(!code.is_empty(), "runtime WASM {} is empty", wasm.display());
    let hash = H256::from(sp_crypto_hashing::blake2_256(&code));

    let (rpc, ctx) = connect_and_ctx(ws, genesis).await?;
    let nonce = rpc.account_nonce(&account.ss58()).await?;
    let xt = build_signed(
        calls::apply_authorized_upgrade(code.clone()),
        &account,
        nonce,
        0,
        &ctx,
    );
    eprintln!(
        "upgrade apply: uploading {} bytes (code_hash {hash:#x}) as {}",
        code.len(),
        account.ss58()
    );
    let block = rpc
        .submit_and_watch(&xt, true, "apply_authorized_upgrade")
        .await?;
    // A FAILED extrinsic (System.NothingAuthorized / Unauthorized) surfaces here, matched to our xt …
    assert_extrinsic_ok(&rpc, block, &xt, "apply_authorized_upgrade").await?;
    // … but an invalid-VERSION upgrade does not fail the extrinsic — it emits RejectedInvalidAuthorizedUpgrade
    // + pays no fee. So confirm the outcome from the block's events.
    let events = committee::events_at(&rpc, block).await?;
    for ev in &events {
        if let cogno_chain_runtime::RuntimeEvent::System(
            frame_system::Event::RejectedInvalidAuthorizedUpgrade { error, .. },
        ) = ev
        {
            anyhow::bail!(
				"upgrade apply: the chain REJECTED the upgrade ({}) — code-hash mismatch or a non-increasing \
				 spec_version",
				committee::format_dispatch_error(error)
			);
        }
    }
    let enacted = events.iter().any(|ev| {
        matches!(
            ev,
            cogno_chain_runtime::RuntimeEvent::System(frame_system::Event::CodeUpdated { .. })
        )
    });
    anyhow::ensure!(
		enacted,
		"upgrade apply: no System.CodeUpdated event — the upload landed but the upgrade did not enact (was a \
		 matching code hash authorized first?)"
	);
    println!("✓ runtime upgrade enacted (:code updated) in {block:#x}");
    Ok(())
}

async fn cmd_set_keys(
    account_key: &Path,
    aura_key: &Path,
    grandpa_key: &Path,
    ws: &str,
    prod: bool,
    genesis: Option<&str>,
) -> anyhow::Result<()> {
    let account = load_signer(account_key)?;
    key::assert_not_dev_key(&account, prod)?;
    key::assert_key_file_secure(account_key, prod)?;
    let aura = load_signer(aura_key)?;
    let grandpa = load_signer(grandpa_key)?;
    // Dev-key-check the SESSION keys too: the registered aura key seals blocks and the grandpa key signs
    // finality votes — a dev session key is a publicly known authority key, exactly what --prod must refuse.
    key::assert_not_dev_key(&aura, prod)?;
    key::assert_not_dev_key(&grandpa, prod)?;
    key::assert_key_file_secure(aura_key, prod)?;
    key::assert_key_file_secure(grandpa_key, prod)?;
    let aura_pub = aura.require_sr25519_public()?;
    let grandpa_pub = grandpa.require_ed25519_public()?;

    // Proof-of-possession: each session key signs `b"POP_" ++ <account bytes>` (the owner the pallet
    // checks); the proof is the SCALE tuple of the two fixed-size signatures (= their concatenation).
    let mut statement = b"POP_".to_vec();
    statement.extend_from_slice(&account.public_bytes());
    let mut proof = aura.sign_raw(&statement);
    proof.extend_from_slice(&grandpa.sign_raw(&statement));

    let inner = calls::set_keys(aura_pub, grandpa_pub, proof);
    let (rpc, ctx) = connect_and_ctx(ws, genesis).await?;
    let nonce = rpc.account_nonce(&account.ss58()).await?;
    let xt = build_signed(inner, &account, nonce, 0, &ctx);
    eprintln!(
        "set_keys as {} (aura {} / grandpa {})",
        account.ss58(),
        aura.ss58(),
        grandpa.ss58()
    );
    let block = rpc.submit_and_watch(&xt, true, "set_keys").await?;
    // Surface a landed-but-reverted set_keys (e.g. Session.InvalidProof) with its real reason.
    assert_extrinsic_ok(&rpc, block, &xt, "set_keys").await?;
    println!("✓ set_keys finalized in {block:#x}");
    Ok(())
}
