// M5 live acceptance (DR-05 + DR-07) — run against a fresh `--dev` node.
//
// Proves, end-to-end on a live chain built with the REAL benchmarked weights:
//   (0) spec_version == 105 and the FollowerCommittee is seated 5-of-5 at genesis (DR-07).
//   (A) the EnsureRoot/sudo fallback still works AND posting is still FEELESS under the
//       benchmarked weights: a sudo-granted account posts and its free balance is UNCHANGED.
//   (B) the capacity gate is intact: a bound-but-unweighted account's post is REJECTED at the
//       pool (ExhaustsResources) — the only anti-spam still bites.
//   (C) the DR-07 k-of-t authority works LIVE: a 3-of-5 FollowerCommittee motion (propose →
//       3×vote → close) executes `talk_stake::set_stake` for a target that sudo never touched,
//       via the EnsureProportionAtLeast<3,5> origin. The proposal lifecycle events are the audit log.
//
// Lives here (not app/scripts) because it uses @polkadot/api (dynamic metadata — auto-exposes the
// new `followerCommittee` pallet, no PAPI codegen), the same dep + location as verify-m4c.mjs.
//
// Usage:  WS=ws://127.0.0.1:9944 node m5-acceptance.mjs
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, blake2AsU8a } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { throw new Error(`ACCEPTANCE FAIL: ${m}`); };

// Send a tx, resolve with the decoded events at inBlock; reject on dispatchError OR pool reject.
function send(api, tx, signer, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events = [], dispatchError }) => {
      if (dispatchError) {
        let msg = dispatchError.toString();
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          msg = `${d.section}.${d.name}`;
        }
        reject(new Error(`${label}: dispatchError ${msg}`));
      } else if (status.isInBlock) {
        resolve(events.map(({ event }) => event));
      }
    }).catch(reject);
  });
}
const has = (events, section, method) =>
  events.some((e) => e.section === section && e.method === method);
const find = (events, section, method) =>
  events.find((e) => e.section === section && e.method === method);

async function main() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
  const [alice, bob, charlie, dave, eve] =
    ["//Alice", "//Bob", "//Charlie", "//Dave", "//Eve"].map((s) => kr.addFromUri(s));
  const grace = kr.addFromUri("//Grace");   // committee-path target (sudo never touches it)
  const ferdie = kr.addFromUri("//Ferdie");  // bound-but-unweighted (capacity-gate reject)

  // ── (0) chain identity ─────────────────────────────────────────────────────────────────────
  const spec = api.runtimeVersion.specVersion.toNumber();
  console.log("genesis:", api.genesisHash.toHex(), "| spec_version:", spec);
  if (spec !== 105) fail(`spec_version ${spec} != 105`);
  ok("spec_version == 105");
  const members = await api.query.followerCommittee.members();
  if (members.length !== 5) fail(`FollowerCommittee seated ${members.length} != 5`);
  ok(`FollowerCommittee seated 5 members (3-of-5 k-of-t live)`);

  const idHash = (addr) => u8aToHex(blake2AsU8a(`cogno-m5:${addr}`, 256));
  const capConst = api.consts.microblog;
  const capRatio = capConst.capRatio.toBigInt();
  const ceiling = capConst.ceiling.toBigInt();
  const baseCost = capConst.baseCost.toBigInt();

  // ── (A) sudo fallback + FEELESS post under benchmarked weights ───────────────────────────────
  const W = 10_000_000n; // ≈10 ADA lovelace
  const cap = W * capRatio < ceiling ? W * capRatio : ceiling;
  await send(api, api.tx.sudo.sudo(api.tx.cognoGate.linkIdentity(idHash(dave.address), dave.address, null)), alice, "bind-dave");
  await send(api, api.tx.sudo.sudo(api.tx.talkStake.setStake(dave.address, W)), alice, "stake-dave");
  await send(api, api.tx.sudo.sudo(api.tx.microblog.forceSetCapacity(dave.address, cap)), alice, "battery-dave");
  ok(`sudo (EnsureRoot fallback) bound + weighted + charged //Dave (cap=${cap})`);

  const before = (await api.query.system.account(dave.address)).data.free.toBigInt();
  const evs = await send(api, api.tx.microblog.postMessage("gm cogno — M5 feeless under real weights", null), dave, "post-dave");
  if (!has(evs, "microblog", "PostCreated")) fail("no PostCreated event");
  const after = (await api.query.system.account(dave.address)).data.free.toBigInt();
  if (after !== before) fail(`post was NOT feeless: Δfree = ${after - before}`);
  ok(`//Dave posted — PostCreated emitted, free balance Δ == 0 (FEELESS under benchmarked weights)`);

  // ── (B) capacity gate still rejects an over-budget post at the pool ──────────────────────────
  await send(api, api.tx.sudo.sudo(api.tx.cognoGate.linkIdentity(idHash(ferdie.address), ferdie.address, null)), alice, "bind-ferdie");
  // Ferdie is bound (is_allowed) but has weight 0 → current_capacity 0 < post_cost → ExhaustsResources.
  let rejected = false;
  try {
    await send(api, api.tx.microblog.postMessage("this should never land", null), ferdie, "post-ferdie");
  } catch (e) {
    rejected = /exhaust|1010|capacity|invalid transaction|resources/i.test(String(e.message || e));
    if (!rejected) throw e;
  }
  if (!rejected) fail("over-budget (weight-0) post was NOT rejected at the pool");
  ok("bound-but-unweighted //Ferdie post REJECTED at the pool (ExhaustsResources) — capacity is the live anti-spam");

  // ── (C) DR-07: a 3-of-5 FollowerCommittee motion authorizes set_stake (no sudo) ──────────────
  const W2 = 42_000_000n;
  const graceBefore = (await api.query.talkStake.allowedStake(grace.address)).toBigInt();
  if (graceBefore !== 0n) fail(`//Grace pre-state weight ${graceBefore} != 0 (sudo must not have touched it)`);
  const inner = api.tx.talkStake.setStake(grace.address, W2);
  const lengthBound = inner.method.toU8a().length + 8;
  const proposeEvs = await send(api, api.tx.followerCommittee.propose(3, inner, lengthBound), charlie, "propose");
  const proposed = find(proposeEvs, "followerCommittee", "Proposed");
  if (!proposed) fail("no FollowerCommittee.Proposed event");
  const proposalIndex = proposed.data[1].toNumber();
  const proposalHash = proposed.data[2].toHex();
  ok(`//Charlie proposed set_stake(//Grace, ${W2}) as committee motion #${proposalIndex} (threshold 3-of-5)`);

  await send(api, api.tx.followerCommittee.vote(proposalHash, proposalIndex, true), alice, "vote-alice");
  await send(api, api.tx.followerCommittee.vote(proposalHash, proposalIndex, true), bob, "vote-bob");
  await send(api, api.tx.followerCommittee.vote(proposalHash, proposalIndex, true), charlie, "vote-charlie");
  ok("3 ayes (//Alice //Bob //Charlie) — supermajority reached");

  const weightBound = { refTime: 5_000_000_000n, proofSize: 500_000n };
  const closeEvs = await send(api, api.tx.followerCommittee.close(proposalHash, proposalIndex, weightBound, lengthBound), dave, "close");
  if (!has(closeEvs, "followerCommittee", "Closed")) fail("no FollowerCommittee.Closed event");
  if (!has(closeEvs, "followerCommittee", "Approved")) fail("motion was not Approved (3-of-5 not counted?)");
  if (!has(closeEvs, "followerCommittee", "Executed")) fail("no FollowerCommittee.Executed event");
  if (!has(closeEvs, "talkStake", "StakeSet")) fail("set_stake did NOT execute via the committee origin");
  const graceAfter = (await api.query.talkStake.allowedStake(grace.address)).toBigInt();
  if (graceAfter !== W2) fail(`committee set_stake failed: AllowedStake(//Grace) = ${graceAfter} != ${W2}`);
  ok(`close → Approved + Executed → talk_stake.StakeSet; AllowedStake(//Grace) == ${W2} (set by the 3-of-5 COMMITTEE, not sudo)`);

  console.log("\nM5 ACCEPTANCE PASSED — real benchmarked weights + feeless posting + capacity gate + k-of-t authority all proven live.");
  await api.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error("\n" + (e.stack || e)); process.exit(1); });
