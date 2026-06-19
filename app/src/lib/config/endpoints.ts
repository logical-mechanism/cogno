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
const ENV_FOLLOWER = process.env.NEXT_PUBLIC_FOLLOWER_URL || "";
const ENV_BIND_RELAY = process.env.NEXT_PUBLIC_BIND_RELAY_URL || "";
const ENV_GRAPHQL = process.env.NEXT_PUBLIC_GRAPHQL_URL || "";
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

// ── Cogno-Follower endpoint (M2) ────────────────────────────────────────────────────────
// The trusted v1 follower the bind flow POSTs the CIP-8 proof to. Config, like the WS
// endpoints — but it buys ZERO route-around in v1 (one trusted follower; the badge says so).
// HTTPS in any real deployment; plain http for the localhost dev showcase.

/** The default follower the dev build binds through. */
export const DEFAULT_FOLLOWER_URL = /^https?:\/\//.test(ENV_FOLLOWER) ? ENV_FOLLOWER : "http://127.0.0.1:8090";
const FOLLOWER_STORAGE_KEY = "cogno.follower";

/** The user-configured follower URL, or {@link DEFAULT_FOLLOWER_URL}. SSG-safe. */
export function getFollowerUrl(): string {
  if (typeof window === "undefined") return DEFAULT_FOLLOWER_URL;
  try {
    const raw = window.localStorage.getItem(FOLLOWER_STORAGE_KEY);
    return raw && /^https?:\/\//.test(raw) ? raw : DEFAULT_FOLLOWER_URL;
  } catch {
    return DEFAULT_FOLLOWER_URL;
  }
}

/** Persist the follower URL (http/https only). No-op without `window`. */
export function setFollowerUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) throw new Error("Follower URL must be http:// or https://");
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FOLLOWER_STORAGE_KEY, url);
  } catch {
    // Storage blocked — non-critical.
  }
}

// ── Sponsored-Bind Relay endpoint (D1 bind-funding) ─────────────────────────────────────
// A freshly sign-to-derived posting account starts with ZERO balance, so it cannot pay the
// (deliberately non-feeless) link_identity_signed fee. The bind flow POSTs the signed CIP-8 proof
// to this funded relay, which pays the fee + submits on the user's behalf. Config, like the WS /
// follower endpoints — and like them it buys ZERO trust over correctness: the relay is a LIVENESS
// party (it can censor, NEVER forge — the proof commits {account, genesis} and the runtime is the
// sole verifier). HTTPS in any real deployment; plain http for the localhost dev showcase.

/** The default Sponsored-Bind Relay the dev build binds through (the follower is :8090; the relay :8091). */
export const DEFAULT_BIND_RELAY_URL = /^https?:\/\//.test(ENV_BIND_RELAY) ? ENV_BIND_RELAY : "http://127.0.0.1:8091";
const BIND_RELAY_STORAGE_KEY = "cogno.bindRelay";

/** The user-configured bind-relay URL, or {@link DEFAULT_BIND_RELAY_URL}. SSG-safe. */
export function getBindRelayUrl(): string {
  if (typeof window === "undefined") return DEFAULT_BIND_RELAY_URL;
  try {
    const raw = window.localStorage.getItem(BIND_RELAY_STORAGE_KEY);
    return raw && /^https?:\/\//.test(raw) ? raw : DEFAULT_BIND_RELAY_URL;
  } catch {
    return DEFAULT_BIND_RELAY_URL;
  }
}

/** Persist the bind-relay URL (http/https only). No-op without `window`. */
export function setBindRelayUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) throw new Error("Bind-relay URL must be http:// or https://");
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BIND_RELAY_STORAGE_KEY, url);
  } catch {
    // Storage blocked — non-critical.
  }
}

// ── SubQuery GraphQL indexer endpoint (M4) ──────────────────────────────────────────────
// The optional indexer the app reads the feed/search/thread/profile views through. Empty =
// read directly from the node (PAPI) — slower, no search, but always available. Like the WS
// and follower endpoints, this is config: the reader picks who they trust to index for them.

/** localStorage key for the indexer URL; default is empty ("" ⇒ read directly from the node). */
const GRAPHQL_STORAGE_KEY = "cogno.graphql";

/**
 * The user-configured GraphQL indexer URL, or "" when unset (⇒ PAPI-direct reads). SSG-safe:
 * returns "" with no `window` and never throws; an invalid stored value is treated as unset.
 */
export function getGraphqlUrl(): string {
  if (typeof window === "undefined") return ENV_GRAPHQL;
  try {
    const raw = window.localStorage.getItem(GRAPHQL_STORAGE_KEY);
    return raw && /^https?:\/\//.test(raw) ? raw : ENV_GRAPHQL;
  } catch {
    return ENV_GRAPHQL;
  }
}

/**
 * Persist the indexer URL (http/https only), or clear it with an empty/blank string (⇒ fall
 * back to PAPI-direct reads). No-op without `window`. Throws on a non-empty, non-http value.
 */
export function setGraphqlUrl(url: string): void {
  const trimmed = url.trim();
  if (typeof window === "undefined") return;
  try {
    if (trimmed.length === 0) {
      window.localStorage.removeItem(GRAPHQL_STORAGE_KEY);
      return;
    }
    if (!/^https?:\/\//.test(trimmed)) {
      throw new Error("GraphQL endpoint must be http:// or https:// (or empty to read directly)");
    }
    window.localStorage.setItem(GRAPHQL_STORAGE_KEY, trimmed);
  } catch (err) {
    // Re-throw a validation error so the UI can report it; swallow storage-blocked errors.
    if (err instanceof Error && err.message.startsWith("GraphQL endpoint")) throw err;
  }
}

// ── Blockfrost provider (M8) ─────────────────────────────────────────────────────────────
// The Cardano provider the in-browser vault lock/exit txs use (fetcher/submitter/evaluator +
// live cost models). A preprod project id — exposed client-side by design so any visitor can
// lock from their own wallet without a backend. Empty ⇒ the lock action is hidden. Config like
// the WS/follower/indexer endpoints: NEXT_PUBLIC_BLOCKFROST_PROJECT_ID seeds the default, a
// user override in localStorage wins.

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
