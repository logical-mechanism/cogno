// Finish the M4 seed (m4-seed.mjs timed out mid-Mallory). Idempotent-ish continuation:
//   ensure Mallory capacity → 2 posts from Mallory → revoke Mallory → delete post #4 (//Bob).
// Fires the remaining event types the indexer needs: Revoked + PostDeleted (+ 2 PostCreated).
// Usage: WS=ws://127.0.0.1:9944 node scripts/m4-seed-finish.mjs
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const ss58 = (uri) => ss58Address(derive(uri).publicKey, 42);
const signer = (uri) => { const k = derive(uri); return getPolkadotSigner(k.publicKey, "Sr25519", k.sign); };

const client = createClient(getWsProvider(WS));
const api = client.getTypedApi(cogno);
const sudo = signer("//Alice");
const sudoCall = (inner) => api.tx.Sudo.sudo({ call: inner.decodedCall }).signAndSubmit(sudo);
const findEv = (events, p, n) => events.find((e) => e.type === p && e.value?.type === n)?.value?.value;

async function post(uri, text, parent) {
  const r = await api.tx.Microblog.post_message({ text: Binary.fromText(text), parent }).signAndSubmit(signer(uri));
  if (!r.ok) throw new Error(`post failed (${uri}): ${JSON.stringify(r.dispatchError)}`);
  const created = findEv(r.events, "Microblog", "PostCreated");
  console.log(`  PostCreated id=${created.id} parent=${parent ?? "—"} by ${uri}`);
  return created.id;
}

async function main() {
  const m = ss58("//M4SeedMallory");
  const capRatio = await api.constants.Microblog.CapRatio();
  const ceiling = await api.constants.Microblog.Ceiling();
  const weight = 10_000_000n;
  const cap = weight * capRatio < ceiling ? weight * capRatio : ceiling;
  // ensure capacity / provider ref (idempotent overwrite)
  await sudoCall(api.tx.Microblog.force_set_capacity({ who: m, cap_last: cap }));
  console.log("Mallory capacity ensured");

  await post("//M4SeedMallory", "M4 seed: a post from an author who will be revoked.");
  await post("//M4SeedMallory", "M4 seed: revoke leaves these posts on-chain — the feed must flag them.");

  const rev = await sudoCall(api.tx.CognoGate.revoke({ substrate_account: m }));
  console.log(`revoke(Mallory) ok=${rev.ok} (Revoked — Mallory's posts remain, author now banned)`);

  // delete post #4 (//Bob authored it); delete_post is fee-bearing → //Bob is genesis-funded.
  const del = await api.tx.Microblog.delete_post({ id: 4n }).signAndSubmit(signer("//Bob"));
  console.log(`delete_post(#4) ok=${del.ok} (PostDeleted → soft-delete tombstone in the indexer)`);

  const nextId = await api.query.Microblog.NextPostId.getValue();
  console.log(`\nfinish complete. NextPostId=${nextId}.`);
  client.destroy();
  process.exit(0);
}
main().catch((e) => { console.error("finish failed:", e); process.exit(1); });
