"use client";

// useRoles — the verifiable Cardano role-tag chain state + actions for the active posting account (SPO +
// dRep). It owns the LIVE observer-written `ObservedRoles` (what the badge shows) and the LIVE
// `RoleClaimOf` per role (claimed-but-not-yet-observed), plus the role-agnostic claim + unclaim actions.
// The per-role wizard/loading UI lives in the RolesSection cards; this hook stays presentation-free so one
// account's role state is shared across all its role cards.
//
// The claim is FEELESS + BARE (unsigned) — the offline `cardano-signer` role proof is the authorization,
// so there's no in-browser signing step. `unclaim` is the one SIGNED action (a self-service release),
// feeless via the pallet's `feeless_if`, so a zero-balance account can remove its own tag; the observer
// additionally clears a tag when the pool/dRep lapses. Both actions return a result — the calling card
// tracks its own in-flight state — and the live watches surface the on-chain change.

import { useCallback, useEffect, useState } from "react";
import { Enum } from "polkadot-api";
import type { PolkadotClient } from "polkadot-api";
import type { CognoApi, PostingSigner } from "@/lib/types";
import {
  submitClaimRoleFeeless,
  submitUnclaimRole,
  readRoleClaim,
  type ObservedRoleView,
  type RoleKindType,
} from "@/lib/chain/roles";

/** The roles the Settings UI offers a claim for + watches. CC awaits its observer branch (Phase C). */
export const CLAIMABLE_ROLES: RoleKindType[] = ["Spo", "DRep"];

/** A fresh, fully-populated claim map (every role null = none/loading). */
function emptyClaims(): Record<RoleKindType, string | null> {
  return { Spo: null, DRep: null, Committee: null };
}

export interface UseRoles {
  /** the account's live observer-written role set (the badge source); null while loading. */
  observed: ObservedRoleView[] | null;
  /** the live `RoleClaimOf` credential (0x-hex) per role — a claim that may not yet be observed; null = none. */
  claimCredHex: Record<RoleKindType, string | null>;
  /** the live observed entry for `kind` (with its resolved display id), or null if none is observed. */
  observedFor: (kind: RoleKindType) => ObservedRoleView | null;
  /**
   * Submit an already-pre-flighted role proof FEELESSLY (bare/unsigned) and confirm it landed. The role
   * comes from the proof itself (not an arg). Returns the result; the live watches surface the badge.
   */
  claim: (coseSign1Hex: string, coseKeyHex: string) => Promise<{ ok: boolean; role?: RoleKindType; error?: string }>;
  /** Self-service release of a role claim (signed; feeless via `feeless_if`). */
  unclaim: (role: RoleKindType) => Promise<{ ok: boolean; error?: string }>;
}

export function useRoles(
  api: CognoApi | null,
  client: PolkadotClient | null,
  signer: PostingSigner,
): UseRoles {
  const [observed, setObserved] = useState<ObservedRoleView[] | null>(null);
  const [claimCredHex, setClaimCredHex] = useState<Record<RoleKindType, string | null>>(emptyClaims);

  // Watch the observed set + each claimable role's `RoleClaimOf` LIVE for the active key. Cleared on any
  // api/account change BEFORE resubscribing (so a wallet switch never shows account A's role under B), and
  // watched (not one-shot) because the observer writes `ObservedRoles` a few blocks after a claim lands and
  // CLEARS it when the pool/dRep lapses — the Settings status must track it live.
  useEffect(() => {
    setObserved(null);
    setClaimCredHex(emptyClaims());
    if (!api) return;
    const subs: { unsubscribe: () => void }[] = [];
    subs.push(
      api.query.CardanoRoles.ObservedRoles.watchValue(signer.ss58, { at: "best" }).subscribe(
        ({ value }) => setObserved((value ?? []).map((r) => ({ kind: r.kind.type, id: r.id }))),
        () => setObserved([]),
      ),
    );
    for (const role of CLAIMABLE_ROLES) {
      subs.push(
        api.query.CardanoRoles.RoleClaimOf.watchValue(signer.ss58, Enum(role), { at: "best" }).subscribe(
          ({ value }) => setClaimCredHex((prev) => ({ ...prev, [role]: value ?? null })),
          () => setClaimCredHex((prev) => ({ ...prev, [role]: null })),
        ),
      );
    }
    return () => subs.forEach((s) => s.unsubscribe());
  }, [api, signer.ss58]);

  const claim = useCallback(
    async (
      coseSign1Hex: string,
      coseKeyHex: string,
    ): Promise<{ ok: boolean; role?: RoleKindType; error?: string }> => {
      if (!api || !client) return { ok: false, error: "not connected" };
      try {
        // Submit the offline proof feelessly, as a bare/unsigned extrinsic — no fee, no signing account.
        // `client.submit` resolves on FINALIZATION (the multi-second wait).
        const res = await submitClaimRoleFeeless(client, api, coseSign1Hex, coseKeyHex);
        if (!res.ok) {
          return { ok: false, error: res.error || "the on-chain role claim was rejected" };
        }
        // Readback: confirm the claim landed for MY account before declaring success (the live watch then
        // surfaces it). The role comes from the proof's `role=` field via the `RoleClaimed` event.
        const claimedCred = await readRoleClaim(api, signer.ss58, res.role ?? "Spo").catch(() => undefined);
        if (!claimedCred) {
          console.error(
            `cogno: role claim submitted but the chain shows no claim for ${signer.ss58.slice(0, 8)}… (role ${res.role ?? "Spo"})`,
          );
          return { ok: false, role: res.role, error: "role claim submitted, but the chain still shows no claim" };
        }
        return { ok: true, role: res.role };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [api, client, signer.ss58],
  );

  const unclaim = useCallback(
    async (role: RoleKindType): Promise<{ ok: boolean; error?: string }> => {
      if (!api) return { ok: false, error: "not connected" };
      return submitUnclaimRole(api, signer, role);
    },
    [api, signer],
  );

  const observedFor = useCallback(
    (kind: RoleKindType): ObservedRoleView | null => observed?.find((r) => r.kind === kind) ?? null,
    [observed],
  );

  return { observed, claimCredHex, observedFor, claim, unclaim };
}
