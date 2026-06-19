// Pure-logic tests for the D1 bind-funding paths: the Sponsored-Bind Relay POST, the balance-aware
// self-vs-relay decision (canSelfPayBind), and the orchestrator (submitBindSponsored). fetch and the
// PAPI api are mocked so the decision logic runs in isolation (no node, no relay). The trust contract
// under test: a zero-balance derived account is routed through the relay; a funded one self-submits.

import { describe, it, expect, vi, afterEach } from "vitest";
import { submitBindViaRelay, canSelfPayBind, submitBindSponsored } from "./identity";
import type { CognoApi, PostingSigner } from "@/lib/types";

const SIGN1 = "ab".repeat(80); // 80-byte cose_sign1 (within the 512 bound)
const KEY = "cd".repeat(40); // 40-byte cose_key (within the 128 bound)

const signer = {
  ss58: "5GxAccount",
  publicKeyHex: "0x" + "11".repeat(32),
  label: "x",
  kind: "derived",
  signer: {},
} as unknown as PostingSigner;

// The default signAndSubmit result: an ok tx carrying a CognoGate.IdentityLinked event.
const LINKED_EVENT = {
  type: "CognoGate",
  value: { type: "IdentityLinked", value: { identity: { asHex: () => "0xfeed" } } },
};

// A mock typed api: System.Account.getValue → { data: { free } }; link_identity_signed(...) → a tx
// with getEstimatedFees + signAndSubmit (one shared tx object so both methods are observable).
function mockApi({ free = 0n, fee = 1_000n, submit }: { free?: bigint; fee?: bigint; submit?: unknown } = {}): CognoApi {
  const tx = {
    getEstimatedFees: vi.fn(async () => fee),
    signAndSubmit: vi.fn(async () => submit ?? { ok: true, events: [LINKED_EVENT] }),
  };
  return {
    query: { System: { Account: { getValue: vi.fn(async () => ({ data: { free } })) } } },
    tx: { CognoGate: { link_identity_signed: vi.fn(() => tx) } },
  } as unknown as CognoApi;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("submitBindViaRelay", () => {
  it("POSTs the proof to <relay>/bind and returns the identity on ok", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, identity: "0xabc" }), { status: 200 }));
    const r = await submitBindViaRelay("http://relay:8091/", SIGN1, KEY, undefined, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.identityHash).toBe("0xabc");
    // trailing slash trimmed, /bind appended
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("http://relay:8091/bind");
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ cose_sign1: SIGN1, cose_key: KEY, thread_pointer: undefined });
  });

  it("surfaces a relay-reported chain error (e.g. tombstoned)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: "Module.CognoGate.IdentityTombstoned" }), { status: 422 }),
    );
    const r = await submitBindViaRelay("http://relay", SIGN1, KEY, undefined, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("IdentityTombstoned");
  });

  it("reports the status when a non-ok response has no usable body", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 502 }));
    const r = await submitBindViaRelay("http://relay", SIGN1, KEY, undefined, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("502");
  });

  it("reports a network failure as unreachable (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await submitBindViaRelay("http://relay", SIGN1, KEY, undefined, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not reach the sponsored-bind relay");
  });
});

describe("canSelfPayBind", () => {
  it("false when the balance is 0 (a fresh sign-to-derived account)", async () => {
    expect(await canSelfPayBind(mockApi({ free: 0n }), signer, SIGN1, KEY)).toBe(false);
  });
  it("true when free balance covers the estimated fee", async () => {
    expect(await canSelfPayBind(mockApi({ free: 10_000n, fee: 1_000n }), signer, SIGN1, KEY)).toBe(true);
  });
  it("false when free balance is below the estimated fee", async () => {
    expect(await canSelfPayBind(mockApi({ free: 500n, fee: 1_000n }), signer, SIGN1, KEY)).toBe(false);
  });
  it("false (not throw) when the balance read fails", async () => {
    const api = {
      query: { System: { Account: { getValue: vi.fn(async () => { throw new Error("node down"); }) } } },
      tx: { CognoGate: { link_identity_signed: vi.fn() } },
    } as unknown as CognoApi;
    expect(await canSelfPayBind(api, signer, SIGN1, KEY)).toBe(false);
  });
});

describe("submitBindSponsored", () => {
  it("self-submits and tags via:self when the account can pay its own fee", async () => {
    const r = await submitBindSponsored(mockApi({ free: 10_000n, fee: 1_000n }), signer, SIGN1, KEY, "http://relay");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("self");
    expect(r.identityHash).toBe("0xfeed");
  });

  it("routes a zero-balance account through the relay and tags via:relay", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, identity: "0xabc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const r = await submitBindSponsored(mockApi({ free: 0n }), signer, SIGN1, KEY, "http://relay");
    expect(r.via).toBe("relay");
    expect(r.ok).toBe(true);
    expect(r.identityHash).toBe("0xabc");
  });

  it("errors clearly when it can't self-pay and no relay is configured", async () => {
    const r = await submitBindSponsored(mockApi({ free: 0n }), signer, SIGN1, KEY, "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no sponsored-bind relay");
  });
});
