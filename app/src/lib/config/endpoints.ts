// Endpoint-as-config. Neutrality is a v1 requirement (no hardcoded "blessed" node in the
// UI, even in M1): the WS endpoint(s) the app talks to are user-overridable and persisted
// locally. Reads stay best-effort; the user picks who they trust to read/broadcast through.
//
// SSG-safe: this module is imported during static export, so it must NEVER touch
// `window`/`localStorage` at module-evaluation time — only inside functions, guarded.
//
// Build-time seeds: NEXT_PUBLIC_* are inlined by Next at build (referenced literally so the static
// export can substitute them), letting a real deployment ship its own defaults while the localhost
// values stay as the dev fallback. A user override in localStorage always wins over both.
const ENV_WS = process.env.NEXT_PUBLIC_WS_URL || "";
const ENV_BLOCKFROST = process.env.NEXT_PUBLIC_BLOCKFROST_PROJECT_ID || "";

/** The default node the dev build speaks to. The only network call the app makes. */
export const DEFAULT_WS_ENDPOINTS: string[] = [
  ENV_WS && (ENV_WS.startsWith("ws://") || ENV_WS.startsWith("wss://")) ? ENV_WS : "ws://127.0.0.1:9944",
];

/** localStorage key holding a JSON array of ws/wss URLs. */
const STORAGE_KEY = "cogno.endpoints";

/** A valid endpoint is a non-empty ws:// or wss:// URL. */
function isValidWsUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("ws://") || value.startsWith("wss://"))
  );
}

/**
 * The user-configured endpoints, or {@link DEFAULT_WS_ENDPOINTS} when unset/invalid.
 * SSG-safe: returns defaults when there is no `window` (server/build time) and never throws.
 */
export function getEndpoints(): string[] {
  if (typeof window === "undefined") return [...DEFAULT_WS_ENDPOINTS];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_WS_ENDPOINTS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_WS_ENDPOINTS];
    const valid = parsed.filter(isValidWsUrl);
    return valid.length > 0 ? valid : [...DEFAULT_WS_ENDPOINTS];
  } catch {
    // Corrupt JSON / blocked storage — fall back to defaults, never throw.
    return [...DEFAULT_WS_ENDPOINTS];
  }
}

/**
 * Persist the user's endpoint list (only valid ws/wss URLs are kept). No-op when there is
 * no `window` or storage is unavailable. Throws on an all-invalid list so the UI can report it.
 */
export function setEndpoints(list: string[]): void {
  const valid = list.filter(isValidWsUrl);
  if (valid.length === 0) {
    throw new Error("No valid ws:// or wss:// endpoints to save.");
  }
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
  } catch {
    // Storage blocked (private mode / quota) — degrade silently; config is non-critical.
  }
}

/** The active endpoint the chain handle connects to (the first configured one). */
export function getActiveWsUrl(): string {
  return getEndpoints()[0];
}

// (The trusted v1 Cogno-Follower endpoint was REMOVED: the node is the source of truth. The bind flow
// no longer POSTs a CIP-8 proof to a follower — identity/stake binds are bare unsigned extrinsics
// (spec 116+) and the bound talk-capacity weight is observed in-protocol by the node's cardano-observer
// inherent, not granted by an off-chain follower.)

// (The Sponsored-Bind Relay endpoint was REMOVED in spec 116: the CIP-8 identity / stake binds are now
// FEELESS, submitted as bare unsigned extrinsics, so there is no fee to sponsor and no relay to point at.
// See `lib/chain/identity.ts` + `docs/TRUSTLESS-IDENTITY.md`.)

// (The SubQuery GraphQL indexer endpoint was REMOVED in the all-Rust restart: reads are served
// EXCLUSIVELY by the node's spec-200 MicroblogApi (feed / thread / profile / search / people /
// replies), so there is no indexer to point at. See `lib/feed/papi-source.ts`.)

// ── Blockfrost provider (M8) ─────────────────────────────────────────────────────────────
// The Cardano provider the in-browser vault lock/exit txs use (fetcher/submitter/evaluator +
// live cost models). A preprod project id — exposed client-side by design so any visitor can
// lock from their own wallet without a backend. Empty ⇒ the lock action is hidden. Config like
// the WS/indexer endpoints: NEXT_PUBLIC_BLOCKFROST_PROJECT_ID seeds the default, a user override
// in localStorage wins.

const BLOCKFROST_STORAGE_KEY = "cogno.blockfrost";

/** The configured Blockfrost preprod project id, or "" when unset. SSG-safe. */
export function getBlockfrostProjectId(): string {
  if (typeof window === "undefined") return ENV_BLOCKFROST;
  try {
    const raw = window.localStorage.getItem(BLOCKFROST_STORAGE_KEY);
    return raw && raw.trim().length > 0 ? raw.trim() : ENV_BLOCKFROST;
  } catch {
    return ENV_BLOCKFROST;
  }
}

/** Persist the Blockfrost project id, or clear it with an empty string. No-op without `window`. */
export function setBlockfrostProjectId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      window.localStorage.removeItem(BLOCKFROST_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(BLOCKFROST_STORAGE_KEY, trimmed);
  } catch {
    // Storage blocked — non-critical.
  }
}
