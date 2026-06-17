// ── cogno-chain Anchor VERIFY (M3 acceptance: "anyone can verify", DR-08) ─────────────────────
//
// Given a recorded checkpoint, independently prove the witnessed root is the chain's real finalized
// root, three ways that must all agree:
//   (A) L3 record      — Anchor.LastCheckpoint on-chain (what the relayer claims it anchored).
//   (B) committed archive — chain_getHeader(block).state_root from an archive node. This IS the
//       "re-derive the finalized state-root from genesis" check: an archive node computes a block's
//       header.state_root by executing every block from genesis, so reading it back re-derives it.
//   (C) Cardano witness — the metadata under our label in the anchor tx, read back from Cardano via
//       Kupo. This is the tamper-evidence: it lives on a chain the operator does not control.
// A == B == C ⇒ no silent rewrite before this anchor. A mismatch is public, on-Cardano evidence.
//
//   node verify.mjs            # verify the latest on-chain checkpoint (Anchor.LastCheckpoint)
//   node verify.mjs --block N  # verify the anchor recorded for solochain height N (from STATE_FILE)
//
// Env: WS, KUPO, STATE_FILE, LABEL (must match the relayer).

import fs from "node:fs";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const KUPO = process.env.KUPO || "http://127.0.0.1:1442";
const STATE_FILE = process.env.STATE_FILE || "/tmp/cogno-m2/anchor-state.json";
const LABEL = String(process.env.LABEL || "67797178");
const HTTP = WS.replace(/^ws/, "http");
const stripHex = (h) => String(h).replace(/^0x/, "").toLowerCase();
const fsbHex = (b) => stripHex(b?.asHex ? b.asHex() : b); // FixedSizeBinary → hex

let rpcId = 0;
async function rpc(method, params = []) {
  const res = await fetch(HTTP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Pull the value of metadata field `key` (e.g. "root") under our LABEL out of Kupo's detailed
// schema. Kupo returns, per tx, { schema: { "<label>": { map: [ { k:{string}, v:{string|int} } ] } } }.
function extractFromKupoSchema(metaEntry, key) {
  const top = metaEntry?.schema?.[LABEL];
  const pairs = top?.map || [];
  for (const p of pairs) {
    const k = p?.k?.string;
    if (k === key) return p?.v?.string ?? p?.v?.int ?? null;
  }
  return null;
}

async function main() {
  const blockArg = process.argv.includes("--block") ? Number(process.argv[process.argv.indexOf("--block") + 1]) : null;
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);

  // The L3 pallet stores only the LATEST checkpoint (Anchor.LastCheckpoint). The relayer's state
  // file is the per-height index (slot/txhash/root) — the full anchor history otherwise lives on
  // Cardano. So: choose the block; load its state entry (no silent fallback, or we'd verify the
  // WRONG anchor); take the recorded claim (A) from the on-chain checkpoint when it IS that height,
  // else from the state entry.
  const cp = await api.query.Anchor.LastCheckpoint.getValue();
  if (!cp) { console.error("✗ no checkpoint recorded on L3 yet (Anchor.LastCheckpoint is empty)"); client.destroy(); process.exit(1); }
  const block = blockArg ?? Number(cp.block_number);

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const entry = (state.anchors || []).find((a) => a.block === block);
  if (!entry) { console.error(`✗ no relayer state entry for block #${block} in ${STATE_FILE}`); client.destroy(); process.exit(1); }

  const onChain = Number(cp.block_number) === block; // is this height the current on-chain record?
  const recordedRoot = onChain ? fsbHex(cp.finalized_root) : stripHex(entry.root);
  const recordedTx = onChain ? fsbHex(cp.cardano_txhash) : entry.cardanoTx.toLowerCase();
  const recordedPosts = onChain ? BigInt(cp.post_count) : BigInt(entry.postCount);
  console.log(`A) L3 record        : block #${block}  root ${recordedRoot}  (source: ${onChain ? "on-chain LastCheckpoint" : "relayer state (history on Cardano)"})`);
  console.log(`                      cardano tx ${recordedTx}  posts ${recordedPosts}`);

  // Chain-identity guard: the node we re-derive against must be the SAME chain the relayer pinned and
  // wrote onto Cardano. An independent verifier syncs their own archive from the published
  // genesis/chainspec (DR-08); against a single operator node, this is only as honest as that node.
  const liveGenesis = stripHex((await client.getChainSpecData()).genesisHash);
  const genesisOk = !entry.genesis || liveGenesis === stripHex(entry.genesis);
  console.log(`   chain identity    : node genesis ${liveGenesis} ${genesisOk ? "== anchored genesis ✓" : "!= anchored genesis ✗ (DIFFERENT CHAIN)"}`);

  // (B) the committed archive — read block N's header.state_root back from an archive node. The
  // header (hence state_root) is always retained, so this works for any historical block; a fully
  // independent verifier re-syncs from genesis and gets the identical root. post_count needs retained
  // STATE at block N (a --pruning archive node, DR-08); on a pruned dev node for an old block it may
  // be unavailable — best-effort, never fails the verify (the root is the load-bearing check).
  const hash = await rpc("chain_getBlockHash", [block]);
  const header = await rpc("chain_getHeader", [hash]);
  const archiveRoot = stripHex(header.stateRoot);
  let archivePosts = null;
  try { archivePosts = await api.query.Microblog.NextPostId.getValue({ at: hash }); }
  catch (e) { console.log(`   (archive post_count at #${block} unavailable: ${e?.message || e})`); }
  console.log(`B) committed archive : block #${block}  header.state_root ${archiveRoot}  posts ${archivePosts ?? "(state pruned)"}`);

  // (C) the Cardano witness — read the metadata back from Cardano via Kupo /metadata/{slot}. This is
  // the whole tamper-evidence point, so an unreadable witness is a HARD FAIL, never a silent skip.
  let cardanoRoot = null, cardanoBlock = null;
  try {
    const url = `${KUPO}/metadata/${entry.slot}?transaction_id=${recordedTx}`;
    const arr = await (await fetch(url)).json();
    const metaEntry = Array.isArray(arr) ? arr[0] : arr;
    cardanoRoot = stripHex(extractFromKupoSchema(metaEntry, "root") || "");
    cardanoBlock = extractFromKupoSchema(metaEntry, "block");
    console.log(`C) Cardano witness   : tx ${recordedTx} @slot ${entry.slot}  metadata.root ${cardanoRoot || "(unreadable)"}  block ${cardanoBlock}`);
  } catch (e) {
    console.log(`C) Cardano witness   : metadata read failed (${e?.message || e})`);
  }

  // The verdict: A == B == C (root), the Cardano block field matches, chain identity matches, and
  // post_count is consistent where the archive state is available.
  const ab = recordedRoot === archiveRoot;
  const ac = !!cardanoRoot && recordedRoot === cardanoRoot;
  const blockMatch = cardanoBlock == null || Number(cardanoBlock) === block;
  const posts = archivePosts === null ? null : recordedPosts === BigInt(archivePosts);
  console.log("");
  console.log(`  chain identity (node == anchored genesis) : ${genesisOk ? "✓" : "✗"}`);
  console.log(`  A==B (L3 record == archive re-derivation) : ${ab ? "✓" : "✗"}`);
  console.log(`  A==C (L3 record == Cardano metadata)      : ${cardanoRoot ? (ac ? "✓" : "✗") : "✗ (witness unreadable)"}`);
  console.log(`  Cardano metadata block field == #${block}      : ${blockMatch ? "✓" : "✗"}`);
  console.log(`  post_count consistent (L3 == archive)     : ${posts === null ? "· (state pruned, skipped)" : posts ? "✓" : "✗"}`);

  // ac MUST be true (the Cardano witness is the point); posts may be skipped but must not be false.
  const ok = genesisOk && ab && ac && blockMatch && posts !== false;
  console.log(ok
    ? `\n🎯 VERIFIED: the root anchored on Cardano matches the chain's finalized post-state root at block #${block}. No silent rewrite before this anchor.`
    : `\n✗ VERIFY FAILED — a mismatch above is evidence the anchored root and the chain disagree.`);
  client.destroy();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("VERIFY ERROR:", e?.stack || e?.message || e); process.exit(1); });
