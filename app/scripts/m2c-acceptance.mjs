// M2c acceptance — feeless, capacity-metered posting (same PAPI stack as the app).
//
// Proves the milestone end-to-end against a running `cogno-chain-node --dev` (spec 102):
//   1. read capacity constants from metadata (never hardcoded)
//   2. an unweighted account is REJECTED at the pool (ExhaustsResources) — capacity is the gate
//   3. the operator grants weight via sudo(set_stake) + sudo(force_set_capacity) (dev escape hatch)
//   4. posting now succeeds and is FEELESS — the signer's free balance is unchanged
//   5. each post CONSUMES capacity (Capacity row drops by post_cost)
//   6. draining the bucket → posts get rejected again (ExhaustsResources)
//   7. capacity REGENERATES over blocks → posting resumes
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
function acct(uri) {
  const kp = derive(uri);
  return { kp, signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign), ss58: ss58Address(kp.publicKey, 42) };
}
const log = (m) => console.log(m);
// Read at "best" so a just-included (not-yet-finalized) post's consume is reflected.
const free = async (api, ss58) => (await api.query.System.Account.getValue(ss58, { at: "best" })).data.free;
const cap = async (api, ss58) => (await api.query.Microblog.Capacity.getValue(ss58, { at: "best" })) ?? null;

// Resolve on in-best-block (fast) OR on the pool-rejection error (ExhaustsResources) OR a
// timeout — never hang. A tx rejected at validate() never finalizes, so we must NOT await
// finalization here.
function tryPost(api, who, text, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    let sub;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sub?.unsubscribe(); } catch {}
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, rejected: true, error: "timeout (no inclusion)" }), timeoutMs);
    sub = api.tx.Microblog
      .post_message({ text: Binary.fromText(text), parent: undefined })
      .signSubmitAndWatch(who.signer)
      .subscribe({
        next: (e) => {
          if (e.type === "txBestBlocksState" && e.found) {
            finish(e.ok ? { ok: true, block: e.block.number } : { ok: false, error: "dispatch error" });
          }
        },
        error: (err) => finish({ ok: false, rejected: true, error: String(err?.message ?? err).split("\n")[0] }),
      });
  });
}

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const v = await api.constants.System.Version();
  log(`connected: ${v.spec_name} v${v.spec_version}`);
  if (v.spec_version < 102) throw new Error(`expected spec_version >= 102, got ${v.spec_version}`);

  // 1. constants from metadata
  const K = {
    CapRatio: await api.constants.Microblog.CapRatio(),
    RegenPerBlock: await api.constants.Microblog.RegenPerBlock(),
    Ceiling: await api.constants.Microblog.Ceiling(),
    BaseCost: await api.constants.Microblog.BaseCost(),
    PerByteCost: await api.constants.Microblog.PerByteCost(),
  };
  log(`\n[1] capacity constants (from metadata): ${JSON.stringify(K, (_, x) => (typeof x === "bigint" ? x.toString() : x))}`);

  const alice = acct("//Alice"); // sudo + the account under test
  const dave = acct("//Dave"); // a funded but unweighted account
  log(`signer under test: //Dave = ${dave.ss58}`);

  // 2. unweighted account is rejected at the pool
  log(`\n[2] post as unweighted //Dave (weight 0, no capacity row) → expect pool reject`);
  const r0 = await tryPost(api, dave, "should be rejected — no talk capacity");
  if (r0.ok) throw new Error("FAIL: an unweighted account was allowed to post");
  log(`  rejected ✓ (${(r0.error || "").split("\n")[0].slice(0, 80)})`);

  // 3. operator grants weight + pre-charges the battery via sudo (dev escape hatch)
  const weight = 10_000_000n; // ≈10 ADA in lovelace
  const capFull = (weight * K.CapRatio < K.Ceiling ? weight * K.CapRatio : K.Ceiling);
  log(`\n[3] sudo grant: set_stake(//Dave, ${weight}) + force_set_capacity(//Dave, ${capFull})`);
  await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who: dave.ss58, weight }).decodedCall }).signAndSubmit(alice.signer);
  await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who: dave.ss58, cap_last: capFull }).decodedCall }).signAndSubmit(alice.signer);
  const w = await api.query.TalkStake.AllowedStake.getValue(dave.ss58);
  const c0 = await cap(api, dave.ss58);
  log(`  AllowedStake(//Dave) = ${w}; Capacity = { cap_last: ${c0.cap_last}, last_block: ${c0.last_block} }`);
  if (w !== weight) throw new Error("FAIL: weight not set");

  // 4. + 5. posting now works, is FEELESS, and consumes capacity
  log(`\n[4/5] post as //Dave → expect success, feeless (balance unchanged), capacity consumed`);
  const balBefore = await free(api, dave.ss58);
  const capBefore = (await cap(api, dave.ss58)).cap_last;
  const text = "gm — my first feeless, capacity-metered post";
  const r1 = await tryPost(api, dave, text);
  if (!r1.ok) throw new Error(`FAIL: post rejected after grant: ${r1.error}`);
  const balAfter = await free(api, dave.ss58);
  const capAfter = (await cap(api, dave.ss58)).cap_last;
  const cost = K.BaseCost + K.PerByteCost * BigInt(new TextEncoder().encode(text).length);
  log(`  posted in block #${r1.block} ✓`);
  log(`  balance: ${balBefore} → ${balAfter}  (Δ = ${balAfter - balBefore})  ${balAfter === balBefore ? "FEELESS ✓" : "FAIL: a fee was charged"}`);
  if (balAfter !== balBefore) throw new Error("FAIL: post was not feeless");
  log(`  capacity: ${capBefore} → ${capAfter}  (consumed ${capBefore - capAfter}; post_cost = ${cost})`);

  // 6. drain the bucket until the pool rejects
  log(`\n[6] drain the bucket: post until ExhaustsResources`);
  let posts = 1, rejectedAt = null;
  for (let i = 0; i < 40; i++) {
    const r = await tryPost(api, dave, `drain ${i}`);
    if (r.ok) { posts++; } else { rejectedAt = posts; break; }
  }
  if (rejectedAt == null) throw new Error("FAIL: never hit the capacity gate while draining");
  log(`  posted ${posts} times this session, then rejected ✓ (cap ≈ ${capFull / K.BaseCost} posts of headroom)`);

  // 7. capacity regenerates over blocks → posting resumes
  const before = await api.query.System.Number.getValue();
  log(`\n[7] wait for regen (~${Number((K.BaseCost) / (w * K.RegenPerBlock)) + 1} blocks for one post) …`);
  await new Promise((res) => setTimeout(res, 30_000)); // ~5 blocks at 6s
  const after = await api.query.System.Number.getValue();
  const r2 = await tryPost(api, dave, "back after regen");
  log(`  block #${before} → #${after}; post after regen: ${r2.ok ? `SUCCESS ✓ (block #${r2.block})` : `still rejected: ${r2.error}`}`);
  if (!r2.ok) throw new Error("FAIL: capacity did not regenerate enough to post");

  log("\n==================== M2c ACCEPTANCE: PASS ====================");
  client.destroy();
  process.exit(0);
}
main().catch((e) => {
  console.error("\n==================== M2c ACCEPTANCE: FAIL ====================");
  console.error(e);
  process.exit(1);
});
