// In-browser talk_vault lock / exit — the L1 "interact with the smart contract" half of the wallet
// button. A browser port of app/scripts/cardano-reference/m2d-{lock,unlock}.mjs: identical tx shape, but the
// signer is the user's connected CIP-30 wallet and the provider is Blockfrost (which supplies live
// cost models, so no manual setCostModels). MeshJS is browser-only, so every runtime dependency is
// imported INSIDE the async functions — this module is import-safe during the static export.
//
// The dual-key discipline holds: the Cardano wallet signs the lock/exit txs (and CIP-8 bind); it
// NEVER signs a post. Posting uses the separate sr25519 key. This module never sees a private key.
import type { BrowserWallet, UTxO } from "@meshsdk/core";
import { VAULT_HASH, APPLIED_CBOR, MIN_LOCK, assertBlueprintIntegrity } from "./blueprint";
import {
  beaconNameHex,
  vaultDatumCborHex,
  mintRedeemerCborHex,
  burnRedeemerCborHex,
  SPEND_REDEEMER_CBOR,
} from "./beacon";
import { preflightLock } from "./preflight";
import { getProvider } from "./provider";

export interface OwnerKeys {
  address: string;
  paymentKeyHash: string;
  stakeKeyHash: string;
}

export interface VaultInfo {
  /** the script address (vault hash payment cred + the owner's stake cred). */
  vaultAddress: string;
  /** the 32-byte beacon name == the app-chain identity hash (blake2b_256(owner)). */
  beacon: string;
  /** policyId + beacon — the full asset unit. */
  unit: string;
  owner: OwnerKeys;
}

/** Enable the wallet and derive the owner keys + the vault address / beacon for this owner. */
async function resolveVault(walletId: string): Promise<{ wallet: BrowserWallet; info: VaultInfo }> {
  const [{ BrowserWallet }, cst] = await Promise.all([import("@meshsdk/core"), import("@meshsdk/core-cst")]);
  const wallet = await BrowserWallet.enable(walletId);
  if ((await wallet.getNetworkId()) !== 0) {
    // Name the cause: this used to say "connect a Cardano wallet", which misread as a connection problem
    // rather than a network mismatch (connect + both binds now catch this earlier — see wallet-derive.ts).
    throw new Error("Switch your wallet to preprod (testnet), then reconnect.");
  }
  const address = await wallet.getChangeAddress();
  const props = cst.Address.fromBech32(address).getProps();
  if (props.paymentPart?.type !== 0) {
    throw new Error("Connect a normal wallet address, not a script address.");
  }
  const paymentKeyHash = props.paymentPart.hash;
  const stakeKeyHash = props.delegationPart?.hash;
  if (!stakeKeyHash) {
    throw new Error("This wallet address has no stake key. Use a base address.");
  }
  const { serializePlutusScript } = await import("@meshsdk/core");
  const { address: vaultAddress } = serializePlutusScript({ code: APPLIED_CBOR, version: "V3" }, stakeKeyHash, 0, false);
  const beacon = beaconNameHex(paymentKeyHash, stakeKeyHash);
  return { wallet, info: { vaultAddress, beacon, unit: VAULT_HASH + beacon, owner: { address, paymentKeyHash, stakeKeyHash } } };
}

/** A pure-ADA collateral UTxO (≥5 ADA) — the wallet's own pick, else the first that qualifies. */
function pickCollateral(collateral: UTxO[], utxos: UTxO[]): UTxO {
  const c =
    collateral[0] ??
    utxos.find((u) => u.output.amount.length === 1 && BigInt(u.output.amount[0].quantity) >= 5_000_000n);
  if (!c) throw new Error("Your wallet needs an ADA-only collateral UTxO of at least 5 ADA.");
  return c;
}

/** Progress phases for a lock/exit tx, so the UI can show a live step flow (the wallet sign and the
 *  Cardano submit are distinct waits, and the submit after signing otherwise reads as "stuck"). */
export type VaultTxPhase = "signing" | "submitting";

/** Lock `lockLovelace` (default = min_lock) at the vault + mint the owner's beacon. */
export async function lockIntoVault(
  walletId: string,
  lockLovelace: bigint = MIN_LOCK,
  onPhase?: (p: VaultTxPhase) => void,
): Promise<{ txHash: string; info: VaultInfo }> {
  await assertBlueprintIntegrity();
  const { wallet, info } = await resolveVault(walletId);
  const { paymentKeyHash, stakeKeyHash } = info.owner;
  preflightLock({ paymentKeyHash, stakeKeyHash, lockLovelace, beacon: info.beacon });

  const { MeshTxBuilder } = await import("@meshsdk/core");
  const provider = await getProvider();
  const utxos = await wallet.getUtxos();
  if (!utxos.length) throw new Error("Your wallet is empty. Add ADA first.");
  const collateral = pickCollateral(await wallet.getCollateral(), utxos);

  const datum = vaultDatumCborHex(paymentKeyHash, stakeKeyHash);
  const redeemer = mintRedeemerCborHex(paymentKeyHash, stakeKeyHash);

  const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, evaluator: provider, verbose: false });
  tx.mintPlutusScriptV3()
    .mint("1", VAULT_HASH, info.beacon)
    .mintingScript(APPLIED_CBOR)
    .mintRedeemerValue(redeemer, "CBOR")
    .txOut(info.vaultAddress, [
      { unit: "lovelace", quantity: lockLovelace.toString() },
      { unit: info.unit, quantity: "1" },
    ])
    .txOutInlineDatumValue(datum, "CBOR")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(paymentKeyHash)
    .changeAddress(info.owner.address)
    .selectUtxosFrom(utxos);
  await tx.complete();
  onPhase?.("signing");
  const signed = await wallet.signTx(tx.txHex);
  onPhase?.("submitting");
  const txHash = await wallet.submitTx(signed);
  return { txHash, info };
}

/** Full exit: spend the vault UTxO + burn the beacon (-1), reclaiming the locked ADA to the owner. */
export async function exitVault(
  walletId: string,
  onPhase?: (p: VaultTxPhase) => void,
): Promise<{ txHash: string; info: VaultInfo }> {
  await assertBlueprintIntegrity();
  const { wallet, info } = await resolveVault(walletId);
  const { MeshTxBuilder } = await import("@meshsdk/core");
  const provider = await getProvider();

  const vaultUtxos = await provider.fetchAddressUTxOs(info.vaultAddress, info.unit);
  const target = vaultUtxos[0];
  if (!target) throw new Error("No locked ADA found for this wallet.");

  const utxos = await wallet.getUtxos();
  const collateral = pickCollateral(await wallet.getCollateral(), utxos);
  const burnRedeemer = burnRedeemerCborHex(info.beacon);

  const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, evaluator: provider, verbose: false });
  tx.spendingPlutusScriptV3()
    .txIn(target.input.txHash, target.input.outputIndex, target.output.amount, target.output.address)
    .txInScript(APPLIED_CBOR)
    .txInInlineDatumPresent()
    .txInRedeemerValue(SPEND_REDEEMER_CBOR, "CBOR")
    .mintPlutusScriptV3()
    .mint("-1", VAULT_HASH, info.beacon)
    .mintingScript(APPLIED_CBOR)
    .mintRedeemerValue(burnRedeemer, "CBOR")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(info.owner.paymentKeyHash)
    .changeAddress(info.owner.address)
    .selectUtxosFrom(utxos);
  await tx.complete();
  onPhase?.("signing");
  const signed = await wallet.signTx(tx.txHex);
  onPhase?.("submitting");
  const txHash = await wallet.submitTx(signed);
  return { txHash, info };
}

/** Read whether this wallet currently has a live vault + how much is locked (for UI state). */
export async function fetchVaultState(walletId: string): Promise<{ info: VaultInfo; locked: bigint | null }> {
  const { info } = await resolveVault(walletId);
  try {
    const provider = await getProvider();
    const utxos = await provider.fetchAddressUTxOs(info.vaultAddress, info.unit);
    const u = utxos[0];
    const locked = u ? BigInt(u.output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0") : null;
    return { info, locked };
  } catch {
    return { info, locked: null };
  }
}
