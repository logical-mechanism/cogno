// Display-only resolution of a governance-poll's anchor URL → the CIP-108 proposal CONTENTS, fetched
// on-demand and rendered INLINE (title / abstract / motivation / rationale) instead of a bare link.
//
// Mirrors roleMeta.ts: fetch off-chain metadata, sanitize every string (it is ATTACKER-CONTROLLED
// off-chain text — the same threat model as pool tickers / dRep names), cache per session, and degrade to
// null on ANY failure (CORS / offline / 404 / bad JSON / oversize / timeout). It NEVER throws and NEVER
// fabricates content. SSG-safe: no `window` / `fetch` at module scope — only inside `resolveProposal`.
//
// PINNED WHERE POSSIBLE: the composer hashes the document it fetched and stores blake2b-256 of it on
// chain beside the link, so a reader can be told whether what they are reading is what the poll was
// created from. A hash is only pinned when a reader could reproduce it (see hashProposalDoc), so many
// polls legitimately carry none and are labelled unverified. Either way this is still a convenience read
// of off-chain text, not an on-chain fact: the DOCUMENT is not on chain, only a commitment to it.

import { sanitizeInline, sanitizeText } from "@/lib/sanitize";

/** The CIP-108 display fields we surface (all optional; at least one present when the result is non-null). */
export interface ProposalMeta {
  title?: string;
  abstract?: string;
  motivation?: string;
  rationale?: string;
}

/** Public IPFS gateway for `ipfs://` anchors (CORS-friendly, no auth). */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
/** Hard cap on the fetched document — a proposal doc is small; anything larger is refused (DOM-flood guard). */
const MAX_DOC_BYTES = 256 * 1024;
/** Fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 8000;
/** Per-field character caps (applied AFTER sanitize): generous enough to read, capped so a hostile doc
 *  can't flood the DOM. */
// Per-field DISPLAY caps (chars). Generous on purpose — a real proposal shouldn't visibly truncate; raise
// further if one does. Independent of `MAX_DOC_BYTES` (the whole-doc OOM guard above), which stays well
// clear of the summed field caps so a legitimate doc is never refused outright.
const CAP = { title: 300, abstract: 5000, motivation: 10000, rationale: 10000 } as const;

/**
 * Map an anchor URL to a fetchable/browsable https URL, or null if the scheme isn't safe to LOAD in the
 * browser. `https:` passes through; `ipfs://<cid>[/path]` (and the `ipfs://ipfs/<cid>` variant) maps to a
 * public gateway. Everything else — `http:` (mixed-content-blocked on our https origin), `data:`,
 * `javascript:`, `ar:`, … — is refused. Pure; exported for the golden-vector test.
 */
export function proposalHttpUrl(anchorUrl: string): string | null {
  const raw = (anchorUrl ?? "").trim();
  if (!raw) return null;
  if (/^ipfs:\/\//i.test(raw)) {
    // Strip the scheme and a leading `ipfs/` (both `ipfs://<cid>` and `ipfs://ipfs/<cid>` occur in the wild).
    const path = raw
      .replace(/^ipfs:\/\//i, "")
      .replace(/^ipfs\//i, "")
      .replace(/^\/+/, "");
    if (!path) return null;
    try {
      return new URL(IPFS_GATEWAY + path).href;
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Hosts whose proposal doc we fetch EAGERLY (on render, to surface the title at a glance), because they're
 *  neutral content hosts — a poll author can't use them to harvest a passive reader's IP: GitHub (raw / gist
 *  / user-content), our IPFS gateway, and the well-known public IPFS gateways. Any OTHER (author-chosen)
 *  host stays click-to-preview, so merely scrolling a timeline never pings it. Suffix-matched, so
 *  `raw.githubusercontent.com` matches `githubusercontent.com` and `<cid>.ipfs.dweb.link` matches `dweb.link`.
 *  Extend deliberately: every entry is a host trusted NOT to leak the reader's IP back to the poll author. */
const NEUTRAL_HOSTS = [
  "ipfs.io",
  "dweb.link",
  "cf-ipfs.com",
  "cloudflare-ipfs.com",
  "pinata.cloud",
  "nftstorage.link",
  "w3s.link",
  "githubusercontent.com",
  "github.com",
] as const;

/**
 * True when the anchor resolves to a fetchable https URL on a NEUTRAL host (see `NEUTRAL_HOSTS`) — the polls
 * whose title we surface at a glance (fetched on render). An author-controlled host returns false: its title
 * appears only after an explicit Preview click, so scrolling a timeline can't leak the reader's IP to it.
 * Pure; exported for the golden-vector test.
 */
export function isNeutralProposalHost(anchorUrl: string): boolean {
  const url = proposalHttpUrl(anchorUrl);
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return NEUTRAL_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/** Read a string field that may be a plain string or a JSON-LD `{ "@value": "…" }` object (CIP-100/108). */
function ldString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const at = (v as { "@value"?: unknown })["@value"];
    if (typeof at === "string") return at;
  }
  return "";
}

/**
 * Parse a CIP-108 (governance metadata) document into the display fields — sanitized + capped. Tolerant of
 * the fields living under `body` (CIP-108) or at the top level, and of JSON-LD `@value` wrapping. The title
 * is hardened as a single LINE; the prose fields keep their line breaks (rendered under `pre-wrap`).
 * Returns null when nothing usable is present. Pure; exported for the golden-vector test.
 */
export function parseProposalDoc(json: unknown): ProposalMeta | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const bodyRaw = root.body;
  const body = (bodyRaw && typeof bodyRaw === "object" ? bodyRaw : root) as Record<string, unknown>;
  const oneLine = (v: unknown, cap: number): string | undefined => {
    const s = sanitizeInline(ldString(v)).slice(0, cap).trim();
    return s || undefined;
  };
  const block = (v: unknown, cap: number): string | undefined => {
    const s = sanitizeText(ldString(v)).slice(0, cap).trim();
    return s || undefined;
  };
  const meta: ProposalMeta = {
    title: oneLine(body.title, CAP.title),
    abstract: block(body.abstract, CAP.abstract),
    motivation: block(body.motivation, CAP.motivation),
    rationale: block(body.rationale, CAP.rationale),
  };
  return meta.title || meta.abstract || meta.motivation || meta.rationale ? meta : null;
}

/**
 * Read a response body as text, STREAMING with a hard byte cap. A hostile/endless chunked body can't be
 * pre-refused by `content-length` (cross-origin responses don't expose that header, so it reads 0), so we
 * count bytes as they arrive and bail — cancelling the stream — the moment the cap is exceeded, instead of
 * letting `res.text()` buffer the whole thing and OOM the tab. Falls back to a bounded `text()` only if the
 * platform exposes no readable stream. Called client-side only (SSG-safe: no fetch/stream at module scope).
 */
async function readCapped(
  res: Response,
  capBytes: number,
): Promise<{ text: string; bytes: Uint8Array } | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    // Measure BYTES (not `.length`, which counts UTF-16 code units) so a multibyte doc can't slip the cap.
    const bytes = new TextEncoder().encode(text);
    return bytes.byteLength > capBytes ? null : { text, bytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel(); // stop pulling from a hostile/endless stream
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  // The RAW bytes are returned alongside the decoded text, and the anchor hash is taken over the bytes.
  // Hashing the decoded text instead would be a bug that only shows up on real documents: TextDecoder
  // strips a UTF-8 BOM by default, so re-encoding gives a buffer three bytes shorter than what arrived,
  // and any invalid UTF-8 decodes to U+FFFD and re-encodes as EF BF BD. Either way the pinned hash could
  // never be reproduced from the identical document. The no-stream fallback above is exempt because it
  // has already lost the original bytes; it is a platform fallback that no real browser takes.
  return { text: new TextDecoder().decode(buf), bytes: buf };
}

// Per-URL caches. `resolved` holds only TERMINAL outcomes — a parsed value, or `null` when a RESPONSE came
// back but yielded nothing usable (bad status, oversized, malformed JSON, empty doc) — so a re-open / a
// second poll linking the same doc never re-fetches a settled result. A TRANSIENT failure (offline / CORS /
// abort / timeout, where NO response arrived) is deliberately NOT cached, so a later open can retry once the
// network recovers.
//
// `inflight` shares one call between concurrent expanders, and it is keyed by (redirect policy, url) —
// NOT by url alone. The two policies are different requests with different outcomes: a no-redirect fetch
// THROWS on a 3xx and settles to nothing, while the consented follow-redirects fetch resolves it. Keyed on
// the url only, a card's eager (no-redirect) fetch already in flight was handed to a reader who clicked
// Preview on a second card linking the same doc, and that reader saw "Couldn't load the proposal." for a
// document that is perfectly reachable — with their one consented attempt already spent. `resolved` stays
// keyed by url alone, correctly: a TERMINAL outcome is about the document, not about how it was reached.
const resolved = new Map<string, ProposalMeta | null>();
const inflight = new Map<string, Promise<ProposalMeta | null>>();

// The hash of whatever the READER's own fetch returned for a url, alongside `resolved`. Safe to cache
// next to the meta precisely because the composer does NOT populate it: `hashProposalDoc` is a separate,
// uncached, no-redirect read. Were the commitment path to share this cache, verification would compare a
// pinned hash against the very entry it was derived from and return "verified" without touching the
// network for the author's whole session.
const readOutcome = new Map<string, AnchorHashResult>();

/** The hash outcome of this reader's own fetch of `anchorUrl`, or null if they have not fetched it yet. */
export function readAnchorOutcome(anchorUrl: string): AnchorHashResult | null {
  const url = proposalHttpUrl(anchorUrl);
  if (!url) return null;
  return readOutcome.get(url) ?? null;
}

/**
 * Fetch + parse the proposal doc for `anchorUrl` (on demand), or null when it can't be loaded/parsed.
 * TERMINAL outcomes are cached per session; a transient network failure is NOT, so it stays retryable.
 * Never throws. Keyed on the RESOLVED https URL so `ipfs://x` and its gateway form share a cache entry.
 */
export async function resolveProposal(
  anchorUrl: string,
  opts?: { followRedirects?: boolean },
): Promise<ProposalMeta | null> {
  const url = proposalHttpUrl(anchorUrl);
  if (!url) return null;
  if (resolved.has(url)) return resolved.get(url) ?? null;
  const follow = opts?.followRedirects === true;
  const flightKey = `${follow ? "follow" : "nofollow"}|${url}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing;

  // Cache + return a SETTLED (terminal) outcome — re-fetching it would change nothing.
  const settle = (meta: ProposalMeta | null): ProposalMeta | null => {
    resolved.set(url, meta);
    return meta;
  };

  const p = (async (): Promise<ProposalMeta | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      // NOT FOLLOWING REDIRECTS IS THE DEFAULT, and that is the whole point of this option. The browser
      // can't read a cross-origin `Location`, so `isNeutralProposalHost` only ever vouches for the FIRST
      // hop — following one lets an author bounce a neutral gateway (e.g. `<cid>.ipfs.dweb.link` via a
      // `_redirects` file) to a host they control and harvest the IP of every reader who merely scrolls
      // past their poll. The flag used to be opt-IN (`noRedirect`), and the eager IntersectionObserver
      // path in ProposalPreview did not pass it, which is exactly the leak this comment describes.
      //
      // `followRedirects` is therefore only ever set on an ON-DEMAND path, where the reader clicked and
      // the request is consented. `redirect: "error"` throws on a 3xx, which the catch below treats as a
      // transient (uncached) failure — so the Preview click can still follow it afterwards.
      const res = await fetch(url, { signal: ctl.signal, redirect: follow ? "follow" : "error" });
      // A response arrived: every conclusion from here is TERMINAL (a retry won't change it) → cache it.
      if (!res.ok) {
        readOutcome.set(url, { kind: "refused" });
        return settle(null); // 404 / 403 / 429 → degrade gracefully
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_DOC_BYTES) {
        readOutcome.set(url, { kind: "refused" });
        return settle(null); // host DOES declare an oversized doc
      }
      const read = await readCapped(res, MAX_DOC_BYTES);
      if (read === null) {
        readOutcome.set(url, { kind: "refused" });
        return settle(null); // over the cap mid-stream → refuse
      }
      let json: unknown;
      try {
        json = JSON.parse(read.text);
      } catch {
        readOutcome.set(url, { kind: "not-a-doc" });
        return settle(null); // malformed JSON — won't improve on retry
      }
      const parsed = parseProposalDoc(json);
      // Hashed over the RAW bytes, the same input `hashProposalDoc` pinned from, so the two are
      // comparable. Recorded even when the doc did not parse into display fields: a poll that pinned a
      // hash still deserves a verdict about the bytes.
      readOutcome.set(url, { kind: "ok", hash: toHex(blake2b(read.bytes, undefined, 32)) });
      return settle(parsed);
    } catch {
      // Transient (offline / CORS / abort / timeout): NO response arrived — don't cache, allow a later retry.
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().then((meta) => {
    inflight.delete(flightKey);
    return meta;
  });

  inflight.set(flightKey, p);
  return p;
}

// ── anchor-hash pinning + verification ───────────────────────────────────────────────────────────
//
// A cogno governance poll is created BEFORE the Cardano action is submitted, so there is usually no
// on-chain proposal whose anchor hash we could copy. Instead the composer hashes the document it
// actually fetched and pins that, and the poll becomes a commitment to the version its author read.
//
// THE COMPOSER FETCHES EXACTLY AS A READER WILL. Same no-redirect policy, and deliberately NOT through
// the shared `resolved` cache. Both halves are load-bearing:
//
//  • Following redirects at compose time would pin a hash from a document readers can never fetch (the
//    browser cannot read a cross-origin Location, so the read path refuses a 3xx on purpose). The author
//    would see "verified" on their own poll while every reader saw "could not check" forever. GitHub
//    blob URLs 302, and the composer's own placeholder suggests one, so this would have been the modal
//    outcome rather than an edge case.
//  • Sharing the cache would make verification a tautology for the author's whole session: the compare
//    would read back the very entry the commitment was derived from, without touching the network.
//
// So a hash is pinned only when a reader, fetching the same way, will be able to reproduce it.

import { blake2b } from "blakejs";
import { toHex } from "@polkadot-api/utils";

/** The outcome of a compose-time hash attempt. Only `ok` produces a pin. */
export type AnchorHashResult =
  | { kind: "ok"; hash: string }
  /** Fetched and hashed, but the body was not a CIP-108 document we could parse. */
  | { kind: "not-a-doc" }
  /** A response arrived and was refused (bad status, oversized). Terminal: retrying changes nothing. */
  | { kind: "refused" }
  /** No response at all (CORS, offline, timeout, or a redirect the read path will also refuse). */
  | { kind: "unreachable" };

/**
 * Fetch the document at `anchorUrl` and return blake2b-256 of the bytes as received, for pinning on
 * chain. Never throws.
 *
 * Deliberately UNCACHED and non-following, mirroring what a reader's verification fetch will do. See the
 * section header for why both matter.
 *
 * A hash is only produced when the body also PARSES as a CIP-108 document. That is not pedantry: the
 * hosts that survive CORS and serve non-JSON are exactly the churny ones (an IPFS directory CID renders
 * a gateway-generated HTML listing that tracks the gateway's version; an SPA shell rewrites its bytes on
 * every deploy). Pinning those would produce "changed" with no author involvement, which trains readers
 * to ignore the warning that is the whole point of the feature.
 */
export async function hashProposalDoc(anchorUrl: string): Promise<AnchorHashResult> {
  const url = proposalHttpUrl(anchorUrl);
  if (!url) return { kind: "unreachable" };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "error" });
    if (!res.ok) return { kind: "refused" };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_DOC_BYTES) return { kind: "refused" };
    const read = await readCapped(res, MAX_DOC_BYTES);
    if (read === null) return { kind: "refused" };
    try {
      if (parseProposalDoc(JSON.parse(read.text)) === null) return { kind: "not-a-doc" };
    } catch {
      return { kind: "not-a-doc" };
    }
    // Over the RAW bytes, never the decoded text. See readCapped.
    return { kind: "ok", hash: toHex(blake2b(read.bytes, undefined, 32)) };
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** What a reader can be told about a poll's pinned document. */
export type AnchorVerdict =
  /** No hash was pinned (every poll before this shipped, and any whose document could not be hashed). */
  | "unpinned"
  /** The document still hashes to what the poll pinned. */
  | "verified"
  /** It fetched, and it is NOT what was pinned. */
  | "changed"
  /** A hash was pinned and the document is now gone or refused. Evidence AGAINST it, not absence of it. */
  | "missing"
  /** Could not be checked from this browser at all. Says nothing either way. */
  | "unchecked";

/**
 * Compare a freshly-read document against the hash a poll pinned.
 *
 * `missing` is separated from `unchecked` on purpose, and it is the one distinction that carries weight.
 * Deleting the document after votes are cast is the cheapest evasion available to a poll author, and a
 * 404 on a pinned document is terminal, cached, and squarely evidence against it. Folding that into the
 * same environmental-sounding "could not check" as an offline reader would give the cheapest attack the
 * mildest label in the set. Pure, so the whole table is unit-tested.
 */
export function anchorVerdict(
  pinned: string | undefined,
  read: AnchorHashResult | null,
): AnchorVerdict {
  if (!pinned) return "unpinned";
  if (read === null) return "unchecked";
  switch (read.kind) {
    case "ok":
      // Hex from `toHex` is lowercase; the on-chain value arrives as PAPI's SizedHex. Compare
      // case-insensitively rather than trusting both ends to agree on casing forever.
      return read.hash.toLowerCase() === pinned.toLowerCase() ? "verified" : "changed";
    case "not-a-doc":
      // It fetched and it is not the pinned document. Whether it stopped being JSON or was replaced
      // wholesale, the commitment does not hold.
      return "changed";
    case "refused":
      return "missing";
    case "unreachable":
      return "unchecked";
  }
}
