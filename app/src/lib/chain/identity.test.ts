// Pure-logic tests for the FEELESS, BARE (unsigned) bind submitters (spec 116). The CIP-8 binds carry
// no fee and no signing account, so the frontend builds the bare extrinsic with `tx.getBareTx()` and
// broadcasts it with the low-level `client.submit`. PAPI's api + client are mocked so the submit/parse
// logic runs in isolation (no node, no relay — the Sponsored-Bind Relay is gone). The contract under
// test: the bare tx bytes are what gets broadcast; the bound credential is read from the chain event;
// a dispatch error or a thrown submit is surfaced as ok:false (never thrown).

import { describe, it, expect, vi } from "vitest";
import { submitLinkIdentityFeeless, submitLinkStakeFeeless } from "./identity";
import type { CognoApi } from "@/lib/types";
import type { PolkadotClient } from "polkadot-api";

const SIGN1 = "ab".repeat(80); // 80-byte cose_sign1 (within the 512 bound)
const KEY = "cd".repeat(40); // 40-byte cose_key (within the 128 bound)
const BARE_TX = "0x05deadbeef"; // a stand-in bare (unsigned, v5) extrinsic hex

// PAPI v2: fixed-size [u8;N] event fields decode to a 0x-hex string (not a Binary with `.asHex()`).
const LINKED_EVENT = {
  type: "CognoGate",
  value: { type: "IdentityLinked", value: { identity: "0xfeed" } },
};
const STAKE_LINKED_EVENT = {
  type: "CognoGate",
  value: { type: "StakeLinked", value: { who: "5GxAccount", stake_cred: "0xc1c1c1" } },
};

/** A mock typed api whose `tx.CognoGate.<call>(...).getBareTx()` resolves to {@link BARE_TX}. */
function mockApi(call: "link_identity_signed" | "link_stake_signed") {
  const getBareTx = vi.fn(async () => BARE_TX);
  const build = vi.fn(() => ({ getBareTx }));
  const api = { tx: { CognoGate: { [call]: build } } } as unknown as CognoApi;
  return { api, build, getBareTx };
}

/** A mock low-level client whose `submit(hex)` resolves to the given finalized payload. */
function mockClient(result: unknown) {
  const submit = vi.fn(async () => result);
  return { client: { submit } as unknown as PolkadotClient, submit };
}

describe("submitLinkIdentityFeeless", () => {
  it("broadcasts the bare (unsigned) tx and returns the identity from the IdentityLinked event", async () => {
    const { api } = mockApi("link_identity_signed");
    const { client, submit } = mockClient({ ok: true, events: [LINKED_EVENT] });
    const r = await submitLinkIdentityFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(true);
    expect(r.identityHash).toBe("0xfeed");
    // the EXACT bytes broadcast are the bare extrinsic — no signature, no fee path.
    expect(submit).toHaveBeenCalledWith(BARE_TX);
  });

  it("surfaces a dispatch error (e.g. IdentityTombstoned) instead of throwing", async () => {
    const { api } = mockApi("link_identity_signed");
    const { client } = mockClient({ ok: false, dispatchError: { type: "IdentityTombstoned", value: undefined } });
    const r = await submitLinkIdentityFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("IdentityTombstoned");
  });

  it("ok but with no IdentityLinked event ⇒ ok with undefined identity (never throws)", async () => {
    const { api } = mockApi("link_identity_signed");
    const { client } = mockClient({ ok: true, events: [] });
    const r = await submitLinkIdentityFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(true);
    expect(r.identityHash).toBeUndefined();
  });

  it("returns ok:false (never throws) when the broadcast itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { api } = mockApi("link_identity_signed");
    const client = { submit: vi.fn(async () => { throw new Error("node down"); }) } as unknown as PolkadotClient;
    const r = await submitLinkIdentityFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("node down");
    vi.restoreAllMocks();
  });
});

describe("submitLinkStakeFeeless", () => {
  it("broadcasts the bare tx and returns the bound stake credential from the StakeLinked event", async () => {
    const { api } = mockApi("link_stake_signed");
    const { client, submit } = mockClient({ ok: true, events: [STAKE_LINKED_EVENT] });
    const r = await submitLinkStakeFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(true);
    expect(r.stakeCredHex).toBe("0xc1c1c1");
    expect(submit).toHaveBeenCalledWith(BARE_TX);
  });

  it("surfaces a dispatch error (e.g. NotPaymentBound) instead of throwing", async () => {
    const { api } = mockApi("link_stake_signed");
    const { client } = mockClient({ ok: false, dispatchError: { type: "NotPaymentBound", value: undefined } });
    const r = await submitLinkStakeFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("NotPaymentBound");
  });

  it("ok but with no StakeLinked event ⇒ ok with undefined credential (never throws)", async () => {
    const { api } = mockApi("link_stake_signed");
    const { client } = mockClient({ ok: true, events: [] });
    const r = await submitLinkStakeFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(true);
    expect(r.stakeCredHex).toBeUndefined();
  });

  it("returns ok:false (never throws) when the broadcast itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { api } = mockApi("link_stake_signed");
    const client = { submit: vi.fn(async () => { throw new Error("node down"); }) } as unknown as PolkadotClient;
    const r = await submitLinkStakeFeeless(client, api, SIGN1, KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("node down");
    vi.restoreAllMocks();
  });
});
