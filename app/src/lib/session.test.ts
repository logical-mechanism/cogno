import { describe, it, expect } from "vitest";
import { deriveSessionState, canWrite, voteCarriesWeight } from "./session";

const sig = (over = {}) => ({ deriving: false, postingEnabled: true, walletConnected: true, ...over });
const id = (over = {}) => ({ bound: null as boolean | null, binding: false, stakeBound: null as boolean | null, ...over });

describe("deriveSessionState — the write-gate machine", () => {
  it("connecting while a sign-to-derive is in flight (wins over everything)", () => {
    expect(deriveSessionState(sig({ deriving: true }), id({ bound: true }))).toBe("connecting");
  });

  it("disconnected when posting is not enabled", () => {
    expect(deriveSessionState(sig({ postingEnabled: false }), id())).toBe("disconnected");
  });

  it("binding while the CIP-8 bind is in flight", () => {
    expect(deriveSessionState(sig(), id({ binding: true }))).toBe("binding");
  });

  it("connected_unbound once derived but not yet bound", () => {
    expect(deriveSessionState(sig(), id({ bound: false }))).toBe("connected_unbound");
  });

  it("bound_no_stake when bound without a stake credential", () => {
    expect(deriveSessionState(sig(), id({ bound: true, stakeBound: false }))).toBe("bound_no_stake");
  });

  it("bound_staked when bound + stake-bound", () => {
    expect(deriveSessionState(sig(), id({ bound: true, stakeBound: true }))).toBe("bound_staked");
  });

  it("bound === null (loading) is treated as not-yet-writable", () => {
    expect(deriveSessionState(sig(), id({ bound: null }))).toBe("disconnected");
  });
});

describe("canWrite / voteCarriesWeight", () => {
  it("write is allowed for every bound state", () => {
    expect(canWrite("bound_no_stake")).toBe(true);
    expect(canWrite("bound_staked")).toBe(true);
    expect(canWrite("connected_unbound")).toBe(false);
    expect(canWrite("disconnected")).toBe(false);
  });

  it("votes carry weight only when stake-bound", () => {
    expect(voteCarriesWeight("bound_staked")).toBe(true);
    expect(voteCarriesWeight("bound_no_stake")).toBe(false);
  });
});
