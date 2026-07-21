// Display-only resolution of an observer-surfaced poolID → a pool ticker / name, via Blockfrost REST
// (the app's existing preprod provider; NO Koios, per the design). The chain gives the trustless part —
// the 28-byte poolID in `ObservedRoles` — and this turns it into a human ticker for the profile badge,
// best-effort. If it can't resolve (no project id, 404, rate-limit, offline) the badge degrades to
// "SPO" + a truncated poolID; it NEVER fabricates a name.
//
// Security: pool tickers/names are ATTACKER-CONTROLLABLE on-chain metadata, so every resolved string is
// hardened through `sanitizeInline` (bidi / invisible / Zalgo) and length-capped before it reaches the
// DOM — the same rule the app applies to every other raw Cardano-sourced text. SSG-safe: no `window`
// at module scope; `fetch` only inside the resolver. Kept MeshJS-free so the badge stays light — the
// poolID is passed to Blockfrost as hex (Blockfrost accepts bech32 OR hex for pool ids).

import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import { sanitizeInline } from "@/lib/sanitize";

/** A resolved pool display name (both fields optional; at least one present when non-null). */
export interface PoolMeta {
  ticker?: string;
  name?: string;
}

// Per-session caches: a resolved value (or `null` = tried, nothing usable) so a badge re-render / a
// second profile with the same pool never re-hits Blockfrost; and an in-flight promise so concurrent
// badges for the same pool share one request.
const resolved = new Map<string, PoolMeta | null>();
const inflight = new Map<string, Promise<PoolMeta | null>>();

/** The Blockfrost REST base for the network the configured project id belongs to (its network prefix). */
function baseFor(projectId: string): string {
  if (projectId.startsWith("mainnet")) return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (projectId.startsWith("preview")) return "https://cardano-preview.blockfrost.io/api/v0";
  // preprod (the app's default network) — and the safe fallback for any unrecognized prefix.
  return "https://cardano-preprod.blockfrost.io/api/v0";
}

/**
 * Resolve a poolID (0x-prefixed or bare 28-byte hex) to a sanitized ticker / name, or `null` when it
 * can't be resolved. Cached per session. Never throws.
 */
export async function resolvePoolMeta(poolIdHex: string): Promise<PoolMeta | null> {
  const id = poolIdHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{56}$/.test(id)) return null;
  if (resolved.has(id)) return resolved.get(id) ?? null;
  const existing = inflight.get(id);
  if (existing) return existing;

  const p = (async (): Promise<PoolMeta | null> => {
    const projectId = getBlockfrostProjectId();
    if (!projectId) return null;
    try {
      const res = await fetch(`${baseFor(projectId)}/pools/${id}/metadata`, {
        headers: { project_id: projectId },
      });
      if (!res.ok) return null; // 404 (no registered metadata) / 400 / 429 → degrade gracefully
      const j = (await res.json()) as { ticker?: unknown; name?: unknown };
      const ticker =
        typeof j.ticker === "string" ? sanitizeInline(j.ticker).slice(0, 16).trim() : "";
      const name = typeof j.name === "string" ? sanitizeInline(j.name).slice(0, 64).trim() : "";
      const meta: PoolMeta = {
        ticker: ticker || undefined,
        name: name || undefined,
      };
      return meta.ticker || meta.name ? meta : null;
    } catch {
      return null; // offline / CORS / provider error — degrade, never surface a throw
    }
  })().then((meta) => {
    resolved.set(id, meta);
    inflight.delete(id);
    return meta;
  });

  inflight.set(id, p);
  return p;
}
