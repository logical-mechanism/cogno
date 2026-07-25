// Guards the per-account draft bucketing. The draft is the most sensitive device-local item — words the
// author has NOT chosen to publish — so the cross-account paths are the point of these tests.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPostDraft,
  savePostDraft,
  clearPostDraft,
  clearAllPostDrafts,
} from "./composerDraftStore";

const ALICE = "5Alice";
const BOB = "5Bob";

class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key = (i: number) => [...this.map.keys()][i] ?? null;
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

describe("per-account bucketing", () => {
  it("keeps two accounts' drafts apart on one device", () => {
    savePostDraft(ALICE, "alice's unsent thought");
    savePostDraft(BOB, "bob's unsent thought");
    expect(loadPostDraft(ALICE)).toBe("alice's unsent thought");
    expect(loadPostDraft(BOB)).toBe("bob's unsent thought");
  });

  it("does not leak one account's draft to another, or to the signed-out bucket", () => {
    savePostDraft(ALICE, "secret");
    expect(loadPostDraft(BOB)).toBe("");
    expect(loadPostDraft(null)).toBe("");
  });

  it("gives signed-out composing its own bucket", () => {
    savePostDraft(null, "guest draft");
    expect(loadPostDraft(null)).toBe("guest draft");
    expect(loadPostDraft(ALICE)).toBe("");
  });

  it("clears only the named account's draft", () => {
    savePostDraft(ALICE, "a");
    savePostDraft(BOB, "b");
    clearPostDraft(ALICE);
    expect(loadPostDraft(ALICE)).toBe("");
    expect(loadPostDraft(BOB)).toBe("b");
  });
});

describe("empty drafts do not linger", () => {
  it("removes the key for an empty or whitespace-only draft", () => {
    savePostDraft(ALICE, "something");
    savePostDraft(ALICE, "   ");
    expect(loadPostDraft(ALICE)).toBe("");
    expect(storage.getItem("cg:draft:post:5Alice")).toBeNull();
  });
});

describe("clearAllPostDrafts (sign-out)", () => {
  it("clears EVERY account bucket, not just the one signing out", () => {
    // Sign-out cannot know who else has used this browser, which is the whole reason it enumerates.
    savePostDraft(ALICE, "a");
    savePostDraft(BOB, "b");
    savePostDraft(null, "guest");
    clearAllPostDrafts();
    expect(loadPostDraft(ALICE)).toBe("");
    expect(loadPostDraft(BOB)).toBe("");
    expect(loadPostDraft(null)).toBe("");
  });

  it("also clears the PRE-BUCKETING device-global key", () => {
    // Upgrading users have a draft under the bare key; leaving it would strand unsent words forever.
    storage.setItem("cg:draft:post", "legacy unsent text");
    clearAllPostDrafts();
    expect(storage.getItem("cg:draft:post")).toBeNull();
  });

  it("leaves unrelated keys alone", () => {
    storage.setItem("cg-bookmarks:5Alice", '["1"]');
    storage.setItem("cg-theme", "dark");
    savePostDraft(ALICE, "a");
    clearAllPostDrafts();
    expect(storage.getItem("cg-bookmarks:5Alice")).toBe('["1"]');
    expect(storage.getItem("cg-theme")).toBe("dark");
  });
});

describe("storage failures degrade quietly", () => {
  it("returns '' and does not throw when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
        get length(): number {
          throw new Error("blocked");
        },
        key: () => null,
      },
    });
    expect(loadPostDraft(ALICE)).toBe("");
    expect(() => savePostDraft(ALICE, "x")).not.toThrow();
    expect(() => clearPostDraft(ALICE)).not.toThrow();
    expect(() => clearAllPostDrafts()).not.toThrow();
  });
});
