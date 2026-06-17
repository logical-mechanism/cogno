// Generate a REAL CIP-8 bind fixture with a headless MeshJS wallet — the programmatic stand-in
// for an in-browser CIP-30 signData, used to test the Cogno-Follower end-to-end (DONE-WHEN #3).
// Emits one line of JSON with everything the follower needs to verify + the values the frontend
// computes, so the follower's pycardano side can assert byte-for-byte agreement.
//
//   node scripts/m2-cip8-fixture.mjs [account_uri] [nonce_hex] [--enterprise] [--wrong-claim]
//
// account_uri  : the sr25519 posting account to commit (dev derivation, default //CognoGateA)
// nonce_hex    : the nonce to embed (default ab*16; pass a follower-issued nonce for a live bind)
// --enterprise : sign from a type-6 enterprise address (default: type-0 base)
// --wrong-claim: claim a DIFFERENT address than was signed (drives the wrong-address NEGATIVE test)
import * as core from "@meshsdk/core";
import * as cst from "@meshsdk/core-cst";
import { blake2b } from "blakejs";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { toHex } from "polkadot-api/utils";

const GENESIS = process.env.GENESIS || "27af38570ab072a2a78232fdf46ac5e957eaa4c44a5c92d06b564558bfb2ed16";
// A fixed test mnemonic — a stand-in for the user's real CIP-30 wallet (no funds involved).
const MNEMONIC = (process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice").split(" ");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const accountUri = args[0] || "//CognoGateA";
const nonceHex = args[1] || "ab".repeat(16);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const accountHex = toHex(derive(accountUri).publicKey).replace(/^0x/, "");
const payload = `cogno-chain/bind/v1;genesis=${GENESIS};account=${accountHex};nonce=${nonceHex}`;

const wallet = new core.MeshWallet({
  networkId: 0,
  key: { type: "mnemonic", words: MNEMONIC },
  ...(flags.has("--enterprise") ? { addressType: "enterprise" } : {}),
});
if (wallet.init) await wallet.init();
const address = await wallet.getChangeAddress();
const sig = await wallet.signData(payload, address);

// What the frontend computes for the AccountOf readback / the gate: the whole-Address hash.
const rawHex = cst.Address.fromBech32(address).toBytes().toString();
const idHashHex = toHex(blake2b(Uint8Array.from(Buffer.from(rawHex, "hex")), undefined, 32)).replace(/^0x/, "");

// For the wrong-address negative test, claim a different (still valid) address.
const claimed = flags.has("--wrong-claim")
  ? await (async () => {
      const w2 = new core.MeshWallet({ networkId: 0, key: { type: "mnemonic", words: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".split(" ") } });
      if (w2.init) await w2.init();
      return w2.getChangeAddress();
    })()
  : address;

console.log(JSON.stringify({
  payload, genesis: GENESIS, accountUri, accountHex, nonceHex,
  signing_address: claimed, signed_address: address, addressRawHex: rawHex, idHashHex,
  signature: sig.signature, key: sig.key,
}));
process.exit(0);
