"use client";

// useObserverHealth — watch whether the Cardano observer is still observing.
//
// The observer inherent is the SOLE writer of talk-capacity weight, voting power and role badges. If it
// freezes, all three stop moving and NOTHING ELSE IN THE APP CAN TELL: blocks keep arriving, the socket
// stays connected, the feed keeps updating, and a user who just locked 100 ADA simply watches a
// countdown finish and nothing happen. The app then told them "It should still land", which was a claim
// it had no basis for.
//
// The chain has recorded this all along in `CardanoObserver.Stalled`, and until now nothing read it.
// (Neither did anything else: the node-side `cogno_observer_*` Prometheus gauges are a separate signal
// written only by the authoring producer, and the shipped alertmanager config has every notifier
// commented out beneath a header stating that it pages nobody.)
//
// Shape copied verbatim from usePendingCapacity: `watchValue({ at: "best" })` per storage item, one
// effect each, `sub.unsubscribe()` on teardown, and — the important convention — a read ERROR falls back
// to the NON-ALARMING value. An RPC hiccup must not shout "the chain is broken" at every reader.
//
// `bestBlock` is passed in rather than subscribed here, so this opens no second head subscription; the
// caller supplies the shared, visibility-frozen `useBestBlock()`. Same rule as NoPostingPowerNotice.

import { useEffect, useState } from "react";
import {
  classifyObserverHealth,
  type ObserverHealth,
} from "@/lib/chain/observer";
import type { CognoApi } from "@/lib/types";

/**
 * `StallAfter`, cached per api handle. It is a runtime constant, so it cannot change under a
 * connection, and every consumer of this hook would otherwise re-read it. Weak, so a destroyed client's
 * entry goes with it. A REJECTION is never cached, matching readObserverConfig: caching one would wedge
 * the whole classification at "unknown" for the life of the connection.
 */
const stallAfterCache = new WeakMap<CognoApi, Promise<number>>();

function readStallAfter(api: CognoApi): Promise<number> {
  const hit = stallAfterCache.get(api);
  if (hit) return hit;
  const p = api.constants.CardanoObserver.StallAfter().catch((err: unknown) => {
    stallAfterCache.delete(api);
    throw err;
  });
  stallAfterCache.set(api, p);
  return p;
}

/**
 * Observer liveness for the connected chain. `unknown` until the reads land, and on any read failure.
 *
 * @param api the live typed api, or null before connect.
 * @param bestBlock the shared best-block height (`useBestBlock()`), or null before the first head.
 */
export function useObserverHealth(api: CognoApi | null, bestBlock: number | null): ObserverHealth {
  const [latched, setLatched] = useState<boolean | null>(null);
  const [lastAppliedAt, setLastAppliedAt] = useState<number | null>(null);
  const [everObserved, setEverObserved] = useState<boolean | null>(null);
  const [stallAfter, setStallAfter] = useState<number | null>(null);

  // The latched alarm. ValueQuery, so this decodes to a plain boolean.
  useEffect(() => {
    if (!api) {
      setLatched(null);
      return;
    }
    const sub = api.query.CardanoObserver.Stalled.watchValue({ at: "best" }).subscribe(
      ({ value }) => setLatched(value),
      () => setLatched(false), // read error → assume NOT stalled (never alarm on a hiccup)
    );
    return () => sub.unsubscribe();
  }, [api]);

  // The block the last observation landed in. ValueQuery BlockNumber → a plain JS number.
  useEffect(() => {
    if (!api) {
      setLastAppliedAt(null);
      return;
    }
    const sub = api.query.CardanoObserver.LastAppliedAt.watchValue({ at: "best" }).subscribe(
      ({ value }) => setLastAppliedAt(value),
      () => setLastAppliedAt(null),
    );
    return () => sub.unsubscribe();
  }, [api]);

  // Has this chain EVER observed? LastReference is an OptionQuery and is `Some` from the first accepted
  // observation onward. Only the BOOLEAN is stored, never the record: a fresh object per block would
  // re-render every consumer on every block for a value that changes once in the life of a chain.
  useEffect(() => {
    if (!api) {
      setEverObserved(null);
      return;
    }
    const sub = api.query.CardanoObserver.LastReference.watchValue({ at: "best" }).subscribe(
      ({ value: ref }) => setEverObserved(!!ref),
      () => setEverObserved(null), // inconclusive, NOT "never observed" — that would misreport a stall
    );
    return () => sub.unsubscribe();
  }, [api]);

  useEffect(() => {
    if (!api) {
      setStallAfter(null);
      return;
    }
    let cancelled = false;
    readStallAfter(api)
      .then((v) => !cancelled && setStallAfter(v))
      .catch(() => !cancelled && setStallAfter(null));
    return () => {
      cancelled = true;
    };
  }, [api]);

  return classifyObserverHealth({ latched, lastAppliedAt, bestBlock, stallAfter, everObserved });
}
