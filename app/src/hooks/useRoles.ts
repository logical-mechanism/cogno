"use client";

// useRoles — the verifiable Cardano role-tag state for the active posting account (SPO first). It mirrors
// the stake-bind half of useIdentity, but the proof is produced OFFLINE (cardano-signer), so the wizard
// (components/settings/RolesSection) owns the multi-step form (enter key → copy command → paste result →
// pre-flight) and hands this hook the already-verified COSE blobs to SUBMIT. This hook owns the chain
// state: the live observer-written `ObservedRoles` (what the badge shows) and the live `RoleClaimOf[Spo]`
// claim (claimed-but-not-yet-observed), plus the feeless claim action.
//
// The claim is FEELESS + BARE (unsigned) — the offline role proof is the authorization — so there is no
// in-browser signing step: the phases are `submitting` (the multi-second finalize wait) → `confirming`
// (the `RoleClaimOf` readback), symmetric with the stake bind minus the wallet sign. There is no
// self-service unclaim: `unclaim_role` is a signed, fee-bearing call and a posting account has no native
// balance to pay for it, so removal is left to the observer (pool retires) / the committee (revoke).

import { useCallback, useEffect, useState } from "react";
import { Enum } from "polkadot-api";
import type { PolkadotClient } from "polkadot-api";
import type { CognoApi, PostingSigner } from "@/lib/types";
import { submitClaimRoleFeeless, readRoleClaim, type ObservedRoleView } from "@/lib/chain/roles";

/** The phase of an in-flight role claim (no in-browser sign — the proof is produced offline). */
export type ClaimPhase = "idle" | "submitting" | "confirming";

export interface UseRoles {
  /** the account's live observer-written role set (the badge source); null while loading. */
  observed: ObservedRoleView[] | null;
  /** convenience: the live SPO entry (with its resolved poolID), or null if none is observed. */
  spoObserved: ObservedRoleView | null;
  /** the live `RoleClaimOf[Spo]` credential (0x-hex) — a claim that may not yet be observed; null = none. */
  spoClaimCredHex: string | null;
  /** a claim is in flight. */
  claiming: boolean;
  claimPhase: ClaimPhase;
  claimError: string | null;
  /**
   * Submit an already-pre-flighted role proof FEELESSLY (bare/unsigned) and confirm it landed. Resolves
   * true once the claim is on-chain, false otherwise. The COSE blobs come from
   * {@link import("@/lib/cardano/role-proof").preflightRolePasteback}.
   */
  claim: (coseSign1Hex: string, coseKeyHex: string) => Promise<boolean>;
}

export function useRoles(
  api: CognoApi | null,
  client: PolkadotClient | null,
  signer: PostingSigner,
): UseRoles {
  const [observed, setObserved] = useState<ObservedRoleView[] | null>(null);
  const [spoClaimCredHex, setSpoClaimCredHex] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimPhase, setClaimPhase] = useState<ClaimPhase>("idle");
  const [claimError, setClaimError] = useState<string | null>(null);

  // Watch the observed role set + the SPO claim LIVE for the active key. Watched (not one-shot) because
  // the observer writes `ObservedRoles` a few blocks AFTER the claim lands, and later CLEARS it when the
  // pool retires — so the Settings status must track it live, exactly like the stake watches in useIdentity.
  useEffect(() => {
    // Clear the previous account's role state on any api/account change BEFORE resubscribing, so a wallet
    // switch can never transiently show account A's badge under account B in the window before B's watch
    // first-emits (mirrors RoleBadge's watch reset + useIdentity's clear-on-key-change). Without this the
    // effect only unsub/resubscribes and `observed`/`spoClaimCredHex` would linger from the old account.
    setClaimError(null);
    setObserved(null);
    setSpoClaimCredHex(null);
    if (!api) return;
    const s1 = api.query.CardanoRoles.ObservedRoles.watchValue(signer.ss58, { at: "best" }).subscribe(
      ({ value }) => setObserved((value ?? []).map((r) => ({ kind: r.kind.type, id: r.id }))),
      () => setObserved([]),
    );
    const s2 = api.query.CardanoRoles.RoleClaimOf.watchValue(signer.ss58, Enum("Spo"), { at: "best" }).subscribe(
      ({ value }) => setSpoClaimCredHex(value ?? null),
      () => setSpoClaimCredHex(null),
    );
    return () => {
      s1.unsubscribe();
      s2.unsubscribe();
    };
  }, [api, signer.ss58]);

  const claim = useCallback(
    async (coseSign1Hex: string, coseKeyHex: string): Promise<boolean> => {
      if (!api || !client || claiming) return false;
      setClaiming(true);
      setClaimPhase("submitting");
      setClaimError(null);
      try {
        // Submit the offline proof feelessly, as a bare/unsigned extrinsic — no fee, no signing account.
        // `client.submit` resolves on FINALIZATION, so this is the multi-second wait.
        const res = await submitClaimRoleFeeless(client, api, coseSign1Hex, coseKeyHex);
        if (!res.ok) {
          throw new Error(res.error || "the on-chain role claim was rejected");
        }
        // Readback: confirm the claim actually landed for MY account before declaring success (symmetric
        // with the payment/stake bind confirm steps). The live watch above then surfaces it.
        setClaimPhase("confirming");
        const claimedCred = await readRoleClaim(api, signer.ss58, res.role ?? "Spo").catch(() => undefined);
        if (!claimedCred) {
          console.error(
            `cogno: role claim submitted but the chain shows no claim for ${signer.ss58.slice(0, 8)}… (role ${res.role ?? "Spo"})`,
          );
          throw new Error("role claim submitted, but the chain still shows no claim");
        }
        return true;
      } catch (e) {
        setClaimError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setClaiming(false);
        setClaimPhase("idle");
      }
    },
    [api, client, claiming, signer.ss58],
  );

  const spoObserved = observed?.find((r) => r.kind === "Spo") ?? null;

  return {
    observed,
    spoObserved,
    spoClaimCredHex,
    claiming,
    claimPhase,
    claimError,
    claim,
  };
}
