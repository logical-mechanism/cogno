// Guards the per-account draft bucketing. The draft is the most sensitive device-local item — words the
// author has NOT chosen to publish — so the cross-account paths are the point of these tests.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPostDraft,
  savePostDraft,
  clearPostDraft,
  clearAllPostDrafts,
} from "./composerDraftStore";
import type { Ss58 } from "./types";

const ALICE = "5Alice";
const BOB = "5Bob";

/** Real, checksum-valid ss58s: `loadPostDraft` re-validates every stored ref. */
const REF_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as Ss58;
const REF_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" as Ss58;

/** The draft text only, for the bucketing cases that predate the mention registry. */
const textOf = (who: string | null) => loadPostDraft(who).text;

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
    expect(textOf(ALICE)).toBe("alice's unsent thought");
    expect(textOf(BOB)).toBe("bob's unsent thought");
  });

  it("does not leak one account's draft to another, or to the signed-out bucket", () => {
    savePostDraft(ALICE, "secret");
    expect(textOf(BOB)).toBe("");
    expect(textOf(null)).toBe("");
  });

  it("gives signed-out composing its own bucket", () => {
    savePostDraft(null, "guest draft");
    expect(textOf(null)).toBe("guest draft");
    expect(textOf(ALICE)).toBe("");
  });

  it("clears only the named account's draft", () => {
    savePostDraft(ALICE, "a");
    savePostDraft(BOB, "b");
    clearPostDraft(ALICE);
    expect(textOf(ALICE)).toBe("");
    expect(textOf(BOB)).toBe("b");
  });
});

describe("empty drafts do not linger", () => {
  it("removes the key for an empty or whitespace-only draft", () => {
    savePostDraft(ALICE, "something");
    savePostDraft(ALICE, "   ");
    expect(textOf(ALICE)).toBe("");
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
    expect(textOf(ALICE)).toBe("");
    expect(textOf(BOB)).toBe("");
    expect(textOf(null)).toBe("");
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

// F6. The composer holds friendly `@Bob` DISPLAY tokens and a parallel registry that binds each one to
// an ss58; `serializeMentions` expands them at submit. Persisting the TEXT alone brought a draft back
// with an empty registry, so `serialize` became the identity function and pressing Post wrote the
// literal `@Bob` to a chain with no `delete_post`.
describe("the mention registry survives a restore", () => {
  it("round-trips the bindings alongside the text", () => {
    savePostDraft(ALICE, "hey @Bob and @Carol", [
      { ss58: REF_A, display: "Bob" },
      { ss58: REF_B, display: "Carol" },
    ]);
    const back = loadPostDraft(ALICE);
    expect(back.text).toBe("hey @Bob and @Carol");
    expect(back.mentions).toEqual([
      { ss58: REF_A, display: "Bob" },
      { ss58: REF_B, display: "Carol" },
    ]);
  });

  it("drops a ref whose token is no longer in the text", () => {
    // A save can be handed a snapshot from a beat before the prune; a stale ref must not outlive it.
    savePostDraft(ALICE, "hey @Bob", [
      { ss58: REF_A, display: "Bob" },
      { ss58: REF_B, display: "Carol" },
    ]);
    expect(loadPostDraft(ALICE).mentions).toEqual([{ ss58: REF_A, display: "Bob" }]);
  });

  it("drops a hand-edited ref that is not a valid ss58", () => {
    // This value decides which ACCOUNT a permanent post credits, so every ref is re-validated on read.
    storage.setItem(
      "cg:draft:post:5Alice",
      JSON.stringify({ v: 1, t: "hey @Bob", m: [{ s: "not-an-address", d: "Bob" }] }),
    );
    const back = loadPostDraft(ALICE);
    expect(back.text).toBe("hey @Bob"); // the token degrades to plain text, which is the safe direction
    expect(back.mentions).toEqual([]);
  });

  it("reads a PRE-envelope draft as plain text rather than losing it", () => {
    // Everything written before the registry existed is a bare string under this key.
    storage.setItem("cg:draft:post:5Alice", "words I had not sent yet");
    expect(loadPostDraft(ALICE)).toEqual({ text: "words I had not sent yet", mentions: [] });
  });

  it("does not mistake a draft that happens to be valid JSON for an envelope", () => {
    storage.setItem("cg:draft:post:5Alice", '{"a":1}');
    expect(loadPostDraft(ALICE).text).toBe('{"a":1}');
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
    expect(textOf(ALICE)).toBe("");
    expect(() => savePostDraft(ALICE, "x")).not.toThrow();
    expect(() => clearPostDraft(ALICE)).not.toThrow();
    expect(() => clearAllPostDrafts()).not.toThrow();
  });
});
