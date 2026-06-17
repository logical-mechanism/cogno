// M2d — CIP-8 bind the OWNER's Cardano address → an sr25519 posting account, via the follower.
// The owner's Cardano wallet signs the follower's committed payload once (signData); the follower
// verifies it and binds blake2b_256(cbor.serialise(owner address)) (== the vault's beacon name) to
// the sr25519 account. So the bind and the vault meet at the SAME beacon name.
//
//   node scripts/m2d-bind.mjs            # posting account = //CognoVaultPoster (dev derivation)
import { createClient, FixedSizeBinary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";
import { toHex } from "polkadot-api/utils";
import fs from "node:fs";
import { getOwnerWallet } from "./m2d-wallet.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const FOLLOWER = process.env.FOLLOWER || "http://127.0.0.1:8090";
const POSTER_URI = process.env.POSTER || "//CognoVaultPoster";
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

async function main() {
  const { wallet, address } = await getOwnerWallet(); // owner Cardano wallet (signData only)
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const posterPub = derive(POSTER_URI).publicKey;
  const account = toHex(posterPub).replace(/^0x/, "");
  const ss58 = ss58Address(posterPub, 42);
  console.log("owner (Cardano):", address);
  console.log("poster (sr25519):", ss58, `(${POSTER_URI})`);

  const nres = await (await fetch(`${FOLLOWER}/nonce?account=${account}`)).json();
  const sig = await wallet.signData(nres.payload, address);
  const bres = await (await fetch(`${FOLLOWER}/bind`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature: sig.signature, key: sig.key, signing_address: address, sr25519_pubkey: account }),
  })).json();
  if (!bres.ok) throw new Error(`follower rejected: ${bres.error}`);
  console.log("BIND OK ✓ identity (beacon name):", bres.identity_hash);

  // AccountOf readback
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const bound = await api.query.CognoGate.AccountOf.getValue(FixedSizeBinary.fromBytes(hexToBytes(bres.identity_hash)));
  console.log("AccountOf readback:", bound === ss58 ? "== my poster ✓" : `MISMATCH (${bound})`);
  fs.writeFileSync("/tmp/cogno-m2/bind.json", JSON.stringify({ identityHash: bres.identity_hash, posterSs58: ss58, posterHex: account, ownerAddress: address }, null, 2));
  client.destroy();
  process.exit(bound === ss58 ? 0 : 1);
}
main().catch((e) => { console.error("BIND FAILED:", e?.message || e); process.exit(1); });
