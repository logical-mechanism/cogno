// M2d/M7 — full EXIT (unlock): spend a talk_vault UTxO + burn its beacon (-1) in ONE tx, reclaiming
// the locked ADA to the owner. This proves the contract's SPEND path LIVE (M2d only proved mint+lock
// live; the spend path was only aiken-checked). Mirrors the contract's `[]` full-exit continuation rule:
//   - spend the vault UTxO with the `Spend` redeemer (owner payment sig required, every path)
//   - burn the beacon bound to THIS datum (mint -1, `Burn(name)` redeemer)
//   - NO continuing output to the vault → the reclaimed ADA flows back to the owner as change
// The own-input-count==1 guard means exactly ONE vault per tx; pass a target if several exist.
// Reuses the live db-sync (fetcher + vault discovery) + Ogmios (submitter/evaluator) + the M2d cost-model fix.
//
//   node scripts/m2d-unlock.mjs [<txHash>#<index>]
//
// LEGACY DEMO TOOLING (frozen): reads the vault descriptor from /tmp/cogno-m2/vault.json directly. The
// always-on path is the durable, committee-driven services/committee/sync-weight.mjs; in the product,
// reclaiming locked ADA is done from the frontend's in-browser CIP-30 flow, not here.
import fs from "node:fs";
import { MeshTxBuilder, serializePlutusScript } from "@meshsdk/core";
import { getOwnerWallet, dbsync, ogmios, fetchCostModels } from "./m2d-wallet.mjs";
import { burnRedeemerCborHex } from "./m2d-beacon.mjs";
import { readUnspentMatches } from "./lib/dbsync.mjs";

const DBSYNC_URL = process.env.DBSYNC_URL || process.env.DBSYNC || "postgres://cogno_reader@127.0.0.1:5432/cexplorer";
const vaultMeta = JSON.parse(fs.readFileSync("/tmp/cogno-m2/vault.json", "utf8"));
const VAULT_HASH = vaultMeta.vaultHash;
const APPLIED_CBOR = vaultMeta.appliedCbor;
// VaultRedeemer::Spend = Constr 0 [] (the on-chain validator ignores the redeemer value, but it must
// still type-decode as VaultRedeemer). 0xd8 0x79 = tag 121; 0x80 = empty array.
const SPEND_REDEEMER = "d87980";
const TARGET = process.argv[2]; // optional "<txHash>#<index>"

async function main() {
  const { wallet, address, paymentKeyHash, stakeKeyHash } = await getOwnerWallet({ withProvider: true });

  // The vault address (script payment cred + the owner's stake cred) — for the script input.
  const { address: vaultAddress } = serializePlutusScript(
    { code: APPLIED_CBOR, version: "V3" }, stakeKeyHash, 0, false,
  );

  // 1) find the live vault UTxO(s) via db-sync: each must hold exactly 1 beacon of this policy.
  const matches = await readUnspentMatches(DBSYNC_URL, VAULT_HASH);
  const vaults = [];
  for (const m of matches) {
    const assets = m.value?.assets ?? {};
    const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === VAULT_HASH.toLowerCase());
    if (beacons.length === 1 && Number(beacons[0][1]) === 1) {
      vaults.push({
        txHash: m.transaction_id,
        index: m.output_index,
        ref: `${m.transaction_id}#${m.output_index}`,
        coins: String(m.value.coins),
        beacon: beacons[0][0].split(".")[1].toLowerCase(),
        createdSlot: m.created_at?.slot_no ?? 0,
      });
    }
  }
  if (!vaults.length) throw new Error("no live vault UTxO observed via db-sync");
  let target;
  if (TARGET) {
    target = vaults.find((v) => v.ref === TARGET);
    if (!target) throw new Error(`target ${TARGET} not among live vaults: ${vaults.map((v) => v.ref).join(", ")}`);
  } else if (vaults.length === 1) {
    target = vaults[0];
  } else {
    // default: the OLDEST vault (so a fresh-lock demo can burn the original, leaving the new one).
    target = vaults.slice().sort((a, b) => a.createdSlot - b.createdSlot)[0];
    console.log(`multiple vaults — defaulting to OLDEST ${target.ref} (pass a ref to override): ${vaults.map((v) => v.ref).join(", ")}`);
  }
  const unit = VAULT_HASH + target.beacon;
  const vaultAmount = [
    { unit: "lovelace", quantity: target.coins },
    { unit, quantity: "1" },
  ];

  console.log("owner   :", address);
  console.log("vault   :", vaultAddress);
  console.log("exiting :", target.ref, `(${BigInt(target.coins) / 1_000_000n} ADA + beacon ${target.beacon.slice(0, 12)}…)`);

  // 2) collateral: a pure-ADA UTxO (≥5 ADA), returned on success.
  const utxos = await wallet.getUtxos();
  if (!utxos.length) throw new Error("owner wallet has no UTxOs — fund it first (collateral + fee)");
  const collateral = utxos.find((u) => u.output.amount.length === 1 && BigInt(u.output.amount[0].quantity) >= 5_000_000n);
  if (!collateral) throw new Error("no pure-ADA UTxO ≥5 ADA for collateral — fund the owner wallet");

  const burnRedeemer = burnRedeemerCborHex(target.beacon);

  const txBuilder = new MeshTxBuilder({ fetcher: dbsync(), submitter: ogmios(), evaluator: ogmios(), verbose: false });
  txBuilder
    // ── spend the vault UTxO (inline datum present; embedded script) ──
    .spendingPlutusScriptV3()
    .txIn(target.txHash, target.index, vaultAmount, vaultAddress)
    .txInScript(APPLIED_CBOR)
    .txInInlineDatumPresent()
    .txInRedeemerValue(SPEND_REDEEMER, "CBOR")
    // ── burn the beacon bound to THIS vault (-1) ──
    .mintPlutusScriptV3()
    .mint("-1", VAULT_HASH, target.beacon)
    .mintingScript(APPLIED_CBOR)
    .mintRedeemerValue(burnRedeemer, "CBOR")
    // ── collateral + owner sig; reclaimed ADA flows to owner as change (no vault output = full exit) ──
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(paymentKeyHash)
    .changeAddress(address)
    .selectUtxosFrom(utxos);

  // Inject live preprod cost models (the fetcher can't supply them; MeshJS defaults are stale → bad
  // script integrity hash). An array makes completeCostModels() keep ours.
  txBuilder.setCostModels(await fetchCostModels());
  await txBuilder.complete();
  const signed = await wallet.signTx(txBuilder.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log("UNLOCK/BURN SUBMITTED ✓ txHash:", txHash);
  fs.writeFileSync("/tmp/cogno-m2/unlock.json", JSON.stringify({ txHash, exited: target.ref, beacon: target.beacon, reclaimed: target.coins, owner: address }, null, 2));
}
main().catch((e) => { console.error("UNLOCK FAILED:", e?.message || e); process.exit(1); });
