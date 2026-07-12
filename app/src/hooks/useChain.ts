"use client";

// useChain — the single owner of the live PAPI connection.
//
// Creates ONE ChainHandle from the active WS endpoint (client-only, SSG-safe),
// subscribes to the derived connection status, runs the read/write boot guard,
// and tears the client down on unmount or when the endpoint changes. Every other
// hook/component receives `api` / `client` from here — there is exactly one socket.

import { useCallback, useEffect, useState } from "react";
import type { PolkadotClient } from "polkadot-api";
import { createChain, watchConnStatus, checkBootGuard } from "@/lib/chain/client";
import { getActiveWsUrl } from "@/lib/config/endpoints";
import type {
  ChainHandle,
  CognoApi,
  ConnStatus,
  BootGuard,
} from "@/lib/types";

export interface UseChain {
  /** The live handle, or null before the client is created (SSG / first paint). */
  handle: ChainHandle | null;
  /** Shortcut to handle.api (null until connected). */
  api: CognoApi | null;
  /** The PolkadotClient (null until connected) — needed by the bare-unsigned CIP-8 binds + useIdentity. */
  client: PolkadotClient | null;
  /** Derived socket lifecycle. */
  status: ConnStatus;
  /** Read/write boot guard; null until the first probe resolves. */
  boot: BootGuard | null;
  /** The WS URL the current handle speaks to. */
  wsUrl: string | null;
  /** Reconnect to a (possibly new) endpoint, destroying the previous client. */
  reconnect: (url?: string) => void;
}

export function useChain(): UseChain {
  // `target` drives (re)connection; null on the server / first SSG paint.
  const [target, setTarget] = useState<string | null>(null);
  const [handle, setHandle] = useState<ChainHandle | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [boot, setBoot] = useState<BootGuard | null>(null);

  // Only ever resolve an endpoint on the client (localStorage is SSG-unsafe).
  useEffect(() => {
    setTarget((prev) => prev ?? getActiveWsUrl());
  }, []);

  const reconnect = useCallback((url?: string) => {
    setBoot(null);
    setStatus("connecting");
    setTarget(url ?? getActiveWsUrl());
  }, []);

  // Create / destroy the handle when the target endpoint changes.
  useEffect(() => {
    if (target === null) return;

    let disposed = false;
    const h = createChain(target);
    if (!disposed) setHandle(h);

    return () => {
      disposed = true;
      setHandle((cur) => (cur === h ? null : cur));
      try {
        h.client.destroy();
      } catch {
        /* destroy is best-effort; a torn-down client may already be gone */
      }
    };
  }, [target]);

  // Subscribe to the derived connection status for the current handle.
  useEffect(() => {
    if (!handle) return;
    const sub = watchConnStatus(handle).subscribe({
      next: setStatus,
      error: () => setStatus("error"),
    });
    return () => sub.unsubscribe();
  }, [handle]);

  // Run the boot guard once per handle (read/write capability probe).
  useEffect(() => {
    if (!handle) return;
    let cancelled = false;
    checkBootGuard(handle.api)
      .then((g) => {
        if (cancelled) return;
        if (!g.ok) {
          // A not-ok boot guard BLOCKS posting (wrong chain / spec mismatch). Make it observable.
          console.warn(`cogno: boot guard not ok — posting blocked:`, g.reason ?? "(no reason)");
        }
        setBoot(g);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // checkBootGuard never throws in normal operation; if it does, the node is unreachable.
        console.warn(`cogno: boot guard probe threw (node unreachable?):`, err);
        setBoot({
          ok: false,
          nodeSpecName: "",
          nodeSpecVersion: 0,
          descriptorSpecVersion: null,
          reason:
            err instanceof Error
              ? err.message
              : "boot guard probe failed (node unreachable?)",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  return {
    handle,
    api: handle?.api ?? null,
    client: handle?.client ?? null,
    status,
    boot,
    wsUrl: handle?.wsUrl ?? null,
    reconnect,
  };
}
