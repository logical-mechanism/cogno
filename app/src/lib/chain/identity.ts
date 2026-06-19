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
    const tx = api.tx.CognoGate.link_identity_signed({
      cose_sign1: Binary.fromBytes(hexToBytes(coseSign1Hex)),
      cose_key: Binary.fromBytes(hexToBytes(coseKeyHex)),
      thread_pointer: threadHex ? Binary.fromBytes(hexToBytes(threadHex)) : undefined,
    });
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
