// The Cardano provider for in-browser transactions (Blockfrost). It supplies the
// fetcher / submitter / evaluator AND live protocol parameters (including the PlutusV3 cost
// models) — so the in-browser flow needs no separate cost-model injection (the off-chain scripts
// read UTxOs from db-sync and inject Ogmios cost models via an explicit setCostModels()). MeshJS is
// browser-only, so it is imported dynamically and this module stays import-safe during the static
// export. The `import type` is fully erased at build time, so it never pulls the runtime bundle into SSG.
//
// The project id is config: NEXT_PUBLIC_BLOCKFROST_PROJECT_ID at build time, user-overridable in
// the browser (see lib/config/endpoints). It is a read/submit key exposed client-side by design — the
// cost of letting any visitor lock from their own wallet without a backend. Which network it must be
// for is not a build-time fact: the chain names it, and a project id for a different one is refused
// below rather than quietly used.
import type { BlockfrostProvider as BlockfrostProviderType } from "@meshsdk/core";
import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import { providerNetworkMismatch } from "./network";

/** Whether a Cardano provider is configured (⇒ the wallet lock/exit actions are available). */
export function hasCardanoProvider(): boolean {
  return getBlockfrostProjectId().length > 0;
}

/** Construct the Blockfrost provider, or throw a friendly error when none is configured. */
export async function getProvider(projectId?: string): Promise<BlockfrostProviderType> {
  const id = (projectId ?? getBlockfrostProjectId()).trim();
  if (!id) {
    throw new Error(
      "Add a Blockfrost project id to lock ADA.",
    );
  }
  // Fail closed on a provider that serves a different network than the chain. This provider is the
  // fetcher, submitter AND evaluator for the vault txs, so a mismatch here does not throw on its own:
  // it selects UTxOs, prices fees and evaluates scripts against the wrong network's ledger. Checked
  // only for a CONFIGURED mismatch — an unresolved network leaves the caller's own guard to fail.
  const mismatch = providerNetworkMismatch(id);
  if (mismatch) throw new Error(mismatch);
  const { BlockfrostProvider } = await import("@meshsdk/core");
  return new BlockfrostProvider(id);
}

