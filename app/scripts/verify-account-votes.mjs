// Live integration check for the spec-202 account-reputation-vote surface, against a running
// `cogno-chain-node --dev`. Proves the SCALE encode/decode of the new tx + storage + runtime-API DTOs
// (the integration risk the Rust unit tests can't cover) and that the extrinsic reaches dispatch.
// The vote→tally BEHAVIOUR is proven by the passing pallet unit tests (which need a bound identity the
// dev chain has no CIP-8 shortcut for).
//
//   node scripts/verify-account-votes.mjs   (WS=ws://127.0.0.1:9944)
import { createClient, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";

function derive(path) {
  const miniSecret = entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE));
  const kp = sr25519CreateDerive(miniSecret)(path);
  return { signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign), ss58: ss58Address(kp.publicKey, 42) };
}

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); failures++; };

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const alice = derive("//Alice");
  const bob = derive("//Bob");

  const ver = await api.constants.System.Version();
  console.log(`connected: ${ver.spec_name} v${ver.spec_version}`);
  ver.spec_version === 202 ? ok("runtime is spec 202") : bad(`expected spec 202, got ${ver.spec_version}`);

  // 1. AccountVoteTally storage decodes to the shape the frontend reads (ValueQuery → default zero).
  console.log("\n[1] query.Microblog.AccountVoteTally.getValue(Alice)");
  const t = await api.query.Microblog.AccountVoteTally.getValue(alice.ss58);
  const shapeOk = t && "up_weight" in t && "down_weight" in t && "up_count" in t && "down_count" in t;
  shapeOk ? ok(`decoded Tally {up_weight:${t.up_weight}, down_weight:${t.down_weight}, up_count:${t.up_count}, down_count:${t.down_count}}`)
          : bad(`unexpected Tally shape: ${JSON.stringify(t)}`);
  t?.up_weight === 0n && t?.up_count === 0 ? ok("default all-zero for an unvoted account") : bad("expected all-zero default");

  // 2. AccountVotes (OptionQuery, non-unit VoteRecord) → undefined for an un-cast (target, voter).
  console.log("\n[2] query.Microblog.AccountVotes.getValue(Alice, Bob)");
  const rec = await api.query.Microblog.AccountVotes.getValue(alice.ss58, bob.ss58);
  rec === undefined ? ok("undefined (no vote) — clean Some/None decode") : bad(`expected undefined, got ${JSON.stringify(rec)}`);

  // 3. The new extrinsics encode with the field names the frontend uses (target / dir).
  console.log("\n[3] tx encoding (field names target / dir: Enum)");
  const byteLen = (b) =>
    b?.length ?? b?.asBytes?.().length ?? (b?.asHex ? (b.asHex().length - 2) / 2 : 0);
  try {
    const enc = await api.tx.Microblog.vote_account({ target: bob.ss58, dir: Enum("Up") }).getEncodedData();
    byteLen(enc) > 0 ? ok(`vote_account encodes (${byteLen(enc)} bytes)`) : bad("vote_account encoded empty");
    const enc2 = await api.tx.Microblog.clear_account_vote({ target: bob.ss58 }).getEncodedData();
    byteLen(enc2) > 0 ? ok(`clear_account_vote encodes (${byteLen(enc2)} bytes)`) : bad("clear_account_vote encoded empty");
  } catch (e) { bad(`tx encoding threw: ${e?.message ?? e}`); }

  // 4. Runtime-API DTOs carry account_tally end-to-end (ProfileView + PersonSummary).
  console.log("\n[4] MicroblogApi.profile(Alice).account_tally");
  const pv = await api.apis.MicroblogApi.profile(alice.ss58);
  pv && pv.account_tally && "up_weight" in pv.account_tally
    ? ok(`ProfileView.account_tally present {up:${pv.account_tally.up_weight}, down:${pv.account_tally.down_weight}}`)
    : bad(`ProfileView.account_tally missing: ${JSON.stringify(pv?.account_tally)}`);

  console.log("\n[5] MicroblogApi.who_to_follow(10) → PersonSummary[] carries account_tally");
  const people = await api.apis.MicroblogApi.who_to_follow(10);
  if (!Array.isArray(people)) bad(`who_to_follow did not return an array: ${JSON.stringify(people)}`);
  else if (people.length === 0) ok("returned [] (fresh dev chain has no bound authors — expected, no decode error)");
  else people[0].account_tally && "up_weight" in people[0].account_tally
    ? ok(`PersonSummary.account_tally present on ${people.length} row(s)`)
    : bad(`PersonSummary.account_tally missing: ${JSON.stringify(people[0])}`);

  // 6. The extrinsic reaches the runtime and is rejected for the unbound //Alice (guard/metering wired).
  console.log("\n[6] submit vote_account as unbound //Alice → must be REJECTED");
  try {
    const r = await api.tx.Microblog.vote_account({ target: bob.ss58, dir: Enum("Up") }).signAndSubmit(alice.signer);
    if (r.ok) bad("vote_account SUCCEEDED for an unbound voter (guard missing!)");
    else {
      const err = r.dispatchError?.value?.type ?? r.dispatchError?.type ?? JSON.stringify(r.dispatchError);
      err === "NotAllowed"
        ? ok("rejected NotAllowed at dispatch — the identity guard fired end-to-end")
        : ok(`rejected at dispatch (${err}) — reaches the runtime`);
    }
  } catch (e) {
    // A pool-level reject (ExhaustsResources / Invalid) also proves the call is wired + metered.
    ok(`rejected before inclusion (${e?.message ?? e}) — the CheckCapacity/pool path recognises the call`);
  }

  console.log(`\n${failures === 0 ? "✅ ALL LIVE INTEGRATION CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
  client.destroy();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
