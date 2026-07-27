// Guards the device-local set stores (bookmarks / mutes).
//
// READ THIS BEFORE ADDING A CASE: the real stores are module singletons that read localStorage the
// first time a bucket is touched. Seed storage BEFORE creating the store — seed it after and the store
// comes up empty and every assertion passes for the WRONG reason. `boot()` enforces the order, and the
// first test asserts the harness itself actually sees seeded data.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createViewerScopedStringSetStore } from "./stringSetStore";

const DIGITS = (v: string) => /^\d+$/.test(v);
const NONEMPTY = (v: string) => v.length > 0;

const ALICE = "5Alice";
const BOB = "5Bob";

class FakeStorage {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
}

let storage: FakeStorage;
let storageListeners: Array<(e: StorageEvent) => void>;

/** Install a fresh window + localStorage, seeded, BEFORE any store is created. */
function boot(seed: Record<string, unknown> = {}) {
  storage = new FakeStorage();
  storageListeners = [];
  for (const [k, v] of Object.entries(seed)) storage.setItem(k, JSON.stringify(v));
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: (type: string, cb: (e: StorageEvent) => void) => {
      if (type === "storage") storageListeners.push(cb);
    },
    removeEventListener: () => {},
  });
}

// `claimLegacy: true` mirrors the real bookmarks/mutes stores — both shipped device-global before being
// bucketed per account, so their bare key is claimable exactly once. It is NOT the default (see the
// "legacy claim is opt-in" case below): a store bucketed from birth must never adopt a bare key.
const bookmarks = () =>
  createViewerScopedStringSetStore({ prefix: "cg-bookmarks", isValid: DIGITS, claimLegacy: true });
const mutes = () =>
  createViewerScopedStringSetStore({ prefix: "cg-muted", isValid: NONEMPTY, claimLegacy: true });

/** Another tab writes the key, then this tab receives the `storage` event the browser would deliver. */
function foreignWrite(key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value));
  for (const cb of storageListeners) cb({ key } as StorageEvent);
}

const persisted = (key: string): string[] => JSON.parse(storage.getItem(key) ?? "[]");

beforeEach(() => boot());

describe("harness", () => {
  it("seeds storage before the store reads it (else every test here is vacuous)", () => {
    boot({ "cg-bookmarks:5Alice": ["5"] });
    expect([...bookmarks().readFor(ALICE)]).toEqual(["5"]);
  });
});

describe("per-account scoping (the leak: a shared device showed one wallet's list to the next)", () => {
  it("two accounts on one device do not see each other's bookmarks", () => {
    const store = bookmarks();
    store.actionsFor(ALICE).add("5");
    store.actionsFor(BOB).add("9");

    expect([...store.readFor(ALICE)]).toEqual(["5"]);
    expect([...store.readFor(BOB)]).toEqual(["9"]);
    expect(persisted("cg-bookmarks:5Alice")).toEqual(["5"]);
    expect(persisted("cg-bookmarks:5Bob")).toEqual(["9"]);
  });

  it("mute lists are per-account too", () => {
    const store = mutes();
    store.actionsFor(ALICE).add("5Carol");
    expect(store.readFor(BOB).has("5Carol")).toBe(false);
  });

  it("signed-out browsing gets its own bucket, never an account's", () => {
    const store = bookmarks();
    store.actionsFor(null).add("1");
    expect([...store.readFor(null)]).toEqual(["1"]);
    expect(store.readFor(ALICE).has("1")).toBe(false);
    expect(persisted("cg-bookmarks:anon")).toEqual(["1"]);
  });
});

describe("one-shot migration of the pre-namespacing device-global set", () => {
  it("the first account to mount claims the legacy set", () => {
    boot({ "cg-bookmarks": ["5", "9"] });
    expect([...bookmarks().readFor(ALICE)]).toEqual(["5", "9"]);
    expect(persisted("cg-bookmarks:5Alice")).toEqual(["5", "9"]);
  });

  it("and the legacy key is REMOVED, so a second account does not inherit it (the whole point)", () => {
    boot({ "cg-bookmarks": ["5", "9"] });
    const store = bookmarks();
    expect([...store.readFor(ALICE)]).toEqual(["5", "9"]); // Alice claims
    expect(storage.getItem("cg-bookmarks")).toBe(null); // legacy consumed
    expect([...store.readFor(BOB)]).toEqual([]); // Bob starts clean
  });

  it("signed-out browsing never claims it (else the list would look lost once you connect)", () => {
    boot({ "cg-bookmarks": ["5"] });
    const store = bookmarks();
    expect([...store.readFor(null)]).toEqual([]); // anon does not consume it
    expect(storage.getItem("cg-bookmarks")).not.toBe(null); // still there for the real account
    expect([...store.readFor(ALICE)]).toEqual(["5"]); // Alice still gets it
  });

  it("does not overwrite an account that already has its own bucket", () => {
    boot({ "cg-bookmarks": ["9"], "cg-bookmarks:5Alice": ["5"] });
    expect([...bookmarks().readFor(ALICE)]).toEqual(["5"]);
  });
});

describe("cross-tab safety (the bug: a second tab silently destroyed the first tab's data)", () => {
  it("a foreign write is not clobbered by this tab's next commit", () => {
    const store = bookmarks();
    store.subscribeFor(ALICE, () => {}); // a mounted component — arms the `storage` listener

    foreignWrite("cg-bookmarks:5Alice", ["5"]); // tab A bookmarks #5
    store.actionsFor(ALICE).add("9"); // tab B bookmarks #9

    // Previously tab B rebuilt from its boot-time empty cache and committed ["9"], destroying #5.
    expect(persisted("cg-bookmarks:5Alice")).toEqual(["5", "9"]);
  });

  it("re-reads on subscribe, so a write that landed while nothing was mounted is not lost", () => {
    const store = bookmarks();
    // No subscriber yet → the `storage` listener is not attached, so this event fires into a void.
    store.readFor(ALICE); // materialise the bucket
    foreignWrite("cg-bookmarks:5Alice", ["5"]);
    store.subscribeFor(ALICE, () => {}); // now a component mounts

    expect([...store.readFor(ALICE)]).toEqual(["5"]);
    store.actionsFor(ALICE).add("9");
    expect(persisted("cg-bookmarks:5Alice")).toEqual(["5", "9"]);
  });

  it("notifies subscribers when another tab changes the set", () => {
    const store = mutes();
    let notified = 0;
    store.subscribeFor(ALICE, () => notified++);

    foreignWrite("cg-muted:5Alice", ["5Carol"]);

    expect(notified).toBe(1);
    expect([...store.readFor(ALICE)]).toEqual(["5Carol"]);
  });
});

describe("validity is enforced on BOTH paths", () => {
  it("rejects an invalid member on WRITE (mute('') would render an empty address as muted)", () => {
    const store = mutes();
    store.actionsFor(ALICE).add("");
    expect(store.readFor(ALICE).has("")).toBe(false);
    expect(storage.getItem("cg-muted:5Alice")).toBe(null);
  });

  it("drops junk on READ — the BigInt() crash guard that keeps /bookmarks alive", () => {
    boot({ "cg-bookmarks:5Alice": ["5", "not-an-id", "9"] });
    const set = bookmarks().readFor(ALICE);
    expect([...set]).toEqual(["5", "9"]);
    expect(() => [...set].map((s) => BigInt(s))).not.toThrow();
  });

  it("survives corrupt JSON rather than throwing", () => {
    boot();
    storage.setItem("cg-bookmarks:5Alice", "{not json");
    expect([...bookmarks().readFor(ALICE)]).toEqual([]);
  });
});

describe("add / remove / toggle", () => {
  it("round-trips through storage", () => {
    const a = bookmarks().actionsFor(ALICE);
    a.add("5");
    expect(persisted("cg-bookmarks:5Alice")).toEqual(["5"]);
    a.toggle("5");
    expect(persisted("cg-bookmarks:5Alice")).toEqual([]);
    a.toggle("7");
    expect(persisted("cg-bookmarks:5Alice")).toEqual(["7"]);
    a.remove("7");
    expect(persisted("cg-bookmarks:5Alice")).toEqual([]);
  });

  it("is idempotent (a repeat add does not re-commit)", () => {
    const store = bookmarks();
    let notified = 0;
    store.subscribeFor(ALICE, () => notified++);
    store.actionsFor(ALICE).add("5");
    store.actionsFor(ALICE).add("5");
    expect(notified).toBe(1);
  });
});

describe("the legacy claim is OPT-IN", () => {
  // Regression guard for a store bucketed per-account from birth (topicStore). The claim used to be
  // hard-coded on for every store built through this facade, so a brand-new store would silently adopt
  // whatever sat at its bare key — the exact case viewerScopedStore documents as forbidden.
  const fresh = () => createViewerScopedStringSetStore({ prefix: "cg-topics", isValid: NONEMPTY });

  it("does NOT claim a bare key by default", () => {
    boot({ "cg-topics": ["cardano"] });
    const store = fresh();
    expect([...store.readFor(ALICE)]).toEqual([]);
    expect(storage.getItem("cg-topics")).not.toBe(null); // untouched, not migrated away
  });

  it("still buckets per account when the claim is off", () => {
    boot();
    const store = fresh();
    store.actionsFor(ALICE).add("cardano");
    expect([...store.readFor(ALICE)]).toEqual(["cardano"]);
    expect([...store.readFor(BOB)]).toEqual([]);
    expect([...store.readFor(null)]).toEqual([]);
  });
});

// The fifteen cases above make NO size assertion at all, so nothing stopped a set growing without
// bound — and /bookmarks and Settings → Hidden each resolve their whole set on mount in one unbounded
// `Promise.all`, so "unbounded" is a burst of that many concurrent node reads on every visit.
describe("max — the size bound, on both the read and the write path", () => {
  const capped = () =>
    createViewerScopedStringSetStore({ prefix: "cg-capped", isValid: DIGITS, max: 3 });

  it("refuses an add past the cap, and SAYS SO", () => {
    boot();
    const store = capped();
    const a = store.actionsFor(ALICE);
    expect(a.add("1")).toBe(true);
    expect(a.add("2")).toBe(true);
    expect(a.add("3")).toBe(true);
    expect(a.add("4")).toBe(false); // the caller can now show an error instead of a success toast
    expect([...store.readFor(ALICE)].sort()).toEqual(["1", "2", "3"]);
  });

  it("does not refuse a value already in the set", () => {
    boot();
    const store = capped();
    const a = store.actionsFor(ALICE);
    a.add("1");
    a.add("2");
    a.add("3");
    expect(a.add("2")).toBe(true); // the requested state already holds
  });

  it("makes room again after a remove", () => {
    boot();
    const store = capped();
    const a = store.actionsFor(ALICE);
    a.add("1");
    a.add("2");
    a.add("3");
    expect(a.remove("2")).toBe(true);
    expect(a.add("4")).toBe(true);
    expect([...store.readFor(ALICE)].sort()).toEqual(["1", "3", "4"]);
  });

  it("truncates an over-cap value already on disk", () => {
    // A bucket written before the cap existed (or hand-edited) must not come back over it.
    boot({ "cg-capped:5Alice": ["1", "2", "3", "4", "5"] });
    const store = capped();
    expect(store.readFor(ALICE).size).toBe(3);
  });

  it("leaves an uncapped store uncapped", () => {
    boot();
    const store = createViewerScopedStringSetStore({ prefix: "cg-uncapped", isValid: DIGITS });
    const a = store.actionsFor(ALICE);
    for (let i = 0; i < 50; i++) expect(a.add(String(i))).toBe(true);
    expect(store.readFor(ALICE).size).toBe(50);
  });
});

// F17 — every device-local write swallowed its own throw while the caller painted an unconditional
// success toast. The store layer now reports it.
describe("a write that cannot reach storage reports false", () => {
  it("returns false from add/remove when localStorage throws", () => {
    boot();
    const store = createViewerScopedStringSetStore({ prefix: "cg-throwy", isValid: DIGITS });
    // Seat the bucket first (the store reads its key on the first touch), then break writes.
    expect(store.actionsFor(ALICE).add("1")).toBe(true);
    storage.setItem = () => {
      throw new Error("blocked");
    };
    expect(store.actionsFor(ALICE).add("2")).toBe(false);
    expect(store.actionsFor(ALICE).remove("1")).toBe(false);
    // The in-memory value still moved — the session keeps working, it just will not survive a reload.
    expect([...store.readFor(ALICE)].sort()).toEqual(["2"]);
  });
});
