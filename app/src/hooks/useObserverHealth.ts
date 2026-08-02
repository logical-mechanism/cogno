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
// Each storage read is `watchValue({ at: "best" })` with a read ERROR falling back to the NON-ALARMING
// value — an RPC hiccup must not shout "the chain is broken" at every reader.
//
// ONE SET OF SUBSCRIPTIONS PER CONNECTION, not per mount. This hook is called from four components
// (Composer's and EditProfileModal's NoPostingPowerNotice, VaultSection, DiagnosticsSection), several of
// which coexist: /settings alone mounts two, and NoPostingPowerNotice calls it ABOVE its
// `viewer.status !== "ready"` early return — which the rules of hooks require — so a signed-out or
// unbound viewer paid for reads nothing ever displayed. Per-mount `watchValue` made that six live
// subscriptions for three storage items on one screen, each re-decoding on every block. The header used
// to hold up `useBestBlock()` (a shared, visibility-frozen context) as the pattern it followed, and then
// did not follow it. It does now, via a refcounted per-api cache rather than a provider: this is a
// leaf-level diagnostic that several unrelated trees mount, so sharing it at the module keeps the
// caller list open instead of requiring every future consumer to sit under one more context.
//
// `bestBlock` is still passed in rather than subscribed here, so this opens no head subscription at all;
// the caller supplies the shared `useBestBlock()`. Same rule as NoPostingPowerNotice.

import { useEffect, useState } from "react";
import {
  classifyObserverHealth,
  type ObserverHealth,
  type ObserverLiveness,
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

/** The three WATCHED reads, as one immutable value. `null` is "not resolved yet", never "zero". */
type Watched = Pick<ObserverLiveness, "latched" | "lastAppliedAt" | "everObserved">;

/**
 * The raw watched state. `hasReference` is the `LastReference` read on its own; `everObserved` is DERIVED
 * from it plus `lastAppliedAt` (see the subscription below for why the frontier alone no longer answers
 * the question) and is what consumers read.
 */
type RawWatched = Watched & { hasReference: boolean | null };

const UNRESOLVED: RawWatched = {
  latched: null,
  lastAppliedAt: null,
  everObserved: null,
  hasReference: null,
};

/**
 * "Has this chain ever applied an observation?" — `true` if the frontier moved OR a block ever stamped
 * the applied-at clock (block 0 is genesis and carries no extrinsics, so a non-zero clock is always a
 * real observation). Stays `null` while both reads are unresolved, because "inconclusive" and "never"
 * must not collapse: reporting "never" on a read failure would hide a live stall.
 */
export function deriveEverObserved(raw: {
  hasReference: boolean | null;
  lastAppliedAt: number | null;
}): boolean | null {
  if (raw.hasReference === true) return true;
  if (raw.lastAppliedAt !== null && raw.lastAppliedAt > 0) return true;
  if (raw.hasReference === null || raw.lastAppliedAt === null) return null;
  return false;
}

interface SharedWatch {
  snapshot: RawWatched;
  listeners: Set<(w: Watched) => void>;
  subs: { unsubscribe: () => void }[];
}

const watchCache = new WeakMap<CognoApi, SharedWatch>();

/**
 * Subscribe to this connection's observer-liveness reads, opening them on the first listener and
 * tearing them down with the last. The listener is called immediately with the current snapshot, so a
 * component mounting into an already-running watch renders the known state rather than a fresh
 * "unknown" it would have to wait a block to leave.
 *
 * A patch that changes nothing notifies nobody: `Stalled` and `LastReference` emit on EVERY block and
 * hold the same value for the life of a healthy chain, so forwarding those would re-render every
 * consumer per block for no change. `lastAppliedAt` genuinely moves, and that one is the point.
 */
function subscribeWatched(api: CognoApi, listener: (w: Watched) => void): () => void {
  let entry = watchCache.get(api);
  if (!entry) {
    const created: SharedWatch = { snapshot: UNRESOLVED, listeners: new Set(), subs: [] };
    const patch = (next: Partial<RawWatched>) => {
      const merged = { ...created.snapshot, ...next };
      merged.everObserved = deriveEverObserved(merged);
      if (
        merged.latched === created.snapshot.latched &&
        merged.lastAppliedAt === created.snapshot.lastAppliedAt &&
        merged.everObserved === created.snapshot.everObserved
      ) {
        return;
      }
      created.snapshot = merged;
      created.listeners.forEach((l) => l(merged));
    };
    const q = api.query.CardanoObserver;
    created.subs.push(
      // The latched alarm. ValueQuery, so this decodes to a plain boolean.
      q.Stalled.watchValue({ at: "best" }).subscribe(
        ({ value }) => patch({ latched: value }),
        () => patch({ latched: false }), // read error → assume NOT stalled (never alarm on a hiccup)
      ),
      // The block the last observation landed in. ValueQuery BlockNumber → a plain JS number.
      q.LastAppliedAt.watchValue({ at: "best" }).subscribe(
        ({ value }) => patch({ lastAppliedAt: value }),
        () => patch({ lastAppliedAt: null }),
      ),
      // Has this chain EVER observed? LastReference is an OptionQuery, `Some` from the first accepted
      // observation onward. Only the BOOLEAN is kept, never the record: a fresh object per block would
      // re-render every consumer on every block for a value that changes once in the life of a chain.
      //
      // Since spec 215 it is NOT the whole test. LastReference advances only on a block that carried its
      // whole change set, so a chain whose first observation is BACKLOGGED has applied real pages, is
      // crediting real weight, and still reads `None` here — the ordinary bootstrap, and exactly the
      // window in which "not started" is the most misleading thing to render. LastAppliedAt is stamped by
      // every applied observation, drained or not, so the two together are the honest test. The pallet
      // pairs them the same way in its own stall-alarm guard.
      q.LastReference.watchValue({ at: "best" }).subscribe(
        ({ value: ref }) => patch({ hasReference: !!ref }),
        () => patch({ hasReference: null }), // inconclusive, NOT "never" — that would misreport a stall
      ),
    );
    watchCache.set(api, created);
    entry = created;
  }

  const shared = entry;
  shared.listeners.add(listener);
  listener(shared.snapshot);
  return () => {
    shared.listeners.delete(listener);
    if (shared.listeners.size > 0) return;
    shared.subs.forEach((s) => s.unsubscribe());
    // Dropped rather than kept warm: the next mount reopens it, and holding three live subscriptions
    // on a connection nothing is reading is the cost this whole cache exists to avoid.
    watchCache.delete(api);
  };
}

/**
 * Observer liveness for the connected chain. `unknown` until the reads land, and on any read failure.
 *
 * @param api the live typed api, or null before connect.
 * @param bestBlock the shared best-block height (`useBestBlock()`), or null before the first head.
 */
export function useObserverHealth(api: CognoApi | null, bestBlock: number | null): ObserverHealth {
  const [watched, setWatched] = useState<Watched>(UNRESOLVED);
  const [stallAfter, setStallAfter] = useState<number | null>(null);

  useEffect(() => {
    if (!api) {
      setWatched(UNRESOLVED);
      return;
    }
    return subscribeWatched(api, setWatched);
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

  return classifyObserverHealth({ ...watched, bestBlock, stallAfter });
}
