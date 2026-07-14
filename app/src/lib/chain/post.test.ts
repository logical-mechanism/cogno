// Pure-logic tests for the write path's event extraction, error mapping, and phase ordering.
// watchTx is driven by a hand-rolled "submit" factory so we can replay an exact event sequence
// and assert the honest phase stream (signed -> broadcast -> inBestBlock/invalid -> finalized/error)
// without a chain. The id extraction is load-bearing for the UI.
//
// Error classification moved to errors.test.ts — along with a CORRECTED module-error fixture. The one
// that lived here invented the shape (`value.error` as a string) and passed only because the old code
// JSON-stringified the value blindly.

import { describe, it, expect, vi, afterEach } from "vitest";
import { extractPostId, watchTx } from "./post";
import type { TxUpdate } from "@/lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

// A minimal ChainEvent shape matching post.ts's internal reader.
const microblogEvent = (type: string, value: Record<string, unknown>) => ({
  type: "Microblog",
  value: { type, value },
});

describe("extractPostId", () => {
  it("extracts the id from a PostCreated event", () => {
    const events = [microblogEvent("PostCreated", { id: 42n, author: "x" })];
    expect(extractPostId(events as never, "PostCreated")).toBe(42n);
  });

  it("returns undefined when the events array is absent (e.g. a failed tx)", () => {
    expect(extractPostId(undefined, "PostCreated")).toBeUndefined();
  });

  it("returns undefined when no Microblog event of the wanted name is present", () => {
    const events = [
      { type: "System", value: { type: "ExtrinsicSuccess", value: {} } },
      microblogEvent("VoteCleared", { id: 9n }), // a different Microblog event — not the one queried
    ];
    expect(extractPostId(events as never, "PostCreated")).toBeUndefined();
  });

  it("returns undefined when the id is malformed (not a bigint)", () => {
    const events = [microblogEvent("PostCreated", { id: 42 })]; // number, not bigint
    expect(extractPostId(events as never, "PostCreated")).toBeUndefined();
  });

  it("does not pick up a same-named event from a different pallet", () => {
    const events = [{ type: "SomethingElse", value: { type: "PostCreated", value: { id: 1n } } }];
    expect(extractPostId(events as never, "PostCreated")).toBeUndefined();
  });
});

// ── watchTx: drive an exact event sequence and assert the emitted phase stream ───────────────────

/** Build a one-shot "submit" factory that replays `events` then completes (or errors). */
function fakeSubmit(events: unknown[], opts: { errorWith?: unknown } = {}) {
  return () => ({
    subscribe(o: {
      next: (e: unknown) => void;
      error: (err: unknown) => void;
      complete: () => void;
    }) {
      // Synchronous replay keeps the test deterministic (no fake timers needed).
      for (const e of events) o.next(e);
      if ("errorWith" in opts) o.error(opts.errorWith);
      else o.complete();
      return { unsubscribe: () => {} };
    },
  });
}

function collect(events: unknown[], opts?: { errorWith?: unknown }): Promise<TxUpdate[]> {
  return new Promise((resolve) => {
    const out: TxUpdate[] = [];
    watchTx(fakeSubmit(events, opts) as never, "PostCreated").subscribe({
      next: (u) => out.push(u),
      error: () => resolve(out),
      complete: () => resolve(out),
    });
  });
}

describe("watchTx — honest phase ordering", () => {
  it("emits signing -> broadcast -> inBestBlock -> finalized for a successful tx", async () => {
    const out = await collect([
      { type: "signed", txHash: "0xabc" },
      { type: "broadcasted", txHash: "0xabc" },
      {
        type: "txBestBlocksState",
        found: true,
        ok: true,
        txHash: "0xabc",
        block: { number: 100, hash: "0xb", index: 0 },
        events: [microblogEvent("PostCreated", { id: 5n })],
      },
      {
        type: "finalized",
        ok: true,
        txHash: "0xabc",
        block: { number: 100, hash: "0xb", index: 0 },
        events: [microblogEvent("PostCreated", { id: 5n })],
      },
    ]);
    expect(out.map((u) => u.phase)).toEqual(["signing", "broadcast", "inBestBlock", "finalized"]);
    const inBlock = out.find((u) => u.phase === "inBestBlock")!;
    expect(inBlock.postId).toBe(5n);
    expect(inBlock.blockNumber).toBe(100);
    const fin = out.find((u) => u.phase === "finalized")!;
    expect(fin.finalized).toBe(true);
    expect(fin.postId).toBe(5n);
  });

  it("SILENTLY SKIPS a txBestBlocksState with found:false (dropped from best chain)", async () => {
    const out = await collect([
      { type: "signed" },
      { type: "txBestBlocksState", found: false }, // re-org drop — must NOT emit a phase
      {
        type: "txBestBlocksState",
        found: true,
        ok: true,
        block: { number: 200, hash: "0xb", index: 0 },
        events: [microblogEvent("PostCreated", { id: 8n })],
      },
    ]);
    // No phase for the dropped state: signing then inBestBlock only.
    expect(out.map((u) => u.phase)).toEqual(["signing", "inBestBlock"]);
    expect(out[1].postId).toBe(8n);
  });

  it("maps an included-but-dispatch-failed best block to 'invalid' with the dispatch error", async () => {
    const out = await collect([
      { type: "signed" },
      {
        type: "txBestBlocksState",
        found: true,
        ok: false,
        block: { number: 300, hash: "0xb", index: 0 },
        // The REAL decoded shape (a three-level tagged enum), not the invented `value.error` string
        // this fixture used to carry. See errors.test.ts.
        dispatchError: { type: "Module", value: { type: "Microblog", value: { type: "TooLong" } } },
      },
    ]);
    const invalid = out.find((u) => u.phase === "invalid")!;
    expect(invalid).toBeDefined();
    expect(invalid.error).toEqual({ kind: "module", pallet: "Microblog", name: "TooLong" });
    expect(invalid.blockNumber).toBe(300);
  });

  it("maps a dispatch-failed finalized block to 'error'", async () => {
    const out = await collect([
      { type: "signed" },
      {
        type: "finalized",
        ok: false,
        block: { number: 400, hash: "0xb", index: 0 },
        dispatchError: { type: "BadOrigin", value: null },
      },
    ]);
    const err = out.find((u) => u.phase === "error")!;
    expect(err).toBeDefined();
    expect(err.error).toEqual({ kind: "raw", detail: "BadOrigin" });
  });

  it("logs and emits a single 'error' phase on a stream error (signer rejection / network)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await collect([{ type: "signed" }], { errorWith: new Error("user rejected") });
    expect(out.map((u) => u.phase)).toEqual(["signing", "error"]);
    expect(out[1].error).toEqual({ kind: "raw", detail: "user rejected" });
    // The audit gap: a failed submission must be logged with context, not silently swallowed.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toContain("PostCreated");
  });

  it("does not extract a postId from a malformed/empty events array (falls back to undefined)", async () => {
    const out = await collect([
      { type: "signed" },
      { type: "txBestBlocksState", found: true, ok: true, block: { number: 1, hash: "0x", index: 0 } },
    ]);
    const inBlock = out.find((u) => u.phase === "inBestBlock")!;
    expect(inBlock.postId).toBeUndefined();
  });
});
