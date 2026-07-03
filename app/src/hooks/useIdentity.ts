"use client";

// useIdentity — the D1 (trustless) bind state for the active posting key: is it bound (⇒ may post), and
// the action that produces a CIP-8 self-proof with a Cardano wallet and submits it DIRECTLY on-chain as a
// FEELESS, BARE (unsigned) extrinsic via `cognoGate.link_identity_signed` (the runtime verifies the
// signature — no trusted follower, no fee, no funded relay), then confirms it with the on-chain AccountOf
// readback. The wallet sign, the on-chain submit, and the readback are distinct steps, surfaced as one
// `binding` flag here but narrated by the UI.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PolkadotClient } from "polkadot-api";
import type { CognoApi, PostingSigner } from "@/lib/types";
import {
  getGenesisHex,
  isAccountBound,
  readAccountOf,
  submitLinkIdentityFeeless,
  submitLinkStakeFeeless,
} from "@/lib/chain/identity";
import { produceBindProof, produceBindProofStake } from "@/lib/cardano/cip8";

/** The phase of an in-flight identity bind, so the UI can narrate the background steps instead of
 *  showing one opaque "Registering…" spinner. `client.submit` resolves on FINALIZATION, so the
 *  `submitting` phase is a genuine multi-second wait — the one that felt "stuck". */
export type BindPhase = "idle" | "signing" | "submitting" | "confirming";

export interface UseIdentity {
  /** true = bound (may post), false = unbound, null = unknown/loading. */
  bound: boolean | null;
  /** a bind is in flight (wallet sign → feeless on-chain submit → readback). */
  binding: boolean;
  /** the phase of an in-flight bind (`idle` when not binding) — drives the step indicator. */
  bindPhase: BindPhase;
  error: string | null;
  /** the Cardano address the bind was signed from, once bound (for display). */
  boundAddress: string | null;
  bind: (walletId: string) => void;
  refresh: () => void;

  // ── Voting power (the SEPARATE stake-key bind) ───────────────────────────────────────────
  // Posting capacity comes from the 100-ADA vault deposit (see useVault/useCapacity). VOTE
  // weight is distinct: it comes from the TOTAL Cardano stake of a stake credential the user
  // proves 1:1 with a stake-key CIP-8 signature. These watch chain state live.
  /** true = a stake credential is bound (votes carry weight), false = none, null = loading. */
  stakeBound: boolean | null;
  /** the account's live voting power = total observed Cardano stake (lovelace); 0n until a committee
   *  `set_voting_power` / the enforced inherent observes it; null while loading. */
  votingPower: bigint | null;
  /** the bound 28-byte stake credential as 0x-hex, once stake-bound (for display). */
  boundStakeCredHex: string | null;
  /** a stake bind is in flight (stake-key wallet sign → feeless on-chain `link_stake_signed`). */
  stakeBinding: boolean;
  /** the phase of an in-flight stake bind (`idle` when not binding) — drives the step indicator.
   *  Uses `signing` → `submitting` only (there is no post-submit readback like the payment bind). */
  stakeBindPhase: BindPhase;
  /** error from the LAST stake-bind attempt (kept separate from the payment-bind `error`). */
  stakeError: string | null;
  /** Bind the wallet's stake key to enable stake-weighted voting. Requires the account to already
   *  be payment-bound (`bound === true`); the runtime rejects an unbound account (`NotPaymentBound`). */
  bindStake: (walletId: string) => void;
}

export function useIdentity(
  api: CognoApi | null,
  client: PolkadotClient | null,
  signer: PostingSigner,
): UseIdentity {
  const [bound, setBound] = useState<boolean | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindPhase, setBindPhase] = useState<BindPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [boundAddress, setBoundAddress] = useState<string | null>(null);

  // Stake (voting-power) bind state.
  const [stakeBound, setStakeBound] = useState<boolean | null>(null);
  const [votingPower, setVotingPower] = useState<bigint | null>(null);
  const [boundStakeCredHex, setBoundStakeCredHex] = useState<string | null>(null);
  const [stakeBinding, setStakeBinding] = useState(false);
  const [stakeBindPhase, setStakeBindPhase] = useState<BindPhase>("idle");
  const [stakeError, setStakeError] = useState<string | null>(null);

  // The posting key the last bound-read was for. On a KEY switch we must clear `bound` to null (unknown)
  // before the async re-read — otherwise the previous key's value lingers (e.g. `false` for the reverted
  // //Alice key after a disconnect), and an in-app reconnect flaps through a phantom `connected_unbound`
  // that mis-drives onboarding + "Finish setup" affordances. A mere socket (api) reconnect keeps the same
  // key, so `bound` is NOT cleared there — that would needlessly bounce a logged-in user off the wall.
  const boundKeyRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    // boundAddress describes a bind PERFORMED for the current key this session; it is not re-derivable
    // from chain state. Clear it whenever the key/chain changes (this callback re-runs on [api, ss58])
    // so a stale signing-address can't survive a wallet switch to a different — already-bound — account.
    setBoundAddress(null);
    if (boundKeyRef.current !== signer.ss58) {
      boundKeyRef.current = signer.ss58;
      setBound(null); // key changed → boundness unknown until re-read; never show the prior key's value
    }
    if (!api) {
      setBound(null);
      return;
    }
    isAccountBound(api, signer.ss58)
      .then(setBound)
      .catch(() => setBound(null));
  }, [api, signer.ss58]);

  // Re-check whenever the chain or the active posting key changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Watch the stake (voting-power) state LIVE for the active key: the bound stake credential
  // (`CognoGate.StakeCredOf`, OptionQuery) and the voting power it confers (`TalkStake.VotingPower`,
  // ValueQuery → 0n until a committee `set_voting_power` / the enforced inherent observes the stake).
  // Watched (not one-shot) because the weight lands ASYNCHRONOUSLY, a few blocks after the bind.
  useEffect(() => {
    // A stale per-attempt error must not survive a key/chain switch (this effect re-runs on [api, ss58]).
    setStakeError(null);
    if (!api) {
      setStakeBound(null);
      setVotingPower(null);
      setBoundStakeCredHex(null);
      return;
    }
    const s1 = api.query.CognoGate.StakeCredOf.watchValue(signer.ss58, "best").subscribe(
      (cred) => {
        setStakeBound(cred !== undefined);
        setBoundStakeCredHex(cred ? cred.asHex() : null);
      },
      () => setStakeBound(null),
    );
    const s2 = api.query.TalkStake.VotingPower.watchValue(signer.ss58, "best").subscribe(
      (w) => setVotingPower((w as bigint) ?? 0n),
      () => setVotingPower(null),
    );
    return () => {
      s1.unsubscribe();
      s2.unsubscribe();
    };
  }, [api, signer.ss58]);

  const bind = useCallback(
    (walletId: string) => {
      if (!api || !client || binding) return;
      setBinding(true);
      setBindPhase("signing");
      setError(null);
      void (async () => {
        try {
          // (1) the live genesis the proof must commit (anti-cross-chain), read straight from the node.
          const genesisHex = await getGenesisHex(api);
          // (2) the wallet signs the pinned payload ONCE (built in-browser; no trusted follower).
          const proof = await produceBindProof({ walletId, sr25519PubkeyHex: signer.publicKeyHex, genesisHex });
          if (!proof.ok || !proof.coseSign1 || !proof.coseKey) {
            throw new Error(proof.error || "could not produce the CIP-8 bind proof");
          }
          // (3) submit the self-proof on-chain, FEELESSLY, as a bare/unsigned extrinsic. No fee, no
          //     funded relay — the CIP-8 proof is the authorization and the runtime is the sole verifier,
          //     so even a brand-new zero-balance derived account binds itself with no sponsor.
          //     `client.submit` resolves on FINALIZATION → this is the multi-second wait, so the UI
          //     shows a distinct "submitting" step rather than leaving the sign prompt up.
          setBindPhase("submitting");
          const res = await submitLinkIdentityFeeless(client, api, proof.coseSign1, proof.coseKey);
          if (!res.ok) {
            throw new Error(res.error || "the on-chain bind was rejected");
          }
          // (4) AccountOf readback (L5 §5.7): confirm the verified identity resolves to MY account, the
          //     belt-and-suspenders 1:1 check (the proof already commits my account cryptographically).
          setBindPhase("confirming");
          if (res.identityHash) {
            const who = await readAccountOf(api, res.identityHash).catch(() => undefined);
            if (who && who !== signer.ss58) {
              throw new Error("the bound identity resolved to a different account — refusing to claim it");
            }
          }
          const nowBound = await isAccountBound(api, signer.ss58).catch(() => false);
          if (!nowBound) {
            // eslint-disable-next-line no-console
            console.error(
              `cogno: bind submitted but the chain shows ${signer.ss58.slice(0, 8)}… unbound (wallet "${walletId}", identity ${res.identityHash?.slice(0, 10)}…)`,
            );
            throw new Error("bind submitted, but the chain still shows your account unbound");
          }
          setBound(true);
          setBoundAddress(proof.signingAddress ?? null);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`cogno: bind failed for ${signer.ss58.slice(0, 8)}… (wallet "${walletId}"):`, e instanceof Error ? e.message : String(e));
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBinding(false);
          setBindPhase("idle");
        }
      })();
    },
    [api, client, binding, signer],
  );

  const bindStake = useCallback(
    (walletId: string) => {
      if (!api || !client || stakeBinding) return;
      // The runtime requires the account to be payment-bound first (NotPaymentBound). Pre-check for a
      // clear message; the on-chain rule (pool + dispatch) is the authority either way.
      if (bound !== true) {
        setStakeError("register your posting key first — voting power needs an account that can already post");
        return;
      }
      setStakeBinding(true);
      setStakeBindPhase("signing");
      setStakeError(null);
      void (async () => {
        try {
          // (1) the live genesis the proof must commit (anti-cross-chain), read straight from the node.
          const genesisHex = await getGenesisHex(api);
          // (2) the wallet signs the pinned payload ONCE WITH ITS STAKE KEY (over the reward address).
          //     Requires a wallet that signs over a reward address (Eternl/Lace); the UI gates this.
          const proof = await produceBindProofStake({ walletId, sr25519PubkeyHex: signer.publicKeyHex, genesisHex });
          if (!proof.ok || !proof.coseSign1 || !proof.coseKey) {
            throw new Error(proof.error || "could not produce the CIP-8 stake proof");
          }
          // (3) submit the stake self-proof FEELESSLY, as a bare/unsigned extrinsic — same as the payment
          //     bind, no fee and no funded relay. The runtime requires the account already be payment-bound
          //     (NotPaymentBound), enforced at the pool too, so we submit this only once `bound === true`.
          //     `client.submit` resolves on finalization, so the submit is the multi-second wait.
          setStakeBindPhase("submitting");
          const res = await submitLinkStakeFeeless(client, api, proof.coseSign1, proof.coseKey);
          if (!res.ok) {
            throw new Error(res.error || "the on-chain stake bind was rejected");
          }
          // The live watch (above) flips stakeBound and surfaces the voting power once observed; seed
          // boundStakeCredHex from the LOCALLY-PROVEN credential (what the runtime binds) so the UI
          // confirms it immediately. Fall back to the event-derived value only if the proof lacks it.
          setBoundStakeCredHex(
            proof.stakeCredentialHex ? `0x${proof.stakeCredentialHex}` : (res.stakeCredHex ?? null),
          );
          setStakeBound(true);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`cogno: stake bind failed for ${signer.ss58.slice(0, 8)}… (wallet "${walletId}"):`, e instanceof Error ? e.message : String(e));
          setStakeError(e instanceof Error ? e.message : String(e));
        } finally {
          setStakeBinding(false);
          setStakeBindPhase("idle");
        }
      })();
    },
    [api, client, stakeBinding, bound, signer],
  );

  return {
    bound,
    binding,
    bindPhase,
    error,
    boundAddress,
    bind,
    refresh,
    stakeBound,
    votingPower,
    boundStakeCredHex,
    stakeBinding,
    stakeBindPhase,
    stakeError,
    bindStake,
  };
}
