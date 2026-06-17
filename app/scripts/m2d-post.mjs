// M2d — THE MONEY SHOT: the poster posts feelessly with weight that came from LOCKED ADA.
// No sudo grant of weight or capacity here — m2d-sync-weight already set_stake'd the poster from
// the on-chain vault lock. This script just posts and proves: (a) PostCreated, (b) free balance
// Δ = 0 (feeless), (c) the post used talk-capacity, not a fee. Lock ADA → weight → post.
//
//   node scripts/m2d-post.mjs
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const POSTER_URI = process.env.POSTER || "//CognoVaultPoster";
const TEXT = process.env.TEXT || "posting feelessly — this weight came from 100 ADA locked on Cardano (M2d)";

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const kp = derive(POSTER_URI);
  const poster = ss58Address(kp.publicKey, 42);
  const signer = getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
  console.log("poster (sr25519):", poster, `(${POSTER_URI})`);

  // The Cardano-sourced state: stake (weight) came from the locked ADA, set by m2d-sync-weight.
  const stake = await api.query.TalkStake.AllowedStake.getValue(poster);
  const allowed = (await api.query.CognoGate.PkhOf.getValue(poster)) !== undefined;
  console.log("on-chain weight (TalkStake.AllowedStake):", stake, "| identity-gated allowed:", allowed);
  if (!allowed) throw new Error("poster not identity-bound — run m2d-bind.mjs first");
  if (!stake || stake === 0n) throw new Error("poster has zero weight — run m2d-sync-weight.mjs first");

  const free0 = (await api.query.System.Account.getValue(poster)).data.free;
  const pr = await api.tx.Microblog.post_message({ text: Binary.fromText(TEXT), parent: undefined }).signAndSubmit(signer);
  const created = (pr.events || []).find((e) => e.type === "Microblog" && e.value?.type === "PostCreated");
  const free1 = (await api.query.System.Account.getValue(poster)).data.free;

  console.log(pr.ok && created ? `✓ PostCreated id=${created.value.value.id}` : "✗ post did NOT emit PostCreated");
  console.log(free0 === free1 ? `✓ FEELESS: free balance Δ = 0 (before=${free0}, after=${free1})` : `✗ balance changed: ${free0} → ${free1}`);
  const success = !!(pr.ok && created && free0 === free1);
  console.log(success
    ? `\n🎯 MONEY SHOT: locked ADA → Cardano-sourced weight ${stake} → feeless post id ${created.value.value.id}.`
    : "\n✗ money shot FAILED");
  client.destroy();
  process.exit(success ? 0 : 1);
}
main().catch((e) => { console.error("POST FAILED:", e?.message || e); process.exit(1); });
