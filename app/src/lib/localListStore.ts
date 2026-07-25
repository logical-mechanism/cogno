"use client";

// localListStore — user-created LISTS of accounts, device-local (client-only; NO chain state, nothing
// written to the chain or to Cardano). Scoped per account and mirrored across this device's tabs via the
// shared viewer-scoped store.
//
// A list is a private reading lens: name it, put accounts in it, read a timeline of just those accounts.
// It changes nothing anyone else sees and applies no label to anyone — which is exactly why the private
// form ships first. (A PUBLIC list would put a permanent label on third parties who cannot remove
// themselves, on a chain with no on-chain moderation and no delete. That is a deliberate, separate
// decision, not a free extension of this.)
//
// "Private" means NOT PUBLISHED — it does not mean un-inferable. Rendering a list's timeline sends its
// membership to the RPC node as a burst of author reads. The UI says so; don't let copy imply otherwise.
//
// THE CAPS BELOW ARE DELIBERATELY EQUAL TO THE BOUNDS A FUTURE ON-CHAIN `Lists` MAP WOULD USE
// (8 lists / 64 members / a 48-BYTE name). Getting them right now is what makes "publish this list"
// later a lossless copy instead of a lossy one that silently truncates a user's list.
//
// `publishedSlot` is the other half of that seam: nothing writes it today, but BOTH `parse` and
// `serialize` carry it. Both halves are needed and for different reasons — `parse` so a slot survives a
// reload, and `serialize` so an unrelated mutation (adding a member) doesn't drop it on the next commit.
// `serialize` is the load-bearing one: it projects fields EXPLICITLY, so a field omitted there is
// destroyed on write even though `parse` understood it.

import { createViewerScopedStore } from "./viewerScopedStore";
import { normalizeSs58 } from "./ss58";
import { utf8Bytes } from "./bytes";
import type { Ss58 } from "./types";

/** Max lists per account. Equal to a future `MaxListsPerAccount`. */
export const MAX_LOCAL_LISTS = 8;
/** Max members per list. Equal to a future `MaxListMembers`. */
export const MAX_LIST_MEMBERS = 64;
/** Max list-name length in UTF-8 BYTES (not UTF-16 units). Equal to a future `MaxListNameLen`. */
export const MAX_LIST_NAME_BYTES = 48;

export interface LocalList {
  /** Device-local id. Never leaves this device; a published list would be keyed by (owner, slot). */
  id: string;
  /** The raw, UNSANITIZED name as typed. Sanitize at RENDER (`sanitizeInline`) — never before a byte
   *  count or a write, or the stored value and the measured value drift apart. */
  name: string;
  /** Canonical (prefix-42) member addresses, deduped. */
  members: Ss58[];
  /**
   * Forward-compat seam for publishing: the on-chain `u8` slot this list occupies once published.
   * NOTHING writes this today. It exists so a later publish flow can map a device-local id to a chain
   * slot without a stored-format change — which requires both `parse` and `serialize` to carry it.
   */
  publishedSlot?: number;
}

const EMPTY: readonly LocalList[] = [];

/** Is `name` within the byte cap? Empty names are rejected (a list needs a handle to be usable). */
export function isValidListName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && utf8Bytes(trimmed) <= MAX_LIST_NAME_BYTES;
}

/**
 * Coerce one unknown parsed value into a valid `LocalList`, or null.
 *
 * This runs on READ (`parse`). localStorage is not trustworthy input — it survives across sessions and can
 * be hand-edited — and a member that isn't a checksum-valid address would be interpolated into a chain
 * read and either error or silently return nothing, so invalid members are DROPPED rather than kept.
 * Over-long collections are capped here too; the write path refuses to exceed the cap, so that only fires
 * on storage someone edited by hand.
 */
function coerceList(raw: unknown): LocalList | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.name !== "string" || !isValidListName(r.name)) return null;
  if (!Array.isArray(r.members)) return null;

  const members: Ss58[] = [];
  const seen = new Set<string>();
  for (const m of r.members) {
    if (typeof m !== "string") continue;
    const norm = normalizeSs58(m);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    members.push(norm as Ss58);
    if (members.length >= MAX_LIST_MEMBERS) break;
  }

  // Sorted, so the in-memory value and the persisted value agree. They did not before: `serialize` sorted
  // while the committed in-memory array kept insertion order, so a list's member order changed across a
  // reload — and member order decides WHICH members the timeline's capped fan-out actually reads.
  members.sort();
  const list: LocalList = { id: r.id, name: r.name, members };
  // Tolerate (and preserve) the publish seam. A non-integer / out-of-range slot is dropped, not kept.
  if (
    typeof r.publishedSlot === "number" &&
    Number.isInteger(r.publishedSlot) &&
    r.publishedSlot >= 0 &&
    r.publishedSlot < MAX_LOCAL_LISTS
  ) {
    list.publishedSlot = r.publishedSlot;
  }
  return list;
}

const store = createViewerScopedStore<readonly LocalList[]>({
  prefix: "cg-lists",
  empty: EMPTY,
  parse: (rawStr) => {
    const parsed: unknown = rawStr ? JSON.parse(rawStr) : [];
    if (!Array.isArray(parsed)) return EMPTY;
    const out: LocalList[] = [];
    for (const entry of parsed) {
      const list = coerceList(entry);
      if (list !== null) out.push(list);
      if (out.length >= MAX_LOCAL_LISTS) break;
    }
    return out;
  },
  // List ORDER is user-meaningful, so lists are not reordered. Members are already sorted by the write
  // path, so this is a straight projection — it must NOT sort here, or the persisted form would differ
  // from the in-memory one again. `publishedSlot` is projected through explicitly (see the header).
  serialize: (lists) =>
    JSON.stringify(
      lists.map((l) => ({
        id: l.id,
        name: l.name,
        members: l.members,
        ...(l.publishedSlot !== undefined ? { publishedSlot: l.publishedSlot } : {}),
      })),
    ),
  // Per-account from birth — there is no pre-namespacing bare `cg-lists` key to claim.
});

/** A fresh device-local list id. `randomUUID` where available; a counter-salted fallback otherwise. */
function newListId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `l-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface LocalListActions {
  /** Create a named list. Returns its id, or null when the name is invalid or the cap is reached. */
  create: (name: string) => string | null;
  /** Rename. No-ops on an invalid name (so a bad keystroke can't wipe a name). */
  rename: (id: string, name: string) => void;
  /** Delete a list outright. */
  remove: (id: string) => void;
  /** Add a member. No-ops when the address is invalid, already present, or the list is full. */
  addMember: (id: string, address: string) => void;
  /** Remove a member. */
  removeMember: (id: string, address: string) => void;
  /** Add if absent, remove if present — for a single "in this list" control. */
  toggleMember: (id: string, address: string) => void;
}

/** Members are held SORTED everywhere — in memory, on disk, and after a reload — so the order that
 *  decides which members a capped fan-out reads cannot change under the user. */
function withMember(l: LocalList, addr: Ss58): LocalList {
  if (l.members.includes(addr) || l.members.length >= MAX_LIST_MEMBERS) return l;
  return { ...l, members: [...l.members, addr].sort() };
}

/** List actions bound to `who` (null = the signed-out device bucket). */
export function localListActionsFor(who: Ss58 | null): LocalListActions {
  const mapList = (id: string, fn: (l: LocalList) => LocalList) =>
    store.update(who, (lists) => lists.map((l) => (l.id === id ? fn(l) : l)));

  return {
    create: (name) => {
      if (!isValidListName(name)) return null;
      if (store.readFor(who).length >= MAX_LOCAL_LISTS) return null;
      const id = newListId();
      store.update(who, (lists) => [...lists, { id, name: name.trim(), members: [] }]);
      return id;
    },
    rename: (id, name) => {
      if (!isValidListName(name)) return;
      mapList(id, (l) => ({ ...l, name: name.trim() }));
    },
    remove: (id) => store.update(who, (lists) => lists.filter((l) => l.id !== id)),
    addMember: (id, address) => {
      const norm = normalizeSs58(address);
      if (norm === null) return;
      mapList(id, (l) => withMember(l, norm as Ss58));
    },
    removeMember: (id, address) => {
      const norm = normalizeSs58(address);
      if (norm === null) return;
      mapList(id, (l) => ({ ...l, members: l.members.filter((m) => m !== norm) }));
    },
    toggleMember: (id, address) => {
      const norm = normalizeSs58(address);
      if (norm === null) return;
      mapList(id, (l) =>
        l.members.includes(norm as Ss58)
          ? { ...l, members: l.members.filter((m) => m !== norm) }
          : withMember(l, norm as Ss58),
      );
    },
  };
}

/** `who`'s lists, in user-meaningful order. Subscribes. */
export function useLocalLists(who: Ss58 | null): readonly LocalList[] {
  return store.use(who);
}

/** One list by id. Subscribes. */
export function useLocalList(who: Ss58 | null, id: string | null | undefined): LocalList | null {
  const lists = store.use(who);
  if (id == null) return null;
  return lists.find((l) => l.id === id) ?? null;
}

/** Non-React read, for tests and one-shot reads outside a component. */
export function readLocalLists(who: Ss58 | null): readonly LocalList[] {
  return store.readFor(who);
}
