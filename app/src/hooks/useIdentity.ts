"use client";

// useIdentity — the D1 (trustless) bind state for the active posting key: is it bound (⇒ may post), and
// the action that produces a CIP-8 self-proof with a Cardano wallet and submits it DIRECTLY on-chain via
// `cognoGate.link_identity_signed` (the runtime verifies the signature — no trusted follower), then
// confirms it with the on-chain AccountOf readback. The wallet sign, the on-chain submit, and the
// readback are distinct steps, surfaced as one `binding` flag here but narrated by the UI.

import { useCallback, useEffect, useState } from "react";
import type { CognoApi, PostingSigner } from "@/lib/types";
import { getGenesisHex, isAccountBound, readAccountOf, submitBindSponsored, type BindVia } from "@/lib/chain/identity";
import { getBindRelayUrl } from "@/lib/config/endpoints";
import { produceBindProof } from "@/lib/cardano/cip8";

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
}

export function useIdentity(api: CognoApi | null, signer: PostingSigner): UseIdentity {
  const [bound, setBound] = useState<boolean | null>(null);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boundAddress, setBoundAddress] = useState<string | null>(null);
  const [boundVia, setBoundVia] = useState<BindVia | null>(null);

  const refresh = useCallback(() => {
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

  return { bound, binding, error, boundAddress, boundVia, bind, refresh };
}
