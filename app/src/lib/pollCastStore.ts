"use client";

// pollCastStore — "the chain now reflects a vote in poll N", as a signal any surface beside that poll
// can subscribe to.
//
// WHY IT EXISTS. A poll is owned by InlinePoll, which mounts inside PostCard. Anything rendered NEXT to
// that card (today: ThreadView's voter roster) reads the same poll through its own hook and has no way
// to learn that the viewer just cast, so it keeps showing the pre-vote answer while the bars a few
// pixels above it show the post-vote one. Casting a vote is the one change a voter expects to see
// immediately, and being absent from a roster you just joined reads as "your vote did not register".
//
// WHY NOT A PROP. The alternative was threading a callback down through PostCard, which is shared by
// every list surface in the app and is deliberately presentational. One optional prop used by exactly
// one caller, forwarded through a component that has no interest in it, is a worse trade than a
// module-level signal.
//
// WHY NOT JUST RE-READ PER BLOCK. Because the roster enumerates a whole storage prefix. usePollVoters
// and useReplyVoteChoices both document why they refuse a per-block cadence: on a busy thread they
// would be the hottest reads on the page and would still disagree with the tallies beside them.
//
// A module-level singleton with useSyncExternalStore, mirroring lib/signInPromptStore — same reason:
// the producer is a mutation callback that imports the action directly rather than taking it as a dep.

import { useSyncExternalStore } from "react";

/** hostId (as a decimal string, since a bigint is not a usable Map key across realms) → cast count. */
let ticks: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/**
 * Record that a cast in `hostId` is now VISIBLE to a fresh read.
 *
 * Call this from the reconcile-settle path, never from the submit's `onConfirm`. A transaction included
 * in the best block can still resolve a hair before a state read at that block reflects it, so a
 * listener that re-read on confirm would fetch the pre-vote list, cache it, and look exactly as broken
 * as doing nothing.
 */
export function notePollCast(hostId: bigint): void {
  const key = hostId.toString();
  const next = new Map(ticks);
  next.set(key, (next.get(key) ?? 0) + 1);
  ticks = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * How many casts in `hostId` have settled this session. The VALUE is meaningless; it is a nonce, and
 * every change means "re-read". Returns 0 for a null host and under the static-export prerender.
 */
export function usePollCastTick(hostId: bigint | null): number {
  const key = hostId == null ? null : hostId.toString();
  return useSyncExternalStore(
    subscribe,
    () => (key == null ? 0 : (ticks.get(key) ?? 0)),
    () => 0,
  );
}
