// Pure helpers for the id-paged LIVE feed (useLiveFeed). Kept React-free + unit-testable: the merge
// math + the "where does each freshly-read post go" classification live here; the hook wires them to
// state + the FeedSource. The live feed pages by id and folds in new posts off the NextPostId head —
// it never rebuilds from a full `watchEntries` snapshot.

import type { CognoPost } from "@/lib/types";

/** Newest-first by id (bigint-safe). */
export function byIdDesc(a: CognoPost, b: CognoPost): number {
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * Union two post lists by id — `incoming` WINS on a collision (it carries the fresher tally/count) —
 * and return newest-first. Used to fold a refreshed/older page into the loaded list without dropping
 * or duplicating a row.
 */
export function mergeById(existing: CognoPost[], incoming: CognoPost[]): CognoPost[] {
  const byId = new Map<string, CognoPost>();
  for (const p of existing) byId.set(String(p.id), p);
  for (const p of incoming) byId.set(String(p.id), p); // incoming (fresher) wins
  return Array.from(byId.values()).sort(byIdDesc);
}

/** Where each post of a freshly-read page goes when folded into the live feed. */
export interface FreshPartition {
  /** New OWN posts (author === me): inject directly into the loaded list (never buffered). */
  newOwn: CognoPost[];
  /** New OTHERS' posts: buffer behind the "N new posts" pill until the viewer flushes. */
  newOthers: CognoPost[];
  /** Posts already loaded: refresh them in place (tallies/counts) — they stay visible. */
  refreshLoaded: CognoPost[];
  /** Posts already buffered: refresh them in place — they stay buffered until flush. */
  refreshBuffered: CognoPost[];
}

/**
 * Classify a freshly-read page against what is already loaded/buffered. A genuinely-new post from
 * SOMEONE ELSE buffers behind the pill (so the scroll never jumps); the viewer's OWN new post injects
 * directly (it already shows as an optimistic card, and this hands it off seamlessly); an
 * already-seen id is a refresh-in-place wherever it currently lives.
 */
export function partitionFresh(
  fresh: CognoPost[],
  loadedIds: ReadonlySet<string>,
  bufferedIds: ReadonlySet<string>,
  me: string | null,
): FreshPartition {
  const newOwn: CognoPost[] = [];
  const newOthers: CognoPost[] = [];
  const refreshLoaded: CognoPost[] = [];
  const refreshBuffered: CognoPost[] = [];
  for (const p of fresh) {
    const key = String(p.id);
    if (loadedIds.has(key)) refreshLoaded.push(p);
    else if (bufferedIds.has(key)) refreshBuffered.push(p);
    else if (me != null && p.author === me) newOwn.push(p);
    else newOthers.push(p);
  }
  return { newOwn, newOthers, refreshLoaded, refreshBuffered };
}
