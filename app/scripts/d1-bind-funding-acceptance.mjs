// D1 bind-funding live acceptance — proves a BRAND-NEW, ZERO-BALANCE posting account can complete a
// full trustless bind through the Sponsored-Bind Relay, then post feelessly. This closes the new-user
// funding gap: link_identity_signed is deliberately NOT feeless (the DoS defence), so a fresh
// sign-to-derived account (balance 0) cannot self-pay; the funded relay pays the fee + relays the proof,
// and the RUNTIME stays the sole verifier (the relay is a LIVENESS party — it cannot forge or retarget).
//
//   WS=ws://127.0.0.1:9945 node scripts/d1-bind-funding-acceptance.mjs   # (use the nvm node v22 — MeshJS)
//
// Run against a FRESH `--dev --base-path /tmp/fund-demo --rpc-port 9945` node (a clean genesis so the
// account is unbound). The relay submitter is //Bob (FUNDED but NOT privileged — it holds no sudo /
// committee authority); sudo weighting (so the bound account can post) goes through //Alice. The bound
// account is //CognoFundDemo — a non-endowed dev derivation, so it starts with ZERO balance and never
// pays. Exits 0 on full success, 1 on any failed assertion.
import { execFileSync, spawn } from "node:child_process";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9945";
const RELAY_PORT = Number(process.env.RELAY_PORT || 8091);
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;
const RELAY_SEED = process.env.RELAY_SEED || "//Bob"; // funded fee-payer, NOT a privileged key
const GATE_URI = process.env.GATE || "//CognoFundDemo"; // a non-endowed (zero-balance) dev derivation
const RELAY_MJS = new URL("../../services/sponsored-bind-relay/relay.mjs", import.meta.url).pathname;

const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const signerOf = (uri) => { const kp = derive(uri); return getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign); };
const ss58Of = (uri) => ss58Address(derive(uri).publicKey, 42);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let FAILS = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${msg}`); if (!cond) FAILS++; };
const evName = (events, pallet, type) => events.find((e) => e.type === pallet && e.value?.type === type)?.value?.value;
const freeOf = async (api, ss58) => (await api.query.System.Account.getValue(ss58))?.data?.free ?? 0n;

async function waitRelayReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RELAY_URL}/health`);
      const body = await r.json().catch(() => ({}));
      if (body.node_reachable) return body;
    } catch {
      // not listening yet
    }
    await sleep(400);
  }
  throw new Error(`relay at ${RELAY_URL} never became ready`);
}

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const gateSs58 = ss58Of(GATE_URI);
  const relaySs58 = ss58Of(RELAY_SEED);

  const genesis = (await api.query.System.BlockHash.getValue(0)).asHex().replace(/^0x/, "");
  console.log(`live genesis = ${genesis}`);
  console.log(`bind target  = ${GATE_URI} (${gateSs58})  [must start with ZERO balance]`);
  console.log(`relay payer  = ${RELAY_SEED} (${relaySs58})  [funded, NOT privileged]`);

  // 0. PRECONDITION: the bound account is brand-new and holds zero balance (so it cannot self-pay).
  const gateStart = await freeOf(api, gateSs58);
  ok(gateStart === 0n, `bind target starts with ZERO balance (free=${gateStart}) — cannot pay its own fee`);
  const bound0 = await api.query.CognoGate.PkhOf.getValue(gateSs58);
  ok(bound0 === undefined, "bind target is not yet bound (fresh chain)");

  // 1. A REAL MeshJS CIP-8 proof committing the fresh GATE account over the live genesis (the headless
  //    stand-in for an in-browser CIP-30 signData). Nothing trusted writes the chain.
  const out = execFileSync("node", ["scripts/m2-cip8-fixture.mjs", GATE_URI], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, GENESIS: genesis }, encoding: "utf8",
  });
  const fx = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());
  console.log(`proof signed by Cardano wallet ${fx.signed_address.slice(0, 18)}…`);

  // 2. Start the Sponsored-Bind Relay (submitter = the FUNDED //Bob key), pointed at this node.
  console.log(`\n[relay] starting sponsored-bind relay (RELAY_SEED=${RELAY_SEED}) on :${RELAY_PORT}…`);
  const relay = spawn("node", [RELAY_MJS], {
    env: { ...process.env, WS, PORT: String(RELAY_PORT), RELAY_SEED, GENESIS: genesis, RATE_LIMIT_PER_MIN: "0" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    const health = await waitRelayReady();
    ok(health.ok === true, `relay /health is healthy (relay funded, node reachable) — badges: ${JSON.stringify(health.badges?.relay)}`);

    // 3. POST the proof to the relay — the relay pays the fee + submits link_identity_signed. Measure the
    //    relay payer's balance across JUST this POST to prove the RELAY (not the bound account) paid.
    const relayBefore = await freeOf(api, relaySs58);
    console.log("\n[bind] POST /bind → the relay pays the fee + submits cognoGate.link_identity_signed…");
    const resp = await fetch(`${RELAY_URL}/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cose_sign1: fx.signature, cose_key: fx.key }),
    });
    const bindOut = await resp.json().catch(() => ({}));
    ok(resp.ok && bindOut.ok === true, `relay accepted + submitted the bind${bindOut.ok ? "" : " — " + JSON.stringify(bindOut)}`);
    const idHex = (bindOut.identity || "").replace(/^0x/, "");
    ok(/^[0-9a-f]{64}$/.test(idHex), `relay returned a 32-byte beacon-name identity (${idHex.slice(0, 16)}…)`);

    // 4. The binding landed for the FRESH account (the proof's account), keyed on the on-chain identity.
    const idFix = (await api.query.CognoGate.PkhOf.getValue(gateSs58)); // FixedSizeBinary<32> or undefined
    ok(idFix !== undefined, "PkhOf[bind target] is now set (the bind landed)");
    ok(idFix?.asHex().replace(/^0x/, "") === idHex, "PkhOf[account] == the relay-reported identity (1:1 reverse map)");
    const accountOf = await api.query.CognoGate.AccountOf.getValue(idFix);
    ok(accountOf === gateSs58, `AccountOf[identity] == ${GATE_URI} (the PROOF's account, NOT the //Bob relay payer)`);
    ok(accountOf !== relaySs58, "the bound account is NOT the relay payer — the relay funded, it did not become the identity");

    // 5. THE CRUX: the bound account NEVER paid — its balance is still exactly zero; the relay's dropped.
    const gateAfter = await freeOf(api, gateSs58);
    const relayAfter = await freeOf(api, relaySs58);
    ok(gateAfter === 0n, `bind target STILL has ZERO balance after binding (free=${gateAfter}) — it never paid`);
    ok(relayAfter < relayBefore, `the relay payer's balance dropped (${relayBefore} → ${relayAfter}) — the RELAY paid the fee`);

    // 5b. The relay RELAYS the chain's verdict verbatim — it cannot force a bind. Re-POST the same proof
    //     (the account is now bound) → the runtime refuses (1:1 invariant); a malformed body → a 400
    //     anti-abuse pre-check BEFORE the relay pays anything.
    console.log("\n[relay-fidelity] re-POST the same proof (already bound) + a malformed body…");
    const replay = await fetch(`${RELAY_URL}/bind`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cose_sign1: fx.signature, cose_key: fx.key }),
    });
    const replayOut = await replay.json().catch(() => ({}));
    ok(replay.status === 422 && replayOut.ok === false && /AlreadyBound/.test(replayOut.error || ""),
      `relay surfaces the chain's rejection of a re-bind verbatim (${(replayOut.error || "").slice(0, 40)}) — it cannot force a bind`);
    const bad = await fetch(`${RELAY_URL}/bind`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cose_sign1: "zz", cose_key: fx.key }),
    });
    ok(bad.status === 400, "relay rejects a malformed proof with 400 (anti-abuse pre-check, before paying a fee)");
  } finally {
    relay.kill("SIGTERM");
  }

  // 6. Weight the bound account (sudo //Alice) so its first post is feeless-capable.
  console.log("\n[weight] sudo set_stake + force_set_capacity so the (still zero-balance) account can post…");
  const alice = signerOf("//Alice");
  const capRatio = await api.constants.Microblog.CapRatio();
  const ceiling = await api.constants.Microblog.Ceiling();
  const weight = 100_000_000n;
  const cap = weight * capRatio < ceiling ? weight * capRatio : ceiling;
  await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who: gateSs58, weight }).decodedCall }).signAndSubmit(alice);
  await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who: gateSs58, cap_last: cap }).decodedCall }).signAndSubmit(alice);

  // 7. The zero-balance bound account posts FEELESSLY — identity gate + capacity meter both pass, and its
  //    balance is STILL zero afterwards (posting takes no fee).
  console.log("[post] the bound (zero-balance) account posts a message…");
  const postRes = await api.tx.Microblog.post_message({
    text: Binary.fromText("gm — bound via a sponsored relay, paid nothing (D1 bind-funding)"), parent: undefined,
  }).signAndSubmit(signerOf(GATE_URI));
  const created = evName(postRes.events, "Microblog", "PostCreated");
  ok(postRes.ok && !!created, `PostCreated (id=${created?.id}) — the zero-balance bound account posted feelessly`);
  ok((await freeOf(api, gateSs58)) === 0n, "bind target STILL has ZERO balance after posting (feeless)");

  console.log(`\n== D1 BIND-FUNDING ACCEPTANCE: ${FAILS === 0 ? "ALL PASSED ✓" : FAILS + " FAILED ✗"} ==`);
  client.destroy();
  process.exit(FAILS === 0 ? 0 : 1);
}
main().catch((e) => { console.error("d1-bind-funding-acceptance ERROR:", e); process.exit(1); });
