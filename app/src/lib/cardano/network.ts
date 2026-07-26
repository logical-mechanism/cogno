// Which Cardano network this deployment talks to — resolved from the chain, never hardcoded.
//
// The AUTHORITY is the app-chain itself. `CognoGate.CardanoNetwork` and `CardanoRoles.CardanoNetwork`
// are both `#[pallet::constant]` (0 = testnet, 1 = mainnet) and are already in the committed PAPI
// descriptors, so the frontend asks the chain it is connected to rather than carrying its own copy.
// That makes a mainnet cutover a chain-side constant change plus a Blockfrost project id, with no
// frontend edit — and it removes the class of bug where a bundle built for one network signs for
// another. The runtime-side analogue of scripts/check-spec.mjs.
//
// Why this matters more than the six wallet guards suggest: two call sites BUILD ADDRESSES from the
// network id (the vault script address in vault.ts and the synthetic enterprise address in
// role-proof.ts). Those fail late and in the money path — a lock tx carrying an `addr_test1…` output,
// or a role proof signed over a testnet address the chain rejects after the wallet signature is
// already spent. The guards fail loudly on connect; the builders do not.
//
// Resolution is one-shot per chain handle, from the boot probe (lib/chain/client.ts `checkBootGuard`).
// Before it lands, `getCardanoNetworkId()` is null and every consumer must fail closed rather than
// assume a network. There is deliberately NO build-time fallback: a second source of truth is a
// second thing that can disagree, and the disagreement is silent.
//
// When it lands on "no network", the REASON lives here too (`cardanoNetworkReason`), because the
// difference matters to whoever is reading the screen: "still connecting" is a wait, a half-finished
// cutover is permanent, and telling someone to wait for the second one is a lie the UI can tell forever.
//
// SSG-safe: no `window` at module-evaluation time (the Blockfrost read below is guarded internally).

import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import type { CognoApi } from "@/lib/types";

/** The low nibble of a Cardano address header byte: 0 = testnet (preprod/preview), 1 = mainnet. */
export type CardanoNetworkId = 0 | 1;

/**
 * The specific testnet, which the chain constant cannot express — preprod and preview are BOTH
 * network id 0. Only the Blockfrost project id distinguishes them, and it is display-and-endpoint
 * detail: nothing consensus-facing depends on it.
 */
export type CardanoFlavor = "mainnet" | "preprod" | "preview";

/** The chain's answer, or null before the boot probe has resolved it. Module-scoped, one per app. */
let resolved: CardanoNetworkId | null = null;

/**
 * Why the chain named no network, when it could not. Committed alongside {@link resolved} so the
 * fail-closed paths can say what is actually wrong. Without it, a PERMANENT misconfiguration (the two
 * pallets disagreeing) rendered as {@link STILL_CONNECTING} on every Cardano surface, telling the user
 * to wait for a state that will never arrive.
 */
let unresolvedReason: string | null = null;

/** What we can honestly say before the boot probe has landed: it is a wait, not a diagnosis. */
const STILL_CONNECTING = "Still connecting to cogno. Wait a moment, then try again.";

/**
 * Bumped by every {@link resetCardanoNetwork}. A resolve reads it on entry and refuses to commit if it
 * moved while the constant reads were in flight — without that, switching endpoints lets the OLD
 * chain's answer (or its post-`destroy()` rejection, which commits `null`) land after the new one has
 * already resolved, and the app is then either on the wrong network or wedged as "still connecting"
 * with nothing left to re-resolve it. The exact stale-cache bug the reset exists to prevent.
 */
let epoch = 0;

/** The resolved network id, or null when the boot probe has not landed (or reported a broken chain). */
export function getCardanoNetworkId(): CardanoNetworkId | null {
  return resolved;
}

/**
 * User-facing copy for why no network is known: the resolver's own diagnosis when it has one, else
 * the neutral "still connecting". Always a sentence, so a caller can surface it directly.
 */
export function cardanoNetworkReason(): string {
  return unresolvedReason ?? STILL_CONNECTING;
}

/**
 * The resolved network id, throwing user-facing copy when it is not known yet. For the paths that
 * must never guess — the two address builders and the CIP-8 bind flows. All of them run well after
 * boot in practice, so this throw is a fail-closed backstop rather than an expected state.
 */
export function requireCardanoNetworkId(): CardanoNetworkId {
  if (resolved === null) {
    throw new Error(cardanoNetworkReason());
  }
  return resolved;
}

/**
 * Drop the cached value. Called when the chain handle changes so a new endpoint re-resolves — and it
 * also invalidates any resolve still in flight for the previous handle (see {@link epoch}).
 */
export function resetCardanoNetwork(): void {
  epoch += 1;
  resolved = null;
  unresolvedReason = null;
}

/**
 * Read the network from the chain and cache it. Cross-checks the two pallets against each other:
 * `CognoGate` gates identity binds and `CardanoRoles` gates role claims, and a runtime that flipped
 * only one of them would accept binds while rejecting every role proof (or the reverse). That is a
 * real cutover failure mode — the two constants are set in separate `impl` blocks in
 * runtime/src/configs/mod.rs — and it is invisible from any single call site.
 *
 * Never throws: a read failure resolves to `null` (with the reason left in
 * {@link cardanoNetworkReason}) so the boot path stays alive and consumers fail closed on their own.
 *
 * A resolve that was superseded by a {@link resetCardanoNetwork} mid-flight still RETURNS its answer
 * (the caller's own cancellation guard decides what to do with it) but never writes the cache.
 */
export async function resolveCardanoNetwork(api: CognoApi): Promise<CardanoNetworkId | null> {
  const gen = epoch;
  // Only the resolve that still owns the current epoch may write the cache. The reason rides the same
  // guard, so a superseded resolve can neither install a network nor an explanation for one.
  const commit = (value: CardanoNetworkId | null, why?: string): void => {
    if (gen !== epoch) return;
    resolved = value;
    unresolvedReason = value === null ? (why ?? null) : null;
  };
  const misconfigured = "This network is misconfigured. Cardano actions are off.";
  try {
    const [gate, roles] = await Promise.all([
      api.constants.CognoGate.CardanoNetwork(),
      api.constants.CardanoRoles.CardanoNetwork(),
    ]);
    if (gate !== roles) {
      commit(null, misconfigured);
      // Not user-actionable, but it must not read as a wallet problem: the chain is misconfigured.
      console.error(
        `cogno: chain reports disagreeing Cardano networks (CognoGate=${gate}, CardanoRoles=${roles}); refusing to pick one`,
      );
      return null;
    }
    if (gate !== 0 && gate !== 1) {
      commit(null, misconfigured);
      console.error(`cogno: chain reports an unknown Cardano network id ${gate}`);
      return null;
    }
    commit(gate);
    return gate;
  } catch (err) {
    commit(null, "Can't reach cogno. Check your connection and try again.");
    console.warn("[cogno] could not read the Cardano network constant:", err);
    return null;
  }
}

/** The flavor a Blockfrost project id names by its prefix, or null when unset/unrecognized. */
export function flavorOf(projectId: string): CardanoFlavor | null {
  if (projectId.startsWith("mainnet")) return "mainnet";
  if (projectId.startsWith("preprod")) return "preprod";
  if (projectId.startsWith("preview")) return "preview";
  return null;
}

/** The flavor the configured Blockfrost project id belongs to, or null when unset/unrecognized. */
export function cardanoFlavor(): CardanoFlavor | null {
  return flavorOf(getBlockfrostProjectId());
}

/** Whether a provider flavor can serve the chain's network (preprod and preview are both id 0). */
function flavorServes(flavor: CardanoFlavor, network: CardanoNetworkId): boolean {
  return network === 1 ? flavor === "mainnet" : flavor !== "mainnet";
}

/**
 * The flavor to actually use for endpoints and links: the configured one when it can serve the
 * chain's network, else the safe default for that network. A provider that disagrees with the chain
 * is never silently followed — {@link providerNetworkMismatch} is what surfaces it.
 */
export function effectiveFlavor(network: CardanoNetworkId): CardanoFlavor {
  const f = cardanoFlavor();
  if (f && flavorServes(f, network)) return f;
  return network === 1 ? "mainnet" : "preprod";
}

/**
 * User-facing copy when the configured Blockfrost project id is for a different network than the
 * chain, else null. This is the expensive mismatch: a mainnet chain with a preprod project id would
 * build a lock tx against preprod UTxOs and preprod protocol parameters.
 */
export function providerNetworkMismatch(projectId?: string): string | null {
  const network = getCardanoNetworkId();
  if (network === null) return null;
  // Check the id the provider will actually be BUILT with, not merely the stored one — getProvider
  // accepts an override, and checking a different value than it uses would be worse than not checking.
  const f = projectId === undefined ? cardanoFlavor() : flavorOf(projectId);
  if (!f || flavorServes(f, network)) return null;
  // Names no control to go fix it in: the project id is a deployment seed
  // (NEXT_PUBLIC_BLOCKFROST_PROJECT_ID) with no Settings editor behind it, and pointing at one that
  // does not exist is worse than pointing at nothing.
  return `Your Blockfrost project is for ${f}, but this network runs on ${networkLabel(network)}. Cardano actions are off until they match.`;
}

/** How to name a network to a reader: the specific testnet when known, else the coarse name. */
export function networkLabel(network: CardanoNetworkId): string {
  const f = cardanoFlavor();
  if (f && flavorServes(f, network)) {
    return f === "mainnet" ? "mainnet" : `${f} (testnet)`;
  }
  return network === 1 ? "mainnet" : "testnet";
}

/**
 * The shared wrong-network message. It is the copy the user actually sees: the connect step renders
 * whatever was thrown, verbatim. (It used to re-derive this string from the network id after matching
 * a token in it, which meant any OTHER message mentioning a network — the provider mismatch above —
 * got rewritten into a wrong-network diagnosis it had nothing to do with.)
 */
export function wrongNetworkMessage(network: CardanoNetworkId): string {
  return `Wrong network. Switch your wallet to ${networkLabel(network)}, then reconnect.`;
}

/** The verdict of {@link checkWalletNetwork}. */
export type NetworkCheck =
  | { ok: true; network: CardanoNetworkId }
  /**
   * `mismatch` = the wallet answered and it is on the wrong network, which is conclusive.
   * `unresolved` = we do not know the chain's network yet, so nothing can be concluded. Callers that
   * drop state on a mismatch (the session restore probe) must treat `unresolved` as inconclusive.
   */
  | { ok: false; kind: "mismatch" | "unresolved"; message: string };

/** Compare a CIP-30 `getNetworkId()` answer against the chain's network. Never throws. */
export function checkWalletNetwork(walletNetworkId: number): NetworkCheck {
  const network = getCardanoNetworkId();
  if (network === null) {
    return { ok: false, kind: "unresolved", message: cardanoNetworkReason() };
  }
  if (walletNetworkId !== network) {
    return { ok: false, kind: "mismatch", message: wrongNetworkMessage(network) };
  }
  return { ok: true, network };
}

/**
 * Assert the wallet is on the chain's network, throwing the shared copy if not. The form the
 * throwing call sites want; {@link checkWalletNetwork} is for the ones that return a result.
 */
export function assertWalletNetwork(walletNetworkId: number): CardanoNetworkId {
  const check = checkWalletNetwork(walletNetworkId);
  if (!check.ok) throw new Error(check.message);
  return check.network;
}

// ── endpoints + explorer links ───────────────────────────────────────────────────────────────────
// One implementation each. These used to be duplicated per consumer (roleMeta and govParams each
// carried their own Blockfrost base, explorer.ts pinned preprod outright), which is how the mainnet
// hosts were reachable from one place and not the others.

/**
 * The flavor these hosts should be built from right now: the chain's network when it has answered,
 * else the configured project id's own flavor (and preprod when there is nothing to go on).
 *
 * Read at CALL time, not at module load — the network arrives asynchronously, so anything that caches
 * a host string across the boot probe can pin the pre-resolution fallback.
 */
function currentFlavor(): CardanoFlavor {
  const network = getCardanoNetworkId();
  return network === null ? (cardanoFlavor() ?? "preprod") : effectiveFlavor(network);
}

/** The Blockfrost REST base for the effective network. */
export function blockfrostBase(): string {
  return `https://cardano-${currentFlavor()}.blockfrost.io/api/v0`;
}

/** The Cardanoscan origin for the effective network. */
export function cardanoscanBase(): string {
  const flavor = currentFlavor();
  return flavor === "mainnet" ? "https://cardanoscan.io" : `https://${flavor}.cardanoscan.io`;
}

/** The cexplorer subdomain for the effective network (`""` = mainnet). */
export function cexplorerSub(): string {
  const flavor = currentFlavor();
  return flavor === "mainnet" ? "" : `${flavor}.`;
}
