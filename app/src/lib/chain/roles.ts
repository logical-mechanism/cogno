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

/** One entry from the observer-written `ObservedRoles` set: a currently-live role + its display id. Both
 *  SPO sources — ownership AND Calidus — carry the 28-byte poolID of the live pool they name; a dRep the
 *  drepID; a CC the hot credential. As 0x-hex. An mSPO (one operator, several pools declaring one Calidus
 *  key) holds SEVERAL SPO entries, one per pool. */
export interface ObservedRoleView {
  kind: RoleKindType;
  /** 0x-prefixed 28-byte display id (a poolID for an SPO — ownership or Calidus; the drepID for a dRep). */
  id: string;
  /**
   * The governance-poll CHAMBER WEIGHT this role votes with, in lovelace — a pool's total delegated
   * block-production stake, or a dRep's total delegated voting stake, at the observer's as-of epoch.
   *
   * `null` IS NOT ZERO, and conflating the two is the whole reason this is nullable. `null` means the read
   * that produced this entry does not carry a weight at all: {@link mapObservedRolePairs} decodes the
   * node-served `Vec<(u8, [u8;28])>` folded into `ProfileView.observed_roles` / `EnrichedPost.author_roles`,
   * which is kind + id only. `0n` is a FACT from the ledger — the credential is observed and currently
   * carries no delegated stake. Only a direct `CardanoRoles.ObservedRoles` storage read supplies a number.
   *
   * A `0n` has two ordinary causes and a surface must not read it as "not a real role": a genuinely
   * undelegated pool/dRep, and a NEWLY delegated one whose stake is not in the as-of epoch snapshot yet
   * (chamber stake is read at `tip − StakeEpochLookback`, and Cardano only makes a new dRep's voting power
   * effective the epoch after its delegation cert, so a fresh dRep reads 0 here for up to two epochs).
   */
  weight: bigint | null;
}

/**
 * Where the viewer stands on ONE role kind, with "not resolved yet" kept apart from "confirmed none".
 *
 * `useRoles` publishes `observed` as `ObservedRoleView[] | null`, where `null` means the live
 * `ObservedRoles` watch has not answered. RolesSection flattened that with `(roles.observed ?? [])` and
 * then branched on the first entry, so a VERIFIED SPO or dRep was shown the full "Enter your SPO
 * verification key" wizard on the ordinary loading path of every Settings open — and permanently
 * whenever the subscription errored, because the error callback wrote `[]` (a confirmed negative) where
 * `Providers.tsx` writes `null` for the same read.
 *
 * Taking `null` as an input and returning a THREE-state answer is what makes the collapse
 * unrepresentable: there is no `?? []` to write, because the caller cannot index this.
 */
export type RoleStatus = "loading" | "none" | "verified";

export function roleStatusOf(
  observed: readonly ObservedRoleView[] | null,
  kind: RoleKindType,
): RoleStatus {
  if (observed === null) return "loading";
  return observed.some((r) => r.kind === kind) ? "verified" : "none";
}

/**
 * True when a role's display id is the all-zero id — a DEFENSIVE guard, no longer produced on any live
 * path. Every observed SPO now names a real poolID (`blake2b_224(cold pubkey)`, never all-zero): the
 * ownership path always did, and a confirmed Calidus SPO now names the specific live pool whose cold key
 * authorized its key (an mSPO yields one per pool). This guard remains only so a hypothetical all-zero id
 * renders as a plain "verified SPO" (no ticker, no cexplorer link) rather than a bogus `pool1…` link.
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
 *
 * `weight` is `null` on every entry, and that is the honest answer rather than a gap: the folded pair
 * carries kind + id and no stake, so claiming `0n` here would state as fact ("this role has no delegated
 * stake") something this read never looked at. A surface that wants the number reads
 * `CardanoRoles.ObservedRoles` directly. See {@link ObservedRoleView.weight}.
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
    if (id) out.push({ kind, id, weight: null });
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
