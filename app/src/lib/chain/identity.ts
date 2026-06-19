// CognoGate reads + the trustless bind WRITE (D1). Reads: is the active posting account bound (⇒
// allowed to post), and the AccountOf readback that confirms a fresh bind landed on-chain (L5 §5.7).
// Write: submit the user's CIP-8 self-proof via `cognoGate.link_identity_signed` — the runtime verifies
// the wallet signature, so there is no trusted follower in the bind path. Pure PAPI.

import { Binary, FixedSizeBinary } from "polkadot-api";
import type { CognoApi, PostingSigner, Ss58 } from "@/lib/types";
import { stringifyDispatchError, stringifyError } from "@/lib/chain/post";

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * THIS chain's genesis (block-0) hash as lowercase hex, no 0x — exactly what the on-chain verifier
 * compares the signed payload's `genesis` against (`frame_system::BlockHash[0]`). The CIP-8 bind payload
 * must commit this, so a proof for another chain is rejected (anti-cross-chain).
 */
export async function getGenesisHex(api: CognoApi): Promise<string> {
  const h = await api.query.System.BlockHash.getValue(0);
  return h.asHex().replace(/^0x/, "");
}

/** Outcome of submitting a CIP-8 self-proof on-chain. */
export interface SignedBindResult {
  ok: boolean;
  /** the on-chain identity (beacon-name hash) the verifier computed, from the IdentityLinked event. */
  identityHash?: string;
  error?: string;
}

/** Build the `cognoGate.link_identity_signed` tx (shared by the self-submit, fee-estimate, and relay paths). */
function buildLinkIdentityTx(api: CognoApi, coseSign1Hex: string, coseKeyHex: string, threadHex?: string) {
  return api.tx.CognoGate.link_identity_signed({
    cose_sign1: Binary.fromBytes(hexToBytes(coseSign1Hex)),
    cose_key: Binary.fromBytes(hexToBytes(coseKeyHex)),
    thread_pointer: threadHex ? Binary.fromBytes(hexToBytes(threadHex)) : undefined,
  });
}

/**
 * Submit a CIP-8 bind self-proof via `cognoGate.link_identity_signed`, signed (and fee-paid) by the
 * user's posting account — the DoS defence; the BOUND account is the one the proof cryptographically
 * commits, not the submitter. The runtime verifies the signature, checks the genesis, and writes the 1:1
 * binding. Resolves when finalized; returns the on-chain identity hash from the `IdentityLinked` event.
 */
export async function submitLinkIdentitySigned(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
  threadHex?: string,
): Promise<SignedBindResult> {
  try {
    const tx = buildLinkIdentityTx(api, coseSign1Hex, coseKeyHex, threadHex);
    const res = await tx.signAndSubmit(signer.signer);
    if (!res.ok) {
      const dispatchError = (res as { dispatchError?: { type: string; value: unknown } }).dispatchError;
      return { ok: false, error: stringifyDispatchError(dispatchError) };
    }
    const ev = (res.events as Array<{ type: string; value?: { type: string; value?: { identity?: { asHex: () => string } } } }>)
      .find((e) => e.type === "CognoGate" && e.value?.type === "IdentityLinked");
    return { ok: true, identityHash: ev?.value?.value?.identity?.asHex() };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("cogno: link_identity_signed submission failed:", stringifyError(e), e);
    return { ok: false, error: stringifyError(e) };
  }
}

/** How a sponsored bind completed — so the UI can be honest about whether a liveness party was used. */
export type BindVia = "self" | "relay";

export interface SponsoredBindResult extends SignedBindResult {
  /** "self" = the posting account paid its own fee (fully trustless); "relay" = a funded relay paid it. */
  via?: BindVia;
}

/**
 * POST a signed CIP-8 proof to a Sponsored-Bind Relay (D1 bind-funding). The relay pays the fee and
 * submits `cognoGate.link_identity_signed` for the user — a LIVENESS party only: the proof commits
 * {account, genesis} and the RUNTIME re-verifies it, so the relay can never forge or retarget the
 * binding (it can only withhold/censor). Returns the on-chain identity hash the relay reports. `fetchImpl`
 * is injectable for testing.
 */
export async function submitBindViaRelay(
  relayUrl: string,
  coseSign1Hex: string,
  coseKeyHex: string,
  threadHex?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SignedBindResult> {
  try {
    const url = relayUrl.replace(/\/+$/, "") + "/bind";
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cose_sign1: coseSign1Hex, cose_key: coseKeyHex, thread_pointer: threadHex }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; identity?: string; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `the sponsored-bind relay responded ${res.status}` };
    }
    return { ok: true, identityHash: data.identity };
  } catch (e) {
    return { ok: false, error: `could not reach the sponsored-bind relay: ${stringifyError(e)}` };
  }
}

/**
 * Whether `signer.ss58` can pay the `link_identity_signed` fee from its own free balance. A fresh
 * sign-to-derived posting account holds 0 ⇒ false (route through the relay). Best-effort: any read or
 * fee-estimate failure ⇒ false (prefer the relay over a doomed self-submit).
 */
export async function canSelfPayBind(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
  threadHex?: string,
): Promise<boolean> {
  try {
    const acct = await api.query.System.Account.getValue(signer.ss58);
    const free = acct?.data?.free ?? 0n;
    if (free <= 0n) return false;
    const fee = await buildLinkIdentityTx(api, coseSign1Hex, coseKeyHex, threadHex).getEstimatedFees(signer.ss58);
    return free >= fee;
  } catch {
    return false;
  }
}

/**
 * Balance-aware bind (D1 bind-funding). If the posting account can pay its own fee, self-submit (fully
 * trustless — no liveness party); otherwise POST the signed proof to the Sponsored-Bind Relay, which
 * pays the fee. A brand-new derived account (balance 0) always takes the relay path. `via` is surfaced
 * so the UI can label which path was taken honestly.
 */
export async function submitBindSponsored(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
  relayUrl: string,
  threadHex?: string,
): Promise<SponsoredBindResult> {
  if (await canSelfPayBind(api, signer, coseSign1Hex, coseKeyHex, threadHex)) {
    const res = await submitLinkIdentitySigned(api, signer, coseSign1Hex, coseKeyHex, threadHex);
    return { ...res, via: "self" };
  }
  if (!relayUrl) {
    return {
      ok: false,
      error: "your posting account has no balance to pay the bind fee, and no sponsored-bind relay is configured",
    };
  }
  const res = await submitBindViaRelay(relayUrl, coseSign1Hex, coseKeyHex, threadHex);
  return { ...res, via: "relay" };
}

/** Whether `ss58` has a live 1:1 identity binding (`PkhOf` present ⇒ `is_allowed` ⇒ may post). */
export async function isAccountBound(api: CognoApi, ss58: Ss58): Promise<boolean> {
  const v = await api.query.CognoGate.PkhOf.getValue(ss58);
  return v !== undefined;
}

/**
 * The AccountOf readback: which account the 32-byte identity hash is bound to. The client's
 * bind-complete check is `readAccountOf(idHash) === my ss58` — the only client-side defense
 * against a follower binding the wrong key (the committed payload PREVENTS it; this DETECTS it).
 */
export async function readAccountOf(api: CognoApi, idHashHex: string): Promise<Ss58 | undefined> {
  return api.query.CognoGate.AccountOf.getValue(FixedSizeBinary.fromBytes(hexToBytes(idHashHex)));
}
