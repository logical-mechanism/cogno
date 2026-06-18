// Read-only chain-state inspector — the companion to op.mjs (writes) / sync-weight.mjs.
// Dumps genesis + spec + an identity's bind + weight + the microblog post count, so an
// operator can see the live state before/after a privileged action (e.g. a vault relaunch).
//
//   WS=ws://127.0.0.1:9944 node state.mjs
//   WS=… node state.mjs --identity 0x287a99d2… --account //CognoVaultPoster
//
// No funds, no writes — just queries.
import { connect, operators } from "./lib.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";

function parse(argv) {
  const o = { identity: process.env.IDENTITY, account: process.env.ACCOUNT || "//CognoVaultPoster" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--identity") o.identity = argv[++i];
    else if (argv[i] === "--account") o.account = argv[++i];
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const api = await connect(WS);
  const ops = operators([o.account.startsWith("//") ? o.account : "//CognoVaultPoster"]);
  // Resolve the target account: a //Uri derives a fresh address; a raw ss58 is used as-is.
  const account = o.account.startsWith("//") ? ops.map[o.account.replace(/^\/\//, "")].address : o.account;

  console.log("WS              :", WS);
  console.log("genesis         :", api.genesisHash.toHex());
  console.log("spec            :", api.runtimeVersion.specName.toString(), api.runtimeVersion.specVersion.toNumber());
  console.log("account         :", o.account, "=>", account);

  if (o.identity) {
    const bound = await api.query.cognoGate.accountOf(o.identity);
    console.log("AccountOf[id]   :", bound.isNone ? "— UNBOUND" : bound.unwrap().toString());
  }
  const pkh = await api.query.cognoGate.pkhOf(account);
  console.log("PkhOf[account]  :", pkh.isNone ? "— not bound" : pkh.unwrap().toHex());
  const weight = await api.query.talkStake.allowedStake(account);
  console.log("AllowedStake    :", weight.toString());

  // Microblog post count (entries in the Posts map) + this author's posts. The Posts value is a
  // plain Post struct (not an Option), so read author off its JSON form.
  const posts = await api.query.microblog.posts.entries();
  const mine = posts.filter(([, v]) => {
    try {
      return v.toJSON()?.author === account;
    } catch {
      return false;
    }
  }).length;
  console.log("Microblog posts :", posts.length, `(by this account: ${mine})`);

  await api.disconnect();
  process.exit(0);
}
main().catch(async (e) => {
  console.error("STATE FAILED:", e?.message || e);
  process.exit(1);
});
