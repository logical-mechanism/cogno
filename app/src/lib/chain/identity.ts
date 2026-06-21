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

/** Outcome of submitting a CIP-8 STAKE self-proof on-chain (the voting-power bind). */
export interface StakeLinkResult {
  ok: boolean;
  /** the 28-byte stake credential the runtime verified + bound (0x-hex), from the `StakeLinked` event. */
  stakeCredHex?: string;
  error?: string;
}

/** Build the `cognoGate.link_stake_signed` tx — takes ONLY the two COSE blobs (NO thread pointer). */
function buildLinkStakeTx(api: CognoApi, coseSign1Hex: string, coseKeyHex: string) {
  return api.tx.CognoGate.link_stake_signed({
    cose_sign1: Binary.fromBytes(hexToBytes(coseSign1Hex)),
    cose_key: Binary.fromBytes(hexToBytes(coseKeyHex)),
  });
}

/**
 * Submit a CIP-8 STAKE-key self-proof via `cognoGate.link_stake_signed` (spec 115 — voting power),
 * signed (and fee-paid) by the user's posting account. The runtime verifies the stake-key signature,
 * parses the proven 28-byte stake credential, and binds it 1:1 to the account — its votes/polls then
 * weigh by the total Cardano stake of that credential. The account MUST already be payment-bound
 * (`link_identity_signed`); the runtime rejects an unbound account with `NotPaymentBound`. This is the
 * SELF-PAY leg of {@link submitStakeBindSponsored} — used when the posting account can cover its own
 * fee; a zero-balance derived account routes through the Sponsored-Bind Relay instead. Resolves when
 * included; returns the bound stake credential from the `StakeLinked` event.
 */
export async function submitLinkStakeSigned(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
): Promise<StakeLinkResult> {
  try {
    const tx = buildLinkStakeTx(api, coseSign1Hex, coseKeyHex);
    const res = await tx.signAndSubmit(signer.signer);
    if (!res.ok) {
      const dispatchError = (res as { dispatchError?: { type: string; value: unknown } }).dispatchError;
      return { ok: false, error: stringifyDispatchError(dispatchError) };
    }
    const ev = (res.events as Array<{ type: string; value?: { type: string; value?: { stake_cred?: { asHex: () => string } } } }>)
      .find((e) => e.type === "CognoGate" && e.value?.type === "StakeLinked");
    return { ok: true, stakeCredHex: ev?.value?.value?.stake_cred?.asHex() };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("cogno: link_stake_signed submission failed:", stringifyError(e), e);
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
 * Whether `ss58` can pay `estimateFee()`'s fee from its free balance AND stay above the existential
 * deposit. Shared by {@link canSelfPayBind} (identity) and {@link canSelfPayStakeBind} (voting power).
 * A fresh sign-to-derived account holds 0 ⇒ false (route through the relay); a *barely*-funded account
 * (free ≥ fee but the fee would dust it below the ED) also routes to the relay rather than risking a
 * self-submit the runtime rejects. Best-effort: any read or fee-estimate failure ⇒ false (prefer the
 * relay over a doomed self-submit); an absent ED constant ⇒ treat ED as 0.
 */
async function canSelfPayFee(api: CognoApi, ss58: Ss58, estimateFee: () => Promise<bigint>): Promise<boolean> {
  try {
    const acct = await api.query.System.Account.getValue(ss58);
    const free = acct?.data?.free ?? 0n;
    if (free <= 0n) return false;
    const fee = await estimateFee();
    let ed = 0n;
    try {
      ed = await api.constants.Balances.ExistentialDeposit();
    } catch {
      ed = 0n; // ED constant unavailable — fall back to the bare fee comparison
    }
    return free >= fee + ed;
  } catch {
    return false;
  }
}

/** Whether the posting account can self-pay the `link_identity_signed` fee (else route to the relay). */
export async function canSelfPayBind(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
  threadHex?: string,
): Promise<boolean> {
  return canSelfPayFee(api, signer.ss58, () =>
    buildLinkIdentityTx(api, coseSign1Hex, coseKeyHex, threadHex).getEstimatedFees(signer.ss58),
  );
}

/** Whether the posting account can self-pay the `link_stake_signed` fee (else route to the relay). */
export async function canSelfPayStakeBind(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
): Promise<boolean> {
  return canSelfPayFee(api, signer.ss58, () =>
    buildLinkStakeTx(api, coseSign1Hex, coseKeyHex).getEstimatedFees(signer.ss58),
  );
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

/** A stake (voting-power) bind result that records whether the fee was self-paid or relay-sponsored. */
export interface SponsoredStakeBindResult extends StakeLinkResult {
  /** "self" = the posting account paid its own fee (fully trustless); "relay" = a funded relay paid it. */
  via?: BindVia;
}

/**
 * POST a signed CIP-8 STAKE proof to the Sponsored-Bind Relay's `/bind-stake` route. The relay pays the
 * fee and submits `cognoGate.link_stake_signed` for the user — a LIVENESS party only: the proof commits
 * {account, stake_credential, genesis} and the RUNTIME re-verifies it, so the relay can never forge or
 * retarget the voting-power binding (it can only withhold/censor). Returns the bound 28-byte stake
 * credential (0x-hex) the relay reports. `fetchImpl` is injectable for testing.
 */
export async function submitStakeBindViaRelay(
  relayUrl: string,
  coseSign1Hex: string,
  coseKeyHex: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StakeLinkResult> {
  try {
    const url = relayUrl.replace(/\/+$/, "") + "/bind-stake";
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cose_sign1: coseSign1Hex, cose_key: coseKeyHex }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; stake_cred?: string; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `the sponsored-bind relay responded ${res.status}` };
    }
    // Normalize to 0x-hex so the bound credential displays identically whether self- or relay-submitted.
    const cred = data.stake_cred;
    return { ok: true, stakeCredHex: cred ? (cred.startsWith("0x") ? cred : `0x${cred}`) : undefined };
  } catch (e) {
    return { ok: false, error: `could not reach the sponsored-bind relay: ${stringifyError(e)}` };
  }
}

/**
 * Balance-aware STAKE (voting-power) bind, mirroring {@link submitBindSponsored}. If the posting account
 * can pay its own `link_stake_signed` fee, self-submit (fully trustless — no liveness party); otherwise
 * POST the signed proof to the Sponsored-Bind Relay's `/bind-stake`, which pays the fee. A derived
 * account that posts feelessly and bound its identity through the relay holds 0 balance, so it takes the
 * relay path here too. `via` is surfaced so the UI can label which path was taken honestly. The account
 * must already be payment-bound — the runtime rejects an unbound account with `NotPaymentBound`.
 */
export async function submitStakeBindSponsored(
  api: CognoApi,
  signer: PostingSigner,
  coseSign1Hex: string,
  coseKeyHex: string,
  relayUrl: string,
): Promise<SponsoredStakeBindResult> {
  if (await canSelfPayStakeBind(api, signer, coseSign1Hex, coseKeyHex)) {
    const res = await submitLinkStakeSigned(api, signer, coseSign1Hex, coseKeyHex);
    return { ...res, via: "self" };
  }
  if (!relayUrl) {
    return {
      ok: false,
      error: "your posting account has no balance to pay the stake-bind fee, and no sponsored-bind relay is configured",
    };
  }
  const res = await submitStakeBindViaRelay(relayUrl, coseSign1Hex, coseKeyHex);
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
