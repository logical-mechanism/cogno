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
// Hardened HTTP (timeouts + retry, shared with the committee — themes 3/4) + the pure, unit-tested
// relayer helpers (relayer-9).
import { fetchJson } from "../_shared/net.mjs";
import { isMain } from "../_shared/cli.mjs";
import { missedIntervals, parseAckTokens } from "./lib.mjs";

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
// Hard cap on a single committee/sudo `op.mjs` subprocess (relayer-2). `op.mjs` connects to the L3
// node via @polkadot/api, whose WsProvider retries a dead endpoint FOREVER (no connect timeout), so a
// stalled WS would otherwise block this synchronous `execFileSync` — and the whole single-threaded
// relayer — indefinitely. On timeout the call throws and the ack is retried with backoff (never a
// re-minted Cardano tx). Generous: a 3-of-5 motion is propose + vote×k + close ≈ several blocks.
const OP_TIMEOUT_MS = Number(process.env.OP_TIMEOUT_MS || "120000");
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
  const out = execFileSync(process.execPath, [OP_CLI, "--call", "anchor.anchorAck", "--args", args, "--via", "committee", "--ws", WS], { encoding: "utf8", timeout: OP_TIMEOUT_MS });
  process.stdout.write(out);
  return parseAckTokens(out);
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

// Record an explicit tamper-evidence gap for the intermediate anchoring heights the relayer skipped
// (relayer-6). The relayer always anchors ONLY the latest finalized head, so intermediate due heights
// are skipped BY DESIGN — this happens both after downtime AND during normal operation whenever the
// finalized head advances by > one interval between cycles (e.g. while a prior anchor's Cardano
// confirmation blocks the single-threaded loop). True backfill of historical heights needs archived
// state (the typed reads key on a PINNED block), so we at least RECORD the hole — in state.gaps + a
// warning — rather than letting it pass silently. The gap COUNT is accurate; the cause may be either
// catch-up or downtime, so the message does not assert which.
function recordGap(state, last, anchored, missed) {
  const gap = { afterBlock: last == null ? 0 : Number(last), anchoredBlock: Number(anchored), missedAnchors: missed, every: Number(ANCHOR_EVERY), at: new Date().toISOString() };
  (state.gaps ||= []).push(gap);
  saveState(state);
  console.warn(`  ⚠ ANCHOR GAP: ~${missed} intermediate anchor height(s) between #${gap.afterBlock} and #${anchored} were NOT anchored (relayer anchors only the latest finalized head — normal catch-up between cycles, or downtime) — recorded in state.gaps (relayer-6).`);
}

// The Cardano tip slot (for the reorg-burial check). Best-effort; null on any error — but with a
// bounded timeout so a hung Ogmios connection cannot stall the confirmation loop (relayer-7).
async function tipSlot() {
  try {
    const { result } = await fetchJson(OGMIOS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip" }),
      timeoutMs: 10_000,
      retries: 2,
    });
    return result?.slot ?? null;
  } catch { return null; }
}

// Wait until Kupo shows a UTxO created by `txHash` at the relayer address (⇒ the tx is in a block)
// AND it is buried >= CONFIRM_DEPTH_SLOTS past the tip (reorg safety, DR-09b). Returns the slot it
// landed in (needed later to read the metadata back, for verify).
//
// relayer-1 (fund-burn fix): DISTINGUISH "the tx never made it / rolled back" (→ undefined → the
// caller resubmits a fresh PAID tx) from "the tx IS on-chain but not yet buried, or the Ogmios tip is
// momentarily unavailable" (→ keep polling, NEVER resubmit). Once the tx has been SEEN unspent at the
// relayer address, resubmitting would mint a SECOND paid tx for a height already witnessed — and with
// a production burial depth (a few hundred slots ≈ minutes at ~1 slot/s) that exceeds the
// CONFIRM_TIMEOUT_MS window, the old "timeout ⇒ resubmit" path did exactly that every timeout even
// with a perfectly healthy stack. So CONFIRM_TIMEOUT_MS now bounds ONLY the first-appearance wait;
// once seen, burial waiting is unbounded-but-safe (fail-closed: never ack an unburied tx, never
// re-mint a confirmed one). NOTE the `.catch` guards the WHOLE fetch+json: a Kupo blip mid-wait must
// not crash the relayer while a tx is submitted-but-unacked.
async function waitConfirmed(address, txHash) {
  const appearDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let everSeen = false;
  let warnedPendingBurial = false;
  for (;;) {
    // Bounded timeout + retry so a hung/blipping Kupo cannot stall a submitted-but-unacked tx (relayer-7).
    const matches = await fetchJson(`${KUPO}/matches/${address}?unspent`, { timeoutMs: 10_000, retries: 2 }).catch(() => []);
    const hit = (matches || []).find((m) => (m.transaction_id || "").toLowerCase() === txHash.toLowerCase());
    const slot = hit?.created_at?.slot_no ?? null;
    if (slot != null) {
      everSeen = true;
      if (CONFIRM_DEPTH_SLOTS <= 0) return slot; // demo: ack as soon as it's in a block
      const tip = await tipSlot();
      if (tip != null && tip - slot >= CONFIRM_DEPTH_SLOTS) return slot; // buried past k ⇒ reorg-safe
      // On-chain but not yet buried (or tip unavailable): KEEP polling for burial — do NOT resubmit.
      if (!warnedPendingBurial && Date.now() >= appearDeadline) {
        warnedPendingBurial = true;
        console.warn(`  ⏳ tx ${txHash} confirmed at slot ${slot} but not yet buried ${CONFIRM_DEPTH_SLOTS} slots (tip ${tip ?? "unavailable"}) — waiting for burial, NOT resubmitting (relayer-1).`);
      }
    } else if (everSeen) {
      return undefined; // SEEN unspent then GONE ⇒ a genuine rollback ⇒ resubmit
    } else if (Date.now() >= appearDeadline) {
      return undefined; // never appeared within CONFIRM_TIMEOUT_MS ⇒ it likely didn't make it ⇒ resubmit
    }
    await sleep(POLL_MS);
  }
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
// `failed` entries (permanently unackable — relayer-4) are skipped so they don't wedge the loop.
// Single O(n) min-scan (no sort) over the append-only anchors list.
function oldestPendingAnchor(state) {
  let best = null;
  for (const a of state.anchors || []) {
    if (!a.cardanoTx || a.slot == null || a.acked || a.failed) continue;
    if (best === null || a.block < best.block) best = a;
  }
  return best;
}

// The on-chain anchor checkpoint as plain numbers, or null if none recorded. Used to decide, BEFORE
// retrying a pending ack (relayer-4), whether the height is already covered (a no-op) or can never be
// acked because it would regress post_count/timestamp (the pallet rejects it as NonMonotonicAnchor).
async function readCheckpoint(api) {
  const cp = await api.query.Anchor.LastCheckpoint.getValue();
  return cp
    ? { block: Number(cp.block_number), postCount: Number(cp.post_count), ts: Number(cp.timestamp) }
    : null;
}

// Record `entry` on L3, retrying ONLY the ack (never the paid Cardano tx) with bounded exponential
// backoff. A dispatch/tooling error OR a reply with neither AnchorAcked nor AckIgnored (relayer-2) is
// a hard failure for that attempt — never a silent "submitted" success. Returns `{ recorded }` (true
// iff AnchorAcked or AckIgnored landed — both mean "on L3"; `ignored` is not surfaced separately as
// no caller distinguishes it). After ACK_MAX_ATTEMPTS of TRANSIENT failure the entry stays
// persisted-but-unacked and we throw, so the next run resumes ack-only.
//
// relayer-4 (permanent-failure guard): a PERMANENTLY-unackable entry would otherwise be retried by
// `drainPending` on every loop iteration, wedging all forward anchoring. So before retrying we
// cross-check the on-chain checkpoint: if it already covers this height the ack is a no-op (mark
// recorded); if this entry would REGRESS post_count/timestamp (⇒ NonMonotonicAnchor, which can never
// succeed) we mark it `failed` and skip it, letting the loop make progress. A failed checkpoint read
// is treated as transient (fall through to the normal retry).
async function recordAckWithRetry(api, sudo, state, entry) {
  const head = { number: BigInt(entry.block), stateRoot: entry.root };

  let cp;
  try { cp = await readCheckpoint(api); } catch { cp = undefined; }
  if (cp) {
    if (cp.block >= entry.block) {
      // Already recorded or superseded on-chain ⇒ submitting would only yield AckIgnored.
      console.log(`  · anchor #${entry.block} already covered by on-chain LastCheckpoint #${cp.block} — marking recorded (relayer-4).`);
      entry.acked = true; entry.ackedAt = new Date().toISOString(); saveState(state);
      return { recorded: true };
    }
    if (entry.postCount < cp.postCount || entry.ts < cp.ts) {
      entry.failed = true;
      entry.failReason = `would regress vs on-chain LastCheckpoint #${cp.block} (post_count ${entry.postCount} < ${cp.postCount} or ts ${entry.ts} < ${cp.ts}) → NonMonotonicAnchor`;
      entry.failedAt = new Date().toISOString(); saveState(state);
      console.error(`  ✗ anchor #${entry.block} PERMANENTLY unackable and SKIPPED (relayer-4): ${entry.failReason}. The chain state regressed vs persisted relayer state (a reset/fork?) — investigate; new anchoring continues.`);
      return { recorded: false, failed: true };
    }
  }

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
  return { recorded: acked || ignored };
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
    console.log(`  ⚠ tx never appeared in ${CONFIRM_TIMEOUT_MS}ms or rolled back — rebuilding & resubmitting`);
    await sleep(POLL_MS);
  }
  console.log(`  ✓ confirmed at slot ${slot}`);

  // Persist the confirmed (but not-yet-acked) anchor BEFORE the ack, so a failed ack or a crash
  // resumes by retrying ONLY the ack — never minting a second paid Cardano tx for this height.
  const entry = { block: Number(head.number), root: stripHex(head.stateRoot), cardanoTx: txHash, slot, postCount: Number(postCount), ts: Number(ts), label: LABEL, genesis: genesisHex, acked: false, at: new Date().toISOString() };
  state.anchors.push(entry);
  saveState(state);

  const { recorded } = await recordAckWithRetry(api, sudo, state, entry);
  return { txHash, slot, acked: !!recorded };
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
  // relayer-8: a zero burial depth has NO reorg protection — make that loud (the showcase default).
  if (CONFIRM_DEPTH_SLOTS <= 0)
    console.warn(`  ⚠ CONFIRM_DEPTH_SLOTS=0 — NO reorg-burial protection: a Cardano rollback after an ack would pin a vanished txhash into the monotonic LastCheckpoint. Set CONFIRM_DEPTH_SLOTS (a few hundred slots, DR-09b) for a value-bearing deployment.`);

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
    const missed = missedIntervals(last, head.number, ANCHOR_EVERY);
    if (missed > 0) recordGap(state, last, head.number, missed);
    await anchorOne(api, sudo, wallet, address, genesisHex, head, state);
    client.destroy(); process.exit(0);
  }

  // watch: anchor the latest finalized head whenever it has advanced >= ANCHOR_EVERY since the last
  // recorded checkpoint. Single-threaded loop ⇒ each anchor fully settles before the next.
  console.log(`\nwatching finalized heads — anchoring every ${ANCHOR_EVERY} blocks. Ctrl-C to stop.`);
  let consecutiveErrors = 0;
  for (;;) {
    try {
      await drainPending(api, sudo, state); // finish any unacked anchor first (ack-only, no re-mint)
      const head = await finalizedHead(client);
      const last = await lastOnChain();
      const due = last === null ? head.number >= ANCHOR_EVERY : head.number >= last + ANCHOR_EVERY;
      if (due) {
        // relayer-6: if more than one interval elapsed since the last checkpoint, the relayer was
        // down and skipped anchoring opportunities — record the gap before anchoring the latest head.
        const missed = missedIntervals(last, head.number, ANCHOR_EVERY);
        if (missed > 0) recordGap(state, last, head.number, missed);
        await anchorOne(api, sudo, wallet, address, genesisHex, head, state);
      }
      consecutiveErrors = 0;
    } catch (e) {
      // relayer-7: bounded exponential backoff so a persistent fault (node WS down, Cardano stack
      // unreachable) doesn't hot-loop. The PAPI ws-provider auto-reconnects under the client; a
      // transient drop surfaces here and is retried with growing backoff (capped at 60s).
      consecutiveErrors++;
      const wait = Math.min(POLL_MS * 2 ** (consecutiveErrors - 1), 60_000);
      console.error(`  ⚠ loop error #${consecutiveErrors} (retry in ${wait}ms):`, e?.message || e);
      await sleep(wait);
      continue;
    }
    await sleep(POLL_MS);
  }
}

// Run only when invoked directly (not when imported by tests).
if (isMain(import.meta.url)) {
  main().catch((e) => { console.error("RELAYER FAILED:", e?.stack || e?.message || e); process.exit(1); });
}
