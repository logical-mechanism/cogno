// Acceptance smoke test for the all-Rust cogno-chain posture, run against a live node.
//
//   WS=ws://127.0.0.1:9944 node acceptance.mjs        # any node: a --dev node, the relay, the public RPC
//
// What it checks (in the REAL composed runtime, not a pallet mock):
//
//   1. the runtime is `cogno-chain-runtime`
//   2. the REMOVED surfaces are absent: no `sudo`, no `talkStake.set_stake`, no `anchor`, no
//      `microblog.delete_post` (content is append-only)
//   3. the expected surfaces are present: microblog posting, the permissionless CIP-8 bind, the
//      3-of-5 FollowerCommittee, and the node-served read APIs (MicroblogApi + CardanoObserverApi)
//   4. the capacity gate is LIVE: a signed `post_message` from an account with no talk-capacity is
//      rejected AT THE POOL with `ExhaustsResources` — the `CheckCapacity` TransactionExtension
//      running in the real tx pipeline. This one needs an existing, funded signer (an account with no
//      providers is rejected earlier, by `CheckNonce`, with `Payment`), so it runs only when SURI's
//      account exists on the chain; against a public node with no such account it is SKIPPED, loudly.
//
// What it does NOT check: the product loop end to end (bind an identity -> lock ADA on Cardano ->
// earn capacity -> post). That needs a Cardano wallet, a funded preprod vault, and a db-sync the
// observer can read, so it cannot run unattended in CI. The positive half of the capacity mechanic
// is covered by the pallet tests; this script covers the composition and the negative (gate closed).
//
//   SURI=//Alice   the signer for check 4 (default //Alice — funded on a --dev chain, nonexistent
//                  anywhere else, which is exactly when the check skips)

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';

const WS = process.env.WS || 'ws://127.0.0.1:9944';
const SURI = process.env.SURI || '//Alice';

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });

  const rt = api.runtimeVersion;
  console.log(
    `connected: ${rt.specName.toString()} v${rt.specVersion.toString()} (impl ${rt.implName.toString()})`,
  );
  if (rt.specName.toString() !== 'cogno-chain-runtime') {
    throw new Error(`unexpected runtime spec_name: ${rt.specName.toString()}`);
  }

  const fail = [];

  // [1] Removed surfaces must be ABSENT: sudo-free from genesis; the observer inherent is the sole
  //     weight writer (no set_stake extrinsic); anchoring dropped.
  if (api.tx.sudo) fail.push('sudo pallet present — the chain must be sudo-free');
  if (api.tx.talkStake?.setStake || api.tx.talkStake?.setVotingPower) {
    fail.push('talkStake.set_stake/set_voting_power present — weight must be observer-written only');
  }
  if (api.tx.anchor) fail.push('anchor pallet present — anchoring must be dropped');
  if (api.tx.microblog?.deletePost) {
    fail.push('microblog.delete_post present — content must be append-only');
  }

  // [2] Expected call surface must be PRESENT.
  if (!api.tx.microblog?.postMessage) fail.push('microblog.post_message missing');
  if (!api.tx.cognoGate?.linkIdentitySigned) {
    fail.push('cognoGate.link_identity_signed missing — the permissionless CIP-8 bind');
  }
  if (!api.tx.followerCommittee?.propose) {
    fail.push('followerCommittee.propose missing — the 3-of-5 governance path');
  }

  // [3] The node serves reads itself (no indexer in the read path).
  if (!api.call.microblogApi?.feedPage) fail.push('MicroblogApi.feed_page missing — the node-served feed');
  if (!api.call.cardanoObserverApi) fail.push('CardanoObserverApi missing — the observer inherent');
  if (api.call.microblogApi?.feedPage) {
    const page = await api.call.microblogApi.feedPage(null, 3, null);
    if (!Array.isArray(page.toJSON()?.posts)) fail.push('MicroblogApi.feed_page did not return a page');
  }

  // [4] The capacity gate, in the real tx pipeline.
  const signer = new Keyring({ type: 'sr25519' }).addFromUri(SURI);
  const { providers, data } = await api.query.system.account(signer.address);
  if (providers.isZero()) {
    console.log(
      `  ~ capacity gate NOT exercised: ${signer.address} does not exist on this chain ` +
        '(set SURI to an existing account, or run against --dev)',
    );
  } else {
    let err = '';
    try {
      await api.tx.microblog.postMessage('acceptance: capacity gate', null).signAndSend(signer);
    } catch (e) {
      err = String(e?.message || e);
    }
    if (!err) {
      fail.push(
        `microblog.post_message from ${signer.address} (balance ${data.free.toString()}, no talk-capacity) ` +
          'was ACCEPTED — the CheckCapacity gate is not enforcing',
      );
    } else if (!/exhaust/i.test(err)) {
      fail.push(`post_message rejected, but not by the capacity gate: ${err}`);
    } else {
      console.log('  ✓ CheckCapacity rejects a post with no talk-capacity at the pool (ExhaustsResources)');
    }
  }

  if (fail.length) {
    console.error('\n==================== ACCEPTANCE: FAIL ====================');
    for (const f of fail) console.error(`  ✗ ${f}`);
    await api.disconnect();
    process.exit(1);
  }

  console.log('  ✓ sudo-free, observer-written weight, anchoring dropped, append-only content');
  console.log('  ✓ posting + permissionless CIP-8 bind + 3-of-5 committee + node-served reads present');
  console.log('\n==================== ACCEPTANCE: PASS ====================');
  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n==================== ACCEPTANCE: FAIL ====================');
  console.error(e);
  process.exit(1);
});
