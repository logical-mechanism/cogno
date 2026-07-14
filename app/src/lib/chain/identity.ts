// CognoGate reads + the trustless bind WRITE (D1). Reads: is the active posting account bound (⇒
// allowed to post), and the AccountOf readback that confirms a fresh bind landed on-chain.
// Write: submit the user's CIP-8 self-proof via `cognoGate.link_identity_signed` / `link_stake_signed`.
//
// The binds are FEELESS and UNSIGNED (spec 116): the CIP-8 proof IS the authorization (the runtime
// verifies it at pool admission AND dispatch — `pallet_cogno_gate::validate_unsigned`), so there is no
// fee payer and no signing account. A brand-new sign-to-derived posting account — zero balance, zero
// provider references — therefore completes its FIRST on-chain action (the bind) with NO funded sponsor.
// This is why the old Sponsored-Bind Relay is gone: nobody needs to pay for the bind. The bound account
// is the one the proof cryptographically commits, so no one can bind a victim's key. Pure PAPI: the bare
// (unsigned) extrinsic is built with `tx.getBareTx()` and broadcast with the low-level `client.submit`.

import type { PolkadotClient, SizedHex } from "polkadot-api";
import type { CognoApi, Ss58 } from "@/lib/types";
import { classifyDispatchError, classifyThrown, errorCopy } from "@/lib/chain/errors";
import { hexToBytes } from "@/lib/util/hex";

/**
 * THIS chain's genesis (block-0) hash as lowercase hex, no 0x — exactly what the on-chain verifier
 * compares the signed payload's `genesis` against (`frame_system::BlockHash[0]`). The CIP-8 bind payload
 * must commit this, so a proof for another chain is rejected (anti-cross-chain).
 */
export async function getGenesisHex(api: CognoApi): Promise<string> {
  // PAPI v2: a fixed-size `[u8;32]` decodes to a 0x-hex string (SizedHex<32>), not a Binary object.
  const h = await api.query.System.BlockHash.getValue(0);
  return h.replace(/^0x/, "");
}

/** Outcome of submitting a CIP-8 identity self-proof on-chain. */
export interface BindResult {
  ok: boolean;
  /** the on-chain identity (beacon-name hash) the verifier computed, from the IdentityLinked event. */
  identityHash?: string;
  error?: string;
}

/** Outcome of submitting a CIP-8 STAKE self-proof on-chain (the voting-power bind). */
export interface StakeLinkResult {
  ok: boolean;
  /** the 28-byte stake credential the runtime verified + bound (0x-hex), from the `StakeLinked` event. */
  stakeCredHex?: string;
  error?: string;
}

/** Build the `cognoGate.link_identity_signed` tx (the call data; submitted bare/unsigned). */
function buildLinkIdentityTx(api: CognoApi, coseSign1Hex: string, coseKeyHex: string, threadHex?: string) {
  // PAPI v2: `Vec<u8>` fields take a raw Uint8Array (`Binary.fromBytes` is gone). hexToBytes → Uint8Array.
  return api.tx.CognoGate.link_identity_signed({
    cose_sign1: hexToBytes(coseSign1Hex),
    cose_key: hexToBytes(coseKeyHex),
    thread_pointer: threadHex ? hexToBytes(threadHex) : undefined,
  });
}

/** Build the `cognoGate.link_stake_signed` tx — takes ONLY the two COSE blobs (NO thread pointer). */
function buildLinkStakeTx(api: CognoApi, coseSign1Hex: string, coseKeyHex: string) {
  return api.tx.CognoGate.link_stake_signed({
    cose_sign1: hexToBytes(coseSign1Hex),
    cose_key: hexToBytes(coseKeyHex),
  });
}

/**
 * Submit a CIP-8 identity bind self-proof FEELESSLY, as a BARE (unsigned) extrinsic. The CIP-8 proof is
 * the authorization — the runtime verifies the wallet signature at pool admission and re-verifies it on
 * inclusion (`pallet_cogno_gate::validate_unsigned`) — so there is no fee and no signing account: a
 * zero-balance sign-to-derived posting account binds with no sponsor. `tx.getBareTx()` produces the
 * unsigned extrinsic bytes; `client.submit` broadcasts and resolves when finalized. The BOUND account is
 * the one the proof commits (not any submitter). Returns the on-chain identity hash from `IdentityLinked`.
 */
export async function submitLinkIdentityFeeless(
  client: PolkadotClient,
  api: CognoApi,
  coseSign1Hex: string,
  coseKeyHex: string,
  threadHex?: string,
): Promise<BindResult> {
  try {
    const bareTx = await buildLinkIdentityTx(api, coseSign1Hex, coseKeyHex, threadHex).getBareTx();
    const res = await client.submit(bareTx);
    if (!res.ok) {
      return { ok: false, error: errorCopy(classifyDispatchError(res.dispatchError)) };
    }
    // PAPI v2: the event's `identity` ([u8;32]) decodes to a 0x-hex string, not a Binary with `.asHex()`.
    const ev = (res.events as Array<{ type: string; value?: { type: string; value?: { identity?: string } } }>)
      .find((e) => e.type === "CognoGate" && e.value?.type === "IdentityLinked");
    return { ok: true, identityHash: ev?.value?.value?.identity };
  } catch (e) {
    const err = classifyThrown(e);
    console.error("cogno: feeless link_identity_signed submission failed:", errorCopy(err), e);
    return { ok: false, error: errorCopy(err) };
  }
}

/**
 * Submit a CIP-8 STAKE-key self-proof FEELESSLY, as a BARE (unsigned) extrinsic via
 * `cognoGate.link_stake_signed` (spec 116 — voting power). Mirrors {@link submitLinkIdentityFeeless}: the
 * stake-key proof is the authorization, so no fee / no signing account is needed. The runtime parses the
 * proven 28-byte stake credential and binds it 1:1 to the account the proof commits; that account MUST
 * already be payment-bound (`link_identity_signed`) — the runtime / pool rejects an unbound account. The
 * frontend therefore submits this only after the identity bind is in a block. Returns the bound stake
 * credential from the `StakeLinked` event.
 */
export async function submitLinkStakeFeeless(
  client: PolkadotClient,
  api: CognoApi,
  coseSign1Hex: string,
  coseKeyHex: string,
): Promise<StakeLinkResult> {
  try {
    const bareTx = await buildLinkStakeTx(api, coseSign1Hex, coseKeyHex).getBareTx();
    const res = await client.submit(bareTx);
    if (!res.ok) {
      return { ok: false, error: errorCopy(classifyDispatchError(res.dispatchError)) };
    }
    // PAPI v2: the event's `stake_cred` ([u8;28]) decodes to a 0x-hex string, not a Binary with `.asHex()`.
    const ev = (res.events as Array<{ type: string; value?: { type: string; value?: { stake_cred?: string } } }>)
      .find((e) => e.type === "CognoGate" && e.value?.type === "StakeLinked");
    return { ok: true, stakeCredHex: ev?.value?.value?.stake_cred };
  } catch (e) {
    const err = classifyThrown(e);
    console.error("cogno: feeless link_stake_signed submission failed:", errorCopy(err), e);
    return { ok: false, error: errorCopy(err) };
  }
}

/** Whether `ss58` has a live 1:1 identity binding (`PkhOf` present ⇒ `is_allowed` ⇒ may post). */
export async function isAccountBound(api: CognoApi, ss58: Ss58): Promise<boolean> {
  const v = await api.query.CognoGate.PkhOf.getValue(ss58);
  return v !== undefined;
}

/** Whether `ss58` has a live stake credential bound (`StakeCredOf` present ⇒ votes carry weight). The
 *  stake-bind analogue of `isAccountBound`: the readback that confirms a fresh voting-power bind landed
 *  on-chain, so the stake bind can narrate a `confirming` step just like the payment bind. */
export async function isStakeBound(api: CognoApi, ss58: Ss58): Promise<boolean> {
  const v = await api.query.CognoGate.StakeCredOf.getValue(ss58);
  return v !== undefined;
}

/**
 * The AccountOf readback: which account the 32-byte identity hash is bound to. The client's
 * bind-complete check is `readAccountOf(idHash) === my ss58` — the only client-side defense
 * against a wrong-key bind (the committed payload PREVENTS it; this DETECTS it).
 */
export async function readAccountOf(api: CognoApi, idHashHex: string): Promise<Ss58 | undefined> {
  // PAPI v2: the `[u8;32]` storage key is supplied as a 0x-hex string (SizedHex<32>), not a FixedSizeBinary.
  return api.query.CognoGate.AccountOf.getValue(idHashHex as SizedHex<32>);
}
