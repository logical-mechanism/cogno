// Endpoint-as-config. Neutrality is a v1 requirement (no hardcoded "blessed" node in the
// UI, even in M1): the WS endpoint(s) the app talks to are user-overridable and persisted
// locally. Reads stay best-effort; the user picks who they trust to read/broadcast through.
//
// SSG-safe: this module is imported during static export, so it must NEVER touch
// `window`/`localStorage` at module-evaluation time — only inside functions, guarded.

/** The default node the dev build speaks to. The only network call the app makes. */
export const DEFAULT_WS_ENDPOINTS: string[] = ["ws://127.0.0.1:9944"];

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
