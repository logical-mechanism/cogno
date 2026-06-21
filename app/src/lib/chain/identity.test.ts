// Pure-logic tests for the D1 bind-funding paths: the Sponsored-Bind Relay POST, the balance-aware
// self-vs-relay decision (canSelfPayBind), and the orchestrator (submitBindSponsored). fetch and the
// PAPI api are mocked so the decision logic runs in isolation (no node, no relay). The trust contract
// under test: a zero-balance derived account is routed through the relay; a funded one self-submits.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  submitBindViaRelay,
  canSelfPayBind,
  submitBindSponsored,
  submitLinkStakeSigned,
  submitStakeBindViaRelay,
  canSelfPayStakeBind,
  submitStakeBindSponsored,
} from "./identity";
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
// with getEstimatedFees + signAndSubmit (one shared tx object so both methods are observable). `ed`,
// when provided, wires constants.Balances.ExistentialDeposit (omitted ⇒ canSelfPayBind treats ED as 0).
function mockApi({ free = 0n, fee = 1_000n, ed, submit }: { free?: bigint; fee?: bigint; ed?: bigint; submit?: unknown } = {}): CognoApi {
  const tx = {
    getEstimatedFees: vi.fn(async () => fee),
    signAndSubmit: vi.fn(async () => submit ?? { ok: true, events: [LINKED_EVENT] }),
  };
  const api: Record<string, unknown> = {
    query: { System: { Account: { getValue: vi.fn(async () => ({ data: { free } })) } } },
    tx: { CognoGate: { link_identity_signed: vi.fn(() => tx) } },
  };
  if (ed !== undefined) api.constants = { Balances: { ExistentialDeposit: vi.fn(async () => ed) } };
  return api as unknown as CognoApi;
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
  it("false when the fee would dust the account below the existential deposit (routes to relay)", async () => {
    expect(await canSelfPayBind(mockApi({ free: 1_500n, fee: 1_000n, ed: 1_000n }), signer, SIGN1, KEY)).toBe(false);
  });
  it("true when free balance covers fee + ED", async () => {
    expect(await canSelfPayBind(mockApi({ free: 2_500n, fee: 1_000n, ed: 1_000n }), signer, SIGN1, KEY)).toBe(true);
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

// The stake (voting-power) bind, SELF-PAY leg: submit `link_stake_signed` and surface the bound
// credential from the StakeLinked event. This is the path taken when the account can cover its own
// fee; a zero-balance account routes through the /bind-stake relay instead — the balance-aware
// decision + relay POST are covered by the submitStakeBind* describe blocks below.
const STAKE_LINKED_EVENT = {
  type: "CognoGate",
  value: { type: "StakeLinked", value: { who: "5GxAccount", stake_cred: { asHex: () => "0xc1c1c1" } } },
};

function stakeApi(submit?: unknown): CognoApi {
  const tx = { signAndSubmit: vi.fn(async () => submit ?? { ok: true, events: [STAKE_LINKED_EVENT] }) };
  return { tx: { CognoGate: { link_stake_signed: vi.fn(() => tx) } } } as unknown as CognoApi;
}

describe("submitLinkStakeSigned", () => {
  it("submits and returns the bound stake credential from the StakeLinked event", async () => {
    const r = await submitLinkStakeSigned(stakeApi(), signer, SIGN1, KEY);
    expect(r.ok).toBe(true);
    expect(r.stakeCredHex).toBe("0xc1c1c1");
  });

  it("surfaces a dispatch error (e.g. NotPaymentBound) instead of throwing", async () => {
    const r = await submitLinkStakeSigned(
      stakeApi({ ok: false, dispatchError: { type: "NotPaymentBound", value: undefined } }),
      signer,
      SIGN1,
      KEY,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("NotPaymentBound");
  });

  it("ok but with no StakeLinked event ⇒ ok with undefined credential (never throws)", async () => {
    const r = await submitLinkStakeSigned(stakeApi({ ok: true, events: [] }), signer, SIGN1, KEY);
    expect(r.ok).toBe(true);
    expect(r.stakeCredHex).toBeUndefined();
  });

  it("returns ok:false (never throws) when the submission itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = {
      tx: { CognoGate: { link_stake_signed: vi.fn(() => ({ signAndSubmit: vi.fn(async () => { throw new Error("node down"); }) })) } },
    } as unknown as CognoApi;
    const r = await submitLinkStakeSigned(api, signer, SIGN1, KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("node down");
  });
});

// The sponsored STAKE (voting-power) bind: the balance-aware self-vs-relay decision for
// link_stake_signed. Mirrors the identity bind's sponsor path — a zero-balance derived account (every
// browser user: posts feelessly, bound its identity through the relay) is routed through /bind-stake.
function mockStakeApi({ free = 0n, fee = 1_000n, ed, submit }: { free?: bigint; fee?: bigint; ed?: bigint; submit?: unknown } = {}): CognoApi {
  const tx = {
    getEstimatedFees: vi.fn(async () => fee),
    signAndSubmit: vi.fn(async () => submit ?? { ok: true, events: [STAKE_LINKED_EVENT] }),
  };
  const api: Record<string, unknown> = {
    query: { System: { Account: { getValue: vi.fn(async () => ({ data: { free } })) } } },
    tx: { CognoGate: { link_stake_signed: vi.fn(() => tx) } },
  };
  if (ed !== undefined) api.constants = { Balances: { ExistentialDeposit: vi.fn(async () => ed) } };
  return api as unknown as CognoApi;
}

describe("submitStakeBindViaRelay", () => {
  it("POSTs the proof to <relay>/bind-stake (no thread) and returns the 0x-normalized stake credential", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, stake_cred: "0xc1c1c1" }), { status: 200 }));
    const r = await submitStakeBindViaRelay("http://relay:8091/", SIGN1, KEY, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.stakeCredHex).toBe("0xc1c1c1");
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("http://relay:8091/bind-stake");
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    // link_stake_signed takes NO thread pointer — the body carries only the two COSE blobs.
    expect(JSON.parse(init.body)).toEqual({ cose_sign1: SIGN1, cose_key: KEY });
  });

  it("normalizes a bare-hex stake_cred from the relay to 0x-prefixed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, stake_cred: "c1c1c1" }), { status: 200 }));
    const r = await submitStakeBindViaRelay("http://relay", SIGN1, KEY, fetchImpl as unknown as typeof fetch);
    expect(r.stakeCredHex).toBe("0xc1c1c1");
  });

  it("surfaces a relay-reported chain error (e.g. NotPaymentBound)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: "Module.CognoGate.NotPaymentBound" }), { status: 422 }),
    );
    const r = await submitStakeBindViaRelay("http://relay", SIGN1, KEY, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("NotPaymentBound");
  });

  it("reports the status when a non-ok response has no usable body", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 502 }));
    const r = await submitStakeBindViaRelay("http://relay", SIGN1, KEY, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("502");
  });

  it("reports a network failure as unreachable (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await submitStakeBindViaRelay("http://relay", SIGN1, KEY, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not reach the sponsored-bind relay");
  });
});

describe("canSelfPayStakeBind", () => {
  it("false when the balance is 0 (a fresh sign-to-derived account)", async () => {
    expect(await canSelfPayStakeBind(mockStakeApi({ free: 0n }), signer, SIGN1, KEY)).toBe(false);
  });
  it("true when free balance covers the estimated fee", async () => {
    expect(await canSelfPayStakeBind(mockStakeApi({ free: 10_000n, fee: 1_000n }), signer, SIGN1, KEY)).toBe(true);
  });
  it("false when free balance is below the estimated fee", async () => {
    expect(await canSelfPayStakeBind(mockStakeApi({ free: 500n, fee: 1_000n }), signer, SIGN1, KEY)).toBe(false);
  });
  it("false when the fee would dust the account below the existential deposit (routes to relay)", async () => {
    expect(await canSelfPayStakeBind(mockStakeApi({ free: 1_500n, fee: 1_000n, ed: 1_000n }), signer, SIGN1, KEY)).toBe(false);
  });
});

describe("submitStakeBindSponsored", () => {
  it("self-submits and tags via:self when the account can pay its own fee", async () => {
    const r = await submitStakeBindSponsored(mockStakeApi({ free: 10_000n, fee: 1_000n }), signer, SIGN1, KEY, "http://relay");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("self");
    expect(r.stakeCredHex).toBe("0xc1c1c1");
  });

  it("routes a zero-balance account through the relay and tags via:relay", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, stake_cred: "0xc1c1c1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const r = await submitStakeBindSponsored(mockStakeApi({ free: 0n }), signer, SIGN1, KEY, "http://relay");
    expect(r.via).toBe("relay");
    expect(r.ok).toBe(true);
    expect(r.stakeCredHex).toBe("0xc1c1c1");
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("http://relay/bind-stake");
  });

  it("errors clearly when it can't self-pay and no relay is configured", async () => {
    const r = await submitStakeBindSponsored(mockStakeApi({ free: 0n }), signer, SIGN1, KEY, "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no sponsored-bind relay");
  });
});
