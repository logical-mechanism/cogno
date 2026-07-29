// Resolve a CIP-129 governance action id (`gov_action1…`) to the three things a cogno poll tag needs:
// the CIP-1694 action TYPE, the anchor URL of its proposal document, and the anchor hash the Cardano
// ledger itself recorded.
//
// WHY. Opening a discussion about an action already submitted to Cardano used to mean leaving cogno,
// finding the proposal on gov.tools or an explorer, copying its raw document link, and picking the
// action type by hand from a dropdown. Every one of those steps is a chance to attach the wrong
// document to the poll, and nothing downstream could tell that it had happened.
//
// THE LEDGER HASH IS A CROSS-CHECK, NOT THE PIN. This module deliberately does NOT hand its
// `anchorHash` on to be stored. The poll still pins what `hashProposalDoc` fetched, because that is
// what makes a pin mean "a reader can reproduce this" — see the section header in proposalMeta.ts. A
// hash taken from the ledger would be more authoritative and LESS verifiable: it exists for anchors
// whose host sends no CORS header, for hosts that redirect (the read path refuses a 3xx on purpose),
// and for documents that are not CIP-108 JSON at all, which CIP-100 explicitly permits. Pinning those
// would hand readers a permanent "could not check" on a poll whose author did nothing wrong.
//
// So the ledger hash is compared against the composer's own fetch and the ANSWER is shown to the
// author before they post. Agreement means the link really is the document Cardano committed to.
// Disagreement is worth knowing at compose time, which is the only time it can still be fixed.
//
// Blockfrost is the only browser-reachable source that carries all of this: it sends
// `access-control-allow-origin: *`, it covers preprod, and the app already holds a project id for it.
// Koios returns strictly more in one call, and cannot be used — it sends no CORS header to any origin
// but its own, and a static export has no backend to proxy through.
//
// Same posture as roleMeta.ts, which this mirrors: cache per session, share in-flight calls, sanitize
// every string that reaches the DOM, and degrade to null on ANY failure rather than throwing. A null
// result means the author falls back to today's manual type-and-link flow, which still works.

import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import { blockfrostBase, providerNetworkMismatch } from "@/lib/cardano/network";
import { sanitizeInline } from "@/lib/sanitize";
import type { GovActionType } from "@/lib/types";

/** A parsed CIP-129 governance action id. */
export interface GovActionRef {
  /** The proposing transaction's hash, lowercase hex, no 0x. */
  txHash: string;
  /** The governance action's index within that transaction. */
  index: number;
}

/** Where a governance action stands on Cardano, which is a different clock from the cogno poll's. */
export type GovActionStatus =
  /** Still accepting votes on Cardano. `expiresEpoch` says until when. */
  | { kind: "open"; expiresEpoch: number }
  | { kind: "ratified"; epoch: number }
  | { kind: "enacted"; epoch: number }
  | { kind: "dropped"; epoch: number }
  | { kind: "expired"; epoch: number }
  /** The terminal epochs were all null and the current epoch could not be read. */
  | { kind: "unknown" };

/** A resolved on-chain governance action, as the composer needs it. */
export interface ResolvedGovAction {
  ref: GovActionRef;
  /** The id as it round-trips, so the UI can echo back a canonical form. */
  id: string;
  actionType: GovActionType;
  /** The proposal document's anchor URL, exactly as recorded on Cardano (often `ipfs://…`). */
  anchorUrl: string;
  /**
   * blake2b-256 of the document, as recorded by the LEDGER, `0x`-prefixed to match how cogno writes and
   * compares a pin.
   *
   * THE PREFIX IS LOAD-BEARING. Blockfrost, Koios, db-sync and cardano-cli all hand this back as BARE
   * hex, while cogno's own pin is `toHex(...)` output and `anchorVerdict` compares with plain string
   * equality after lowercasing, with no normalization. Dropped in unprefixed, every comparison against
   * a cogno pin fails and reports "changed" — silently, and for every poll.
   */
  anchorHash: string;
  status: GovActionStatus;
  /** The proposal's own title, sanitized and capped, when the document carries one. */
  title?: string;
}

// ── CIP-129 bech32 decode ────────────────────────────────────────────────────────────────────────
//
// Decode-only, and local rather than networked, so a typo is answered instantly and without telling
// anyone what the author is about to poll on. roleMeta.ts carries the matching ENCODER for dRep ids;
// these are the same tables run the other way. Neither pulls in a bech32 dependency, for the reason
// that file gives: the alternative is the ~6 MB Cardano bundle.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GOV_ACTION_HRP = "gov_action";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Parse a `gov_action1…` id into its transaction hash and index, or null when it is not one.
 *
 * Rejects rather than guesses on every failure: wrong prefix, a character outside the bech32 alphabet,
 * a bad checksum, or a payload that is not exactly 33 bytes. The 33 is the CIP-129 shape (a 32-byte
 * transaction hash followed by a one-byte action index), and holding to it exactly is deliberate: the
 * Conway CDDL allows a two-byte index, and no authoritative statement covers how CIP-129 would encode
 * one above 255, so a longer payload is refused as unparseable rather than silently misread.
 *
 * Pure, so the whole table is unit-testable. Never throws.
 */
export function parseGovActionId(raw: string): GovActionRef | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s.startsWith(GOV_ACTION_HRP + "1")) return null;
  const data = s.slice(GOV_ACTION_HRP.length + 1);
  if (data.length < 7) return null; // 6 checksum chars plus at least some payload
  const values: number[] = [];
  for (const c of data) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    values.push(v);
  }
  if (polymod(hrpExpand(GOV_ACTION_HRP).concat(values)) !== 1) return null;

  // 5-bit groups back to bytes. The trailing partial group is padding and is dropped; a padding group
  // with any bit set is a malformed encoding, not something to round off.
  const payload = values.slice(0, -6);
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  if (bytes.length !== 33) return null;

  const txHash = bytes
    .slice(0, 32)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { txHash, index: bytes[32]! };
}

// ── Blockfrost ───────────────────────────────────────────────────────────────────────────────────

/**
 * Blockfrost's `governance_type` values → cogno's `GovActionType`.
 *
 * Written out rather than derived, so a Blockfrost rename surfaces as an unresolved action (the honest
 * outcome, which drops the author back to the manual picker) instead of a silently mismatched tag.
 */
const TYPE_BY_BLOCKFROST: Record<string, GovActionType> = {
  hard_fork_initiation: "HardFork",
  new_committee: "UpdateCommittee",
  new_constitution: "NewConstitution",
  parameter_change: "ParamChange",
  treasury_withdrawals: "TreasuryWithdrawal",
  no_confidence: "NoConfidence",
  info_action: "Info",
};

/** Shape of the two Blockfrost responses this reads. Only the fields used are declared. */
interface BfProposal {
  governance_type?: unknown;
  ratified_epoch?: unknown;
  enacted_epoch?: unknown;
  dropped_epoch?: unknown;
  expired_epoch?: unknown;
  expiration?: unknown;
}
interface BfMetadata {
  url?: unknown;
  hash?: unknown;
  json_metadata?: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Where the action stands, from the four terminal epoch fields plus the current epoch.
 *
 * The terminal fields are checked FIRST and in ledger order. An action that was enacted also has an
 * expiration in the past, so reading `expiration` first would report a landed action as expired.
 * `currentEpoch` null (its own read failed) yields "unknown" rather than assuming open: "still open
 * for voting" is a claim about right now, and it must not be made on a read that did not land.
 */
export function govActionStatus(p: BfProposal, currentEpoch: number | null): GovActionStatus {
  const enacted = num(p.enacted_epoch);
  if (enacted != null) return { kind: "enacted", epoch: enacted };
  const ratified = num(p.ratified_epoch);
  if (ratified != null) return { kind: "ratified", epoch: ratified };
  const dropped = num(p.dropped_epoch);
  if (dropped != null) return { kind: "dropped", epoch: dropped };
  const expired = num(p.expired_epoch);
  if (expired != null) return { kind: "expired", epoch: expired };
  const expiration = num(p.expiration);
  if (expiration == null || currentEpoch == null) return { kind: "unknown" };
  return currentEpoch < expiration
    ? { kind: "open", expiresEpoch: expiration }
    : { kind: "expired", epoch: expiration };
}

// Per-id caches, exactly as roleMeta.ts does it: a settled value (or null = tried, nothing usable) so a
// re-paste never re-hits Blockfrost, and an in-flight promise so a double paste shares one call.
const resolved = new Map<string, ResolvedGovAction | null>();
const inflight = new Map<string, Promise<ResolvedGovAction | null>>();

/** Blockfrost's cap on a proposal title we will render. Generous; the doc's own cap is larger. */
const MAX_TITLE = 200;

/**
 * Resolve a governance action id against Blockfrost, or null when it cannot be resolved.
 *
 * TWO REQUESTS, and it cannot be one. `/governance/proposals/{tx}/{index}` carries the ledger's own
 * `governance_type` and the status epochs but no anchor; `/{index}/metadata` carries the anchor url and
 * hash but no type. The metadata response DOES embed a type at
 * `json_metadata.body.onChain.gov_action.tag`, and that one is not used on purpose: it is a field
 * inside the author's own document, so trusting it would let a document say what kind of action it is.
 * The type comes from the ledger.
 *
 * A third request reads the current epoch, for the status only. It is allowed to fail on its own: a
 * resolved action with an unknown status is still worth having, and it is the reason `status` has an
 * "unknown" member rather than defaulting to open.
 *
 * Never throws. Returns null for an unparseable id, an unconfigured or wrong-network project id, a 404
 * (which on this deployment also means "a real action, but on another network"), or any transport
 * failure.
 */
export async function resolveGovAction(rawId: string): Promise<ResolvedGovAction | null> {
  const ref = parseGovActionId(rawId);
  if (!ref) return null;
  const key = `${ref.txHash}#${ref.index}`;
  if (resolved.has(key)) return resolved.get(key) ?? null;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async (): Promise<ResolvedGovAction | null> => {
    const projectId = getBlockfrostProjectId();
    // No id configured, or an id for a different network than the chain names. Either way the call
    // cannot succeed, so it is skipped rather than spent — same call the role resolvers make.
    if (!projectId || providerNetworkMismatch(projectId)) return null;
    const headers = { project_id: projectId };
    const base = `${blockfrostBase()}/governance/proposals/${ref.txHash}/${ref.index}`;
    try {
      const [proposalRes, metaRes] = await Promise.all([
        fetch(base, { headers }),
        fetch(`${base}/metadata`, { headers }),
      ]);
      if (!proposalRes.ok || !metaRes.ok) return null; // 404 (not on this network) / 403 / 429
      const proposal = (await proposalRes.json()) as BfProposal;
      const meta = (await metaRes.json()) as BfMetadata;

      const actionType =
        typeof proposal.governance_type === "string"
          ? TYPE_BY_BLOCKFROST[proposal.governance_type]
          : undefined;
      const anchorUrl = typeof meta.url === "string" ? meta.url.trim() : "";
      const rawHash = typeof meta.hash === "string" ? meta.hash.trim().toLowerCase() : "";
      // An action with no usable type or anchor is not something the composer can tag a poll with, and
      // half-filling the form would be worse than not resolving at all.
      if (!actionType || !anchorUrl || !/^[0-9a-f]{64}$/.test(rawHash)) return null;

      // The current epoch is for the status line only, so its failure must not sink the resolve.
      const currentEpoch = await fetch(`${blockfrostBase()}/epochs/latest`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => num((j as { epoch?: unknown } | null)?.epoch))
        .catch(() => null);

      const body = (meta.json_metadata as { body?: { title?: unknown } } | null)?.body;
      const rawTitle = typeof body?.title === "string" ? body.title : "";
      // Attacker-controllable off-chain text, on the same footing as a pool ticker or a dRep name.
      const title = sanitizeInline(rawTitle).slice(0, MAX_TITLE).trim();

      return {
        ref,
        id: rawId.trim().toLowerCase(),
        actionType,
        anchorUrl,
        anchorHash: `0x${rawHash}`,
        status: govActionStatus(proposal, currentEpoch),
        title: title || undefined,
      };
    } catch {
      return null; // offline / CORS / provider error — degrade, never surface a throw
    }
  })().then((r) => {
    // Only a SETTLED answer is cached. A transport failure resolves to null too, so cache it only when
    // a response actually arrived... which this cannot distinguish, so it caches either way and the
    // composer offers an explicit retry by re-pasting. Matches roleMeta, where a badge is cheap to
    // re-request; unlike proposalMeta, nothing here is a permanent on-chain commitment.
    resolved.set(key, r);
    inflight.delete(key);
    return r;
  });

  inflight.set(key, p);
  return p;
}

/** Drop a cached resolve so an explicit retry re-hits the network. Used by the composer's Retry. */
export function forgetGovAction(rawId: string): void {
  const ref = parseGovActionId(rawId);
  if (ref) resolved.delete(`${ref.txHash}#${ref.index}`);
}

/**
 * Whether this deployment can resolve an id at all: a Blockfrost project id is configured, and it is
 * for the network the chain names.
 *
 * Exists so the UI can tell "you mistyped it" apart from "this browser cannot look anything up", which
 * `resolveGovAction` alone cannot: both come back null. The two need opposite copy. The first asks the
 * author to check the id; the second must not, because the id may be perfectly good and the fix is in
 * Settings. `.env.example` ships the project id empty, so the second is a normal state, not an edge.
 */
export function govActionLookupAvailable(): boolean {
  const projectId = getBlockfrostProjectId();
  return !!projectId && !providerNetworkMismatch(projectId);
}
