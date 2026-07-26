// The shipped vault-script list. These assert INVARIANTS of the list itself, against the REAL module
// (no mocks), which is the half vault.test.ts cannot check because it substitutes its own two scripts.
//
// What they are protecting: the list is edited by hand at redeploy time, under time pressure, by
// somebody pasting a hash and a CBOR out of git history. Order carries meaning (index 0 is the only
// script that earns posting power), and a duplicate or a swapped pair would either strand funds or
// point new locks at a dead address.

import { describe, it, expect } from "vitest";
import { VAULT_SCRIPTS, currentVaultScript, legacyVaultScripts, vaultScriptByHash } from "./vaults";
import vault from "./vault.json";

describe("VAULT_SCRIPTS", () => {
  it("puts the CURRENT script first, and takes it from the generated artifact", () => {
    // Never hand-typed: contracts/scripts/regen-vault.mjs owns vault.json, and entry 0 tracks it. A
    // hand-copied current entry is how the bundle ends up building an address nobody deployed.
    expect(currentVaultScript().hash).toBe(vault.vaultHash);
    expect(currentVaultScript().appliedCbor).toBe(vault.appliedCbor);
    expect(currentVaultScript().minLock).toBe(BigInt(vault.minLock));
    expect(VAULT_SCRIPTS[0]).toBe(currentVaultScript());
  });

  it("ships with no retired scripts, because talk_vault has been deployed once", () => {
    // If this ever fails, a redeploy happened and every legacy assertion below is now load-bearing.
    expect(legacyVaultScripts()).toHaveLength(0);
    expect(VAULT_SCRIPTS).toHaveLength(1);
  });

  it("has no duplicate hashes", () => {
    // A duplicate would make vaultScriptByHash ambiguous and could attach the wrong CBOR to a spend.
    const hashes = VAULT_SCRIPTS.map((s) => s.hash.toLowerCase());
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("carries the applied CBOR for EVERY entry, not just the current one", () => {
    // A hash alone cannot spend: the exit attaches the script's full CBOR as the spend witness and
    // burns the beacon under that script's own policy. An entry without it is unreachable funds.
    for (const s of VAULT_SCRIPTS) {
      expect(s.hash).toMatch(/^[0-9a-f]{56}$/);
      expect(s.appliedCbor.length).toBeGreaterThan(0);
      expect(s.minLock).toBeGreaterThan(0n);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
});

describe("vaultScriptByHash", () => {
  it("finds the current script", () => {
    expect(vaultScriptByHash(currentVaultScript().hash)).toBe(currentVaultScript());
  });

  it("tolerates 0x and upper case, since a hash may arrive from a chain constant", () => {
    const h = currentVaultScript().hash;
    expect(vaultScriptByHash(`0x${h.toUpperCase()}`)).toBe(currentVaultScript());
  });

  it("returns undefined for an unknown hash rather than a wrong script", () => {
    // exitVault turns this into a refusal. Falling back to the current script here would attach the
    // wrong witness and build an invalid transaction against somebody's stranded funds.
    expect(vaultScriptByHash("ff".repeat(28))).toBeUndefined();
  });
});
