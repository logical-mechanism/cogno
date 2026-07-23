// govParams.ts — best-effort LIVE read of the Conway voting THRESHOLDS + total active stake from Blockfrost,
// for the governance-poll readout. Mirrors roleMeta.ts: fetch, cache per session, degrade to the shipped
// FALLBACK_THRESHOLDS / no-coverage — never throws. SSG-safe (no fetch at module scope / on the server).
//
// Display-only: the chain gives the trustless part (the chamber weights); this adds the real-governance
// context — the ratification bar (a governance-set protocol parameter) and the coverage denominator.

import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import { FALLBACK_THRESHOLDS, type VotingThresholds } from "./governance";

export interface GovParams {
  thresholds: VotingThresholds;
  /** Total active stake (lovelace) — the coverage denominator; null when unavailable. */
  totalActiveStake: bigint | null;
  /** true when thresholds came from Blockfrost; false = shipped fallback (surface as "approx"). */
  live: boolean;
}

const FETCH_TIMEOUT_MS = 8000;
const FALLBACK: GovParams = { thresholds: FALLBACK_THRESHOLDS, totalActiveStake: null, live: false };

/** Blockfrost REST base for the network the configured project id belongs to (its network prefix). */
function blockfrostBase(projectId: string): string {
  if (projectId.startsWith("mainnet")) return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (projectId.startsWith("preview")) return "https://cardano-preview.blockfrost.io/api/v0";
  return "https://cardano-preprod.blockfrost.io/api/v0"; // preprod default + safe fallback
}

/** Coerce a Blockfrost threshold value (decimal string or number) to a fraction, or the fallback if absent. */
function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

async function fetchJson(
  url: string,
  projectId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { project_id: projectId }, signal });
  if (!res.ok) return null; // 404 / 403 / 429 → degrade
  return (await res.json()) as Record<string, unknown>;
}

// A single successful live result is cached for the session; a fallback is NOT cached so a later call can
// retry the network. An in-flight promise is shared so concurrent poll cards issue one request.
let cached: GovParams | null = null;
let inflight: Promise<GovParams> | null = null;

/**
 * The live Conway voting thresholds + total active stake, or the shipped fallback. Best-effort, cached,
 * never throws. Called client-side from the governance-poll reader.
 */
export async function resolveGovParams(): Promise<GovParams> {
  if (cached) return cached;
  if (inflight) return inflight;
  // No window (SSG / server) → don't reach the network during a static export; use the fallback.
  if (typeof window === "undefined") return FALLBACK;

  inflight = (async (): Promise<GovParams> => {
    const projectId = getBlockfrostProjectId();
    if (!projectId) return FALLBACK;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const base = blockfrostBase(projectId);
      const [p, net] = await Promise.all([
        fetchJson(`${base}/epochs/latest/parameters`, projectId, ctl.signal),
        fetchJson(`${base}/network`, projectId, ctl.signal).catch(() => null),
      ]);
      if (!p) return FALLBACK; // no params → fall back whole (thresholds are the load-bearing part)
      const f = FALLBACK_THRESHOLDS;
      const thresholds: VotingThresholds = {
        spo: {
          motionNoConfidence: num(p.pvt_motion_no_confidence, f.spo.motionNoConfidence),
          committeeNormal: num(p.pvt_committee_normal, f.spo.committeeNormal),
          committeeNoConfidence: num(p.pvt_committee_no_confidence, f.spo.committeeNoConfidence),
          hardForkInitiation: num(p.pvt_hard_fork_initiation, f.spo.hardForkInitiation),
          ppSecurityGroup: num(p.pvt_p_p_security_group, f.spo.ppSecurityGroup),
        },
        drep: {
          motionNoConfidence: num(p.dvt_motion_no_confidence, f.drep.motionNoConfidence),
          committeeNormal: num(p.dvt_committee_normal, f.drep.committeeNormal),
          committeeNoConfidence: num(p.dvt_committee_no_confidence, f.drep.committeeNoConfidence),
          updateToConstitution: num(p.dvt_update_to_constitution, f.drep.updateToConstitution),
          hardForkInitiation: num(p.dvt_hard_fork_initiation, f.drep.hardForkInitiation),
          ppNetworkGroup: num(p.dvt_p_p_network_group, f.drep.ppNetworkGroup),
          ppEconomicGroup: num(p.dvt_p_p_economic_group, f.drep.ppEconomicGroup),
          ppTechnicalGroup: num(p.dvt_p_p_technical_group, f.drep.ppTechnicalGroup),
          ppGovGroup: num(p.dvt_p_p_gov_group, f.drep.ppGovGroup),
          treasuryWithdrawal: num(p.dvt_treasury_withdrawal, f.drep.treasuryWithdrawal),
        },
      };
      let totalActiveStake: bigint | null = null;
      const active = (net?.stake as { active?: unknown } | undefined)?.active;
      if (typeof active === "string" && /^\d+$/.test(active)) {
        try {
          totalActiveStake = BigInt(active);
        } catch {
          totalActiveStake = null;
        }
      }
      return { thresholds, totalActiveStake, live: true };
    } catch {
      return FALLBACK; // offline / CORS / abort → fallback
    } finally {
      clearTimeout(timer);
    }
  })().then((r) => {
    if (r.live) cached = r; // cache only a real result; keep retrying while on the fallback
    inflight = null;
    return r;
  });
  return inflight;
}
