"use client";

// RoleBadge — the verifiable Cardano role chip(s) on an author identity line (SPO + dRep). Renders one
// chip per LIVE observed role, so a multi-pool operator shows several ✓ SPO tags. Two data sources:
//   • `roles` — a set supplied by the caller (the node-served feed/thread/quote/profile folds the observed
//     roles onto each author, so a timeline card shows badges with NO extra per-author subscription); or
//   • `address` — self-fetching fallback: watches `CardanoRoles.ObservedRoles` LIVE for that account (used
//     where only an address is in hand). A tag appears once the observer confirms the role is live and
//     DISAPPEARS the moment the pool retires / the dRep deregisters / the claim is unclaimed or revoked.
// Renders NOTHING while loading or when the account holds no live role — a lapsed role leaves no residue.
//
// Each chip is a "verify on-chain" link to cexplorer (the trustless 28-byte poolID/drepID → its explorer
// page), so a viewer can confirm the binding independently. The ticker/name is a best-effort Blockfrost
// lookup (lib/cardano/roleMeta, sanitized), degrading to the role label + a truncated id when unresolved —
// never a fabricated name. Kept MeshJS-free so a profile / feed page never pulls the heavy Cardano bundle.

import { useEffect, useState } from "react";
import styles from "./RoleBadge.module.css";
import { useSession } from "@/components/Providers";
import { resolvePoolMeta, resolveDRepName, roleExplorerUrl } from "@/lib/cardano/roleMeta";
import { isBlankRoleId, type ObservedRoleView, type RoleKindType } from "@/lib/chain/roles";

/** Short label per role. */
const ROLE_LABEL: Record<RoleKindType, string> = { Spo: "SPO", DRep: "dRep", Committee: "CC" };
/** Full role name for the accessible label / tooltip. */
const ROLE_FULL: Record<RoleKindType, string> = {
  Spo: "stake pool operator",
  DRep: "delegated representative",
  Committee: "Constitutional Committee member",
};

/** `0x…` (28-byte hex) → `1a2b3c…c3d4` for the unresolved fallback. */
function truncId(idHex: string): string {
  const h = idHex.replace(/^0x/, "");
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

/** Resolve a role's display name via Blockfrost (SPO → pool ticker/name, dRep → dRep name), or null. */
async function resolveRoleName(kind: RoleKindType, idHex: string): Promise<string | null> {
  if (kind === "Spo") {
    const meta = await resolvePoolMeta(idHex);
    return meta?.ticker || meta?.name || null;
  }
  if (kind === "DRep") return resolveDRepName(idHex);
  return null; // CC has no name registry
}

/**
 * The verified role chip(s) for an author. Provide EITHER `roles` (the folded, node-served set — no
 * subscription) OR `address` (self-fetch the live set). If both are given, `roles` wins.
 */
export function RoleBadge({ roles, address }: { roles?: ObservedRoleView[]; address?: string }) {
  const { api } = useSession();
  const provided = roles !== undefined;
  const [fetched, setFetched] = useState<ObservedRoleView[] | null>(null);
  // `${kind}:${id}` → resolved ticker/name. Absent = unresolved (show the truncated id).
  const [names, setNames] = useState<Record<string, string>>({});

  // Self-fetch only when the caller did NOT supply `roles`. A serialized guard avoids a re-render every
  // block (watchValue re-emits per best block) when the set is unchanged.
  useEffect(() => {
    if (provided) return; // the set is supplied — no subscription
    if (!api || !address) {
      setFetched(null);
      return;
    }
    setFetched(null);
    let last = " "; // sentinel distinct from any JSON
    const sub = api.query.CardanoRoles.ObservedRoles.watchValue(address, { at: "best" }).subscribe(
      ({ value }) => {
        const next: ObservedRoleView[] = (value ?? []).map((r) => ({ kind: r.kind.type, id: r.id }));
        const key = JSON.stringify(next);
        if (key === last) return;
        last = key;
        setFetched(next);
      },
      () => setFetched([]),
    );
    return () => sub.unsubscribe();
  }, [provided, api, address]);

  const set = provided ? roles : fetched;

  // Best-effort Blockfrost resolution of each role's display name. Cached in lib/cardano/roleMeta, so a
  // repeat (re-render, second author with the same id) never re-hits the network.
  useEffect(() => {
    if (!set) return;
    let cancelled = false;
    for (const r of set) {
      if (isBlankRoleId(r.id)) continue; // a generic Calidus SPO names no pool — nothing to resolve
      const nameKey = `${r.kind}:${r.id}`;
      if (names[nameKey] !== undefined) continue;
      void resolveRoleName(r.kind, r.id).then((label) => {
        if (cancelled || !label) return;
        setNames((prev) => ({ ...prev, [nameKey]: label }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [set, names]);

  if (!set || set.length === 0) return null;

  return (
    <>
      {set.map((r) => {
        // A Calidus-derived SPO carries the BLANK id: it names no pool (a Calidus registration can't
        // attest one), so it renders as a generic "✓ SPO" — no ticker, no detail, no verify link.
        const blank = isBlankRoleId(r.id);
        const resolvedName = names[`${r.kind}:${r.id}`];
        const detail = blank ? null : (resolvedName ?? truncId(r.id));
        const href = blank ? null : roleExplorerUrl(r.kind, r.id);
        const label = `Verified Cardano ${ROLE_FULL[r.kind]}${resolvedName ? `, ${resolvedName}` : ""}`;
        const title = `Verified Cardano ${ROLE_FULL[r.kind]}${detail ? ` — ${detail}` : ""}. The chain holds a live binding.${
          href ? " Click to verify on-chain." : ""
        }`;
        const inner = (
          <>
            <span className={styles.check} aria-hidden>
              ✓
            </span>
            <span className={styles.role}>{ROLE_LABEL[r.kind]}</span>
            {detail != null && (
              <span className={styles.detail} aria-hidden>
                {detail}
              </span>
            )}
          </>
        );
        // A link to the explorer when we can build one (SPO/dRep); a plain chip otherwise (CC / bad id).
        return href ? (
          <a
            key={`${r.kind}:${r.id}`}
            className={styles.badge}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            aria-label={`${label} — verify on-chain`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {inner}
          </a>
        ) : (
          <span key={`${r.kind}:${r.id}`} className={styles.badge} title={title} aria-label={label}>
            {inner}
          </span>
        );
      })}
    </>
  );
}
