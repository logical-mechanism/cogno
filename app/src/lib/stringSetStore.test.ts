// Guards the device-local set stores (bookmarks / mutes).
//
// READ THIS BEFORE ADDING A CASE: the real stores are module singletons that load() at module-eval
// time. localStorage must be seeded BEFORE the module is imported — seed it after and the store comes
// up empty and every assertion passes for the WRONG reason. `bootWith` below enforces the order, and
// the first test asserts the harness itself actually sees seeded data.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStringSetStore } from "./stringSetStore";

const DIGITS = (v: string) => /^\d+$/.test(v);
const NONEMPTY = (v: string) => v.length > 0;

class FakeStorage {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
}

let storage: FakeStorage;
let storageListeners: Array<(e: StorageEvent) => void>;

/** Install a fresh window + localStorage, seeded, BEFORE any store is created. */
function boot(seed: Record<string, string> = {}) {
  storage = new FakeStorage();
  storageListeners = [];
  for (const [k, v] of Object.entries(seed)) storage.setItem(k, v);
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: (type: string, cb: (e: StorageEvent) => void) => {
      if (type === "storage") storageListeners.push(cb);
    },
    removeEventListener: () => {},
  });
}

/** Another tab writes the key, then this tab receives the `storage` event the browser would deliver. */
function foreignWrite(key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value));
  for (const cb of storageListeners) cb({ key } as StorageEvent);
}

const persisted = (key: string): string[] => JSON.parse(storage.getItem(key) ?? "[]");

beforeEach(() => boot());

describe("harness", () => {
  it("seeds storage before the store reads it (else every test here is vacuous)", () => {
    boot({ "cg-bookmarks": JSON.stringify(["5"]) });
    expect([...createStringSetStore("cg-bookmarks", DIGITS).read()]).toEqual(["5"]);
  });
});

describe("cross-tab safety (the bug: a second tab silently destroyed the first tab's data)", () => {
  it("a foreign write is not clobbered by this tab's next commit", () => {
    boot();
    const store = createStringSetStore("cg-bookmarks", DIGITS);
    store.subscribe(() => {}); // a mounted component — arms the `storage` listener

    foreignWrite("cg-bookmarks", ["5"]); // tab A bookmarks #5
    store.add("9"); // tab B bookmarks #9

    // Previously tab B rebuilt from its boot-time empty cache and committed ["9"], destroying #5.
    expect(persisted("cg-bookmarks")).toEqual(["5", "9"]);
  });

  it("re-reads on subscribe, so a write that landed while nothing was mounted is not lost", () => {
    boot();
    const store = createStringSetStore("cg-bookmarks", DIGITS);

    // No subscriber yet → the `storage` listener is not attached, so this event fires into a void.
    foreignWrite("cg-bookmarks", ["5"]);
    store.subscribe(() => {}); // now a component mounts

    expect([...store.read()]).toEqual(["5"]);
    store.add("9");
    expect(persisted("cg-bookmarks")).toEqual(["5", "9"]);
  });

  it("notifies subscribers when another tab changes the set", () => {
    boot();
    const store = createStringSetStore("cg-muted", NONEMPTY);
    let notified = 0;
    store.subscribe(() => notified++);

    foreignWrite("cg-muted", ["5Alice"]);

    expect(notified).toBe(1);
    expect([...store.read()]).toEqual(["5Alice"]);
  });
});

describe("validity is enforced on BOTH paths", () => {
  it("rejects an invalid member on WRITE (mute('') would render an empty address as muted)", () => {
    const store = createStringSetStore("cg-muted", NONEMPTY);
    store.add("");
    expect(store.read().has("")).toBe(false);
    expect(storage.getItem("cg-muted")).toBe(null);
  });

  it("drops junk on READ — the BigInt() crash guard that keeps /bookmarks alive", () => {
    boot({ "cg-bookmarks": JSON.stringify(["5", "not-an-id", "9"]) });
    const store = createStringSetStore("cg-bookmarks", DIGITS);
    expect([...store.read()]).toEqual(["5", "9"]);
    expect(() => [...store.read()].map((s) => BigInt(s))).not.toThrow();
  });

  it("survives corrupt JSON rather than throwing at import time", () => {
    boot({ "cg-bookmarks": "{not json" });
    expect([...createStringSetStore("cg-bookmarks", DIGITS).read()]).toEqual([]);
  });
});

describe("add / remove / toggle", () => {
  it("round-trips through storage", () => {
    const store = createStringSetStore("cg-bookmarks", DIGITS);
    store.add("5");
    expect(persisted("cg-bookmarks")).toEqual(["5"]);
    store.toggle("5");
    expect(persisted("cg-bookmarks")).toEqual([]);
    store.toggle("7");
    expect(persisted("cg-bookmarks")).toEqual(["7"]);
    store.remove("7");
    expect(persisted("cg-bookmarks")).toEqual([]);
  });

  it("is idempotent (a repeat add does not re-commit)", () => {
    const store = createStringSetStore("cg-bookmarks", DIGITS);
    let notified = 0;
    store.subscribe(() => notified++);
    store.add("5");
    store.add("5");
    expect(notified).toBe(1);
  });
});
