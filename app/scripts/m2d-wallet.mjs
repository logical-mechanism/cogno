// M2d owner wallet — a temp preprod wallet that owns the talk_vault (the identity). The mnemonic is
// persisted to /tmp/cogno-m2/owner.json (testnet only, low value, NOT committed) so every M2d step
// reuses the SAME wallet. The local Kupo (fetcher) + Ogmios (submitter/evaluator) back it, so no
// Blockfrost is needed. `node scripts/m2d-wallet.mjs` prints the address to fund.
import fs from "node:fs";
import { MeshWallet, KupoProvider, OgmiosProvider } from "@meshsdk/core";
import * as cst from "@meshsdk/core-cst";

const WALLET_FILE = process.env.OWNER_FILE || "/tmp/cogno-m2/owner.json";
const OGMIOS = process.env.OGMIOS || "http://127.0.0.1:1337";
const KUPO = process.env.KUPO || "http://127.0.0.1:1442";

export function kupo() {
  return new KupoProvider(KUPO);
}
export function ogmios() {
  return new OgmiosProvider(OGMIOS);
}

/** The live preprod cost models from Ogmios, as the [v1, v2, v3] integer-array list MeshTxBuilder
 * wants (setCostModels). REQUIRED: KupoProvider doesn't implement fetchCostModels, so MeshJS falls
 * back to its bundled defaults — but those are stale vs preprod's Conway PlutusV3 (350 params), so
 * the script integrity hash mismatches and the ledger rejects the tx. Inject the real ones instead. */
export async function fetchCostModels() {
  const res = await fetch(OGMIOS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/protocolParameters" }),
  });
  const { result } = await res.json();
  const cm = result.plutusCostModels;
  return [cm["plutus:v1"], cm["plutus:v2"], cm["plutus:v3"]];
}

/** Load (or first-time create + persist) the owner wallet. networkId 0 = preprod/testnet.
 * `withProvider` attaches the Kupo fetcher + Ogmios submitter (needed for utxos/submit, not for
 * deriving the address). */
export async function getOwnerWallet({ withProvider = false } = {}) {
  let mnemonic;
  if (fs.existsSync(WALLET_FILE)) {
    mnemonic = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).mnemonic;
  } else {
    mnemonic = MeshWallet.brew(); // 24-word array
    fs.mkdirSync("/tmp/cogno-m2", { recursive: true });
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ mnemonic }, null, 2));
  }
  const opts = {
    networkId: 0,
    key: { type: "mnemonic", words: Array.isArray(mnemonic) ? mnemonic : mnemonic.split(" ") },
  };
  if (withProvider) {
    opts.fetcher = kupo();
    opts.submitter = ogmios();
  }
  const wallet = new MeshWallet(opts);
  if (wallet.init) await wallet.init();
  const address = await wallet.getChangeAddress();
  const props = cst.Address.fromBech32(address).getProps();
  return {
    wallet,
    address,
    paymentKeyHash: props.paymentPart?.hash,
    stakeKeyHash: props.delegationPart?.hash,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { address, paymentKeyHash, stakeKeyHash } = await getOwnerWallet();
  console.log(JSON.stringify({ address, paymentKeyHash, stakeKeyHash }, null, 2));
  process.exit(0);
}
