// The Cardano provider for in-browser transactions (Blockfrost, preprod). It supplies the
// fetcher / submitter / evaluator AND live protocol parameters (including the PlutusV3 cost
// models) — so the in-browser flow needs no separate cost-model injection (the off-chain scripts
// read UTxOs from db-sync and inject Ogmios cost models via an explicit setCostModels()). MeshJS is
// browser-only, so it is imported dynamically and this module stays import-safe during the static
// export. The `import type` is fully erased at build time, so it never pulls the runtime bundle into SSG.
//
// The project id is config: NEXT_PUBLIC_BLOCKFROST_PROJECT_ID at build time, user-overridable in
// the browser (see lib/config/endpoints). It is a preprod read/submit key exposed client-side by
// design — the cost of letting any visitor lock from their own wallet without a backend.
import type { BlockfrostProvider as BlockfrostProviderType } from "@meshsdk/core";
import { getBlockfrostProjectId } from "@/lib/config/endpoints";

/** Whether a Cardano provider is configured (⇒ the wallet lock/exit actions are available). */
export function hasCardanoProvider(): boolean {
  return getBlockfrostProjectId().length > 0;
}

/** Construct the Blockfrost provider, or throw a friendly error when none is configured. */
export async function getProvider(projectId?: string): Promise<BlockfrostProviderType> {
  const id = (projectId ?? getBlockfrostProjectId()).trim();
  if (!id) {
    throw new Error(
      "No Cardano provider configured — set a Blockfrost preprod project id in settings to lock from your wallet.",
    );
  }
  const { BlockfrostProvider } = await import("@meshsdk/core");
  return new BlockfrostProvider(id);
}
