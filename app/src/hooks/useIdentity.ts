"use client";

// useIdentity — the D1 (trustless) bind state for the active posting key: is it bound (⇒ may post), and
// the action that produces a CIP-8 self-proof with a Cardano wallet and submits it DIRECTLY on-chain via
// `cognoGate.link_identity_signed` (the runtime verifies the signature — no trusted follower), then
// confirms it with the on-chain AccountOf readback. The wallet sign, the on-chain submit, and the
// readback are distinct steps, surfaced as one `binding` flag here but narrated by the UI.

import { useCallback, useEffect, useState } from "react";
import type { CognoApi, PostingSigner } from "@/lib/types";
import {
  getGenesisHex,
  isAccountBound,
  readAccountOf,
  submitBindSponsored,
  submitStakeBindSponsored,
  type BindVia,
} from "@/lib/chain/identity";
import { getBindRelayUrl } from "@/lib/config/endpoints";
import { produceBindProof, produceBindProofStake } from "@/lib/cardano/cip8";

export interface UseIdentity {
  /** true = bound (may post), false = unbound, null = unknown/loading. */
  bound: boolean | null;
  /** a bind is in flight (wallet sign → on-chain submit/relay → readback). */
  binding: boolean;
  error: string | null;
  /** the Cardano address the bind was signed from, once bound (for display). */
  boundAddress: string | null;
  /** how the just-completed bind was submitted: "self" (paid own fee) or "relay" (sponsored). null = unknown. */
  boundVia: BindVia | null;
  bind: (walletId: string) => void;
  refresh: () => void;

  // ── Voting power (spec 115 — the SEPARATE stake-key bind) ───────────────────────────────
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
  /** how the just-completed stake bind was submitted: "self" (paid own fee) or "relay" (sponsored). null = unknown. */
  stakeBoundVia: BindVia | null;
  /** a stake bind is in flight (stake-key wallet sign → on-chain `link_stake_signed`). */
  stakeBinding: boolean;
  /** error from the LAST stake-bind attempt (kept separate from the payment-bind `error`). */
  stakeError: string | null;
  /** Bind the wallet's stake key to enable stake-weighted voting. Requires the account to already
   *  be payment-bound (`bound === true`); the runtime rejects an unbound account (`NotPaymentBound`). */
  bindStake: (walletId: string) => void;
}

export function useIdentity(api: CognoApi | null, signer: PostingSigner): UseIdentity {
  const [bound, setBound] = useState<boolean | null>(null);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boundAddress, setBoundAddress] = useState<string | null>(null);
  const [boundVia, setBoundVia] = useState<BindVia | null>(null);

  // Stake (voting-power) bind state.
  const [stakeBound, setStakeBound] = useState<boolean | null>(null);
  const [votingPower, setVotingPower] = useState<bigint | null>(null);
  const [boundStakeCredHex, setBoundStakeCredHex] = useState<string | null>(null);
  const [stakeBoundVia, setStakeBoundVia] = useState<BindVia | null>(null);
  const [stakeBinding, setStakeBinding] = useState(false);
  const [stakeError, setStakeError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    // boundVia/boundAddress describe a bind PERFORMED for the current key this session; they are not
    // re-derivable from chain state. Clear them whenever the key/chain changes (this callback re-runs on
    // [api, signer.ss58]) so the "fee sponsored by the relay" sub-label can't go stale after a wallet
    // switch to a different — already-bound — account.
    setBoundVia(null);
    setBoundAddress(null);
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
    // A stale per-attempt error / via-label must not survive a key/chain switch (this effect re-runs
    // on [api, signer.ss58]; stakeBoundVia describes a bind PERFORMED for the current key this session).
    setStakeError(null);
    setStakeBoundVia(null);
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
      if (!api || binding) return;
      setBinding(true);
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
          // (3) submit the self-proof on-chain. Balance-aware (D1 bind-funding): if MY posting key can
          //     pay its own fee, self-submit (fully trustless); otherwise POST the proof to the funded
          //     Sponsored-Bind Relay, which pays the fee (a LIVENESS party — it can't forge the binding,
          //     the runtime re-verifies). A fresh derived account (balance 0) always takes the relay.
          const res = await submitBindSponsored(api, signer, proof.coseSign1, proof.coseKey, getBindRelayUrl());
          if (!res.ok) {
            throw new Error(res.error || "the on-chain bind was rejected");
          }
          // (4) AccountOf readback (L5 §5.7): confirm the verified identity resolves to MY account, the
          //     belt-and-suspenders 1:1 check (the proof already commits my account cryptographically).
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
          setBoundVia(res.via ?? null);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`cogno: bind failed for ${signer.ss58.slice(0, 8)}… (wallet "${walletId}"):`, e instanceof Error ? e.message : String(e));
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBinding(false);
        }
      })();
    },
    [api, binding, signer],
  );

  const bindStake = useCallback(
    (walletId: string) => {
      if (!api || stakeBinding) return;
      // The runtime requires the account to be payment-bound first (NotPaymentBound). Pre-check for a
      // clear message; the on-chain rule is the authority either way.
      if (bound !== true) {
        setStakeError("register your posting key first — voting power needs an account that can already post");
        return;
      }
      setStakeBinding(true);
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
          // (3) submit the stake self-proof. Balance-aware (like the payment bind): if MY posting key
          //     can pay its own fee, self-submit (fully trustless); otherwise POST the proof to the
          //     Sponsored-Bind Relay's /bind-stake, which pays the fee (a LIVENESS party — it can't
          //     forge the binding, the runtime re-verifies). A fresh derived account (balance 0) takes
          //     the relay. The runtime requires the account already be payment-bound (NotPaymentBound).
          const res = await submitStakeBindSponsored(api, signer, proof.coseSign1, proof.coseKey, getBindRelayUrl());
          if (!res.ok) {
            throw new Error(res.error || "the on-chain stake bind was rejected");
          }
          // The live watch (above) flips stakeBound and surfaces the voting power once observed; seed
          // boundStakeCredHex from the LOCALLY-PROVEN credential (what the runtime binds) so the UI
          // confirms it immediately — never trust the relay's echoed stake_cred for display (a buggy
          // relay could return any hex; the proof value can't be relay-influenced). Fall back to the
          // event-derived value only if the proof somehow lacks it.
          setBoundStakeCredHex(
            proof.stakeCredentialHex ? `0x${proof.stakeCredentialHex}` : (res.stakeCredHex ?? null),
          );
          // Surface how the fee was paid so the UI can honestly label a relay-sponsored bind (parity
          // with the identity bind's boundVia). A zero-balance derived account always takes "relay".
          setStakeBoundVia(res.via ?? null);
          setStakeBound(true);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`cogno: stake bind failed for ${signer.ss58.slice(0, 8)}… (wallet "${walletId}"):`, e instanceof Error ? e.message : String(e));
          setStakeError(e instanceof Error ? e.message : String(e));
        } finally {
          setStakeBinding(false);
        }
      })();
    },
    [api, stakeBinding, bound, signer],
  );

  return {
    bound,
    binding,
    error,
    boundAddress,
    boundVia,
    bind,
    refresh,
    stakeBound,
    votingPower,
    boundStakeCredHex,
    stakeBoundVia,
    stakeBinding,
    stakeError,
    bindStake,
  };
}
