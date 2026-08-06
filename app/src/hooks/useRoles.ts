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

/** The roles the Settings UI offers a claim for + watches. CC's observer branch is wired, but no preprod
 *  committee member can claim: all three sitting members are script cold and hot, and a script cannot
 *  CIP-8-sign. Lighting the card would offer a claim that always fails. */
export const CLAIMABLE_ROLES: RoleKindType[] = ["Spo", "DRep"];

/** A fresh, fully-populated claim map (every role null = none/loading). */
function emptyClaims(): Record<RoleKindType, string | null> {
  return { Spo: null, DRep: null, Committee: null };
}

export interface UseRoles {
  /** the account's live observer-written role set (the badge source); null while loading OR on error. */
  observed: ObservedRoleView[] | null;
  /**
   * The `ObservedRoles` watch FAILED, as opposed to being in flight. Both leave `observed` null (a failed
   * read is not "you hold no roles"), but they are different things to show: a read still landing is a
   * spinner, a read that erred is a dead end. An errored rxjs subscription is terminated and nothing
   * re-subscribes until `api`/the account changes, so without this the Settings card sat on "Checking
   * your verified roles." for the whole session with the claim wizard unreachable and no way back.
   */
  observedError: boolean;
  /** Re-subscribe the role watches. The retry behind `observedError`. */
  reload: () => void;
  /** the live `RoleClaimOf` credential (0x-hex) per role — a claim that may not yet be observed; null = none. */
  claimCredHex: Record<RoleKindType, string | null>;
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
  const [observedError, setObservedError] = useState(false);
  const [claimCredHex, setClaimCredHex] = useState<Record<RoleKindType, string | null>>(emptyClaims);
  // Bumped by `reload` to re-run the subscribe effect. A watch that errors is TERMINATED by rxjs, so
  // re-subscribing is the only way back — there is nothing to retry on the dead observable itself.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  // Watch the observed set + each claimable role's `RoleClaimOf` LIVE for the active key. Cleared on any
  // api/account change BEFORE resubscribing (so a wallet switch never shows account A's role under B), and
  // watched (not one-shot) because the observer writes `ObservedRoles` a few blocks after a claim lands and
  // CLEARS it when the pool/dRep lapses — the Settings status must track it live.
  useEffect(() => {
    setObserved(null);
    setObservedError(false);
    setClaimCredHex(emptyClaims());
    if (!api) return;
    const subs: { unsubscribe: () => void }[] = [];
    // `watchValue({ at: "best" })` re-emits every best block; deduping the emit against a serialized guard
    // (as RoleBadge's self-fetch does) avoids a re-render of every RoleClaimCard each block when the set
    // is unchanged.
    let lastObserved = " "; // sentinel distinct from any JSON
    subs.push(
      api.query.CardanoRoles.ObservedRoles.watchValue(signer.ss58, { at: "best" }).subscribe(
        ({ value }) => {
          const next: ObservedRoleView[] = (value ?? []).map((r) => ({
            kind: r.kind.type,
            id: r.id,
            weight: r.weight,
          }));
          // `weight` is a u128 → bigint, and `JSON.stringify` THROWS on a bigint ("Do not know how to
          // serialize a BigInt") — inside a subscription callback, where it would kill the watch and leave
          // Settings stuck on "Checking your verified roles." forever. Build the dedupe key by hand.
          const key = next.map((r) => `${r.kind}:${r.id}:${r.weight ?? "-"}`).join("|");
          if (key === lastObserved) return;
          lastObserved = key;
          setObservedError(false);
          setObserved(next);
        },
        // A failed read is NOT "you hold no roles". `[]` here was a confirmed negative written from an
        // unknown, and it stuck for the session — showing a verified SPO the claim wizard. Mirror
        // Providers.tsx, which does `setViewerRoles(null)` on the very same watch. The error flag is what
        // keeps the card from claiming the OTHER unknown ("still checking") forever: the subscription is
        // dead at this point, so the surface has to offer `reload`.
        () => {
          setObserved(null);
          setObservedError(true);
        },
      ),
    );
    for (const role of CLAIMABLE_ROLES) {
      subs.push(
        api.query.CardanoRoles.RoleClaimOf.watchValue(signer.ss58, Enum(role), { at: "best" }).subscribe(
          // Bail out of the state update (return the same `prev` reference) when the claim credential is
          // unchanged, so a per-block re-emit doesn't force a re-render.
          ({ value }) =>
            setClaimCredHex((prev) => {
              const next = value ?? null;
              return prev[role] === next ? prev : { ...prev, [role]: next };
            }),
          () => setClaimCredHex((prev) => (prev[role] === null ? prev : { ...prev, [role]: null })),
        ),
      );
    }
    return () => subs.forEach((s) => s.unsubscribe());
  }, [api, signer.ss58, reloadKey]);

  const claim = useCallback(
    async (
      coseSign1Hex: string,
      coseKeyHex: string,
    ): Promise<{ ok: boolean; role?: RoleKindType; error?: string }> => {
      if (!api || !client) return { ok: false, error: "Not connected to the network." };
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
          return { ok: false, role: res.role, error: "claim submitted, but it hasn't landed yet. Try again in a moment" };
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
      if (!api) return { ok: false, error: "Not connected to the network." };
      return submitUnclaimRole(api, signer, role);
    },
    [api, signer],
  );

  return { observed, observedError, reload, claimCredHex, claim, unclaim };
}
