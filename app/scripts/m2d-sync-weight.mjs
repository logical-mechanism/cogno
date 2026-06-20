// M2d — the follower's vault→weight sync (live). Observe talk_vault beacon UTxOs via db-sync, apply
// LARGEST-WINS per identity (never sum), look up the bound account (CognoGate.AccountOf[beacon]),
// and write TalkStake.set_stake(account, weight=locked lovelace) via sudo (the DR-07 dev hatch).
// This is the Cardano-sourced weight: NO sudo grant of weight — the ADA lock IS the grant.
//
//   node scripts/m2d-sync-weight.mjs
//
// LEGACY DEMO TOOLING (frozen): the M2d sudo-path weight sync. It reads /tmp/cogno-m2/vault.json directly
// and writes via sudo. The always-on, committee-driven successor is services/committee/sync-weight.mjs
// (durable VAULT_FILE under $COGNO_DATA_DIR, set_stake via the 3-of-5 committee — no sudo).
import fs from "node:fs";
import { createClient, FixedSizeBinary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";
import { readUnspentMatches } from "../../services/committee/dbsync.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const DBSYNC_URL = process.env.DBSYNC_URL || process.env.DBSYNC || "postgres://cogno_reader@127.0.0.1:5432/cexplorer";
const VAULT_HASH = JSON.parse(fs.readFileSync("/tmp/cogno-m2/vault.json", "utf8")).vaultHash;
const MIN_LOCK = 100_000_000n;
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

async function main() {
  // 1) observe: db-sync matches for the vault policy → largest-wins per beacon name.
  const matches = await readUnspentMatches(DBSYNC_URL, VAULT_HASH);
  const largest = new Map(); // beaconHex -> lovelace
  for (const m of matches) {
    const assets = m.value?.assets ?? {};
    const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === VAULT_HASH.toLowerCase());
    if (beacons.length === 1 && Number(beacons[0][1]) === 1) {
      const beacon = beacons[0][0].split(".")[1].toLowerCase();
      const coins = BigInt(m.value.coins);
      if (coins > (largest.get(beacon) ?? -1n)) largest.set(beacon, coins);
    }
  }
  console.log(`observed ${matches.length} vault UTxO(s) → ${largest.size} identity(ies)`);

  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const sudoKp = derive("//Alice");
  const sudo = getPolkadotSigner(sudoKp.publicKey, "Sr25519", sudoKp.sign);

  let granted = 0;
  for (const [beacon, lovelace] of largest) {
    const account = await api.query.CognoGate.AccountOf.getValue(FixedSizeBinary.fromBytes(hexToBytes(beacon)));
    if (!account) { console.log(`  · ${beacon.slice(0, 12)}… locked ${lovelace} — NOT bound yet, skip`); continue; }
    const weight = lovelace >= MIN_LOCK ? lovelace : 0n;
    await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who: account, weight }).decodedCall }).signAndSubmit(sudo);
    // prime/charge the battery so the demo can post immediately (force_set_capacity calls on_first_bind)
    const capRatio = await api.constants.Microblog.CapRatio();
    const ceiling = await api.constants.Microblog.Ceiling();
    const full = weight * capRatio < ceiling ? weight * capRatio : ceiling;
    await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who: account, cap_last: full }).decodedCall }).signAndSubmit(sudo);
    console.log(`  ✓ ${account} ← weight ${weight} (Cardano-sourced; ${lovelace / 1_000_000n} ADA locked), battery ${full}`);
    granted++;
  }
  console.log(`\nset_stake written for ${granted} identity(ies) — weight from locked ADA, ZERO sudo grant of weight itself.`);
  client.destroy();
  process.exit(0);
}
main().catch((e) => { console.error("SYNC FAILED:", e?.message || e); process.exit(1); });
