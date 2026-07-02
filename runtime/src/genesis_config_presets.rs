// This file is part of Substrate.

// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use crate::{
	AccountId, BalancesConfig, FollowerCommitteeConfig, RuntimeGenesisConfig, SessionConfig,
	SessionKeys, TalkStakeConfig, ValidatorSetConfig,
};
use alloc::{vec, vec::Vec};
use frame_support::build_struct_json_patch;
use serde_json::Value;
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_consensus_grandpa::AuthorityId as GrandpaId;
use sp_core::{ed25519, sr25519};
use sp_genesis_builder::{self, PresetId};
use sp_keyring::{Ed25519Keyring, Sr25519Keyring};

// Returns the genesis config presets populated with given parameters.
//
// M6 (DR-26): authorities are seated through `pallet-session`, NOT the aura/grandpa GenesisConfig
// (the two are mutually exclusive — `L3-chain.md` §8.2). Each initial authority registers its
// `(Aura, Grandpa)` session keys here; `pallet-validator-set` seats the same accounts as the
// initial mutable validator set. The aura/grandpa pallets then derive their authorities from the
// session at genesis (via `SessionHandler::on_genesis_session`) and at every rotation thereafter.
fn testnet_genesis(
	initial_authorities: Vec<(AccountId, AuraId, GrandpaId)>,
	endowed_accounts: Vec<AccountId>,
	committee: Vec<AccountId>,
	// (account, allowed_stake, voting_power) triples to seed talk-stake at genesis. On preprod/mainnet this
	// is EMPTY — the cardano-observer inherent credits real Cardano weight from block 0. On the no-Cardano
	// dev/local chains it seeds posting weight so the app is usable without a lock.
	initial_weights: Vec<(AccountId, u128, u128)>,
) -> Value {
	build_struct_json_patch!(RuntimeGenesisConfig {
		balances: BalancesConfig {
			balances: endowed_accounts
				.iter()
				.cloned()
				.map(|k| (k, 1u128 << 60))
				.collect::<Vec<_>>(),
		},
		// M6: register each initial authority's session keys. `validator_id == account` (identity
		// ValidatorIdOf). Aura+GRANDPA authorities are populated from these at genesis.
		session: SessionConfig {
			keys: initial_authorities
				.iter()
				.cloned()
				.map(|(account, aura, grandpa)| {
					(account.clone(), account, SessionKeys { aura, grandpa })
				})
				.collect::<Vec<_>>(),
		},
		// M6: seat the initial MUTABLE validator set (the same accounts). `add_validator` /
		// `remove_validator` mutate this later, applied at a session boundary.
		validator_set: ValidatorSetConfig {
			initial_validators: initial_authorities
				.iter()
				.map(|(account, _, _)| account.clone())
				.collect::<Vec<_>>(),
		},
		// SUDO-FREE: no `SudoConfig` — there is no root key. Seat the initial FollowerCommittee (the SOLE
		// governance authority; at 1 seat the 3/5 threshold is `ceil(1*3/5)=1`, so the founder governs
		// alone and a motion executes on propose). Members must be endowed (propose/vote/close are
		// fee-bearing under the retained talk-capacity fee model); the caller passes committee ⊆ endowed.
		follower_committee: FollowerCommitteeConfig { members: committee },
		// Observer-is-sole-writer: talk-stake has no `set_stake` call, so the ONLY way weight enters a
		// no-Cardano chain is this genesis seed. Empty on preprod/mainnet (the inherent credits real weight).
		talk_stake: TalkStakeConfig { initial_weights },
	})
}

/// One authority's genesis keys: `(account, Aura(sr25519), Grandpa(ed25519))`.
/// ⚑ Aura and GRANDPA are DISTINCT keypairs (sr25519 vs ed25519) — seated from the same-named dev
/// keyring (Alice→Alice, Bob→Bob) so they stay in lockstep.
fn alice_authority() -> (AccountId, AuraId, GrandpaId) {
	(
		Sr25519Keyring::Alice.to_account_id(),
		Sr25519Keyring::Alice.public().into(),
		Ed25519Keyring::Alice.public().into(),
	)
}

fn bob_authority() -> (AccountId, AuraId, GrandpaId) {
	(
		Sr25519Keyring::Bob.to_account_id(),
		Sr25519Keyring::Bob.public().into(),
		Ed25519Keyring::Bob.public().into(),
	)
}

/// Dev/local talk-stake seed. Because the `cardano-observer` inherent is the SOLE weight writer and there
/// is no Cardano on `--dev`/`local`, seed each well-known dev account with generous posting weight +
/// voting power so the app is immediately usable without locking ADA. `(account, allowed_stake, voting)`.
fn dev_weights() -> Vec<(AccountId, u128, u128)> {
	const ALLOWED: u128 = 10_000_000_000; // 10k ADA of "locked" weight → generous posting capacity
	const VOTING: u128 = 1_000_000_000_000; // 1M ADA of voting power
	[
		Sr25519Keyring::Alice,
		Sr25519Keyring::Bob,
		Sr25519Keyring::Charlie,
		Sr25519Keyring::Dave,
		Sr25519Keyring::Eve,
	]
	.iter()
	.map(|k| (k.to_account_id(), ALLOWED, VOTING))
	.collect::<Vec<_>>()
}

/// Return the development genesis config — the SUDO-FREE single-operator bootstrap: one authority
/// (`//Alice`) and a **single-seat committee** (`//Alice`). At 1 member the 3/5 threshold is
/// `ceil(1*3/5)=1`, so the founder governs alone and a motion executes on propose, with no root key. The
/// other dev accounts are endowed (not seated) so they can be voted into the committee / validator set
/// later — the same centralized→federated→decentralized path a real operator genesis walks.
pub fn development_config_genesis() -> Value {
	testnet_genesis(
		// One genesis authority (`//Alice`); add more at runtime via `validator add` (committee-voted).
		vec![alice_authority()],
		// Endow the well-known dev accounts + stashes so they can pay fees and be voted in.
		vec![
			Sr25519Keyring::Alice.to_account_id(),
			Sr25519Keyring::Bob.to_account_id(),
			Sr25519Keyring::Charlie.to_account_id(),
			Sr25519Keyring::Dave.to_account_id(),
			Sr25519Keyring::Eve.to_account_id(),
			Sr25519Keyring::AliceStash.to_account_id(),
			Sr25519Keyring::BobStash.to_account_id(),
		],
		// A single committee seat (`//Alice`) — the founder-governs-alone bootstrap.
		vec![Sr25519Keyring::Alice.to_account_id()],
		// Seed posting weight + voting power (no Cardano on --dev; the observer is the only other writer).
		dev_weights(),
	)
}

/// Return the local genesis config preset — the PRE-FEDERATED rig: two authorities (`//Alice` + `//Bob`)
/// and a **5-seat committee** (`//Alice`…`//Eve`) so the real 3-of-5 governance path (`ceil(5*3/5)=3`) is
/// drivable locally without waiting to federate.
pub fn local_config_genesis() -> Value {
	testnet_genesis(
		vec![alice_authority(), bob_authority()],
		Sr25519Keyring::iter()
			.filter(|v| v != &Sr25519Keyring::One && v != &Sr25519Keyring::Two)
			.map(|v| v.to_account_id())
			.collect::<Vec<_>>(),
		// The 5-seat committee — exercises the real 3-of-5 path (all are in the endowed set above).
		vec![
			Sr25519Keyring::Alice.to_account_id(),
			Sr25519Keyring::Bob.to_account_id(),
			Sr25519Keyring::Charlie.to_account_id(),
			Sr25519Keyring::Dave.to_account_id(),
			Sr25519Keyring::Eve.to_account_id(),
		],
		dev_weights(),
	)
}

/// Build an **operator-keyed** genesis (the `cogno-chain-node gen-chainspec` subcommand): the same shape
/// as [`development_config_genesis`] but with the validator authorities, committee, and endowment seeded
/// from OPERATOR key FILES (via `cogno-keyfile`) instead of the well-known dev keys — the production-genesis
/// gap, closed. It lives here (not in the node) so the genesis shape stays defined alongside the presets.
/// Inputs are raw public-key bytes so the node need not depend on the `AuraId`/`GrandpaId` app-crypto types.
///
/// - `validators`: one `(account, aura_sr25519_pub, grandpa_ed25519_pub)` per genesis authority.
/// - `committee`: the initial committee member accounts (the sole sudo-free governance authority).
/// - `extra_endowed`: further accounts to fund (the validator + committee accounts are ALWAYS endowed so
///   they can pay the fee-bearing governance calls).
///
/// Talk-stake weights are seeded EMPTY: on a real (preprod) chain the cardano-observer inherent is the sole
/// weight writer and credits actual locked-ADA vault weight from block 0 (there is no `set_stake` call).
pub fn operator_genesis(
	validators: Vec<(AccountId, [u8; 32], [u8; 32])>,
	committee: Vec<AccountId>,
	extra_endowed: Vec<AccountId>,
) -> Value {
	let authorities: Vec<(AccountId, AuraId, GrandpaId)> = validators
		.into_iter()
		.map(|(account, aura, grandpa)| {
			(
				account,
				AuraId::from(sr25519::Public::from_raw(aura)),
				GrandpaId::from(ed25519::Public::from_raw(grandpa)),
			)
		})
		.collect();
	let mut endowed: Vec<AccountId> = authorities
		.iter()
		.map(|(a, _, _)| a.clone())
		.chain(committee.iter().cloned())
		.chain(extra_endowed)
		.collect();
	endowed.sort();
	endowed.dedup();
	// EMPTY initial weights: the observer credits real Cardano vault weight from block 0 (sole writer).
	testnet_genesis(authorities, endowed, committee, Vec::new())
}

/// Provides the JSON representation of predefined genesis config for given `id`.
pub fn get_preset(id: &PresetId) -> Option<Vec<u8>> {
	let patch = match id.as_ref() {
		sp_genesis_builder::DEV_RUNTIME_PRESET => development_config_genesis(),
		sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET => local_config_genesis(),
		_ => return None,
	};
	Some(
		serde_json::to_string(&patch)
			.expect("serialization to json is expected to work. qed.")
			.into_bytes(),
	)
}

/// List of supported presets.
pub fn preset_names() -> Vec<PresetId> {
	vec![
		PresetId::from(sp_genesis_builder::DEV_RUNTIME_PRESET),
		PresetId::from(sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET),
	]
}
