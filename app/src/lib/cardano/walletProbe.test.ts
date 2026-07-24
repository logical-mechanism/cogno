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

import { describe, it, expect, afterEach, vi } from "vitest";
import { probeWalletIdentity } from "./cip8";

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

describe("probeWalletIdentity — never throws", () => {
  it("resolves rather than rejecting on any of the failure shapes above", async () => {
    withCardano({ eternl: { isEnabled: 42, enable: null } as Injected });
    await expect(probeWalletIdentity("eternl")).resolves.toMatchObject({ ok: false });
  });
});
