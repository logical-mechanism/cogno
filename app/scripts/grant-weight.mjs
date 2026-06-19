// Dev operator tool — grant talk-stake weight + pre-charge the battery for ALREADY-BOUND accounts, via
// sudo (the DR-07 escape hatch; //Alice = sudo on --dev). In the full system this is the follower's job
// (set_stake) driven by Cardano vault locks (M2/M2d). Here it lets the showcase work: weight an account
// so it can post feelessly with a full battery that drains as you post and regenerates over ~blocks.
//
// ⚠ D1 (trustless identity): sudo can NO LONGER fabricate identities. Binding is the permissionless
// on-chain CIP-8 self-proof `cognoGate.link_identity_signed` (a real Cardano wallet signature), so this
// tool only grants WEIGHT to accounts that are ALREADY bound — it warns + skips unbound ones. To bind a
// dev account end-to-end (real headless-MeshJS CIP-8 → on-chain self-proof), run
// `node scripts/d1-acceptance.mjs` (binds //CognoGateA); to bind your own, use the frontend Account widget.
//
// Usage:
//   node scripts/grant-weight.mjs                      # weight the default dev accounts, 10 ADA each
//   node scripts/grant-weight.mjs //CognoGateA 25000000  # weight a specific (bound) account
//   WS=ws://127.0.0.1:9944 node scripts/grant-weight.mjs
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const DEFAULT_ACCOUNTS = ["//Alice", "//Bob", "//Charlie", "//Dave", "//Eve"];
const DEFAULT_WEIGHT = 10_000_000n; // ≈10 ADA (lovelace) → ~10 posts of burst at the dev constants

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const ss58Of = (uri) => ss58Address(derive(uri).publicKey, 42);

async function main() {
  const argUri = process.argv[2];
  const argWeight = process.argv[3] ? BigInt(process.argv[3]) : DEFAULT_WEIGHT;
  const targets = argUri ? [argUri] : DEFAULT_ACCOUNTS;

  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const sudoKp = derive("//Alice");
  const sudo = getPolkadotSigner(sudoKp.publicKey, "Sr25519", sudoKp.sign);

  const K = {
    capRatio: await api.constants.Microblog.CapRatio(),
    ceiling: await api.constants.Microblog.Ceiling(),
    baseCost: await api.constants.Microblog.BaseCost(),
  };
  const capOf = (w) => (w * K.capRatio < K.ceiling ? w * K.capRatio : K.ceiling);

  let granted = 0;
  let skipped = 0;
  for (const uri of targets) {
    const who = ss58Of(uri);
    // D1: weight only a BOUND account — sudo can no longer bind. An unbound account is warned + skipped.
    const bound = (await api.query.CognoGate.PkhOf.getValue(who)) !== undefined;
    if (!bound) {
      console.log(`skip ${uri} (${who.slice(0, 8)}…): NOT bound — bind it first via the frontend or \`node scripts/d1-acceptance.mjs\` (D1 self-proof)`);
      skipped++;
      continue;
    }
    const full = capOf(argWeight);
    process.stdout.write(`granting ${uri} (${who.slice(0, 8)}…) weight=${argWeight} → battery=${full} (~${full / K.baseCost} posts) … `);
    await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who, weight: argWeight }).decodedCall }).signAndSubmit(sudo);
    await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who, cap_last: full }).decodedCall }).signAndSubmit(sudo);
    console.log("done ✓");
    granted++;
  }

  console.log(`\nweighted ${granted} bound account(s)${skipped ? `, skipped ${skipped} unbound` : ""}. Bound + weighted accounts can now post feelessly until the battery drains, then wait for regen.`);
  client.destroy();
  process.exit(0);
}
main().catch((e) => {
  console.error("grant failed:", e);
  process.exit(1);
});
