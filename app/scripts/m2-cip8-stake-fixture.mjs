// Generate a REAL CIP-8 STAKE-key bind fixture with a headless MeshJS wallet — the programmatic
// stand-in for an in-browser CIP-30 signData over the REWARD address (signed with the STAKE key).
// Used to test `pallet_cogno_gate::cip8::verify_bind_proof_stake` + `link_stake_signed` end-to-end.
//
//   node scripts/m2-cip8-stake-fixture.mjs [account_uri] [nonce_hex]
//
// Emits one JSON line with the COSE_Sign1 (signature), the COSE_Key, the committed account+genesis,
// and the proven stake credential, plus a self-check that blake2b_224(pubkey) == the reward
// address's stake credential (the exact bind the on-chain verifier enforces).
import * as core from "@meshsdk/core";
import * as cst from "@meshsdk/core-cst";
import { blake2b } from "blakejs";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { toHex } from "polkadot-api/utils";

const GENESIS = process.env.GENESIS || "27af38570ab072a2a78232fdf46ac5e957eaa4c44a5c92d06b564558bfb2ed16";
const MNEMONIC = (process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice").split(" ");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const accountUri = args[0] || "//CognoGateA";
const nonceHex = args[1] || "ab".repeat(16);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const accountHex = toHex(derive(accountUri).publicKey).replace(/^0x/, "");
const payload = `cogno-chain/bind/v1;genesis=${GENESIS};account=${accountHex};nonce=${nonceHex}`;

const wallet = new core.MeshWallet({ networkId: 0, key: { type: "mnemonic", words: MNEMONIC } });
if (wallet.init) await wallet.init();

const rewardAddresses = await wallet.getRewardAddresses();
if (!rewardAddresses.length) throw new Error("wallet exposes no reward addresses");
const rewardAddr = rewardAddresses[0];
const rewardRaw = cst.Address.fromBech32(rewardAddr).toBytes().toString(); // 29-byte hex
const stakeCredHex = rewardRaw.slice(2); // drop the 1-byte header → 28-byte stake credential

const sig = await wallet.signData(payload, rewardAddr);

// Self-check: the COSE key's pubkey must blake2b-224-hash to the reward address's stake credential
// — exactly what `verify_bind_proof_stake` asserts on-chain.
const pubkey = cst.getPublicKeyFromCoseKey(sig.key);
const pubkeyHex = (typeof pubkey === "string" ? pubkey : pubkey.hex?.() ?? String(pubkey)).replace(/^0x/, "");
const computedCred = toHex(blake2b(Uint8Array.from(Buffer.from(pubkeyHex, "hex")), undefined, 28)).replace(/^0x/, "");

console.log(JSON.stringify({
  payload, genesis: GENESIS, accountUri, accountHex, nonceHex,
  reward_address: rewardAddr, reward_raw_hex: rewardRaw, stake_cred_hex: stakeCredHex,
  pubkey_hex: pubkeyHex, computed_cred_hex: computedCred,
  cred_matches: computedCred === stakeCredHex,
  signature: sig.signature, key: sig.key,
}, null, 2));
process.exit(0);
