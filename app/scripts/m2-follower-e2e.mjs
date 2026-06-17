// M2 follower → chain end-to-end: drive the FULL bind loop the way the browser will, but with a
// headless MeshJS wallet standing in for the in-browser CIP-30 signData (the real click-through is
// the user's final acceptance). Proves DONE-WHEN #3 (real CIP-8 verify + link_identity submit) and
// the bind→weight→post loop of #4:
//
//   GET /nonce → sign the follower's payload (MeshJS) → POST /bind → follower verifies + submits
//   → assert on-chain AccountOf(idHash) == my account → sudo grant weight → FEELESS post succeeds
//
// Needs: a fresh --dev --tmp node on :9944 AND the Cogno-Follower on :8090. Run:
//   cd app && node scripts/m2-follower-e2e.mjs
import { createClient, FixedSizeBinary, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";
import { toHex } from "polkadot-api/utils";
import * as core from "@meshsdk/core";
import * as cst from "@meshsdk/core-cst";
import { blake2b } from "blakejs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const FOLLOWER = process.env.FOLLOWER || "http://127.0.0.1:8090";
const MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice".split(" ");

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log(`  ✓ ${m}`); } else { FAIL++; console.log(`  ✗ FAIL: ${m}`); } };
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const sudoKp = derive("//Alice");
  const sudo = getPolkadotSigner(sudoKp.publicKey, "Sr25519", sudoKp.sign);

  // The user's sr25519 posting account (Model-B key, here a dev derivation).
  const accountKp = derive("//CognoGateA");
  const accountHex = toHex(accountKp.publicKey).replace(/^0x/, "");
  const account = ss58Address(accountKp.publicKey, 42);
  const accountSigner = getPolkadotSigner(accountKp.publicKey, "Sr25519", accountKp.sign);

  console.log(`\n== M2 follower → chain e2e @ node ${WS} / follower ${FOLLOWER} ==`);
  const health = await (await fetch(`${FOLLOWER}/health`)).json();
  ok(health.ok === true, `follower healthy; badges = ${JSON.stringify(health.badges)}`);

  // 1) fetch a nonce + the exact payload to sign
  const nres = await (await fetch(`${FOLLOWER}/nonce?account=${accountHex}`)).json();
  ok(typeof nres.payload === "string" && nres.payload.includes(accountHex), `/nonce returned a payload committing my account`);
  ok(nres.genesis === health.genesis, `payload commits this chain's genesis`);

  // 2) the user signs the follower's payload with their Cardano wallet (headless MeshJS here)
  const wallet = new core.MeshWallet({ networkId: 0, key: { type: "mnemonic", words: MNEMONIC } });
  if (wallet.init) await wallet.init();
  const signing_address = await wallet.getChangeAddress();
  const sig = await wallet.signData(nres.payload, signing_address);
  const rawHex = cst.Address.fromBech32(signing_address).toBytes().toString();
  const idHashHex = toHex(blake2b(hexToBytes(rawHex), undefined, 32)).replace(/^0x/, "");

  // 3) POST the bind to the follower (it verifies CIP-8 + submits link_identity)
  const bres = await (await fetch(`${FOLLOWER}/bind`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature: sig.signature, key: sig.key, signing_address, sr25519_pubkey: accountHex }),
  })).json();
  ok(bres.ok === true, `follower verified the CIP-8 proof + submitted link_identity (${JSON.stringify(bres.error ?? "ok")})`);
  ok(bres.identity_hash === idHashHex, `follower bound the identity hash I computed (${idHashHex.slice(0, 16)}…)`);

  // 4) the AccountOf readback — the client's bind-complete check (L5 §5.7)
  const bound = await api.query.CognoGate.AccountOf.getValue(FixedSizeBinary.fromBytes(hexToBytes(idHashHex)));
  ok(bound === account, `on-chain AccountOf(idHash) == MY account (readback resolves the bind)`);
  ok((await api.query.CognoGate.PkhOf.getValue(account)) !== undefined, `is_allowed(my account) == true`);

  // 5) weight is still sudo-granted in M2 (Cardano-sourced weight is M2d) → then a FEELESS post
  await api.tx.Sudo.sudo({ call: api.tx.TalkStake.set_stake({ who: account, weight: 10_000_000n }).decodedCall }).signAndSubmit(sudo);
  await api.tx.Sudo.sudo({ call: api.tx.Microblog.force_set_capacity({ who: account, cap_last: 5_000_000_000n }).decodedCall }).signAndSubmit(sudo);
  const free0 = (await api.query.System.Account.getValue(account)).data.free;
  const pr = await api.tx.Microblog.post_message({ text: Binary.fromText("bound via real CIP-8, posting feelessly"), parent: undefined }).signAndSubmit(accountSigner);
  const created = (pr.events || []).find((e) => e.type === "Microblog" && e.value?.type === "PostCreated");
  ok(pr.ok && !!created, `bound account posts after a REAL CIP-8 bind (PostCreated id=${created?.value?.value?.id})`);
  const free1 = (await api.query.System.Account.getValue(account)).data.free;
  ok(free0 === 0n && free1 === 0n, `feeless: free balance Δ = 0 (before=${free0}, after=${free1})`);

  console.log(`\n== RESULT: ${PASS} passed, ${FAIL} failed ==\n`);
  client.destroy();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("e2e crashed:", e); process.exit(1); });
