// The PAPI client lifecycle + honest connection/boot reporting.
//
// `createChain` bundles the client + typed API + endpoint into a ChainHandle.
// `watchConnStatus` derives a connecting/connected/reconnecting signal purely from block
// liveness (no private provider events) — robust and never throws.
// `checkBootGuard` compares the live runtime spec to what the app was built against; a
// mismatch must BLOCK the write path (a silent spec bump mis-encodes posts) while reads
// stay best-effort. This module only REPORTS `ok`; the UI enforces the block.

import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { cogno } from "@polkadot-api/descriptors";
import { Observable, type Subscription } from "rxjs";
import type { ChainHandle, ConnStatus, BootGuard, CognoApi } from "@/lib/types";

/**
 * The spec_name the descriptors were generated against (cogno-chain-runtime). The spec_version is
 * embedded only in the descriptors' opaque metadata blob — see DESCRIPTOR_SPEC_VERSION below — so we
 * gate solely on the name here and avoid re-introducing a version number that drifts.
 */
const EXPECTED_SPEC_NAME = "cogno-chain-runtime";

/**
 * The runtime spec_version this app's PAPI descriptors were generated against.
 *
 * This was `null` — which made the version half of the boot guard a permanent no-op, so a runtime spec
 * bump would ship a frontend that silently MIS-ENCODES every write, and neither the types, the guard,
 * nor CI would notice. (The guard's own reason string has always said "Posting is blocked to avoid
 * mis-encoding"; it just never had a version to compare against.)
 *
 * It is `null` no longer, and it cannot silently drift: `npm run check:spec` (part of `npm run lint`,
 * and therefore CI) asserts this equals `spec_version` in runtime/src/lib.rs. Bump the runtime without
 * regenerating the descriptors and updating this, and the build fails — loudly, which is the point.
 *
 * The spec_version genuinely is NOT statically readable from the descriptors (SCALE metadata does not
 * carry it; it lives in the RuntimeVersion runtime API), so a checked constant is the honest mechanism.
 */
const DESCRIPTOR_SPEC_VERSION: number | null = 205;

/** Heartbeat window: if no new best block arrives within this, we surface "reconnecting". */
const BLOCK_HEARTBEAT_MS = 30_000;

/** Build a chain handle: a fresh PAPI client + the typed cogno API + the endpoint it speaks to. */
export function createChain(wsUrl: string): ChainHandle {
  const client = createClient(getWsProvider(wsUrl));
  const api = client.getTypedApi(cogno);
  return { client, api, wsUrl };
}

/**
 * Connection lifecycle derived from block liveness:
 *   - emits "connecting" immediately,
 *   - "connected" once the first best block arrives,
 *   - "reconnecting" if no new block lands for > {@link BLOCK_HEARTBEAT_MS},
 *   - "error" only if the block stream itself errors.
 * Never throws; the UI consumes this to drive the connecting/reconnecting chrome.
 */
export function watchConnStatus(handle: ChainHandle): Observable<ConnStatus> {
  return new Observable<ConnStatus>((subscriber) => {
    subscriber.next("connecting");

    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let blockSub: Subscription | undefined;

    const armHeartbeat = () => {
      if (heartbeat) clearTimeout(heartbeat);
      heartbeat = setTimeout(() => {
        // No fresh block within the window — the link is likely stalled / dropped.
        subscriber.next("reconnecting");
      }, BLOCK_HEARTBEAT_MS);
    };

    try {
      blockSub = handle.client.bestBlocks$.subscribe({
        next: () => {
          // Any (re)arriving block means the link is live again.
          subscriber.next("connected");
          armHeartbeat();
        },
        error: () => {
          // Clear the armed heartbeat so it can't later flip a settled "error" back to
          // "reconnecting" (this handler emits a value, not observable-error, so no teardown runs).
          if (heartbeat) clearTimeout(heartbeat);
          subscriber.next("error");
        },
      });
    } catch {
      subscriber.next("error");
    }

    return () => {
      if (heartbeat) clearTimeout(heartbeat);
      blockSub?.unsubscribe();
    };
  });
}

/**
 * Read the live runtime version and compare it to what the app was built against.
 * `ok` is false on a spec_name mismatch (wrong chain entirely) — and, when the descriptor
 * spec_version is known, on a spec_version mismatch too. Never throws: a failed read yields
 * a not-ok guard with a reason rather than crashing the boot path.
 */
export async function checkBootGuard(api: CognoApi): Promise<BootGuard> {
  try {
    const version = await api.constants.System.Version();
    const nodeSpecName = version.spec_name;
    const nodeSpecVersion = version.spec_version;

    const nameMatches = nodeSpecName === EXPECTED_SPEC_NAME;
    const versionMatches =
      DESCRIPTOR_SPEC_VERSION === null ||
      nodeSpecVersion === DESCRIPTOR_SPEC_VERSION;
    const ok = nameMatches && versionMatches;

    let reason: string | undefined;
    if (!nameMatches) {
      reason = `Runtime spec_name "${nodeSpecName}" does not match expected "${EXPECTED_SPEC_NAME}". This is not a cogno-chain node.`;
    } else if (!versionMatches) {
      reason = `Runtime spec_version ${nodeSpecVersion} does not match the version this app was built against (${DESCRIPTOR_SPEC_VERSION}). Posting is blocked to avoid mis-encoding; reads remain best-effort.`;
    }

    return {
      ok,
      nodeSpecName,
      nodeSpecVersion,
      descriptorSpecVersion: DESCRIPTOR_SPEC_VERSION,
      reason,
    };
  } catch (err) {
    return {
      ok: false,
      nodeSpecName: "",
      nodeSpecVersion: 0,
      descriptorSpecVersion: DESCRIPTOR_SPEC_VERSION,
      reason: `Could not read runtime version: ${stringifyError(err)}`,
    };
  }
}

/** Best-effort error → message, used so the boot guard never leaks a thrown object. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

// Re-export the client type so consumers of this module have the PAPI client type handy
// without a second import path. (Pure type re-export; no runtime cost.)
export type { PolkadotClient };
