// Acceptance smoke test for the all-Rust cogno-chain posture.
//
// Verifies, against a running node (e.g. `cogno-chain-node run --dev`), that the deployed runtime is
// the sudo-free, observer-written, anchoring-dropped all-Rust chain — NOT a pre-fork shape. It checks
// the call surface only (no signing / identity / capacity setup needed), so it runs against any node.
//
//   1. connect over WS and confirm the runtime is `cogno-chain-runtime`
//   2. assert the REMOVED surfaces are absent: no `sudo`, no `talkStake.set_stake`, no `anchor`,
//      and no `microblog.delete_post` (content is append-only)
//   3. assert the expected surface is present: microblog posting, the permissionless CIP-8 bind,
//      and the 3-of-5 FollowerCommittee governance path
//
// Usage:  WS=ws://127.0.0.1:9944 node acceptance.mjs

import { ApiPromise, WsProvider } from '@polkadot/api';

const WS = process.env.WS || 'ws://127.0.0.1:9944';

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

  // [2] Expected surface must be PRESENT.
  if (!api.tx.microblog?.postMessage) fail.push('microblog.post_message missing');
  if (!api.tx.cognoGate?.linkIdentitySigned) {
    fail.push('cognoGate.link_identity_signed missing — the permissionless CIP-8 bind');
  }
  if (!api.tx.followerCommittee?.propose) {
    fail.push('followerCommittee.propose missing — the 3-of-5 governance path');
  }

  if (fail.length) {
    console.error('\n==================== ACCEPTANCE: FAIL ====================');
    for (const f of fail) console.error(`  ✗ ${f}`);
    await api.disconnect();
    process.exit(1);
  }

  console.log('  ✓ sudo-free, observer-written weight, anchoring dropped, append-only content');
  console.log('  ✓ posting + permissionless CIP-8 bind + 3-of-5 committee present');
  console.log('\n==================== ACCEPTANCE: PASS ====================');
  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n==================== ACCEPTANCE: FAIL ====================');
  console.error(e);
  process.exit(1);
});
