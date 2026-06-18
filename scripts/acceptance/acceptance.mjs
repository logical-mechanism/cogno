// M0 acceptance test for cogno-chain.
//
// Verifies the docs/PLAN.md §8 "done-when" for M0 against a running `cogno-chain-node --dev`:
//   1. connect over WS and confirm the runtime is `cogno-chain-runtime`
//   2. submit a signed `Microblog.post_message({ text, parent })` (sr25519 //Alice)
//   3. confirm it lands in a block and `PostCreated` fires
//   4. read it back via `query.Microblog.Posts` (point + entries)
//   5. `delete_post` it, confirm `PostDeleted` fires and the row is gone
//
// Usage:  WS=ws://127.0.0.1:9944 node acceptance.mjs

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { stringToU8a, u8aToString, u8aToHex } from '@polkadot/util';

const WS = process.env.WS || 'ws://127.0.0.1:9944';

function submitAndGetEventId(api, signer, tx, section, method) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        let msg = dispatchError.toString();
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          msg = `${d.section}.${d.name}: ${d.docs.join(' ')}`;
        }
        if (unsub) unsub();
        return reject(new Error(`dispatch error: ${msg}`));
      }
      if (status.isInBlock) {
        console.log(`  included in block ${status.asInBlock.toHex()}`);
        let id = null;
        for (const { event } of events) {
          if (event.section === section && event.method === method) {
            id = event.data[0].toString();
          }
        }
        if (unsub) unsub();
        if (id === null) return reject(new Error(`${section}.${method} not emitted`));
        return resolve(id);
      }
    })
      .then((u) => { unsub = u; })
      .catch(reject);
  });
}

async function main() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });

  const rt = api.runtimeVersion;
  console.log(`connected: ${rt.specName.toString()} v${rt.specVersion.toString()} (impl ${rt.implName.toString()})`);
  if (rt.specName.toString() !== 'cogno-chain-runtime') {
    throw new Error(`unexpected runtime spec_name: ${rt.specName.toString()}`);
  }
  if (!api.tx.microblog?.postMessage || !api.tx.microblog?.deletePost) {
    throw new Error('Microblog.post_message / delete_post not present in metadata');
  }

  const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
  console.log(`signer: Alice = ${alice.address}`);

  const text = `gm cogno — M0 acceptance @ ${new Date().toISOString()}`;
  console.log(`\n[1] post_message(${JSON.stringify(text)}, None)`);
  // Pass the text as a hex string: polkadot-js `Bytes` treats a hex/plain string as raw
  // *content*, but a Uint8Array as already-SCALE-encoded (length-prefixed) input — which
  // would misread the first byte as a bogus compact length.
  const textHex = u8aToHex(stringToU8a(text));
  const id = await submitAndGetEventId(
    api, alice, api.tx.microblog.postMessage(textHex, null),
    'microblog', 'PostCreated',
  );
  console.log(`  PostCreated fired -> id = ${id}`);

  console.log(`\n[2] query.Microblog.Posts(${id})`);
  const stored = await api.query.microblog.posts(id);
  if (stored.isNone) throw new Error(`Posts(${id}) empty after post`);
  const post = stored.unwrap();
  const gotText = u8aToString(post.text);
  console.log(`  author = ${post.author.toString()}`);
  console.log(`  text   = ${JSON.stringify(gotText)}`);
  console.log(`  at     = #${post.at.toString()}  parent = ${post.parent.toString()}`);
  if (gotText !== text) throw new Error(`text mismatch: ${JSON.stringify(gotText)}`);

  const entries = await api.query.microblog.posts.entries();
  console.log(`  Posts.entries() count = ${entries.length}`);

  console.log(`\n[3] delete_post(${id})`);
  const delId = await submitAndGetEventId(
    api, alice, api.tx.microblog.deletePost(id),
    'microblog', 'PostDeleted',
  );
  console.log(`  PostDeleted fired -> id = ${delId}`);
  const after = await api.query.microblog.posts(id);
  if (after.isSome) throw new Error(`Posts(${id}) still present after delete`);
  console.log(`  Posts(${id}) removed ✓`);

  console.log('\n==================== M0 ACCEPTANCE: PASS ====================');
  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n==================== M0 ACCEPTANCE: FAIL ====================');
  console.error(e);
  process.exit(1);
});
