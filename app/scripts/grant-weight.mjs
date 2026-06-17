// Dev operator tool — grant talk-stake weight + pre-charge the battery for accounts, via
// sudo (the DR-07 escape hatch; //Alice = sudo on --dev). In the full system this is the
// follower's job (set_stake) driven by Cardano vault locks (M2/M2d). Here it lets the M2c
// showcase work out of the box: run it once and the dev accounts can post feelessly with a
// full battery that then drains as you post and regenerates over ~blocks.
//
// Usage:
//   node scripts/grant-weight.mjs                      # grants the default dev accounts, 10 ADA each
//   node scripts/grant-weight.mjs //Dave 25000000      # grant a specific account a specific weight
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

  for (const uri of targets) {
    const who = ss58Of(uri);
    const full = capOf(argWeight);
    process.stdout.write(`granting ${uri} (${who.slice(0, 8)}…) weight=${argWeight} → battery=${full} (~${full / K.baseCost} posts) … `);
    await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who, weight: argWeight }).decodedCall }).signAndSubmit(sudo);
    await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who, cap_last: full }).decodedCall }).signAndSubmit(sudo);
    console.log("done ✓");
  }

  console.log(`\ngranted ${targets.length} account(s). They can now post feelessly until the battery drains, then wait for regen.`);
  client.destroy();
  process.exit(0);
}
main().catch((e) => {
  console.error("grant failed:", e);
  process.exit(1);
});
