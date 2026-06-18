// M1 PAPI acceptance / grounding harness for cogno-chain.
//
// Asserts the docs/PLAN.md §8 M1 "post/read loop" programmatically against a running
// `cogno-chain-node --dev`, using the SAME stack the frontend uses: polkadot-api (PAPI),
// an sr25519 signer via @polkadot-labs/hdkd + getPolkadotSigner, descriptors generated
// from the live node. (The browser loop is the real acceptance; this is the regression.)
//
//   1. connect over WS, confirm spec_name == cogno-chain-runtime + descriptor match
//   2. sign + submit Microblog.post_message({ text, parent: undefined }) as sr25519 //Alice
//   3. confirm it lands in a block and PostCreated fires -> id
//   4. read it back via query.Microblog.Posts.getValue(id) + getEntries()
//   5. delete_post({ id }); confirm PostDeleted fires and the row is gone
//
// Usage:  WS=ws://127.0.0.1:9944 node scripts/papi-acceptance.mjs
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";

function deriveSr25519(path) {
  const entropy = mnemonicToEntropy(DEV_PHRASE);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const kp = derive(path);
  return {
    keyPair: kp,
    signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
    ss58: ss58Address(kp.publicKey, 42),
  };
}

function findEvent(events, pallet, name) {
  for (const e of events) {
    if (e.type === pallet && e.value?.type === name) return e.value.value;
  }
  return null;
}

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);

  const ver = await api.constants.System.Version();
  console.log(
    `connected: ${ver.spec_name} v${ver.spec_version} (impl ${ver.impl_name})`,
  );
  if (ver.spec_name !== "cogno-chain-runtime") {
    throw new Error(`unexpected spec_name: ${ver.spec_name}`);
  }

  const alice = deriveSr25519("//Alice");
  console.log(`signer: //Alice = ${alice.ss58}`);

  // M2c: posting is now feeless + talk-capacity-gated, so grant //Alice weight + a full
  // battery (via sudo) before posting — otherwise CheckCapacity rejects at the pool.
  const [capRatio, ceiling] = await Promise.all([
    api.constants.Microblog.CapRatio(),
    api.constants.Microblog.Ceiling(),
  ]);
  const full = 10_000_000n * capRatio < ceiling ? 10_000_000n * capRatio : ceiling;
  await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who: alice.ss58, weight: 10_000_000n }).decodedCall }).signAndSubmit(alice.signer);
  await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who: alice.ss58, cap_last: full }).decodedCall }).signAndSubmit(alice.signer);
  console.log(`granted //Alice weight 10_000_000 + battery ${full} (M2c: capacity required to post)`);

  const text = `gm cogno — M1 PAPI acceptance @ ${new Date().toISOString()}`;
  console.log(`\n[1] post_message(${JSON.stringify(text)}, parent: undefined)`);
  const posted = await api.tx.Microblog.post_message({
    text: Binary.fromText(text),
    parent: undefined,
  }).signAndSubmit(alice.signer);
  if (!posted.ok) throw new Error(`post dispatch failed: ${JSON.stringify(posted.dispatchError)}`);
  console.log(`  in block #${posted.block.number} (${posted.block.hash.slice(0, 10)}…) finalized`);
  const created = findEvent(posted.events, "Microblog", "PostCreated");
  if (!created) throw new Error("PostCreated not emitted");
  const id = created.id;
  console.log(`  PostCreated -> id=${id}  author=${created.author}`);

  console.log(`\n[2] query.Microblog.Posts.getValue(${id})`);
  const stored = await api.query.Microblog.Posts.getValue(id);
  if (!stored) throw new Error(`Posts(${id}) empty after post`);
  const gotText = stored.text.asText();
  console.log(`  author=${stored.author}  at=#${stored.at}  parent=${stored.parent ?? "None"}`);
  console.log(`  text=${JSON.stringify(gotText)}`);
  if (gotText !== text) throw new Error(`text mismatch: ${JSON.stringify(gotText)}`);
  const entries = await api.query.Microblog.Posts.getEntries();
  console.log(`  Posts.getEntries() count = ${entries.length}`);
  const byAuthor = await api.query.Microblog.ByAuthor.getValue(alice.ss58);
  console.log(`  ByAuthor(//Alice) = [${(byAuthor ?? []).join(", ")}]`);
  const next = await api.query.Microblog.NextPostId.getValue();
  console.log(`  NextPostId = ${next}`);

  console.log(`\n[3] delete_post({ id: ${id} })`);
  const del = await api.tx.Microblog.delete_post({ id }).signAndSubmit(alice.signer);
  if (!del.ok) throw new Error(`delete dispatch failed: ${JSON.stringify(del.dispatchError)}`);
  const deleted = findEvent(del.events, "Microblog", "PostDeleted");
  if (!deleted) throw new Error("PostDeleted not emitted");
  console.log(`  PostDeleted -> id=${deleted.id}`);
  const after = await api.query.Microblog.Posts.getValue(id);
  if (after) throw new Error(`Posts(${id}) still present after delete`);
  console.log(`  Posts(${id}) removed ✓`);

  console.log("\n==================== M1 PAPI ACCEPTANCE: PASS ====================");
  client.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n==================== M1 PAPI ACCEPTANCE: FAIL ====================");
  console.error(e);
  process.exit(1);
});
