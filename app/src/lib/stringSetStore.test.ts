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

const bookmarks = () =>
  createViewerScopedStringSetStore({ prefix: "cg-bookmarks", isValid: DIGITS });
const mutes = () => createViewerScopedStringSetStore({ prefix: "cg-muted", isValid: NONEMPTY });

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
