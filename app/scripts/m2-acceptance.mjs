// M2 CHAIN-SIDE acceptance — the CIP-8 identity gate, driven entirely by SUDO (no Cardano).
//
// Proves the on-chain half of M2 (PLAN §7.B: sudo is the documented pre-Cardano escape hatch):
//   1. baseline      — a fresh account is unbound (PkhOf/AccountOf empty, is_allowed false)
//   2. GATE proof    — a WEIGHTED + capacity-primed but UNBOUND account's post fails NotAllowed
//                      (identity ≠ rate-limit: the belt-and-suspenders body gate, distinct from
//                      the capacity pool gate)
//   3. bind + post   — sudo(link_identity) binds 1:1; the AccountOf readback resolves MY account;
//                      then a FEELESS post succeeds with free-balance Δ = 0
//   4. 1:1 anchor    — a double-bind is rejected on BOTH sides (PkhAlreadyBound / AccountAlreadyBound)
//   5. revoke        — sudo(revoke) re-locks (post → NotAllowed), and frees the identity to re-bind
//
// Needs a FRESH `--tmp` node (a prior run's bindings contaminate the baseline). Run:
//   ./target/release/cogno-chain-node --dev --tmp --rpc-port 9944
//   cd app && node scripts/m2-acceptance.mjs
import { createClient, FixedSizeBinary, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const kp = (uri) => derive(uri);
const ss58 = (uri) => ss58Address(kp(uri).publicKey, 42);
const signer = (uri) => { const k = kp(uri); return getPolkadotSigner(k.publicKey, "Sr25519", k.sign); };

let PASS = 0, FAIL = 0;
const ok = (cond, msg) => { if (cond) { PASS++; console.log(`  ✓ ${msg}`); } else { FAIL++; console.log(`  ✗ FAIL: ${msg}`); } };

// Extract the inner Sudo.Sudid result from a tx result's events: returns
// { ok: bool, err: <error-type-string|null> }.
const sudidResult = (res) => {
  const ev = (res.events || []).find((e) => e.type === "Sudo" && e.value?.type === "Sudid");
  if (!ev) return { ok: res.ok, err: null };
  const r = ev.value.value.sudo_result; // Result<(), DispatchError>
  const innerOk = r?.success === true || r?.type === "Ok";
  let err = null;
  if (!innerOk) {
    const d = r?.value ?? r; // DispatchError
    err = d?.value?.value?.type || d?.value?.type || d?.type || JSON.stringify(d);
  }
  return { ok: innerOk, err };
};

// The Module error name from a failed post's top-level dispatchError (e.g. "NotAllowed").
const moduleErr = (res) => res?.dispatchError?.value?.value?.type || res?.dispatchError?.value?.type || null;

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const sudo = signer("//Alice");

  // Test subjects — fresh, UNFUNDED dev derivations (0 balance ⇒ a succeeding post proves feeless).
  const A = ss58("//CognoGateA"), B = ss58("//CognoGateB");
  const HASH_A = FixedSizeBinary.fromBytes(new Uint8Array(32).fill(0xa1)); // stands in for blake2b_256(owner Address)
  const HASH_B = FixedSizeBinary.fromBytes(new Uint8Array(32).fill(0xb2));
  const W = 10_000_000n; // ~10 ADA-lovelace of weight
  const sudoCall = (inner) => api.tx.Sudo.sudo({ call: inner.decodedCall }).signAndSubmit(sudo);
  const isAllowed = async (who) => (await api.query.CognoGate.PkhOf.getValue(who)) !== undefined;
  const freeOf = async (who) => (await api.query.System.Account.getValue(who)).data.free;
  const post = (uri, text) => api.tx.Microblog.post_message({ text: Binary.fromText(text), parent: undefined }).signAndSubmit(signer(uri));

  const ver = await api.constants.System.Version();
  console.log(`\n== M2 chain-side acceptance — ${ver.spec_name} spec ${ver.spec_version} / tx ${ver.transaction_version} @ ${WS} ==`);
  ok(ver.spec_version === 103, `spec_version is 103 (was 102 in M2c)`);
  ok(typeof api.tx.CognoGate.link_identity === "function", `CognoGate.link_identity present (pallet @ index 8)`);

  // ── 1. baseline ──────────────────────────────────────────────────────────────────────
  console.log("\n[1] baseline — A is unbound");
  ok((await api.query.CognoGate.PkhOf.getValue(A)) === undefined, `PkhOf(A) is empty`);
  ok((await api.query.CognoGate.AccountOf.getValue(HASH_A)) === undefined, `AccountOf(hashA) is empty`);
  ok((await isAllowed(A)) === false, `is_allowed(A) == false`);

  // ── 2. GATE proof: weighted + capacity-primed but UNBOUND → NotAllowed ─────────────────
  console.log("\n[2] identity gate — weighted + capacity-primed but UNBOUND post fails NotAllowed");
  await sudoCall(api.tx.TalkStake.set_stake({ who: A, weight: W }));
  // force_set_capacity calls on_first_bind → gives A a provider ref + a full battery, but does
  // NOT create a gate binding. This isolates the identity gate from the capacity gate.
  await sudoCall(api.tx.Microblog.force_set_capacity({ who: A, cap_last: 5_000_000_000n }));
  ok((await isAllowed(A)) === false, `A has weight + capacity but is still NOT bound`);
  const r2 = await post("//CognoGateA", "should be blocked - no identity");
  ok(r2.ok === false && moduleErr(r2) === "NotAllowed", `post by unbound (but capacity'd) A → NotAllowed (got ok=${r2.ok}, err=${moduleErr(r2)})`);

  // ── 3. bind + feeless post ─────────────────────────────────────────────────────────────
  console.log("\n[3] bind via sudo(link_identity) + feeless post");
  const r3link = await sudoCall(api.tx.CognoGate.link_identity({ identity_hash: HASH_A, substrate_account: A, thread_pointer: undefined }));
  ok(sudidResult(r3link).ok, `sudo(link_identity(hashA, A)) succeeded`);
  const pkhA = await api.query.CognoGate.PkhOf.getValue(A);
  const acctOfHashA = await api.query.CognoGate.AccountOf.getValue(HASH_A);
  ok(pkhA !== undefined && pkhA.asHex() === HASH_A.asHex(), `PkhOf(A) == hashA`);
  ok(acctOfHashA === A, `AccountOf(hashA) == A  (the client readback resolves MY account)`);
  ok((await isAllowed(A)) === true, `is_allowed(A) == true`);
  const freeBefore = await freeOf(A);
  const r3post = await post("//CognoGateA", "gm cogno - bound and posting");
  const created = (r3post.events || []).find((e) => e.type === "Microblog" && e.value?.type === "PostCreated");
  ok(r3post.ok === true && !!created, `bound A posts successfully (PostCreated id=${created?.value?.value?.id})`);
  const freeAfter = await freeOf(A);
  ok(freeBefore === 0n && freeAfter === 0n, `feeless: A free balance Δ = 0 (before=${freeBefore}, after=${freeAfter})`);

  // ── 4. 1:1 anchor — reject double-bind on both sides ───────────────────────────────────
  console.log("\n[4] 1:1 enforcement — double-bind rejected on both sides");
  const r4a = sudidResult(await sudoCall(api.tx.CognoGate.link_identity({ identity_hash: HASH_A, substrate_account: B, thread_pointer: undefined })));
  ok(!r4a.ok && /PkhAlreadyBound/.test(r4a.err || ""), `link(hashA → B) rejected: PkhAlreadyBound (got ${r4a.err})`);
  const r4b = sudidResult(await sudoCall(api.tx.CognoGate.link_identity({ identity_hash: HASH_B, substrate_account: A, thread_pointer: undefined })));
  ok(!r4b.ok && /AccountAlreadyBound/.test(r4b.err || ""), `link(hashB → A) rejected: AccountAlreadyBound (got ${r4b.err})`);
  ok((await api.query.CognoGate.AccountOf.getValue(HASH_A)) === A, `binding unchanged: AccountOf(hashA) still == A`);

  // ── 5. revoke (manual ban) + re-bind ───────────────────────────────────────────────────
  console.log("\n[5] revoke re-locks posting, frees the identity to re-bind");
  ok(sudidResult(await sudoCall(api.tx.CognoGate.revoke({ substrate_account: A }))).ok, `sudo(revoke(A)) succeeded`);
  ok((await isAllowed(A)) === false, `is_allowed(A) == false after revoke`);
  ok((await api.query.CognoGate.AccountOf.getValue(HASH_A)) === undefined, `AccountOf(hashA) freed`);
  const r5post = await post("//CognoGateA", "should be blocked again");
  ok(r5post.ok === false && moduleErr(r5post) === "NotAllowed", `revoked A's post → NotAllowed again`);
  const r5re = sudidResult(await sudoCall(api.tx.CognoGate.link_identity({ identity_hash: HASH_A, substrate_account: B, thread_pointer: undefined })));
  ok(r5re.ok && (await api.query.CognoGate.AccountOf.getValue(HASH_A)) === B, `freed identity re-binds to B (AccountOf(hashA) == B)`);

  console.log(`\n== RESULT: ${PASS} passed, ${FAIL} failed ==\n`);
  client.destroy();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("acceptance crashed:", e); process.exit(1); });
