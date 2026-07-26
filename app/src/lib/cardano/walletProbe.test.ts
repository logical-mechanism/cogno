// probeWalletIdentity — the no-popup check that a remembered session still belongs to the wallet's
// CURRENT account.
//
// The distinction it has to get right is `unavailable` vs `mismatch`, and both directions are a real
// bug if inverted:
//   • Reporting an auto-locked or uninstalled wallet as a MISMATCH would sign people out for closing
//     their wallet — worse than the problem the restore fixes.
//   • Reporting a genuinely switched account as UNAVAILABLE would leave the app rendering the wrong
//     handle, avatar and (because the device stores are ss58-keyed) the wrong block/mute lists.
//
// It must also never throw: it runs on the boot path, and the auth wall waits on it.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { probeWalletIdentity } from "./cip8";
import { seedCardanoNetwork } from "./network.fixture";
import { resetCardanoNetwork } from "./network";

type Injected = Record<string, unknown>;

function withCardano(cardano: Injected | undefined) {
  (globalThis as unknown as { window?: unknown }).window = { cardano };
}

const wallet = (over: Injected = {}): Injected => ({
  isEnabled: async () => true,
  enable: async () => ({
    getNetworkId: async () => 0,
    getChangeAddress: async () => "00ABCDEF",
  }),
  ...over,
});

// The expected network comes from the chain (lib/cardano/network.ts). Seed it, else every probe
// reports `unavailable` — which is the correct fail-closed answer, but not what these cases assert.
beforeEach(async () => {
  await seedCardanoNetwork(0);
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("probeWalletIdentity — confirms", () => {
  it("returns the change address, lowercased for a case-stable comparison", async () => {
    withCardano({ eternl: wallet() });
    expect(await probeWalletIdentity("eternl")).toEqual({ ok: true, addressHex: "00abcdef" });
  });
});

describe("probeWalletIdentity — inconclusive (`unavailable`: the session must SURVIVE)", () => {
  it("no window.cardano at all", async () => {
    withCardano(undefined);
    const p = await probeWalletIdentity("eternl");
    expect(p).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("the wallet is not installed any more", async () => {
    withCardano({ lace: wallet() });
    expect(await probeWalletIdentity("eternl")).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("this origin's grant has lapsed (isEnabled false)", async () => {
    withCardano({ eternl: wallet({ isEnabled: async () => false }) });
    expect(await probeWalletIdentity("eternl")).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("enable() rejects — a locked wallet the user dismissed", async () => {
    withCardano({
      eternl: wallet({
        enable: async () => {
          throw new Error("wallet is locked");
        },
      }),
    });
    expect(await probeWalletIdentity("eternl")).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("a hostile / broken injected getter throws", async () => {
    withCardano({
      get eternl(): never {
        throw new Error("boom");
      },
    } as Injected);
    expect(await probeWalletIdentity("eternl")).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("the wallet returns an incomplete API", async () => {
    withCardano({ eternl: wallet({ enable: async () => ({}) }) });
    expect(await probeWalletIdentity("eternl")).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("the wallet returns an empty change address", async () => {
    withCardano({
      eternl: wallet({
        enable: async () => ({ getNetworkId: async () => 0, getChangeAddress: async () => "" }),
      }),
    });
    expect(await probeWalletIdentity("eternl")).toMatchObject({ ok: false, kind: "unavailable" });
  });
});

describe("probeWalletIdentity — conclusive (`mismatch`: drop the session)", () => {
  it("a mainnet-flavoured wallet — it would derive a DIFFERENT posting key", async () => {
    withCardano({
      eternl: wallet({
        enable: async () => ({ getNetworkId: async () => 1, getChangeAddress: async () => "00ABCDEF" }),
      }),
    });
    const p = await probeWalletIdentity("eternl");
    expect(p).toMatchObject({ ok: false, kind: "mismatch" });
    expect(p.ok === false && p.reason).toMatch(/preprod|testnet/i);
  });
});

describe("probeWalletIdentity — an unresolved network must not disable the ACCOUNT check", () => {
  // The regression this pins: the probe reads a local injected extension, the chain's network arrives
  // over a WS handshake, so on a normal cold load the network is still unresolved when the probe runs.
  // Answering `unavailable` at that point returned before the change address was ever read, which made
  // the account-switch detection a no-op on essentially every reload — the exact hole the probe exists
  // to close. The network is inconclusive; the ADDRESS is not.
  it("still returns the change address when the chain has not named a network yet", async () => {
    resetCardanoNetwork();
    withCardano({
      eternl: wallet({
        enable: async () => ({ getNetworkId: async () => 0, getChangeAddress: async () => "00ABCDEF" }),
      }),
    });
    expect(await probeWalletIdentity("eternl")).toEqual({ ok: true, addressHex: "00abcdef" });
  });

  it("and still returns it for a wallet whose network we cannot judge", async () => {
    resetCardanoNetwork();
    withCardano({
      eternl: wallet({
        enable: async () => ({ getNetworkId: async () => 1, getChangeAddress: async () => "00FEEDFACE" }),
      }),
    });
    // Not `mismatch`: nothing to compare against. The caller compares this against the remembered
    // address, which is what conclusively catches a wallet that moved.
    expect(await probeWalletIdentity("eternl")).toEqual({ ok: true, addressHex: "00feedface" });
  });
});

describe("probeWalletIdentity — never throws", () => {
  it("resolves rather than rejecting on any of the failure shapes above", async () => {
    withCardano({ eternl: { isEnabled: 42, enable: null } as Injected });
    await expect(probeWalletIdentity("eternl")).resolves.toMatchObject({ ok: false });
  });
});
