"use client";

// notificationReadState — device-local read-state for the notifications surface (client-only; NO
// chain state, nothing written to Cardano; not synced across devices). Per VIEWER account it tracks:
//   - firstSeen: the ms this device FIRST observed each notification item (by its stable key). Edge
//     signals (likes / follows / reputation / poll votes) carry NO on-chain timestamp, so first-seen is
//     the only stable order we have for them — and it persists so the order doesn't shuffle each session.
//   - readThrough: the ms up to which the viewer has read. Unread = items first-seen AFTER readThrough.
//
// Mirrors recentSearchStore's use of createPersistentStore, but keyed PER ACCOUNT (a new namespacing —
// the existing device-global stores are single keys) via a memoized store-per-account map, since the
// factory bakes ONE fixed key per instance.

import { useSyncExternalStore } from "react";
import { createPersistentStore, type PersistentStore } from "./persistentStore";
import type { Ss58 } from "./types";

/** Device-local read cursor + first-seen index for one viewer's notifications. */
export interface ReadState {
  /** ms; items first-seen at/before this are read. */
  readThrough: number;
  /** stable item key → first-seen ms on THIS device. */
  firstSeen: Record<string, number>;
}

export const EMPTY_READ_STATE: ReadState = { readThrough: 0, firstSeen: {} };

// Safety cap so firstSeen can't grow without bound across months of activity (evict the OLDEST when
// exceeded). The notification fold is itself bounded, so eviction only ever touches long-read items.
const MAX_TRACKED = 4000;

// ── pure helpers (unit-tested; no localStorage / no clock) ──────────────────────────────────────────

export function parseReadState(raw: string | null): ReadState {
  if (!raw) return EMPTY_READ_STATE;
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return EMPTY_READ_STATE;
  }
  if (!p || typeof p !== "object") return EMPTY_READ_STATE;
  const o = p as Record<string, unknown>;
  const readThrough = typeof o.readThrough === "number" ? o.readThrough : 0;
  const firstSeen: Record<string, number> = {};
  if (o.firstSeen && typeof o.firstSeen === "object") {
    for (const [k, v] of Object.entries(o.firstSeen as Record<string, unknown>)) {
      if (typeof v === "number") firstSeen[k] = v;
    }
  }
  return { readThrough, firstSeen };
}

export const serializeReadState = (s: ReadState): string => JSON.stringify(s);

/** Record `now` as the first-seen for any `ids` not already tracked. Returns the SAME ref when nothing
 *  is new (so useSyncExternalStore never churns a re-render). Evicts the oldest past MAX_TRACKED. */
export function withSeen(state: ReadState, ids: string[], now: number): ReadState {
  let changed = false;
  const firstSeen = { ...state.firstSeen };
  for (const id of ids) {
    if (firstSeen[id] == null) {
      firstSeen[id] = now;
      changed = true;
    }
  }
  if (!changed) return state;
  const keys = Object.keys(firstSeen);
  if (keys.length > MAX_TRACKED) {
    // Evict the oldest first-seen entries (smallest ms) down to the cap.
    const drop = keys.sort((a, b) => firstSeen[a] - firstSeen[b]).slice(0, keys.length - MAX_TRACKED);
    for (const k of drop) delete firstSeen[k];
  }
  return { ...state, firstSeen };
}

/** Mark everything seen so far as read (advance the cursor to `now`). Same ref when already current. */
export function withAllRead(state: ReadState, now: number): ReadState {
  if (state.readThrough >= now) return state;
  return { ...state, readThrough: now };
}

/** The number of tracked items first-seen AFTER the read cursor (the unread badge count). */
export function countUnread(state: ReadState): number {
  let n = 0;
  for (const t of Object.values(state.firstSeen)) if (t > state.readThrough) n++;
  return n;
}

/** True iff the item with `key` is unread (first-seen after the read cursor). */
export function isUnread(state: ReadState, key: string): boolean {
  const t = state.firstSeen[key];
  return t != null && t > state.readThrough;
}

// ── the per-viewer persisted store ──────────────────────────────────────────────────────────────────

const stores = new Map<string, PersistentStore<ReadState>>();

function storeFor(who: Ss58): PersistentStore<ReadState> {
  let s = stores.get(who);
  if (!s) {
    s = createPersistentStore<ReadState>({
      key: `cg-notif-read:${who}`,
      empty: EMPTY_READ_STATE,
      parse: parseReadState,
      serialize: serializeReadState,
      crossTab: true, // clearing the badge in one tab clears it in the others
    });
    stores.set(who, s);
  }
  return s;
}

// Module-level STABLE fallbacks so useSyncExternalStore never sees a fresh fn when `who` is null.
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_READ_STATE;

export const notificationReadActions = {
  /** Stamp the first-seen time for any newly-observed item keys (call after each fold). */
  recordSeen(who: Ss58, ids: string[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    const s = storeFor(who);
    const next = withSeen(s.read(), ids, now);
    if (next !== s.read()) s.commit(next);
  },
  /** Advance the read cursor so the unread badge clears (call when the panel is viewed). */
  markAllRead(who: Ss58, now: number = Date.now()): void {
    const s = storeFor(who);
    const next = withAllRead(s.read(), now);
    if (next !== s.read()) s.commit(next);
  },
};

/** Subscribe to a viewer's read-state (re-renders on record/mark). EMPTY while `who` is null. */
export function useNotificationReadState(who: Ss58 | null): ReadState {
  const s = who ? storeFor(who) : null;
  return useSyncExternalStore(
    s ? s.subscribe : noopSubscribe,
    s ? s.getSnapshot : emptySnapshot,
    emptySnapshot,
  );
}
