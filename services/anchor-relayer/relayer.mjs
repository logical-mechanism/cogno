// ── cogno-chain Anchor Relayer (M3, Tier-A: the Cardano WRITE link) ──────────────────────────
//
// Every N FINALIZED solochain blocks, write that block's finalized post-state root onto Cardano as
// tx METADATA, then sudo-call `Anchor.anchor_ack` back so the chain records which Cardano tx
// witnessed which finalized root. Evidence, not enforcement (DR-20): Cardano can't reject a wrong
// root; the anchor only lets a third party DETECT a silent rewrite after the fact (given the
// committed archive, DR-08). See PLAN §4.9-4.10, §9; docs/M3-build.md.
//
// Why the finalized HEADER's state_root (PLAN §4.9): a Substrate block header's `state_root` is the
// trie root AFTER that block executes (its post-state). Reading it from the FINALIZED head means we
// anchor a root GRANDPA has actually committed — never a best-chain/in-progress root that could
// later lose a fork. The pallet deliberately does NOT snapshot a root itself.
//
// §9 risks handled here (this is most of the relayer):
//  • idempotency / anti-double-count — never re-anchor a height <= the pallet's LastCheckpoint;
//    the pallet ALSO no-ops a stale ack (belt + suspenders). Keyed by solochain block_number.
//  • paid-tx / ack separation (relayer-1) — the Cardano metadata tx costs ADA; the L3 ack is free &
//    idempotent. The confirmed Cardano tx is PERSISTED before the ack, and a failed/ambiguous ack is
//    retried ACK-ONLY (never re-minting a paid tx). A run resumes any persisted-but-unacked anchor
//    before considering a new height, so a crash or a down committee can't double-spend the wallet.
//  • UTxO contention / output chaining — single-threaded; each Cardano tx is awaited to confirm
//    (its change UTxO indexed by Kupo) BEFORE the next anchor selects UTxOs, so anchor_{k+1}
//    naturally spends anchor_k's change. No two in-flight txs fighting over one UTxO.
//  • Cardano rollback — if a submitted tx never confirms within the timeout it is rebuilt &
//    resubmitted; because anchor_ack is keyed by solochain height, a duplicate Cardano tx for the
//    same height cannot double-count on L3.
//  • fees / min-ADA — a metadata-only, NO-script tx; MeshTxBuilder coin-selects + computes the fee,
//    change returns to the relayer. (No Plutus script ⇒ the M2d cost-model gotcha does NOT apply.)
//
// Modes:
//   node relayer.mjs              # watch: anchor the latest finalized head every ANCHOR_EVERY blocks
//   node relayer.mjs --once       # anchor the current finalized head once (if > last), then exit
//   node relayer.mjs --reack-last # re-submit anchor_ack for the recorded checkpoint VERBATIM (the
//                                 # exact rollback-resubmit case) → expect the idempotent no-op
//                                 # (AckIgnored), proving anchor_ack never double-counts.
//
// Env: WS, KUPO, OGMIOS, ANCHOR_EVERY (default 10), CONFIRM_TIMEOUT_MS (180000), POLL_MS (4000),
//      ACK_MAX_ATTEMPTS (5), ACK_BACKOFF_MS (4000), STATE_FILE (/tmp/cogno-m2/anchor-state.json),
//      LABEL (67797178 = ASCII "COGN").

import fs from "node:fs";
import { createClient, FixedSizeBinary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";
import { MeshTxBuilder } from "@meshsdk/core";
// The relayer signing wallet IS the M2d owner wallet (a single dev key, DR-07/§9 — labelled as
// such). Reuses the funded preprod wallet + the Kupo fetcher / Ogmios submitter helpers.
import { getOwnerWallet, kupo, ogmios } from "../../app/scripts/m2d-wallet.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const KUPO = process.env.KUPO || "http://127.0.0.1:1442";
const OGMIOS = process.env.OGMIOS || "http://127.0.0.1:1337";
const ANCHOR_EVERY = BigInt(process.env.ANCHOR_EVERY || "10");
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS || "180000");
const POLL_MS = Number(process.env.POLL_MS || "4000");
// Reorg-safety burial depth, in Cardano SLOTS (DR-09b). The relayer only acks a Cardano tx once it
// is buried this many slots past the tip, so a tx that later rolls back is never recorded on L3
// (LastCheckpoint advances monotonically and would otherwise pin a vanished txhash). 0 = ack as soon
// as it's in a block (fast for the showcase); production sets k (a few hundred slots, DR-09b).
const CONFIRM_DEPTH_SLOTS = Number(process.env.CONFIRM_DEPTH_SLOTS || "0");
// anchor_ack retry (relayer-1/2). The Cardano metadata tx is PAID; the L3 ack is height-keyed and
// idempotent. So a failed/ambiguous ack must NEVER re-mint a fresh Cardano tx — we persist the
// confirmed tx, then retry ONLY the ack with bounded exponential backoff before giving up (a circuit
// breaker that leaves the anchor persisted-but-unacked, to be resumed ack-only on the next run/loop).
const ACK_MAX_ATTEMPTS = Number(process.env.ACK_MAX_ATTEMPTS || "5");
const ACK_BACKOFF_MS = Number(process.env.ACK_BACKOFF_MS || "4000");
const STATE_FILE = process.env.STATE_FILE || "/tmp/cogno-m2/anchor-state.json";
// The Cardano metadata label. 67797178 = ASCII "COGN" (C=67 O=79 G=71 N=78) — a self-assigned
// (NOT CIP-10-registered) showcase label; documented in services/anchor-relayer/README.md.
const LABEL = Number(process.env.LABEL || "67797178");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHex = (h) => h.replace(/^0x/, "").toLowerCase();
const hexToBytes = (h) => Uint8Array.from(Buffer.from(stripHex(h), "hex"));

// ── M6 (DR-07): drive the privileged `anchor_ack` through the 3-of-5 FollowerCommittee, not sudo ──
// `ANCHOR_VIA` ∈ {committee (default), sudo}. The committee path shells out to the validated,
// @polkadot/api-based operator tooling (services/committee/op.mjs) — which works at spec 106 without
// regenerating this relayer's PAPI descriptors, and keeps ONE audited propose→vote→close codepath
// for every privileged call. `sudo` keeps the v1 dev fallback (the EnsureRoot escape hatch).
// ⚠ HONESTY (DR-07): on the single-operator preprod stack one operator holds all five committee
// keys, so this is D2-SHAPED, not D2-TRUST. See docs/D2-custody-runbook.md.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ANCHOR_VIA = process.env.ANCHOR_VIA || "committee";
const OP_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "committee", "op.mjs");

// Drive `anchor.anchor_ack(block, root, txhash, count, ts)` via the committee tooling. Throws on
// failure (the caller keeps the checkpoint unrecorded and retries next loop). Returns true.
function committeeAnchorAck({ block, root, txhash, count, ts }) {
  // op.mjs (@polkadot/api) decodes the [u8;32] args from 0x-hex. The state_root (from PAPI) is
  // already 0x-prefixed, but the Cardano txHash (from MeshJS submitTx) is NOT — passed bare, the
  // 64-char hex is read as a 64-BYTE raw string and rejected ("Expected 32 bytes, found 64").
  // Normalize both to 0x-hex so the committee path matches the PAPI/sudo path's encoding.
  const hx = (h) => (String(h).startsWith("0x") ? String(h) : "0x" + h);
  const args = JSON.stringify([Number(block), hx(root), hx(txhash), Number(count), Number(ts)]);
  console.log(`  → anchor_ack via 3-of-5 committee (op.mjs; D2-shaped, single-operator)`);
  // Capture op.mjs's output and read the ACTUAL inner committee events (anchor.AnchorAcked /
  // AckIgnored). Re-reading LastCheckpoint here instead would lag GRANDPA finalization (op.mjs
  // resolves at in-block, finalized state is ~1-2 blocks behind) and mis-report a real ack as ignored.
  const out = execFileSync(process.execPath, [OP_CLI, "--call", "anchor.anchorAck", "--args", args, "--via", "committee", "--ws", WS], { encoding: "utf8" });
  process.stdout.write(out);
  return { acked: /AnchorAcked/.test(out), ignored: /AckIgnored/.test(out) };
}

// The latest finalized head, read entirely through PAPI so the block stays PINNED — its header and
// our storage reads (NextPostId/Timestamp) must all key on a block PAPI is tracking, or the typed
// `getValue({ at })` throws BlockNotPinned. The post-state root of a finalized block = its
// header.stateRoot (the GRANDPA-committed root, PLAN §4.9).
async function finalizedHead(client) {
  const fin = await client.getFinalizedBlock(); // { hash, number, parent }
  const header = await client.getBlockHeader(fin.hash); // { stateRoot, number, ... }
  return { hash: fin.hash, number: BigInt(fin.number), stateRoot: header.stateRoot };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { anchors: [] }; }
}
function saveState(s) {
  fs.mkdirSync(STATE_FILE.replace(/\/[^/]*$/, ""), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// The Cardano tip slot (for the reorg-burial check). Best-effort; null on any error.
async function tipSlot() {
  try {
    const res = await fetch(OGMIOS, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip" }) });
    const { result } = await res.json();
    return result?.slot ?? null;
  } catch { return null; }
}

// Wait until Kupo shows a UTxO created by `txHash` at the relayer address (⇒ the tx is in a block)
// AND it is buried >= CONFIRM_DEPTH_SLOTS past the tip (reorg safety, DR-09b). Returns the slot it
// landed in (needed later to read the metadata back, for verify). On timeout returns undefined —
// the caller treats that as a (possible) rollback and resubmits. If a seen tx ROLLS BACK before it
// buries, its Kupo match vanishes and we keep polling until burial or timeout, so it is never acked.
// NOTE the `.catch` guards the WHOLE fetch+json: a Kupo blip mid-wait must not crash the relayer
// while a tx is submitted-but-unacked.
async function waitConfirmed(address, txHash) {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const matches = await fetch(`${KUPO}/matches/${address}?unspent`).then((r) => r.json()).catch(() => []);
    const hit = (matches || []).find((m) => (m.transaction_id || "").toLowerCase() === txHash.toLowerCase());
    const slot = hit?.created_at?.slot_no ?? null;
    if (slot != null) {
      if (CONFIRM_DEPTH_SLOTS <= 0) return slot; // demo: ack as soon as it's in a block
      const tip = await tipSlot();
      if (tip != null && tip - slot >= CONFIRM_DEPTH_SLOTS) return slot; // buried past k ⇒ reorg-safe
    }
    await sleep(POLL_MS);
  }
  return undefined;
}

async function buildAndSubmitMetadataTx(wallet, address, genesisHex, head, postCount, ts) {
  const rootHex = stripHex(head.stateRoot);
  const meta = {
    v: 1,
    chain: "cogno-chain",
    net: "preprod",
    genesis: genesisHex, // 64 hex chars (no 0x) — within the 64-byte metadata string limit
    block: Number(head.number),
    root: rootHex, // the finalized post-state root, 64 hex chars
    posts: Number(postCount),
    ts: Number(ts),
  };
  const utxos = await wallet.getUtxos();
  if (!utxos.length) throw new Error("relayer wallet has no UTxOs — fund it");
  // Metadata-only, NO script: just attach metadata + return change to self (single change output ⇒
  // clean output-chaining for the next anchor). No txOut, no collateral, no cost models.
  const txBuilder = new MeshTxBuilder({ fetcher: kupo(), submitter: ogmios(), verbose: false });
  txBuilder.metadataValue(LABEL, meta).changeAddress(address).selectUtxosFrom(utxos);
  await txBuilder.complete();
  const signed = await wallet.signTx(txBuilder.txHex);
  const txHash = await wallet.submitTx(signed);
  return { txHash, meta };
}

// Submit anchor_ack via the configured path. Returns {acked, ignored}; throws on a dispatch/tooling
// failure. EITHER AnchorAcked (recorded) OR AckIgnored (idempotent no-op, height <= last) counts as
// "recorded on L3"; the caller treats neither-token as a hard failure (relayer-2). `head` carries
// {number, stateRoot} — stateRoot may be bare or 0x-hex (both encoders normalise it).
async function recordAck(api, sudo, head, txHash, postCount, ts) {
  // DR-07: default through the 3-of-5 committee; `ANCHOR_VIA=sudo` keeps the EnsureRoot dev fallback.
  if (ANCHOR_VIA === "committee") {
    return committeeAnchorAck({ block: head.number, root: head.stateRoot, txhash: txHash, count: postCount, ts });
  }
  const result = await api.tx.Sudo.sudo({
    call: api.tx.Anchor.anchor_ack({
      block_number: Number(head.number),
      finalized_root: FixedSizeBinary.fromBytes(hexToBytes(head.stateRoot)),
      cardano_txhash: FixedSizeBinary.fromBytes(hexToBytes(txHash)),
      post_count: postCount,
      timestamp: ts,
    }).decodedCall,
  }).signAndSubmit(sudo);
  return {
    acked: !!(result.events || []).find((e) => e.type === "Anchor" && e.value?.type === "AnchorAcked"),
    ignored: !!(result.events || []).find((e) => e.type === "Anchor" && e.value?.type === "AckIgnored"),
  };
}

// The oldest persisted anchor whose Cardano tx confirmed but whose L3 ack never landed. Resuming from
// it (ack-only) is what prevents re-minting a paid Cardano tx for a height already witnessed (relayer-1).
function oldestPendingAnchor(state) {
  return (state.anchors || [])
    .filter((a) => a.cardanoTx && a.slot != null && !a.acked)
    .sort((a, b) => a.block - b.block)[0] || null;
}

// Record `entry` on L3, retrying ONLY the ack (never the paid Cardano tx) with bounded exponential
// backoff. A dispatch/tooling error OR a reply with neither AnchorAcked nor AckIgnored (relayer-2) is
// a hard failure for that attempt — never a silent "submitted" success. After ACK_MAX_ATTEMPTS the
// entry stays persisted-but-unacked (acked:false) and we throw, so the next run resumes ack-only.
async function recordAckWithRetry(api, sudo, state, entry) {
  const head = { number: BigInt(entry.block), stateRoot: entry.root };
  let acked = false, ignored = false;
  for (let attempt = 1; attempt <= ACK_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await recordAck(api, sudo, head, entry.cardanoTx, BigInt(entry.postCount), BigInt(entry.ts));
      acked = r.acked; ignored = r.ignored;
      if (acked || ignored) break;
      throw new Error("anchor_ack returned neither AnchorAcked nor AckIgnored (inner dispatch failed?)");
    } catch (e) {
      if (attempt >= ACK_MAX_ATTEMPTS) {
        console.error(`  ✗ anchor_ack failed after ${attempt} attempts — Cardano tx ${entry.cardanoTx} stays persisted for ack-only resume: ${e?.message || e}`);
        throw e;
      }
      const backoff = ACK_BACKOFF_MS * 2 ** (attempt - 1);
      console.error(`  ⚠ anchor_ack attempt ${attempt}/${ACK_MAX_ATTEMPTS} failed (${e?.message || e}) — retrying ACK ONLY in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  console.log(acked ? `  ✓ anchor_ack → AnchorAcked (recorded on L3, via ${ANCHOR_VIA})` : `  · anchor_ack → AckIgnored (idempotent no-op, already recorded)`);
  entry.acked = acked || ignored; // both mean "recorded on L3" ⇒ stop retrying
  entry.ackedAt = new Date().toISOString();
  saveState(state);
  return { acked: !!acked, ignored: !!ignored };
}

// Finish any persisted-but-unacked anchors (ack-only, never re-mint) before considering a new height.
// Throws if an ack is still failing after its retries, so the caller backs off and resumes later.
async function drainPending(api, sudo, state) {
  for (let entry; (entry = oldestPendingAnchor(state)); ) {
    console.log(`\n▶ resuming anchor for block #${entry.block} — Cardano tx ${entry.cardanoTx} @slot ${entry.slot} already confirmed, retrying ack only`);
    await recordAckWithRetry(api, sudo, state, entry);
  }
}

async function anchorOne(api, sudo, wallet, address, genesisHex, head, state) {
  const postCount = await api.query.Microblog.NextPostId.getValue({ at: head.hash });
  const ts = await api.query.Timestamp.Now.getValue({ at: head.hash });
  console.log(`\n▶ anchoring finalized block #${head.number}`);
  console.log(`  state_root : ${head.stateRoot}`);
  console.log(`  post_count : ${postCount}   ts: ${ts}`);

  // Submit the Cardano metadata tx, then wait for it to settle. On a (possible) rollback / timeout,
  // rebuild & resubmit — the L3 ack is height-keyed so this can never double-count.
  let txHash, slot;
  for (let attempt = 1; ; attempt++) {
    ({ txHash } = await buildAndSubmitMetadataTx(wallet, address, genesisHex, head, postCount, ts));
    console.log(`  cardano tx : ${txHash}  (submitted, attempt ${attempt}) — waiting for confirmation…`);
    slot = await waitConfirmed(address, txHash);
    if (slot !== undefined) break;
    console.log(`  ⚠ not confirmed in ${CONFIRM_TIMEOUT_MS}ms (rollback?) — rebuilding & resubmitting`);
    await sleep(POLL_MS);
  }
  console.log(`  ✓ confirmed at slot ${slot}`);

  // Persist the confirmed (but not-yet-acked) anchor BEFORE the ack, so a failed ack or a crash
  // resumes by retrying ONLY the ack — never minting a second paid Cardano tx for this height.
  const entry = { block: Number(head.number), root: stripHex(head.stateRoot), cardanoTx: txHash, slot, postCount: Number(postCount), ts: Number(ts), label: LABEL, genesis: genesisHex, acked: false, at: new Date().toISOString() };
  state.anchors.push(entry);
  saveState(state);

  const { acked } = await recordAckWithRetry(api, sudo, state, entry);
  return { txHash, slot, acked: !!acked };
}

async function reackLast(api, sudo) {
  // Re-submit anchor_ack for the recorded checkpoint with its EXACT fields — the verbatim
  // rollback-resubmit case. The pallet must no-op it (AckIgnored) because block_number <= last.
  const cp = await api.query.Anchor.LastCheckpoint.getValue();
  if (!cp) { console.log("\nno checkpoint recorded yet — nothing to re-ack."); return; }
  console.log(`\n▶ re-acking recorded checkpoint #${cp.block_number} VERBATIM (idempotency / rollback-resubmit test)`);
  const result = await api.tx.Sudo.sudo({
    call: api.tx.Anchor.anchor_ack({
      block_number: cp.block_number,
      finalized_root: cp.finalized_root,
      cardano_txhash: cp.cardano_txhash,
      post_count: cp.post_count,
      timestamp: cp.timestamp,
    }).decodedCall,
  }).signAndSubmit(sudo);
  const acked = (result.events || []).find((e) => e.type === "Anchor" && e.value?.type === "AnchorAcked");
  const ignored = (result.events || []).find((e) => e.type === "Anchor" && e.value?.type === "AckIgnored");
  console.log(ignored ? `  ✓ AckIgnored — idempotent no-op, the checkpoint was NOT double-counted (block #${ignored.value.value.block_number}, last #${ignored.value.value.last})`
    : acked ? `  ✗ AnchorAcked — UNEXPECTED: a verbatim re-ack overwrote the record (idempotency broken!)`
    : `  ? no Anchor event (ok=${result.ok})`);
}

async function main() {
  const mode = process.argv.includes("--once") ? "once" : process.argv.includes("--reack-last") ? "reack-last" : "watch";

  const { wallet, address } = await getOwnerWallet({ withProvider: true });
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const sudoKp = derive("//Alice");
  const sudo = getPolkadotSigner(sudoKp.publicKey, "Sr25519", sudoKp.sign);

  // The genesis hash is the chain's immutable identifier (the block-0 hash) — it pins WHICH chain a
  // verifier checks against. Fetch it live rather than hardcoding: a FRESH --dev chain rebuilt from a
  // new runtime gets a NEW genesis (the wasm is part of genesis state), so a value pinned for an
  // earlier spec_version would be wrong. (A runtime UPGRADE on a *live* chain does NOT change block 0.)
  const genesisHex = stripHex((await client.getChainSpecData()).genesisHash);
  const state = loadState();
  state.genesis = genesisHex;
  console.log(`relayer  : ${address}`);
  console.log(`L3       : ${WS}  genesis ${genesisHex}`);
  console.log(`mode     : ${mode}   anchor-every ${ANCHOR_EVERY}   label ${LABEL}`);

  const lastOnChain = async () => {
    const cp = await api.query.Anchor.LastCheckpoint.getValue();
    return cp ? BigInt(cp.block_number) : null;
  };

  if (mode === "reack-last") {
    await reackLast(api, sudo);
    client.destroy(); process.exit(0);
  }

  if (mode === "once") {
    await drainPending(api, sudo, state); // resume any unacked anchor first (ack-only, no re-mint)
    const head = await finalizedHead(client);
    const last = await lastOnChain();
    if (last !== null && head.number <= last) {
      console.log(`\nfinalized #${head.number} <= last anchored #${last} — nothing new to anchor.`);
      client.destroy(); process.exit(0);
    }
    await anchorOne(api, sudo, wallet, address, genesisHex, head, state);
    client.destroy(); process.exit(0);
  }

  // watch: anchor the latest finalized head whenever it has advanced >= ANCHOR_EVERY since the last
  // recorded checkpoint. Single-threaded loop ⇒ each anchor fully settles before the next.
  console.log(`\nwatching finalized heads — anchoring every ${ANCHOR_EVERY} blocks. Ctrl-C to stop.`);
  for (;;) {
    try {
      await drainPending(api, sudo, state); // finish any unacked anchor first (ack-only, no re-mint)
      const head = await finalizedHead(client);
      const last = await lastOnChain();
      const due = last === null ? head.number >= ANCHOR_EVERY : head.number >= last + ANCHOR_EVERY;
      if (due) await anchorOne(api, sudo, wallet, address, genesisHex, head, state);
    } catch (e) {
      console.error("  ⚠ loop error (will retry):", e?.message || e);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error("RELAYER FAILED:", e?.stack || e?.message || e); process.exit(1); });
