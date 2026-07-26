// Test fixture for the chain-resolved Cardano network.
//
// The wallet guards and both address builders read a module-scoped value that the boot probe fills in
// (lib/chain/client.ts `checkBootGuard`), and they fail closed until it is there. Unit tests have no
// chain, so they seed it here — through the REAL resolver rather than by poking module state, so the
// tests exercise the same path the app does, including the two-pallet cross-check.
//
// Imported only by `*.test.ts`, so it never reaches a page bundle.

import { resolveCardanoNetwork } from "./network";

/**
 * Resolve the Cardano network as if the chain had reported it. Pass a differing `roles` value to
 * simulate a runtime that flipped `CognoGate.CardanoNetwork` without `CardanoRoles.CardanoNetwork`.
 */
export async function seedCardanoNetwork(gate: 0 | 1, roles: 0 | 1 = gate): Promise<void> {
  await resolveCardanoNetwork({
    constants: {
      CognoGate: { CardanoNetwork: async () => gate },
      CardanoRoles: { CardanoNetwork: async () => roles },
    },
  } as never);
}
