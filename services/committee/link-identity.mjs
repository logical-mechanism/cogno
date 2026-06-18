// Committee-routed link_identity submitter the Cogno-Follower shells out to when FOLLOWER_VIA=committee
// (prod-readiness Phase 3). Same CLI + one-line-JSON contract as app/scripts/submit-link.mjs, but writes
// the binding through the 3-of-5 FollowerCommittee (or sudo with --via sudo) using the @polkadot/api
// committee tooling — so the follower host holds the committee SEATS, not the chain's full SUDO key.
// link_identity is gated by FollowerOrigin = EnsureRoot OR the 3-of-5 committee, so this needs no
// runtime change.
//
//   node link-identity.mjs <identity_hash_hex> <account_pubkey_hex> [<thread_hex>] [--via committee|sudo]
//
// Prints one line of JSON: { ok, identity_hash, account, error? }; exit 0 on a successful bind, 1 else.
import { encodeAddress } from "@polkadot/util-crypto";
import { isMain } from "../_shared/cli.mjs";
import { connect, drive, operators, resolveCommittee, assertRealKeys, assertGenesis } from "./lib.mjs";

const out = (o) => console.log(JSON.stringify(o));
const strip = (h) => (h || "").replace(/^0x/, "");
const isHex = (h) => /^[0-9a-fA-F]*$/.test(h);

// PURE arg parse (index-based, like op.mjs): CONSUME the --via VALUE so it never leaks into the
// positional thread_pointer slot. Returns { hashHex, accountHex, threadHexRaw, via }.
export function parseArgs(argv) {
  const positional = [];
  let viaFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--via") viaFlag = argv[++i];
    else if (a.startsWith("--")) { /* unknown flag: ignore (no other flags take a value) */ }
    else positional.push(a);
  }
  const [hashHexRaw, accountHexRaw, threadHexRaw] = positional;
  return {
    hashHex: strip(hashHexRaw),
    accountHex: strip(accountHexRaw),
    threadHexRaw,
    via: (viaFlag || process.env.FOLLOWER_VIA || "committee").trim().toLowerCase(),
  };
}

async function main() {
  const { hashHex, accountHex, threadHexRaw, via } = parseArgs(process.argv.slice(2));
  if (!hashHex || !accountHex || !isHex(hashHex) || !isHex(accountHex)) {
    out({ ok: false, error: "usage: link-identity.mjs <identity_hash_hex> <account_pubkey_hex> [<thread_hex>] [--via committee|sudo]" });
    process.exit(1);
  }
  const threadHex = threadHexRaw ? strip(threadHexRaw) : null;
  if (threadHex !== null && !isHex(threadHex)) {
    out({ ok: false, identity_hash: hashHex, error: `thread_pointer is not hex: ${threadHexRaw}` });
    process.exit(1);
  }
  const api = await connect();
  try {
    assertRealKeys(via); // fail-closed: no public dev keys under COGNO_PROFILE=prod
    assertGenesis(api);  // pin the chain if GENESIS is set
    const account = encodeAddress("0x" + accountHex, 42); // ss58 (prefix 42) from the 32-byte pubkey
    const inner = api.tx.cognoGate.linkIdentity("0x" + hashHex, account, threadHex ? "0x" + threadHex : null);
    const ops = operators();
    const driveOpts = { via, log: () => {} };
    if (via === "committee") {
      // Threshold from on-chain membership + seed reconciliation (same as op.mjs/sync-weight).
      const rc = await resolveCommittee(api, ops);
      Object.assign(driveOpts, { threshold: rc.threshold, members: rc.members, operators: ops });
    }
    // drive() throws on a dispatch/tooling failure OR a reverted inner call (ensureExecuted), so
    // reaching the next line means the binding executed on-chain.
    await drive(api, inner, driveOpts);
    out({ ok: true, identity_hash: hashHex, account });
    await api.disconnect();
    process.exit(0);
  } catch (e) {
    out({ ok: false, identity_hash: hashHex, error: String(e?.message || e) });
    await api.disconnect();
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by tests).
if (isMain(import.meta.url)) main().catch((e) => { out({ ok: false, error: String(e?.message || e) }); process.exit(1); });
