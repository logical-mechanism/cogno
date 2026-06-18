// M2d owner wallet — the preprod wallet that owns the talk_vault (the identity) AND signs the anchor
// relayer's paid Cardano txs. The mnemonic is persisted (testnet only, NOT committed) so every step
// reuses the SAME funded wallet. The local Kupo (fetcher) + Ogmios (submitter/evaluator) back it, so no
// Blockfrost is needed. `node scripts/m2d-wallet.mjs` prints the address to fund.
//
// PROD-READINESS Phase 1: the wallet now lives in the DURABLE data dir (COGNO_DATA_DIR / systemd
// StateDirectory) written 0600 — NOT volatile, world-readable /tmp, where a reboot/tmpfs clear would
// destroy the funded signing key and the relayer would silently brew a fresh empty one and stop
// anchoring. An existing /tmp/cogno-m2/owner.json is MIGRATED on first read. And we REFUSE to brew a new
// wallet unless COGNO_ALLOW_WALLET_BREW is set, so a missing key fails loudly instead of rotating to an
// unfunded address.
import fs from "node:fs";
import { MeshWallet, KupoProvider, OgmiosProvider } from "@meshsdk/core";
import * as cst from "@meshsdk/core-cst";
import { statePaths, migrateFromLegacy, ensureDataDir } from "../../services/_shared/paths.mjs";

const { file: WALLET_FILE, legacy: WALLET_LEGACY } = statePaths("OWNER_FILE", "owner.json");
// Brewing a fresh wallet is a deliberate, one-time act (first-time setup / dev) — gate it behind an
// explicit opt-in so a missing key on a real deployment fails loudly rather than silently rotating to
// an unfunded address and stopping anchoring.
const ALLOW_BREW = ["1", "true", "yes"].includes((process.env.COGNO_ALLOW_WALLET_BREW || "").toLowerCase());
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
  // Migrate an existing funded wallet off legacy /tmp before deciding to brew (preserves the key).
  if (migrateFromLegacy(WALLET_FILE, WALLET_LEGACY))
    console.warn(`migrated relayer wallet ${WALLET_LEGACY} → ${WALLET_FILE} (0600). Delete the plaintext legacy copy: rm ${WALLET_LEGACY}`);
  if (fs.existsSync(WALLET_FILE)) {
    mnemonic = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).mnemonic;
  } else {
    if (!ALLOW_BREW)
      throw new Error(`No wallet at ${WALLET_FILE} and COGNO_ALLOW_WALLET_BREW is unset — refusing to silently brew a NEW (empty, unfunded) wallet, which would make the relayer stop anchoring. To reuse an existing wallet set OWNER_FILE=/path/to/owner.json (or place it at ${WALLET_FILE}); to deliberately create a fresh one re-run with COGNO_ALLOW_WALLET_BREW=1, then FUND the printed address.`);
    mnemonic = MeshWallet.brew(); // 24-word array
    ensureDataDir();
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ mnemonic }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(WALLET_FILE, 0o600); } catch { /* best-effort tighten if umask widened it */ }
    console.warn(`brewed a NEW wallet at ${WALLET_FILE} (0600) — FUND this address before anchoring.`);
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
