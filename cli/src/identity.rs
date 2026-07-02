//! Self-service CIP-8 identity binding — cogno's payment-key + stake-key binds (NOT a committee op).
//!
//! `prove` prints the exact bind-challenge payload to sign in the user's Cardano wallet (CIP-30 `signData`);
//! `bind` / `bind-stake` submit the wallet-produced COSE_Sign1 + COSE_Key as a **BARE (unsigned)** extrinsic
//! — the CIP-8 proof carried in the call IS the authorization (`ensure_none` + `validate_unsigned` at the
//! pool), so there is no signing account and no fee (a zero-balance derived account binds with no sponsor).
//! `show` resolves a bound account → its 32-byte identity hash + 28-byte stake credential.

use anyhow::Context;
use sp_core::hashing::blake2_128;
use sp_core::H256;
use sp_runtime::AccountId32;

use crate::calls;
use crate::committee::{assert_extrinsic_ok, storage_prefix};
use crate::query::ss58;
use crate::rpc::Rpc;
use crate::tx::build_bare;

/// Parse hex (`0x`-optional) into bytes.
fn parse_hex(s: &str) -> anyhow::Result<Vec<u8>> {
	let h = s.trim().strip_prefix("0x").unwrap_or(s.trim());
	hex::decode(h).with_context(|| format!("invalid hex {s:?}"))
}

/// SS58 → the raw 32-byte AccountId.
fn account_bytes(account: &str) -> anyhow::Result<[u8; 32]> {
	use sp_core::crypto::Ss58Codec;
	let a = AccountId32::from_ss58check(account.trim())
		.map_err(|e| anyhow::anyhow!("invalid SS58 account {account:?}: {e:?}"))?;
	let mut out = [0u8; 32];
	out.copy_from_slice(a.as_ref());
	Ok(out)
}

/// Connect and, if `--genesis` was given, assert the connected chain's genesis matches (refuse the wrong
/// chain — the bind payload commits a specific genesis).
async fn connect_checked(ws: &str, genesis: Option<&str>) -> anyhow::Result<(Rpc, H256)> {
	let rpc = Rpc::connect(ws).await?;
	let chain_genesis = rpc.genesis_hash().await?;
	if let Some(want) = genesis {
		let want = crate::parse_genesis(want)?;
		anyhow::ensure!(
			chain_genesis == want,
			"genesis mismatch: connected chain {chain_genesis:#x} != expected {want:#x} — refusing to act \
			 against the wrong chain."
		);
	}
	Ok((rpc, chain_genesis))
}

/// `identity prove` — print the EXACT CIP-8 bind challenge to sign in the wallet, for `account` on the
/// connected chain. The payload byte-for-byte matches the on-chain `cip8::parse_payload` grammar
/// (`cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>`).
pub async fn run_prove(account: &str, nonce: Option<&str>, ws: &str) -> anyhow::Result<()> {
	let rpc = Rpc::connect(ws).await?;
	let genesis = rpc.genesis_hash().await?;
	let acct = account_bytes(account)?;
	let nonce_hex = match nonce {
		Some(n) => {
			let n = n.trim();
			anyhow::ensure!(
				n.len() == 32 && n.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
				"--nonce must be exactly 32 lowercase-hex chars (a 16-byte freshness nonce)"
			);
			n.to_string()
		},
		// The nonce carries no on-chain anti-replay weight (the proof commits the account + the 1:1 maps
		// enforce single-bind), so a fixed zero default is fine; pass --nonce for a fresh-looking challenge.
		None => "0".repeat(32),
	};
	let payload = format!(
		"cogno-chain/bind/v1;genesis={};account={};nonce={}",
		hex::encode(genesis.as_bytes()),
		hex::encode(acct),
		nonce_hex
	);
	println!("CIP-8 bind challenge for {account}");
	println!("  chain genesis: {genesis:#x}");
	println!();
	println!("In your Cardano wallet, run CIP-30 signData(addr, payload) where `addr`'s credential is your");
	println!("posting/stake key, and `payload` is EXACTLY this string (no trailing newline):");
	println!();
	println!("{payload}");
	println!();
	println!("Then submit the wallet output (`signature` = COSE_Sign1, `key` = COSE_Key) BARE (no key file):");
	println!("  cogno-chain-cli identity bind --cose-sign1 0x<signature> --cose-key 0x<key> --ws {ws}");
	Ok(())
}

/// `identity bind` — submit a wallet-produced CIP-8 PAYMENT-key proof as a BARE (unsigned) extrinsic. No
/// key file: the COSE proof (signed OFF-chain in the wallet) IS the authorization, and the bound account is
/// the one the proof commits (not any submitter).
pub async fn run_bind(
	cose_sign1_hex: &str,
	cose_key_hex: &str,
	thread_hex: Option<&str>,
	ws: &str,
	genesis: Option<&str>,
) -> anyhow::Result<()> {
	let cose_sign1 = parse_hex(cose_sign1_hex)?;
	let cose_key = parse_hex(cose_key_hex)?;
	let thread = thread_hex.map(parse_hex).transpose()?;
	let call = calls::link_identity_signed(cose_sign1, cose_key, thread)?;
	let (rpc, _genesis) = connect_checked(ws, genesis).await?;
	let xt = build_bare(call);
	eprintln!("identity bind (BARE/unsigned — the COSE proof is the authorization)");
	let block = rpc.submit_and_watch(&xt, true, "identity bind").await?;
	// Surface a landed-but-reverted bind (CognoGate.ProofInvalid / AlreadyBound / WrongGenesis / …) with its
	// typed reason, matched to OUR extrinsic by index.
	assert_extrinsic_ok(&rpc, block, &xt, "identity bind").await?;
	println!("✓ identity bind finalized in {block:#x}");
	println!("  next (voting power): cogno-chain-cli identity bind-stake --cose-sign1 0x.. --cose-key 0x.. --ws {ws}");
	Ok(())
}

/// `identity bind-stake` — submit a wallet-produced CIP-8 STAKE-key proof as a BARE extrinsic (voting
/// power). The account it commits must already be payment-bound (`identity bind`). No key file — the
/// stake-key proof is the authorization.
pub async fn run_bind_stake(
	cose_sign1_hex: &str,
	cose_key_hex: &str,
	ws: &str,
	genesis: Option<&str>,
) -> anyhow::Result<()> {
	let cose_sign1 = parse_hex(cose_sign1_hex)?;
	let cose_key = parse_hex(cose_key_hex)?;
	let call = calls::link_stake_signed(cose_sign1, cose_key)?;
	let (rpc, _genesis) = connect_checked(ws, genesis).await?;
	let xt = build_bare(call);
	eprintln!("identity bind-stake (BARE/unsigned — the stake-key COSE proof is the authorization)");
	let block = rpc.submit_and_watch(&xt, true, "identity bind-stake").await?;
	assert_extrinsic_ok(&rpc, block, &xt, "identity bind-stake").await?;
	println!("✓ stake bind finalized in {block:#x}");
	Ok(())
}

/// `identity show` — resolve a bound account (SS58) → its 32-byte identity hash (cogno-gate `PkhOf`) and its
/// 28-byte stake credential (`StakeCredOf`), if any.
pub async fn run_show(account: &str, ws: &str) -> anyhow::Result<()> {
	let rpc = Rpc::connect(ws).await?;
	let acct = calls::parse_account(account)?;
	let enc = acct.encode_bytes();

	let mut pkh_key = storage_prefix("CognoGate", "PkhOf");
	pkh_key.extend_from_slice(&blake2_128(&enc));
	pkh_key.extend_from_slice(&enc);
	let identity = rpc.storage_decode::<[u8; 32]>(&pkh_key, None).await?;

	let mut sc_key = storage_prefix("CognoGate", "StakeCredOf");
	sc_key.extend_from_slice(&blake2_128(&enc));
	sc_key.extend_from_slice(&enc);
	let stake_cred = rpc.storage_decode::<[u8; 28]>(&sc_key, None).await?;

	match identity {
		Some(id) => println!("account {} ↔ identity 0x{}", ss58(&acct), hex::encode(id)),
		None => {
			println!("account {} has no identity binding", ss58(&acct));
			return Ok(());
		},
	}
	match stake_cred {
		Some(sc) => println!("  stake credential (voting power): 0x{}", hex::encode(sc)),
		None => println!("  stake credential (voting power): <not bound>"),
	}
	Ok(())
}

/// Local helper: the raw 32-byte SCALE encoding of an `AccountId32` storage key (no length prefix). An
/// `AccountId32` encodes as its 32 bytes verbatim, so this is just the account bytes.
trait EncodeBytes {
	fn encode_bytes(&self) -> Vec<u8>;
}
impl EncodeBytes for AccountId32 {
	fn encode_bytes(&self) -> Vec<u8> {
		<AccountId32 as AsRef<[u8]>>::as_ref(self).to_vec()
	}
}
