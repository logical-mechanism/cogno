// CardanoRoles reads + writes (verifiable role tags — SPO first). The claim mirrors the CIP-8 binds in
// lib/chain/identity.ts: `cardano-roles.claim_role_signed` is FEELESS + UNSIGNED (the offline
// `cardano-signer` role proof IS the authorization — the runtime re-verifies it at pool admission and on
// inclusion via `pallet_cardano_roles::validate_unsigned`), so there is no fee payer and no signing
// account. It is built bare with `tx.getBareTx()` and broadcast with the low-level `client.submit`,
// exactly like `submitLinkStakeFeeless` — which is what lets a zero-balance derived posting account submit
// it. `unclaim_role` is the one SIGNED write here (self-service release of a claim), but it is
// `#[pallet::feeless_if]` when the caller holds the claim, so the SAME zero-balance account that claimed
// can also release it. (The observer additionally clears a tag the moment the pool retires / the claim is
// committee-revoked, so removal never depends solely on the user acting.)
//
// The badge reads `ObservedRoles` (the observer-written, liveness-gated map) — NOT the raw claim — so a
// tag only ever shows while the credential is a currently-live Cardano role. The claim map (`RoleClaimOf`)
// is read only to narrate the Settings wizard ("claimed — awaiting the observer").

import type { PolkadotClient } from "polkadot-api";
import { Enum } from "polkadot-api";
import type { CognoApi, Ss58, PostingSigner } from "@/lib/types";
import { classifyDispatchError, classifyThrown, errorCopy } from "@/lib/chain/errors";
import { hexToBytes } from "@/lib/util/hex";

/** The on-wire `RoleKind` discriminant (SCALE-pinned: 0=Spo, 1=DRep, 2=Committee). PAPI decodes a
 *  fieldless enum value as `{ type: RoleKindType }` and takes an arg as `Enum(RoleKindType)`. */
export type RoleKindType = "Spo" | "DRep" | "Committee";

/** One entry from the observer-written `ObservedRoles` set: a currently-live role + its display id (an
 *  ownership-derived SPO carries the 28-byte poolID; a Calidus-derived SPO carries the BLANK id — see
 *  {@link isBlankRoleId}; a dRep the drepID), as 0x-hex. */
export interface ObservedRoleView {
  kind: RoleKindType;
  /** 0x-prefixed 28-byte display id (poolID for an ownership SPO; all-zero blank for a Calidus SPO). */
  id: string;
}

/**
 * True when a role's display id is the all-zero BLANK marker (the node reduction's `BLANK_ROLE_ID`). A
 * Calidus SPO registration attests no specific pool (any pool's cold key can declare any Calidus key — the
 * key never counter-signs), so a Calidus-derived SPO badge names NO pool and renders as a generic
 * "verified SPO": no pool ticker, no cexplorer link. An ownership SPO carries a real poolID
 * (`blake2b_224(cold pubkey)`, never all-zero) and is unaffected. This is what closes the cross-pool
 * impersonation — a pool operator cannot attribute their pool to an account by declaring its Calidus key.
 */
export function isBlankRoleId(idHex: string): boolean {
  const h = idHex.replace(/^0x/i, "");
  return h.length > 0 && /^0+$/.test(h);
}

/** Kind index (SCALE `#[codec(index)]`) → RoleKindType, in declaration order. */
const ROLE_KIND_BY_INDEX: readonly RoleKindType[] = ["Spo", "DRep", "Committee"];

/**
 * Map the node-served primitive role pairs — `[kind_index, id]`, how PAPI decodes the `Vec<(u8, [u8;28])>`
 * the runtime folds into `ProfileView.observed_roles` / `EnrichedPost.author_roles` — to `ObservedRoleView[]`.
 * Tolerant of the id arriving as a 0x-hex string or a `FixedSizeBinary`. Unknown kind indices are skipped.
 */
export function mapObservedRolePairs(
  pairs: ReadonlyArray<readonly [number, unknown]> | undefined | null,
): ObservedRoleView[] {
  if (!pairs) return [];
  const out: ObservedRoleView[] = [];
  for (const [ix, rawId] of pairs) {
    const kind = ROLE_KIND_BY_INDEX[ix];
    if (!kind) continue;
    const id =
      typeof rawId === "string"
        ? rawId
        : typeof (rawId as { asHex?: () => string } | null)?.asHex === "function"
          ? (rawId as { asHex: () => string }).asHex()
          : undefined;
    if (id) out.push({ kind, id });
  }
  return out;
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

/**
 * Self-service release of a role claim — the one SIGNED write here. Signed by the posting account (the
 * runtime `ensure_signed`s and removes both claim maps; the observer drops the badge on its next
 * observation). It is `#[pallet::feeless_if]` when the caller holds the claim, so a zero-balance account
 * can release its own role. Does NOT tombstone (that is the committee's `revoke_role`). Uses PAPI's
 * promise-shaped `signAndSubmit` (a one-off, so the default nonce is fine) and classifies the result like
 * the feeless submits. Returns finalized ok / a classified error message.
 */
export async function submitUnclaimRole(
  api: CognoApi,
  signer: PostingSigner,
  role: RoleKindType,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await api.tx.CardanoRoles.unclaim_role({ role: Enum(role) }).signAndSubmit(signer.signer);
    if (!res.ok) {
      return { ok: false, error: errorCopy(classifyDispatchError(res.dispatchError)) };
    }
    return { ok: true };
  } catch (e) {
    const err = classifyThrown(e);
    console.error("cogno: unclaim_role submission failed:", errorCopy(err), e);
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
