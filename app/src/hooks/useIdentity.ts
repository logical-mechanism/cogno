"use client";

// useIdentity — the M2 bind state for the active posting key: is it bound (⇒ may post), and the
// action that runs the CIP-8 bind through a Cardano wallet + the Cogno-Follower, then confirms it
// with the on-chain AccountOf readback. Keep the three post-bind waits honest: the wallet sign,
// the follower verify+submit, and the chain readback are distinct steps, surfaced as one
// `binding` flag here but narrated by the UI.

import { useCallback, useEffect, useState } from "react";
import type { CognoApi, PostingSigner } from "@/lib/types";
import { isAccountBound, readAccountOf } from "@/lib/chain/identity";
import { bindIdentity } from "@/lib/cardano/cip8";

export interface UseIdentity {
  /** true = bound (may post), false = unbound, null = unknown/loading. */
  bound: boolean | null;
  /** a bind is in flight (wallet sign → follower → readback). */
  binding: boolean;
  error: string | null;
  /** the Cardano address the bind was signed from, once bound (for display). */
  boundAddress: string | null;
  bind: (walletId: string) => void;
  refresh: () => void;
}

export function useIdentity(api: CognoApi | null, signer: PostingSigner): UseIdentity {
  const [bound, setBound] = useState<boolean | null>(null);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boundAddress, setBoundAddress] = useState<string | null>(null);

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
          const res = await bindIdentity({ walletId, sr25519PubkeyHex: signer.publicKeyHex });
          if (!res.ok || !res.identityHash) {
            throw new Error(res.error || "the follower rejected the bind");
          }
          // AccountOf readback (L5 §5.7): poll until the chain resolves the binding to MY account.
          let resolved = false;
          for (let i = 0; i < 20; i++) {
            const who = await readAccountOf(api, res.identityHash).catch(() => undefined);
            if (who === signer.ss58) {
              resolved = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (!resolved) {
            throw new Error("bind submitted, but the AccountOf readback did not resolve to your account — check the follower");
          }
          setBound(true);
          setBoundAddress(res.signingAddress ?? null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBinding(false);
        }
      })();
    },
    [api, binding, signer.publicKeyHex, signer.ss58],
  );

  return { bound, binding, error, boundAddress, bind, refresh };
}
