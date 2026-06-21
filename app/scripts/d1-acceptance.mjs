// D1 (trustless identity) live acceptance — proves the FEELESS, unsigned CIP-8 self-proof end-to-end,
// with NO trusted writer and NO funded sponsor. A real headless-MeshJS wallet signs the pinned bind
// payload over THIS chain's live genesis; the proof is submitted as a BARE (unsigned) extrinsic — the
// CIP-8 proof IS the authorization, verified at pool admission + dispatch (`validate_unsigned`), so the
// brand-new ZERO-balance bound account pays nothing and needs no relay. We then prove the 1:1 binding,
// that the bound account's balance never moved (Δ = 0 — there is no fee), a feeless post, the FEELESS
// stake (voting-power) bind, and that a revoked identity's proof is refused AT THE POOL (the permanent
// tombstone enforced before inclusion).
//
//   WS=ws://127.0.0.1:9945 node scripts/d1-acceptance.mjs   # (use the nvm node v22 — MeshJS)
//
// The BOUND account is the one the proof commits (//CognoGateA — a non-endowed dev derivation, so it
// starts and stays at ZERO balance). //Alice is used ONLY for the sudo set_stake / force_set_capacity /
// revoke dev escape hatches (DR-07) — never to pay for or submit the binds. Exits 0 on full success.
import { execFileSync } from "node:child_process";
import { createClient, Binary } from "polkadot-api";
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
const freeOf = async (api, ss58) => (await api.query.System.Account.getValue(ss58))?.data?.free ?? 0n;
/** Generate a real MeshJS CIP-8 fixture (payment or stake) over the live genesis, committing GATE_URI.
 *  Robust to either single-line (payment) or pretty-printed multi-line (stake) JSON output: slice from
 *  the first `{` to the last `}` and parse that one object. */
const fixture = (script, genesis) => {
  const out = execFileSync("node", [`scripts/${script}`, GATE_URI], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, GENESIS: genesis }, encoding: "utf8",
  }).trim();
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
};

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const alice = signerOf("//Alice");
  const gateSs58 = ss58Of(GATE_URI);

  // 1. The LIVE genesis (block-0 hash) — exactly what the on-chain verifier compares against.
  const genesis = (await api.query.System.BlockHash.getValue(0)).asHex().replace(/^0x/, "");
  console.log(`live genesis = ${genesis}`);
  console.log(`bind target  = ${GATE_URI} (${gateSs58})`);

  // The bound account is a non-endowed derivation: it MUST start at zero balance, and must NEVER move
  // (the binds are feeless — there is no fee path, no Payment failure, no relay).
  const free0 = await freeOf(api, gateSs58);
  ok(free0 === 0n, `bound account starts at ZERO balance (${free0}) — a brand-new sign-to-derive account`);

  // 2. A REAL MeshJS CIP-8 proof over that genesis, committing the GATE account (the headless stand-in
  //    for an in-browser CIP-30 signData). The Cardano wallet signs; nothing trusted writes the chain.
  const fx = fixture("m2-cip8-fixture.mjs", genesis);
  console.log(`proof identity (beacon name) = ${fx.idHashHex}`);

  // 3. Submit the self-proof as a BARE (unsigned) extrinsic — FEELESS, no submitter account, no relay.
  //    `getBareTx()` builds the unsigned extrinsic; the low-level `client.submit` broadcasts it.
  console.log("\n[bind] cognoGate.link_identity_signed as a BARE (unsigned, feeless) extrinsic…");
  const bindTx = api.tx.CognoGate.link_identity_signed({
    cose_sign1: Binary.fromBytes(hexToBytes(fx.signature)),
    cose_key: Binary.fromBytes(hexToBytes(fx.key)),
    thread_pointer: undefined,
  });
  const bindRes = await client.submit(await bindTx.getBareTx());
  ok(bindRes.ok, `bind extrinsic dispatched ok${bindRes.ok ? "" : " — " + dispatchErr(bindRes)}`);
  const linked = evName(bindRes.events, "CognoGate", "IdentityLinked");
  ok(!!linked, "IdentityLinked event emitted");
  const idHex = linked.identity.asHex().replace(/^0x/, "");
  console.log(`on-chain identity (beacon name) = ${idHex}`);
  ok(!!linked && linked.who === gateSs58, `IdentityLinked.who == ${GATE_URI} (no submitter at all — unsigned)`);
  ok(/^[0-9a-f]{64}$/.test(idHex) && idHex !== "00".repeat(32), "IdentityLinked.identity is a 32-byte beacon-name hash");
  const freeAfterBind = await freeOf(api, gateSs58);
  ok(freeAfterBind === free0, `bound account balance UNCHANGED after the bind (Δ = ${freeAfterBind - free0}) — feeless`);

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
  const postRes = await api.tx.Microblog.post_message({ text: Binary.fromText("gm — bound by a FEELESS on-chain CIP-8 self-proof (D1)"), parent: undefined }).signAndSubmit(signerOf(GATE_URI));
  const created = evName(postRes.events, "Microblog", "PostCreated");
  ok(postRes.ok && !!created, `PostCreated (id=${created?.id}) — the bound account posted feelessly`);

  // 7. The FEELESS stake (voting-power) bind — same wallet, same account, bare unsigned again.
  console.log("\n[stake bind] cognoGate.link_stake_signed as a BARE (unsigned, feeless) extrinsic…");
  const sfx = fixture("m2-cip8-stake-fixture.mjs", genesis);
  const stakeTx = api.tx.CognoGate.link_stake_signed({
    cose_sign1: Binary.fromBytes(hexToBytes(sfx.signature)),
    cose_key: Binary.fromBytes(hexToBytes(sfx.key)),
  });
  const stakeRes = await client.submit(await stakeTx.getBareTx());
  ok(stakeRes.ok, `stake bind dispatched ok${stakeRes.ok ? "" : " — " + dispatchErr(stakeRes)}`);
  const staked = evName(stakeRes.events, "CognoGate", "StakeLinked");
  ok(!!staked && staked.who === gateSs58, `StakeLinked.who == ${GATE_URI} (the proof's account)`);
  const stakeBound = await api.query.CognoGate.StakeCredOf.getValue(gateSs58);
  ok(stakeBound?.asHex().replace(/^0x/, "") === sfx.stake_cred_hex, "StakeCredOf[account] == the proven stake credential");
  const freeAfterStake = await freeOf(api, gateSs58);
  ok(freeAfterStake === free0, `bound account balance STILL ${free0} after the stake bind (Δ = ${freeAfterStake - free0}) — feeless`);

  // 8. Operator ban: sudo revoke → permanent tombstone.
  console.log("\n[revoke] sudo revoke → permanent tombstone…");
  const revRes = await api.tx.Sudo.sudo({ call: api.tx.CognoGate.revoke({ substrate_account: gateSs58 }).decodedCall }).signAndSubmit(alice);
  ok(revRes.ok && !!evName(revRes.events, "CognoGate", "Revoked"), "Revoked event emitted");
  const tomb = await api.query.CognoGate.Tombstoned.getValue(idFix);
  ok(tomb !== undefined, "identity is tombstoned (permanent ban)");
  ok((await api.query.CognoGate.AccountOf.getValue(idFix)) === undefined, "AccountOf cleared after revoke");

  // 9. Replay the SAME (eternally-valid) wallet proof — the tombstone refuses it AT THE POOL (the
  //    unsigned bind is rejected by `validate_unsigned` before inclusion, so `submit` throws/rejects).
  console.log("\n[replay] re-submit the identical proof → must be refused at the pool by the tombstone…");
  let replayErr = "";
  let replayOk = false;
  try {
    const r = await client.submit(await bindTx.getBareTx());
    replayOk = r.ok;
    replayErr = dispatchErr(r);
  } catch (e) {
    replayErr = String(e?.message || e);
  }
  ok(!replayOk, `replay refused (not included) — pool rejection: ${replayErr.slice(0, 100)}`);

  console.log(`\n== D1 FEELESS ACCEPTANCE: ${FAILS === 0 ? "ALL PASSED ✓" : FAILS + " FAILED ✗"} ==`);
  client.destroy();
  process.exit(FAILS === 0 ? 0 : 1);
}
main().catch((e) => { console.error("d1-acceptance ERROR:", e); process.exit(1); });
