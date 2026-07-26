// The Cardano network is resolved from the chain, and everything Cardano-facing fails closed until it
// is. These tests pin the three things that make that safe:
//   • the two-pallet cross-check (a runtime that flips CognoGate but not CardanoRoles names no network)
//   • unresolved is INCONCLUSIVE, never a mismatch — the session-restore probe drops sessions on
//     `mismatch`, so getting this backwards would sign people out during boot
//   • the shared message keeps the token the connect-step classifier matches on
//
// The Blockfrost project id is mocked because flavor (preprod vs preview) is the one thing the chain
// constant cannot express — network id 0 covers both.

import { describe, it, expect, beforeEach, vi } from "vitest";

let projectId = "";
vi.mock("@/lib/config/endpoints", () => ({
  getBlockfrostProjectId: () => projectId,
}));

import {
  resolveCardanoNetwork,
  resetCardanoNetwork,
  getCardanoNetworkId,
  requireCardanoNetworkId,
  checkWalletNetwork,
  assertWalletNetwork,
  wrongNetworkMessage,
  providerNetworkMismatch,
  cardanoFlavor,
  effectiveFlavor,
  blockfrostBase,
  cardanoscanBase,
  cexplorerSub,
} from "./network";
import { seedCardanoNetwork } from "./network.fixture";

// The exact regex app/welcome/page.tsx uses to route a thrown wallet error to its inline treatment,
// applied the same way it is there: against the LOWERCASED message.
const CLASSIFIER = /wrong network|mainnet|preprod|network id|network mismatch/;
const classifies = (message: string): boolean => CLASSIFIER.test(message.toLowerCase());

beforeEach(() => {
  projectId = "";
  resetCardanoNetwork();
});

describe("resolveCardanoNetwork — the chain is the authority", () => {
  it("caches the network when both pallets agree", async () => {
    expect(getCardanoNetworkId()).toBeNull();
    const r = await resolveCardanoNetwork({
      constants: {
        CognoGate: { CardanoNetwork: async () => 1 },
        CardanoRoles: { CardanoNetwork: async () => 1 },
      },
    } as never);
    expect(r).toEqual({ id: 1 });
    expect(getCardanoNetworkId()).toBe(1);
  });

  it("names NO network when the two pallets disagree (a half-finished cutover)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // CognoGate flipped to mainnet, CardanoRoles left on testnet: binds would work while every role
    // proof was rejected. Neither value is safe to act on, so it must resolve to null.
    const r = await seedNetworkPair(1, 0);
    expect(r.id).toBeNull();
    expect(r.reason).toBeTruthy();
    expect(getCardanoNetworkId()).toBeNull();
    expect(spy.mock.calls[0].join(" ")).toMatch(/CognoGate=1.*CardanoRoles=0/);
    spy.mockRestore();
  });

  it("names no network on an unknown id, and never throws on a read failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await seedNetworkPair(7 as 0 | 1, 7 as 0 | 1)).id).toBeNull();
    spy.mockRestore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveCardanoNetwork({
      constants: {
        CognoGate: {
          CardanoNetwork: async () => {
            throw new Error("socket closed");
          },
        },
        CardanoRoles: { CardanoNetwork: async () => 0 },
      },
    } as never);
    expect(r.id).toBeNull();
    expect(r.reason).toBeTruthy();
    warn.mockRestore();
  });

  it("clears the cached value on reset, so a new endpoint cannot inherit the old network", async () => {
    await seedCardanoNetwork(1);
    expect(getCardanoNetworkId()).toBe(1);
    resetCardanoNetwork();
    expect(getCardanoNetworkId()).toBeNull();
  });

  it("a resolve that a reset superseded mid-flight never writes the cache", async () => {
    // Switching endpoints: useChain resets and re-resolves while the PREVIOUS handle's constant reads
    // are still out. Without an epoch guard the old answer lands last and wins — the app is then on
    // the wrong network with nothing left to correct it, which is precisely what the reset is for.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stale = resolveCardanoNetwork({
      constants: {
        CognoGate: {
          CardanoNetwork: async () => {
            await gate;
            return 1;
          },
        },
        CardanoRoles: { CardanoNetwork: async () => 1 },
      },
    } as never);

    resetCardanoNetwork(); // the endpoint changed
    await seedCardanoNetwork(0); // the NEW handle answers first
    expect(getCardanoNetworkId()).toBe(0);

    release();
    expect(await stale).toEqual({ id: 1 }); // it still reports what it saw…
    expect(getCardanoNetworkId()).toBe(0); // …but it does not get to install it
  });

  it("and a superseded resolve's FAILURE cannot wedge the new one at null either", async () => {
    // The same race in its likelier form: the old client is destroyed, so its in-flight reads reject.
    // That rejection commits `null`, and nothing re-resolves — every Cardano action then fails closed
    // with "still connecting" until the next reconnect.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stale = resolveCardanoNetwork({
      constants: {
        CognoGate: {
          CardanoNetwork: async () => {
            await gate;
            throw new Error("client destroyed");
          },
        },
        CardanoRoles: { CardanoNetwork: async () => 0 },
      },
    } as never);

    resetCardanoNetwork();
    await seedCardanoNetwork(0);
    release();
    expect((await stale).id).toBeNull();
    expect(getCardanoNetworkId()).toBe(0);
    warn.mockRestore();
  });
});

describe("wallet guards — fail closed, and never confuse unresolved with mismatch", () => {
  it("reports UNRESOLVED (not mismatch) before the chain has answered", () => {
    const c = checkWalletNetwork(0);
    expect(c).toMatchObject({ ok: false, kind: "unresolved" });
    // The distinction is load-bearing: probeWalletIdentity drops the session on `mismatch`, so an
    // unresolved network during boot must never look like a wrong-network wallet.
    expect(c.ok === false && c.kind).not.toBe("mismatch");
  });

  it("requireCardanoNetworkId throws rather than guessing a network", () => {
    expect(() => requireCardanoNetworkId()).toThrow(/still connecting/i);
  });

  it("passes a matching wallet and rejects a mismatched one", async () => {
    await seedCardanoNetwork(0);
    expect(checkWalletNetwork(0)).toEqual({ ok: true, network: 0 });
    expect(checkWalletNetwork(1)).toMatchObject({ ok: false, kind: "mismatch" });
    expect(assertWalletNetwork(0)).toBe(0);
    expect(() => assertWalletNetwork(1)).toThrow(/wrong network/i);
  });

  it("guards a MAINNET chain against a testnet wallet, not just the reverse", async () => {
    await seedCardanoNetwork(1);
    expect(checkWalletNetwork(1)).toEqual({ ok: true, network: 1 });
    expect(checkWalletNetwork(0)).toMatchObject({ ok: false, kind: "mismatch" });
  });
});

describe("wrongNetworkMessage — stays classifiable at every flavor", () => {
  it("keeps the token app/welcome/page.tsx matches on, whatever the network", () => {
    // This is the regression guard for a real coupling: the classifier routes on these tokens, and a
    // flavor-only message ("switch to preview") would fall through to the raw-string default.
    for (const [id, pid] of [
      [0, ""],
      [0, "preprodABC"],
      [0, "previewABC"],
      [1, "mainnetABC"],
    ] as Array<[0 | 1, string]>) {
      projectId = pid;
      expect(classifies(wrongNetworkMessage(id))).toBe(true);
    }
  });

  it("names the specific testnet when the provider identifies one", () => {
    projectId = "preprodABC";
    expect(wrongNetworkMessage(0)).toContain("preprod (testnet)");
    projectId = "previewABC";
    expect(wrongNetworkMessage(0)).toContain("preview (testnet)");
    projectId = "";
    expect(wrongNetworkMessage(0)).toContain("testnet");
    projectId = "mainnetABC";
    expect(wrongNetworkMessage(1)).toContain("mainnet");
  });

  it("ignores a provider flavor that cannot serve the chain's network", () => {
    // A preprod project id on a mainnet chain must not make the copy say "preprod".
    projectId = "preprodABC";
    expect(wrongNetworkMessage(1)).toContain("mainnet");
    expect(wrongNetworkMessage(1)).not.toContain("preprod");
  });
});

describe("provider mismatch — the expensive one", () => {
  it("flags a preprod project id on a mainnet chain", async () => {
    projectId = "preprodABC";
    await seedCardanoNetwork(1);
    expect(providerNetworkMismatch()).toMatch(/preprod/);
  });

  it("flags a mainnet project id on a testnet chain", async () => {
    projectId = "mainnetABC";
    await seedCardanoNetwork(0);
    expect(providerNetworkMismatch()).toMatch(/mainnet/);
  });

  it("accepts preview OR preprod on a testnet chain (both are network id 0)", async () => {
    await seedCardanoNetwork(0);
    projectId = "preprodABC";
    expect(providerNetworkMismatch()).toBeNull();
    projectId = "previewABC";
    expect(providerNetworkMismatch()).toBeNull();
  });

  it("checks an EXPLICIT project id over the stored one (getProvider accepts an override)", async () => {
    projectId = "mainnetABC"; // stored id agrees with the chain
    await seedCardanoNetwork(1);
    expect(providerNetworkMismatch()).toBeNull();
    // ...but the caller is about to build a provider from a preprod id, which is what must be caught.
    expect(providerNetworkMismatch("preprodXYZ")).toMatch(/preprod/);
  });

  it("stays quiet when nothing is configured, or before the network resolves", async () => {
    projectId = "";
    await seedCardanoNetwork(1);
    expect(providerNetworkMismatch()).toBeNull();
    resetCardanoNetwork();
    projectId = "mainnetABC";
    expect(providerNetworkMismatch()).toBeNull();
  });
});

describe("endpoints + explorer links follow the chain", () => {
  it("points at mainnet hosts on a mainnet chain", async () => {
    projectId = "mainnetABC";
    await seedCardanoNetwork(1);
    expect(cardanoFlavor()).toBe("mainnet");
    expect(effectiveFlavor(1)).toBe("mainnet");
    expect(blockfrostBase()).toBe("https://cardano-mainnet.blockfrost.io/api/v0");
    expect(cardanoscanBase()).toBe("https://cardanoscan.io");
    expect(cexplorerSub()).toBe("");
  });

  it("points at the named testnet on a testnet chain", async () => {
    projectId = "previewABC";
    await seedCardanoNetwork(0);
    expect(blockfrostBase()).toBe("https://cardano-preview.blockfrost.io/api/v0");
    expect(cardanoscanBase()).toBe("https://preview.cardanoscan.io");
    expect(cexplorerSub()).toBe("preview.");
  });

  it("never follows a provider flavor the chain's network cannot serve", async () => {
    // The chain says mainnet; a stale preprod project id must not redirect the links to preprod.
    projectId = "preprodABC";
    await seedCardanoNetwork(1);
    expect(effectiveFlavor(1)).toBe("mainnet");
    expect(cardanoscanBase()).toBe("https://cardanoscan.io");
  });

  it("falls back to preprod hosts before the network resolves", () => {
    projectId = "";
    expect(blockfrostBase()).toBe("https://cardano-preprod.blockfrost.io/api/v0");
    expect(cardanoscanBase()).toBe("https://preprod.cardanoscan.io");
  });
});

/** Resolve an explicit (gate, roles) pair — the fixture's disagreement form, returning the result. */
function seedNetworkPair(gate: 0 | 1, roles: 0 | 1) {
  return resolveCardanoNetwork({
    constants: {
      CognoGate: { CardanoNetwork: async () => gate },
      CardanoRoles: { CardanoNetwork: async () => roles },
    },
  } as never);
}
