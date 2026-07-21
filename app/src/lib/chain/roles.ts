// CardanoRoles reads + the feeless claim WRITE (verifiable role tags — SPO first). The claim mirrors the
// CIP-8 binds in lib/chain/identity.ts: `cardano-roles.claim_role_signed` is FEELESS + UNSIGNED (the
// offline `cardano-signer` role proof IS the authorization — the runtime re-verifies it at pool admission
// and on inclusion via `pallet_cardano_roles::validate_unsigned`), so there is no fee payer and no signing
// account. It is built bare with `tx.getBareTx()` and broadcast with the low-level `client.submit`,
// exactly like `submitLinkStakeFeeless` — which is what lets a zero-balance derived posting account submit
// it. (There is deliberately NO self-service `unclaim_role` write here: it is a SIGNED, fee-bearing call,
// and a posting account has no native balance to pay the fee — so the badge is managed by the observer,
// which clears a tag the moment the pool retires / the claim is committee-revoked.)
//
// The badge reads `ObservedRoles` (the observer-written, liveness-gated map) — NOT the raw claim — so a
// tag only ever shows while the credential is a currently-live Cardano role. The claim map (`RoleClaimOf`)
// is read only to narrate the Settings wizard ("claimed — awaiting the observer").

import type { PolkadotClient } from "polkadot-api";
import { Enum } from "polkadot-api";
import type { CognoApi, Ss58 } from "@/lib/types";
import { classifyDispatchError, classifyThrown, errorCopy } from "@/lib/chain/errors";
import { hexToBytes } from "@/lib/util/hex";

/** The on-wire `RoleKind` discriminant (SCALE-pinned: 0=Spo, 1=DRep, 2=Committee). PAPI decodes a
 *  fieldless enum value as `{ type: RoleKindType }` and takes an arg as `Enum(RoleKindType)`. */
export type RoleKindType = "Spo" | "DRep" | "Committee";

/** One entry from the observer-written `ObservedRoles` set: a currently-live role + its display id (the
 *  resolved 28-byte poolID for SPO; the drepID / hot credential for dRep / CC), as 0x-hex. */
export interface ObservedRoleView {
  kind: RoleKindType;
  /** 0x-prefixed 28-byte display id (poolID for SPO). */
  id: string;
}

/** Outcome of submitting a feeless role claim on-chain. */
export interface RoleClaimResult {
  ok: boolean;
  /** the account the verified proof bound the role to (from `RoleClaimed`). */
  who?: Ss58;
  /** the claimed role (from `RoleClaimed`). */
  role?: RoleKindType;
  /** the 28-byte claimed credential (0x-hex, from `RoleClaimed`). */
  credentialHex?: string;
  error?: string;
}

/** Build the `cardano-roles.claim_role_signed` tx (the call data; submitted bare/unsigned). */
function buildClaimRoleTx(api: CognoApi, coseSign1Hex: string, coseKeyHex: string) {
  // PAPI v2: the `BoundedVec<u8, N>` args take a raw Uint8Array (same as the cogno-gate binds).
  return api.tx.CardanoRoles.claim_role_signed({
    cose_sign1: hexToBytes(coseSign1Hex),
    cose_key: hexToBytes(coseKeyHex),
  });
}

/**
 * Submit a CIP-8 role self-proof FEELESSLY, as a BARE (unsigned) extrinsic via
 * `cardano-roles.claim_role_signed`. Mirrors {@link import("./identity").submitLinkStakeFeeless}: the
 * offline role proof is the authorization, so there is no fee / no signing account. The role comes from
 * the signed payload's `role=` field, not a call arg. The runtime binds the proven credential 1:1 to the
 * account the proof commits (which MUST already be payment-bound). `client.submit` resolves on
 * FINALIZATION. Returns the `(account, role, credential)` from the `RoleClaimed` event.
 */
export async function submitClaimRoleFeeless(
  client: PolkadotClient,
  api: CognoApi,
  coseSign1Hex: string,
  coseKeyHex: string,
): Promise<RoleClaimResult> {
  try {
    const bareTx = await buildClaimRoleTx(api, coseSign1Hex, coseKeyHex).getBareTx();
    const res = await client.submit(bareTx);
    if (!res.ok) {
      return { ok: false, error: errorCopy(classifyDispatchError(res.dispatchError)) };
    }
    // PAPI v2: the event's `credential` ([u8;28]) decodes to a 0x-hex string; `role` to `{ type }`.
    const ev = (
      res.events as Array<{
        type: string;
        value?: { type: string; value?: { who?: Ss58; role?: { type: RoleKindType }; credential?: string } };
      }>
    ).find((e) => e.type === "CardanoRoles" && e.value?.type === "RoleClaimed");
    return {
      ok: true,
      who: ev?.value?.value?.who,
      role: ev?.value?.value?.role?.type,
      credentialHex: ev?.value?.value?.credential,
    };
  } catch (e) {
    const err = classifyThrown(e);
    console.error("cogno: feeless claim_role_signed submission failed:", errorCopy(err), e);
    return { ok: false, error: errorCopy(err) };
  }
}

/** The 28-byte credential the account has CLAIMED for `role` (0x-hex), or undefined if it holds no claim
 *  for that role. Distinct from being observed — a claim can exist before/without a live badge. */
export async function readRoleClaim(
  api: CognoApi,
  ss58: Ss58,
  role: RoleKindType,
): Promise<string | undefined> {
  return api.query.CardanoRoles.RoleClaimOf.getValue(ss58, Enum(role));
}
