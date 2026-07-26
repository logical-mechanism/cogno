// The chain-vs-bundle vault cross-check.
//
// There are two independent places that name a vault script: the runtime's `ObsVaultPolicyId` and
// `VAULT_SCRIPTS[0]` in this bundle. A redeploy has to move both, through a runtime upgrade and a
// separate frontend deploy, and the two can never be atomic. When they disagree, `lockIntoVault`
// builds a perfectly valid transaction that pays 100 ADA into a script address the observer is not
// watching: no error, no revert, no posting power, and no recovery except an exit the user has to
// think to perform. One constant read turns that into an upfront refusal.

import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.hoisted`: a `vi.mock` factory is hoisted above every top-level binding, so a plain const read
// from inside one is a temporal-dead-zone error the moment module resolution order shifts.
const { BUNDLE_HASH } = vi.hoisted(() => ({ BUNDLE_HASH: "dd".repeat(28) }));

vi.mock("./vaults", () => ({
  currentVaultScript: () => ({
    hash: BUNDLE_HASH,
    appliedCbor: "5901",
    minLock: 100_000_000n,
    label: "Current vault",
  }),
}));

import {
  resolveVaultPolicy,
  resetVaultPolicy,
  getObservedVaultPolicyId,
  assertVaultPolicyMatchesChain,
} from "./vaultPolicy";
import type { CognoApi } from "@/lib/types";

/** A fake api whose VaultPolicyId constant resolves to `hex`, or throws. */
function apiWith(hex: string | (() => never)): CognoApi {
  return {
    constants: {
      CardanoObserver: {
        VaultPolicyId: async () => (typeof hex === "function" ? hex() : hex),
      },
    },
  } as unknown as CognoApi;
}

beforeEach(() => {
  resetVaultPolicy();
  vi.restoreAllMocks();
});

describe("resolveVaultPolicy", () => {
  it("caches the chain's answer, normalized to lower-case hex with no 0x", async () => {
    // The constant arrives as SizedHex, so it carries the prefix and may carry upper case; the bundle
    // hash never does. Comparing the two raw forms would report a mismatch on every single boot.
    await resolveVaultPolicy(apiWith(`0x${BUNDLE_HASH.toUpperCase()}`));
    expect(getObservedVaultPolicyId()).toBe(BUNDLE_HASH);
  });

  it("resolves to null on a read failure instead of throwing out of the boot probe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const got = await resolveVaultPolicy(
      apiWith(() => {
        throw new Error("socket closed");
      }),
    );
    expect(got).toBeNull();
    expect(getObservedVaultPolicyId()).toBeNull();
  });

  it("does not let a superseded resolve overwrite a newer one", async () => {
    // An endpoint switch destroys the old client while its constant read is still in flight. Without
    // the epoch guard, the previous chain's policy id lands after the new chain has already answered,
    // and a lock is then validated against a chain that no longer exists.
    const stale = resolveVaultPolicy(apiWith(`0x${"11".repeat(28)}`));
    resetVaultPolicy();
    await stale;
    expect(getObservedVaultPolicyId()).toBeNull();
  });
});

describe("assertVaultPolicyMatchesChain", () => {
  it("passes when the chain credits the script this bundle builds", async () => {
    await resolveVaultPolicy(apiWith(`0x${BUNDLE_HASH}`));
    expect(() => assertVaultPolicyMatchesChain()).not.toThrow();
  });

  it("refuses the lock when they disagree, before any ADA moves", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await resolveVaultPolicy(apiWith(`0x${"11".repeat(28)}`));
    expect(() => assertVaultPolicyMatchesChain()).toThrow(/locking is off/i);
  });

  it("says getting ADA back still works, because it does", () => {
    // The guard gates LOCKING only. Reading and exiting are recovery paths, and a misconfigured
    // deployment is the moment someone most needs to reach their own funds.
    vi.spyOn(console, "error").mockImplementation(() => {});
    return resolveVaultPolicy(apiWith(`0x${"11".repeat(28)}`)).then(() => {
      expect(() => assertVaultPolicyMatchesChain()).toThrow(/back still works/i);
    });
  });

  it("FAILS OPEN while the chain's answer is unknown", () => {
    // Deliberate. An unresolved constant read is a boot problem, and blocking every lock on the whole
    // deployment because one read timed out is a far likelier outage than the mismatch this guards.
    // The mismatch is only reachable through an operator error that has already happened.
    expect(getObservedVaultPolicyId()).toBeNull();
    expect(() => assertVaultPolicyMatchesChain()).not.toThrow();
  });
});
