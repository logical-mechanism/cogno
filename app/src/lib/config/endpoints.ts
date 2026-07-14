// Endpoint-as-config. Neutrality is a requirement: the WS endpoint(s) the app talks to are
// user-overridable and persisted locally. Reads stay best-effort; the user picks who they trust to
// read/broadcast through.
//
// SSG-safe: this module is imported during static export, so it must NEVER touch
// `window`/`localStorage` at module-evaluation time — only inside functions, guarded.
//
// Build-time seeds: NEXT_PUBLIC_* are inlined by Next at build (referenced literally so the static
// export can substitute them), letting a real deployment ship its own defaults. A user override in
// localStorage always wins over both.

/**
 * The public preprod endpoint a clean clone falls back to, so `npm run dev` / `npm run build` work
 * with zero configuration and show the real chain. It is a default, not a blessing: it is the first
 * thing Settings lets you replace, and nothing else in the app hardcodes a host.
 */
const PUBLIC_WS = "wss://cogno.forum/rpc";

const ENV_WS = process.env.NEXT_PUBLIC_WS_URL || "";
const ENV_BLOCKFROST = process.env.NEXT_PUBLIC_BLOCKFROST_PROJECT_ID || "";

/**
 * If a production build NAMES an endpoint, it must be one a browser can actually reach from the
 * https page the export is served over: `wss://`, or a loopback `ws://` (browsers treat loopback as
 * a secure origin, and it is how you build for a local `serve out`). A plaintext `ws://` to a public
 * host is mixed-content-blocked, and would ship a bundle that silently reads nothing.
 *
 * Unset is fine — it falls back to PUBLIC_WS. `next build` sets NODE_ENV=production, so a bad value
 * fails the build rather than the deploy.
 */
if (process.env.NODE_ENV === "production" && ENV_WS) {
  const loopback = ENV_WS.startsWith("ws://127.0.0.1") || ENV_WS.startsWith("ws://localhost");
  if (!ENV_WS.startsWith("wss://") && !loopback) {
    throw new Error(
      `NEXT_PUBLIC_WS_URL must be a wss:// endpoint in a production build (got ${ENV_WS}). ` +
        `A ws://127.0.0.1 value is accepted for a local build; leave it unset to use ${PUBLIC_WS}.`,
    );
  }
}

/** The node the app speaks to out of the box. The only network call the app makes. */
export const DEFAULT_WS_ENDPOINTS: string[] = [
  ENV_WS && (ENV_WS.startsWith("ws://") || ENV_WS.startsWith("wss://")) ? ENV_WS : PUBLIC_WS,
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

// The node above is the ONLY app-chain endpoint there is to configure: feed / thread / profile /
// search / people / replies are all served by its MicroblogApi runtime read API, and the CIP-8
// identity / stake binds are feeless bare unsigned extrinsics submitted straight to it. There is no
// indexer, no follower and no relay to point at.

// ── Blockfrost provider ──────────────────────────────────────────────────────────────────────────
// The Cardano provider the in-browser vault lock/exit txs use (fetcher/submitter/evaluator +
// live cost models). A preprod project id — exposed client-side by design so any visitor can
// lock from their own wallet without a backend. Empty ⇒ the lock action is hidden. Config like
// the WS endpoint: NEXT_PUBLIC_BLOCKFROST_PROJECT_ID seeds the default, a user override
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
