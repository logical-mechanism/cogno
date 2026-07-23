// Display-only resolution of a governance-poll's anchor URL → the CIP-108 proposal CONTENTS, fetched
// on-demand and rendered INLINE (title / abstract / motivation / rationale) instead of a bare link.
//
// Mirrors roleMeta.ts: fetch off-chain metadata, sanitize every string (it is ATTACKER-CONTROLLED
// off-chain text — the same threat model as pool tickers / dRep names), cache per session, and degrade to
// null on ANY failure (CORS / offline / 404 / bad JSON / oversize / timeout). It NEVER throws and NEVER
// fabricates content. SSG-safe: no `window` / `fetch` at module scope — only inside `resolveProposal`.
//
// UNVERIFIED by design: cogno stores only the anchor LINK (the composer pins no hash), so the fetched doc
// could have changed since the poll was created. The UI labels the preview as unverified — this is a
// convenience read of off-chain text, not an on-chain fact.

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
const CAP = { title: 160, abstract: 1200, motivation: 2000, rationale: 2000 } as const;

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
async function readCapped(res: Response, capBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > capBytes ? null : text;
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
  return new TextDecoder().decode(buf);
}

// Per-URL caches: a resolved value (or `null` = tried, nothing usable) so a re-open / a second poll linking
// the same doc never re-fetches; and an in-flight promise so concurrent expanders share one call.
const resolved = new Map<string, ProposalMeta | null>();
const inflight = new Map<string, Promise<ProposalMeta | null>>();

/**
 * Fetch + parse the proposal doc for `anchorUrl` (on demand), or null when it can't be loaded/parsed.
 * Cached per session; never throws. Keyed on the RESOLVED https URL so `ipfs://x` and its gateway form
 * share a cache entry.
 */
export async function resolveProposal(anchorUrl: string): Promise<ProposalMeta | null> {
  const url = proposalHttpUrl(anchorUrl);
  if (!url) return null;
  if (resolved.has(url)) return resolved.get(url) ?? null;
  const existing = inflight.get(url);
  if (existing) return existing;

  const p = (async (): Promise<ProposalMeta | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
      if (!res.ok) return null; // 404 / 403 / 429 → degrade gracefully
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_DOC_BYTES) return null; // fast-refuse when the host DOES declare an oversized doc
      const text = await readCapped(res, MAX_DOC_BYTES);
      if (text === null) return null; // over the cap mid-stream → refuse
      return parseProposalDoc(JSON.parse(text));
    } catch {
      return null; // offline / CORS / abort / bad JSON — degrade, never surface a throw
    } finally {
      clearTimeout(timer);
    }
  })().then((meta) => {
    resolved.set(url, meta);
    inflight.delete(url);
    return meta;
  });

  inflight.set(url, p);
  return p;
}
