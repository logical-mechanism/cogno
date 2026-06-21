// social-seed — generate ONE of every social event on a fresh `--dev` node so the indexer (and the
// verify-m4c re-derivation gate) has real data to fold. Companion to verify-m4c.mjs / m5-acceptance.mjs
// (it lives here, not app/scripts, because it is indexer test data and uses @polkadot/api dynamic
// metadata — no PAPI codegen). Run with the nvm node v22 (the CIP-8 fixture shells out to MeshJS).
//
//   WS=ws://127.0.0.1:9944 node social-seed.mjs
//
// What it does, end to end:
//   1. binds //Bob / //Charlie / //Dave via the D1 trustless CIP-8 self-proof
//      (cognoGate.link_identity_signed) — a REAL headless-MeshJS signature per account (a DISTINCT
//      Cardano mnemonic each, so each gets a unique identity hash for the 1:1 gate). //Alice submits
//      (the fee payer); the bound account is the proof's account.
//   2. sudo set_stake + force_set_capacity (distinct weights → interesting stake-weighted tallies).
//   3. drives posts, a reply, a quote, up/down votes, a stake-change + a re-vote, a clear, reposts,
//      follow/unfollow, a poll + cast/re-cast poll votes, set/clear profile, pin/unpin — i.e. every
//      event the new handlers fold.
import { execFileSync } from "node:child_process";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(here, "..", "..", "app"); // m2-cip8-fixture.mjs lives in app/scripts (MeshJS)

// Distinct VALID BIP39 mnemonics → distinct Cardano wallets → distinct identity hashes (the gate is
// 1:1, so two accounts must NOT share a Cardano identity).
const ACCOUNTS = [
  { uri: "//Bob", weight: 50_000_000n, mnemonic: "test walk nut penalty hip pave soap entry language right filter choice" },
  { uri: "//Charlie", weight: 60_000_000n, mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow" },
  { uri: "//Dave", weight: 40_000_000n, mnemonic: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above" },
];

const log = (m) => console.log(m);
const hex0x = (h) => "0x" + String(h).replace(/^0x/, "");

async function main() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  const kp = {};
  for (const a of ACCOUNTS) kp[a.uri] = keyring.addFromUri(a.uri);
  const alice = keyring.addFromUri("//Alice");
  const ss58 = (uri) => kp[uri].address;

  // Send a tx, resolve with its in-block events; reject on a dispatch error (so the seed fails loud).
  const send = (tx, signer, label) =>
    new Promise((resolve, reject) => {
      tx.signAndSend(signer, ({ status, dispatchError, events, txHash }) => {
        if (!(status.isInBlock || status.isFinalized)) return;
        if (dispatchError) {
          let msg = dispatchError.toString();
          if (dispatchError.isModule) {
            const d = api.registry.findMetaError(dispatchError.asModule);
            msg = `${d.section}.${d.name}`;
          }
          return reject(new Error(`${label} FAILED: ${msg}`));
        }
        resolve({ events, blockHash: status.isInBlock ? status.asInBlock : status.asFinalized, txHash });
      }).catch(reject);
    });

  const genesis = (await api.rpc.chain.getBlockHash(0)).toHex().replace(/^0x/, "");
  log(`live genesis = ${genesis}\nWS = ${WS}\n`);

  // ── 1. bind each account via the CIP-8 self-proof ────────────────────────────
  for (const a of ACCOUNTS) {
    log(`[bind] ${a.uri} (${ss58(a.uri).slice(0, 8)}…) via CIP-8 self-proof …`);
    const out = execFileSync("node", ["scripts/m2-cip8-fixture.mjs", a.uri], {
      cwd: APP_ROOT,
      env: { ...process.env, GENESIS: genesis, MNEMONIC: a.mnemonic },
      encoding: "utf8",
    });
    const fx = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());
    log(`        identity (beacon name) = ${fx.idHashHex}`);
    await send(
      api.tx.cognoGate.linkIdentitySigned(hex0x(fx.signature), hex0x(fx.key), null),
      alice, // //Alice is the FEE payer/submitter; the bound account is the proof's account
      `bind ${a.uri}`,
    );
    log(`        bound ✓`);
  }

  // ── 2. weight + pre-charge the batteries (sudo = //Alice on --dev) ────────────
  const capRatio = (await api.consts.microblog.capRatio).toBigInt();
  const ceiling = (await api.consts.microblog.ceiling).toBigInt();
  const capOf = (w) => { const c = w * capRatio; return c < ceiling ? c : ceiling; };
  for (const a of ACCOUNTS) {
    const battery = capOf(a.weight);
    log(`[weight] ${a.uri} → stake=${a.weight}, battery=${battery}`);
    await send(api.tx.sudo.sudo(api.tx.talkStake.setStake(ss58(a.uri), a.weight)), alice, `set_stake ${a.uri}`);
    await send(api.tx.sudo.sudo(api.tx.microblog.forceSetCapacity(ss58(a.uri), battery)), alice, `force_cap ${a.uri}`);
  }

  // Shorthands for feeless social calls signed by the bound accounts.
  const post = (uri, text, parent = null) => send(api.tx.microblog.postMessage(text, parent), kp[uri], `post ${uri}`);
  const quote = (uri, text, quoted) => send(api.tx.microblog.quotePost(text, quoted), kp[uri], `quote ${uri}`);
  const vote = (uri, id, dir) => send(api.tx.microblog.vote(id, dir), kp[uri], `vote ${uri}`);
  const clearVote = (uri, id) => send(api.tx.microblog.clearVote(id), kp[uri], `clear_vote ${uri}`);
  const repost = (uri, id) => send(api.tx.microblog.repost(id), kp[uri], `repost ${uri}`);
  const follow = (uri, target) => send(api.tx.microblog.follow(ss58(target)), kp[uri], `follow ${uri}`);
  const unfollow = (uri, target) => send(api.tx.microblog.unfollow(ss58(target)), kp[uri], `unfollow ${uri}`);
  const createPoll = (uri, q, opts) => send(api.tx.microblog.createPoll(q, opts), kp[uri], `create_poll ${uri}`);
  const castPoll = (uri, id, opt) => send(api.tx.microblog.castPollVote(id, opt), kp[uri], `cast_poll_vote ${uri}`);
  const setProfile = (uri, name, bio, avatar) => send(api.tx.profile.setProfile(name, bio, avatar), kp[uri], `set_profile ${uri}`);
  const clearProfile = (uri) => send(api.tx.profile.clearProfile(), kp[uri], `clear_profile ${uri}`);
  const pin = (uri, id) => send(api.tx.profile.pinPost(id), kp[uri], `pin_post ${uri}`);
  const unpin = (uri) => send(api.tx.profile.unpinPost(), kp[uri], `unpin_post ${uri}`);

  // ── 3. drive the activity (post ids are assigned in order from 0) ─────────────
  log("\n[posts]");
  await post("//Bob", "hello from bob — the chain is the ledger"); //   id 0
  await post("//Charlie", "charlie's first post"); //                    id 1
  await post("//Dave", "a reply to bob", 0); //                          id 2 (reply → parent 0)
  await quote("//Bob", "quoting charlie ⟢", 1); //                       id 3 (quote → 1)

  log("[votes on #0 — incl. a stake-change + re-vote (reverse-by-STORED-weight test)]");
  await vote("//Charlie", 0, { Up: null }); //  Charlie Up @ 60M
  await vote("//Dave", 0, { Down: null }); //   Dave Down @ 40M
  // change Charlie's stake, then flip his vote: the fold must reverse the STORED 60M (not the new 75M)
  await send(api.tx.sudo.sudo(api.tx.talkStake.setStake(ss58("//Charlie"), 75_000_000n)), alice, "set_stake //Charlie #2");
  await vote("//Charlie", 0, { Down: null }); // Charlie flips Up→Down @ 75M
  await clearVote("//Dave", 0); //               Dave clears (reverse Down 40M)
  await vote("//Bob", 1, { Up: null }); //       Bob Up on #1 @ 50M

  log("[reposts on #1 — permanent]");
  await repost("//Bob", 1);
  await repost("//Dave", 1);

  log("[follows]");
  await follow("//Bob", "//Charlie");
  await follow("//Charlie", "//Bob");
  await follow("//Dave", "//Bob");
  await unfollow("//Dave", "//Bob"); // toggle off

  log("[poll #4 + stake-weighted poll votes incl. a cross-option re-cast]");
  await createPoll("//Charlie", "favorite color?", ["red", "green", "blue"]); // id 4
  await castPoll("//Bob", 4, 0); //     Bob → red @ 50M
  await castPoll("//Dave", 4, 1); //    Dave → green @ 40M
  await castPoll("//Charlie", 4, 2); // Charlie → blue @ 75M
  await castPoll("//Bob", 4, 2); //     Bob re-casts red→blue (reverse opt0, apply opt2)

  log("[profiles + pins]");
  await setProfile("//Bob", "Bob", "builder of things", "ipfs://bob");
  await setProfile("//Charlie", "Charlie", "", ""); // empty bio/avatar (tests empty strings)
  await setProfile("//Dave", "Dave (temp)", "to be cleared", "x");
  await clearProfile("//Dave"); // → Dave profile null
  await pin("//Bob", 0);
  await pin("//Charlie", 1);
  await pin("//Dave", 2);
  const last = await unpin("//Dave"); // → Dave pinnedPostId null

  // ── wait for the LAST seeded block to finalize (the indexer folds finalized blocks) ──
  const lastNum = (await api.rpc.chain.getHeader(last.blockHash)).number.toNumber();
  log(`\nlast seeded extrinsic in block #${lastNum}; waiting for GRANDPA finalization …`);
  for (let i = 0; i < 60; i++) {
    const fin = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
    if (fin >= lastNum) { log(`finalized #${fin} ✓`); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log("\n✅ seed complete. Now: drop the cogno schema, codegen+build, run the indexer, then verify-m4c.");
  await api.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error("seed failed:", e); process.exit(1); });
