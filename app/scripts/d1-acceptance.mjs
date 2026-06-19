// D1 (trustless identity) live acceptance — proves the on-chain CIP-8 self-proof end-to-end, with NO
// trusted writer. A real headless-MeshJS wallet signs the pinned bind payload over THIS chain's live
// genesis; anyone submits `cognoGate.link_identity_signed` (the RUNTIME verifies the signature); then
// we prove the 1:1 binding, a feeless post, and that a revoked identity's proof can never re-bind
// (the permanent tombstone).
//
//   WS=ws://127.0.0.1:9945 node scripts/d1-acceptance.mjs   # (use the nvm node v22 — MeshJS)
//
// Funded //Alice is the FEE payer/submitter (link_identity_signed is NOT feeless — the DoS defence);
// the BOUND account is the one the proof commits (//CognoGateA), never the submitter. set_stake/revoke
// go through sudo (the DR-07 dev escape hatch). Exits 0 on full success, 1 on any failed assertion.
import { execFileSync } from "node:child_process";
import { createClient, Binary, FixedSizeBinary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9945";
const GATE_URI = process.env.GATE || "//CognoGateA";
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const signerOf = (uri) => { const kp = derive(uri); return getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign); };
const ss58Of = (uri) => ss58Address(derive(uri).publicKey, 42);

let FAILS = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${msg}`); if (!cond) FAILS++; };
const evName = (events, pallet, type) =>
  events.find((e) => e.type === pallet && e.value?.type === type)?.value?.value;
const dispatchErr = (r) => JSON.stringify(r.dispatchError ?? r.value ?? r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const alice = signerOf("//Alice");
  const gateSs58 = ss58Of(GATE_URI);

  // 1. The LIVE genesis (block-0 hash) — exactly what the on-chain verifier compares against.
  const genesis = (await api.query.System.BlockHash.getValue(0)).asHex().replace(/^0x/, "");
  console.log(`live genesis = ${genesis}`);
  console.log(`bind target  = ${GATE_URI} (${gateSs58})`);

  // 2. A REAL MeshJS CIP-8 proof over that genesis, committing the GATE account (the headless stand-in
  //    for an in-browser CIP-30 signData). The Cardano wallet signs; nothing trusted writes the chain.
  const out = execFileSync("node", ["scripts/m2-cip8-fixture.mjs", GATE_URI], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, GENESIS: genesis }, encoding: "utf8",
  });
  const fx = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());
  console.log(`proof identity (beacon name) = ${fx.idHashHex}`);

  // 3. Submit the self-proof — signed by //Alice (the FEE payer), bind target is the PROOF's account.
  console.log("\n[bind] cognoGate.link_identity_signed (the runtime verifies the wallet signature)…");
  const bindTx = api.tx.CognoGate.link_identity_signed({
    cose_sign1: Binary.fromBytes(hexToBytes(fx.signature)),
    cose_key: Binary.fromBytes(hexToBytes(fx.key)),
    thread_pointer: undefined,
  });
  const bindRes = await bindTx.signAndSubmit(alice);
  ok(bindRes.ok, `bind extrinsic dispatched ok${bindRes.ok ? "" : " — " + dispatchErr(bindRes)}`);
  const linked = evName(bindRes.events, "CognoGate", "IdentityLinked");
  ok(!!linked, "IdentityLinked event emitted");
  // The AUTHORITATIVE identity is what the runtime verifier computed (the beacon name = blake2b_256 of
  // the owner Address's Plutus-Data CBOR — NOT the fixture's informational `idHashHex`, which is the old
  // raw-CIP-19-bytes hash). The verifier's beacon-name correctness is locked cross-impl in
  // pallets/cogno-gate/src/cip8/tests.rs + services/cogno-follower/test_agreement.py.
  const idHex = linked.identity.asHex().replace(/^0x/, "");
  console.log(`on-chain identity (beacon name) = ${idHex}`);
  ok(!!linked && linked.who === gateSs58, `IdentityLinked.who == ${GATE_URI} (NOT the //Alice submitter)`);
  ok(/^[0-9a-f]{64}$/.test(idHex) && idHex !== "00".repeat(32), "IdentityLinked.identity is a 32-byte beacon-name hash");

  // 4. 1:1 both ways from chain state, keyed on the on-chain identity.
  const idFix = linked.identity; // already a FixedSizeBinary<32>
  const accountOf = await api.query.CognoGate.AccountOf.getValue(idFix);
  const pkhOf = await api.query.CognoGate.PkhOf.getValue(gateSs58);
  ok(accountOf === gateSs58, `AccountOf[identity] == ${GATE_URI} (${accountOf})`);
  ok(pkhOf?.asHex().replace(/^0x/, "") === idHex, "PkhOf[account] == identity (1:1 reverse map)");

  // 5. Weight the bound account (sudo set_stake + a full battery) so its first post is feeless-capable.
  console.log("\n[weight] sudo set_stake + force_set_capacity so the bound account can post…");
  const capRatio = await api.constants.Microblog.CapRatio();
  const ceiling = await api.constants.Microblog.Ceiling();
  const weight = 100_000_000n;
  const cap = weight * capRatio < ceiling ? weight * capRatio : ceiling;
  await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who: gateSs58, weight }).decodedCall }).signAndSubmit(alice);
  await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who: gateSs58, cap_last: cap }).decodedCall }).signAndSubmit(alice);

  // 6. The bound account posts FEELESSLY (the identity gate + capacity meter both pass).
  console.log("[post] the bound account posts a message…");
  const postRes = await api.tx.Microblog.post_message({ text: Binary.fromText("gm — bound by an on-chain CIP-8 self-proof (D1)"), parent: undefined }).signAndSubmit(signerOf(GATE_URI));
  const created = evName(postRes.events, "Microblog", "PostCreated");
  ok(postRes.ok && !!created, `PostCreated (id=${created?.id}) — the bound account posted feelessly`);

  // 7. Operator ban: sudo revoke → permanent tombstone.
  console.log("\n[revoke] sudo revoke → permanent tombstone…");
  const revRes = await api.tx.Sudo.sudo({ call: api.tx.CognoGate.revoke({ substrate_account: gateSs58 }).decodedCall }).signAndSubmit(alice);
  ok(revRes.ok && !!evName(revRes.events, "CognoGate", "Revoked"), "Revoked event emitted");
  const tomb = await api.query.CognoGate.Tombstoned.getValue(idFix);
  ok(tomb !== undefined, "identity is tombstoned (permanent ban)");
  ok((await api.query.CognoGate.AccountOf.getValue(idFix)) === undefined, "AccountOf cleared after revoke");

  // 8. Replay the SAME (eternally-valid) wallet proof — the tombstone refuses it.
  console.log("\n[replay] re-submit the identical proof → must be refused by the tombstone…");
  const replay = await api.tx.CognoGate.link_identity_signed({
    cose_sign1: Binary.fromBytes(hexToBytes(fx.signature)),
    cose_key: Binary.fromBytes(hexToBytes(fx.key)),
    thread_pointer: undefined,
  }).signAndSubmit(alice).catch((e) => ({ ok: false, dispatchError: String(e?.message || e) }));
  const replayErr = dispatchErr(replay);
  ok(!replay.ok && /IdentityTombstoned/.test(replayErr), `replay rejected with IdentityTombstoned (${replayErr.slice(0, 80)})`);

  console.log(`\n== D1 ACCEPTANCE: ${FAILS === 0 ? "ALL PASSED ✓" : FAILS + " FAILED ✗"} ==`);
  client.destroy();
  process.exit(FAILS === 0 ? 0 : 1);
}
main().catch((e) => { console.error("d1-acceptance ERROR:", e); process.exit(1); });
