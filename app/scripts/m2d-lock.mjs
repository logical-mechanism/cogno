// M2d — lock ≥100 ADA at the talk_vault + mint the owner's beacon, in ONE tx (preprod, live).
// Mirrors the contract's create rule: mint beacon(owner) +1, output it at the vault's OWN address
// (script payment cred + the owner's stake cred), value ≥ min_lock, inline VaultDatum{owner}, owner
// signs. Uses the local Kupo (fetcher) + Ogmios (submitter/evaluator). Prints the tx hash.
// The script is embedded in the tx (a reference-script variant is an optional follow-up, see
// docs/M2d-build.md §Acceptance).
//
//   node scripts/m2d-lock.mjs
//
// LEGACY DEMO TOOLING (frozen): a single-operator M2d/M8 showcase script. It still reads the vault
// descriptor from /tmp/cogno-m2/vault.json directly; the always-on path is the durable, committee-driven
// services/committee/sync-weight.mjs (VAULT_FILE under $COGNO_DATA_DIR). In the product, locking is done
// from the frontend's in-browser CIP-30 flow, not here.
import fs from "node:fs";
import { MeshTxBuilder, serializePlutusScript } from "@meshsdk/core";
import { getOwnerWallet, kupo, ogmios, fetchCostModels } from "./m2d-wallet.mjs";
import { beaconNameHex, vaultDatumCborHex, mintRedeemerCborHex } from "./m2d-beacon.mjs";

const LOCK_LOVELACE = process.env.LOCK || "100000000"; // 100 ADA (== min_lock)
const vaultMeta = JSON.parse(fs.readFileSync("/tmp/cogno-m2/vault.json", "utf8"));
const VAULT_HASH = vaultMeta.vaultHash;
const APPLIED_CBOR = vaultMeta.appliedCbor;

async function main() {
  const { wallet, address, paymentKeyHash, stakeKeyHash } = await getOwnerWallet({ withProvider: true });

  // The vault address: script payment cred (the vault hash) + the OWNER's stake key (DR-01).
  const { address: vaultAddress } = serializePlutusScript(
    { code: APPLIED_CBOR, version: "V3" },
    stakeKeyHash,
    0, // preprod / testnet
    false, // key stake credential (not script)
  );

  const beacon = beaconNameHex(paymentKeyHash, stakeKeyHash);
  const datum = vaultDatumCborHex(paymentKeyHash, stakeKeyHash);
  const redeemer = mintRedeemerCborHex(paymentKeyHash, stakeKeyHash);
  const unit = VAULT_HASH + beacon;

  console.log("owner  :", address);
  console.log("vault  :", vaultAddress);
  console.log("beacon :", beacon, "(policy", VAULT_HASH + ")");

  const utxos = await wallet.getUtxos();
  if (!utxos.length) throw new Error("owner wallet has no UTxOs — fund it first");
  // Collateral: a pure-ADA UTxO (≥5 ADA), returned on success.
  const collateral = utxos.find((u) => u.output.amount.length === 1 && BigInt(u.output.amount[0].quantity) >= 5_000_000n) || utxos[0];

  const txBuilder = new MeshTxBuilder({ fetcher: kupo(), submitter: ogmios(), evaluator: ogmios(), verbose: false });
  txBuilder
    .mintPlutusScriptV3()
    .mint("1", VAULT_HASH, beacon)
    .mintingScript(APPLIED_CBOR)
    .mintRedeemerValue(redeemer, "CBOR")
    .txOut(vaultAddress, [
      { unit: "lovelace", quantity: LOCK_LOVELACE },
      { unit, quantity: "1" },
    ])
    .txOutInlineDatumValue(datum, "CBOR")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(paymentKeyHash)
    .changeAddress(address)
    .selectUtxosFrom(utxos);

  // Inject the live preprod cost models (Kupo can't supply them; MeshJS defaults are stale → bad
  // script integrity hash). An array makes completeCostModels() keep ours instead of clobbering.
  txBuilder.setCostModels(await fetchCostModels());
  await txBuilder.complete();
  const signed = await wallet.signTx(txBuilder.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log("LOCK SUBMITTED ✓ txHash:", txHash);
  fs.writeFileSync("/tmp/cogno-m2/lock.json", JSON.stringify({ txHash, vaultAddress, beacon, unit, owner: address, paymentKeyHash, stakeKeyHash, lock: LOCK_LOVELACE }, null, 2));
}
main().catch((e) => { console.error("LOCK FAILED:", e?.message || e); process.exit(1); });
