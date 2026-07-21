// Display-only resolution of an observer-surfaced role id → a human name, via Blockfrost REST (the app's
// existing preprod provider; NO Koios, per the design). The chain gives the trustless part — the 28-byte
// poolID / drepID in `ObservedRoles` — and this turns it into a pool ticker (SPO) or a dRep name (dRep),
// best-effort. If it can't resolve (no project id, 404, rate-limit, offline) the badge degrades to the
// role label + a truncated id; it NEVER fabricates a name.
//
// Security: pool tickers and dRep names are ATTACKER-CONTROLLABLE off-chain metadata, so every resolved
// string is hardened through `sanitizeInline` (bidi / invisible / Zalgo) and length-capped before it
// reaches the DOM. SSG-safe: no `window` at module scope; `fetch` only inside the resolvers. Kept
// MeshJS-free so the badge stays light — poolIDs go to Blockfrost as hex (accepted); dRep ids are encoded
// to the CIP-129 bech32 form Blockfrost requires with a tiny local bech32 encoder (validated against a
// real drep id) rather than pulling in the ~6 MB Cardano bundle.

import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import { sanitizeInline } from "@/lib/sanitize";
import { hexToBytes } from "@/lib/util/hex";

/** A resolved pool display name (both fields optional; at least one present when non-null). */
export interface PoolMeta {
  ticker?: string;
  name?: string;
}

// Per-role caches: a resolved value (or `null` = tried, nothing usable) so a re-render / a second profile
// with the same id never re-hits Blockfrost; and an in-flight promise so concurrent badges share one call.
const poolResolved = new Map<string, PoolMeta | null>();
const poolInflight = new Map<string, Promise<PoolMeta | null>>();
const drepResolved = new Map<string, string | null>();
const drepInflight = new Map<string, Promise<string | null>>();

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
  if (poolResolved.has(id)) return poolResolved.get(id) ?? null;
  const existing = poolInflight.get(id);
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
      const meta: PoolMeta = { ticker: ticker || undefined, name: name || undefined };
      return meta.ticker || meta.name ? meta : null;
    } catch {
      return null; // offline / CORS / provider error — degrade, never surface a throw
    }
  })().then((meta) => {
    poolResolved.set(id, meta);
    poolInflight.delete(id);
    return meta;
  });

  poolInflight.set(id, p);
  return p;
}

// ── bech32 (encode-only), for the CIP-129 dRep id Blockfrost's /governance/dreps endpoint requires ──
// Standard bech32 (checksum constant 1). Validated against a real preprod drep id: credential
// 743e34…6435f11 → drep1yf6rudz7w9kz4etshj0njg7fjtd0c4frgsds6f8e6ep47ygl6sw74.
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) >>> 0) ^ v;
    chk >>>= 0;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
  }
  return chk >>> 0;
}
function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function bech32Checksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = (bech32Polymod(values) ^ 1) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}
/** Regroup 8-bit bytes into 5-bit groups (pad the final group) for bech32. */
function convert8to5(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = ((acc << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convert8to5(bytes);
  const combined = data.concat(bech32Checksum(hrp, data));
  let s = `${hrp}1`;
  for (const d of combined) s += BECH32_CHARSET[d];
  return s;
}

/**
 * The CIP-129 bech32 dRep id (`drep1…`) for a key-based dRep credential (0x-prefixed or bare 28-byte hex),
 * or `null` if the input isn't 28 bytes. Encodes `0x22 ‖ cred` under the `drep` hrp — the form Blockfrost's
 * /governance/dreps endpoint requires. Exported for the golden-vector test.
 */
export function drepBech32(credHex: string): string | null {
  const cred = credHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{56}$/.test(cred)) return null;
  return bech32Encode("drep", Uint8Array.from([0x22, ...hexToBytes(cred)]));
}

/**
 * Resolve a key-based dRep credential (0x-prefixed or bare 28-byte hex) to a sanitized dRep name
 * (CIP-119 `givenName`), or `null` when it can't be resolved. Encodes the credential to the CIP-129
 * bech32 id (`drep` hrp over `0x22 ‖ cred`) Blockfrost's /governance/dreps endpoint requires. Cached
 * per session. Never throws.
 */
export async function resolveDRepName(credHex: string): Promise<string | null> {
  const cred = credHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{56}$/.test(cred)) return null;
  if (drepResolved.has(cred)) return drepResolved.get(cred) ?? null;
  const existing = drepInflight.get(cred);
  if (existing) return existing;

  const p = (async (): Promise<string | null> => {
    const projectId = getBlockfrostProjectId();
    if (!projectId) return null;
    try {
      const drepId = drepBech32(cred) as string; // cred is validated 28-byte hex above
      const res = await fetch(`${baseFor(projectId)}/governance/dreps/${drepId}/metadata`, {
        headers: { project_id: projectId },
      });
      if (!res.ok) return null; // 404 (no metadata) / 400 / 429 → degrade to a truncated id
      const j = (await res.json()) as { json_metadata?: { body?: { givenName?: unknown } } };
      const given = j.json_metadata?.body?.givenName;
      // CIP-119 givenName is a plain string, or a JSON-LD `{ "@value": "…" }` object.
      const raw =
        typeof given === "string"
          ? given
          : typeof (given as { "@value"?: unknown } | undefined)?.["@value"] === "string"
            ? (given as { "@value": string })["@value"]
            : "";
      const name = raw ? sanitizeInline(raw).slice(0, 48).trim() : "";
      return name || null;
    } catch {
      return null;
    }
  })().then((name) => {
    drepResolved.set(cred, name);
    drepInflight.delete(cred);
    return name;
  });

  drepInflight.set(cred, p);
  return p;
}
