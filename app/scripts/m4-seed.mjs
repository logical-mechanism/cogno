// M4 seed — populate the chain with the full event surface the SubQuery indexer ingests:
// PostCreated (top-level + threaded replies), PostDeleted, IdentityLinked, Revoked, StakeSet.
//
// Run AFTER grant-weight.mjs (which binds + stakes + charges //Alice…//Eve). This adds:
//   - 5 top-level posts from //Alice, //Bob, //Charlie
//   - 3 threaded replies (post_message with `parent` set)
//   - a REVOKED-AUTHOR demo: bind + stake + charge a fresh //M4SeedMallory, post 2 messages
//     from it, then sudo-revoke it — revoke leaves the posts intact (cogno-gate by design), so
//     the indexer must mark that author `banned` and the feed must surface it (DR-14b / L4 §4.1).
//   - 1 delete_post (//Bob deletes one of his own posts → PostDeleted, the soft-delete signal)
//
// Idempotent only on a FRESH chain (it does not check for prior seed posts). For a clean M4c
// re-derivation, run once against the fresh archive node.
//
// Usage: WS=ws://127.0.0.1:9944 node scripts/m4-seed.mjs
import { createClient, FixedSizeBinary, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";
import { blake2b } from "blakejs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const ss58 = (uri) => ss58Address(derive(uri).publicKey, 42);
const signer = (uri) => { const k = derive(uri); return getPolkadotSigner(k.publicKey, "Sr25519", k.sign); };

const client = createClient(getWsProvider(WS));
const api = client.getTypedApi(cogno);
const sudo = signer("//Alice");
const sudoCall = (inner) => api.tx.Sudo.sudo({ call: inner.decodedCall }).signAndSubmit(sudo);
const findEv = (events, pallet, name) => events.find((e) => e.type === pallet && e.value?.type === name)?.value?.value;

async function post(uri, text, parent /* bigint | undefined */) {
  const r = await api.tx.Microblog.post_message({ text: Binary.fromText(text), parent }).signAndSubmit(signer(uri));
  if (!r.ok) throw new Error(`post failed (${uri}): ${JSON.stringify(r.dispatchError)}`);
  const created = findEv(r.events, "Microblog", "PostCreated");
  console.log(`  PostCreated id=${created.id} parent=${parent ?? "—"} by ${uri}`);
  return created.id;
}

async function main() {
  console.log("== top-level posts ==");
  const t0 = await post("//Alice", "M4 seed: the civic ledger opens for indexing.");
  const t1 = await post("//Bob", "M4 seed: a second voice, paginated and searchable.");
  const t2 = await post("//Alice", "M4 seed: full-text search needs the indexer (Tier B).");
  const t3 = await post("//Charlie", "M4 seed: profiles resolve by identity hash too.");
  const t4 = await post("//Bob", "M4 seed: this one will be deleted (soft-delete tombstone).");

  console.log("== threaded replies (gated like top-level, DR-14b) ==");
  await post("//Bob", `reply to #${t0}: threads reconstruct from Post.parent.`, t0);
  await post("//Charlie", `reply to #${t0}: no on-chain children index — folded off-chain.`, t0);
  await post("//Alice", `reply to #${t1}: replies inherit the capacity gate.`, t1);

  console.log("== revoked-author demo (//M4SeedMallory): bind → stake → post → revoke ==");
  const m = ss58("//M4SeedMallory");
  const mHash = FixedSizeBinary.fromBytes(blake2b(new TextEncoder().encode(`cogno-m4-seed:${m}`), undefined, 32));
  const capRatio = await api.constants.Microblog.CapRatio();
  const ceiling = await api.constants.Microblog.Ceiling();
  const weight = 10_000_000n;
  const cap = weight * capRatio < ceiling ? weight * capRatio : ceiling;
  const link = await sudoCall(api.tx.CognoGate.link_identity({ identity_hash: mHash, substrate_account: m, thread_pointer: undefined }));
  console.log(`  link_identity(Mallory) ok=${link.ok} (IdentityLinked)`);
  await sudoCall(api.tx.TalkStake.set_stake({ who: m, weight }));        // StakeSet
  await sudoCall(api.tx.Microblog.force_set_capacity({ who: m, cap_last: cap })); // provider ref + battery
  const mp0 = await post("//M4SeedMallory", "M4 seed: a post from an author who will be revoked.");
  await post("//M4SeedMallory", "M4 seed: revoke leaves these posts on-chain — the feed must flag them.");
  const rev = await sudoCall(api.tx.CognoGate.revoke({ substrate_account: m }));
  console.log(`  revoke(Mallory) ok=${rev.ok} (Revoked — posts ${mp0}.. remain, author now banned)`);

  console.log("== delete (//Bob deletes #" + t4 + ") ==");
  const del = await api.tx.Microblog.delete_post({ id: t4 }).signAndSubmit(signer("//Bob"));
  console.log(`  delete_post(#${t4}) ok=${del.ok} (PostDeleted → soft-delete in the indexer)`);

  const nextId = await api.query.Microblog.NextPostId.getValue();
  console.log(`\nseed complete. NextPostId=${nextId}. Events: PostCreated×10, PostDeleted×1, IdentityLinked (Mallory + grant binds), Revoked×1, StakeSet (Mallory + grants).`);
  client.destroy();
  process.exit(0);
}

main().catch((e) => { console.error("seed failed:", e); process.exit(1); });
