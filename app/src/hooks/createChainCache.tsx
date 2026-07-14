"use client";

// createChainCache — the factory behind every session-lived, per-key chain cache in the app.
//
// useReputation (138 LOC), useAuthorWeight (137), useNestedQuote (134) and useAccountProfile (140) were
// THE SAME FILE four times: the same apiRef / requested / queue / flushScheduled / mounted refs, the
// same StrictMode re-arm, the same queueMicrotask coalescing, the same leaf hook. Only the key type,
// the read function, and the error policy differed. They are now four ~15-line declarations over this.
//
// WHAT IT DOES: a value that recurs across dozens of cards and every surface (an author's reputation, an
// account's stake weight, a quoted post's inner id, a display name) is keyed by ACCOUNT/ID and shared
// app-wide, so the same key costs exactly ONE read no matter how many cards want it, and a value fetched
// on Home is already warm in a thread. Registration is idempotent and safe to call every render; a
// microtask coalesces every key registered in the same tick — a whole feed page mounting — into ONE
// Promise.all.
//
// It also adds the one thing none of the four had: `invalidate()`.
//
// ── THE DIVERGENCES THIS PRESERVES (each is load-bearing; a naive merge erases them) ─────────────
//
// 1. ERROR POLICY IS A PARAMETER, NOT DRIFT. reputation/weight/quote UNCOMMIT a failed key so it is
//    retried the next time a card for it mounts. useAccountProfile deliberately COMMITS an empty value
//    and never retries — so a mention chip settles on its truncated-ss58 fallback instead of thrashing
//    a read on every scroll. Both are correct; they are different products.
//
// 2. `null` CAN BE A SUCCESSFUL READ. useNestedQuote's value is `bigint | null`, where null means "this
//    post quotes nothing" — true of MOST posts. The failure sentinel is therefore the RESULT ENVELOPE,
//    never the value: a factory that treated a null *value* as a failure would re-read every
//    non-quoting post forever, i.e. a read storm across the whole timeline.
//
// 3. KEYS CAN BE FALSY. Post id `0n` is a valid post and a falsy bigint. Every guard here tests
//    `undefined` explicitly — `if (key)` would silently drop post 0 out of the quote pill.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "@/components/Providers";
import type { CognoApi } from "@/lib/types";

/** What to do with a key whose read threw. */
export type ErrorPolicy<V> =
  /** Uncommit it, so it is retried the next time a consumer for it mounts. */
  | { mode: "retry" }
  /** Commit `fallback` and never retry (the value is a cosmetic hint; thrashing is worse than stale). */
  | { mode: "commit"; fallback: V };

export interface ChainCacheSpec<K, V> {
  /** Display name, for the React devtools context. */
  name: string;
  /** Stable map key for a K. */
  toKey: (key: K) => string;
  /** Read one key. May throw — {@link ChainCacheSpec.onError} decides what that means. */
  read: (api: CognoApi, key: K) => Promise<V>;
  onError: ErrorPolicy<V>;
}

export interface ChainCache<K, V> {
  Provider: (props: { children: ReactNode }) => React.JSX.Element;
  /**
   * The cached value for `key`, or `null` while unknown / loading / outside the provider. Registering
   * is a side effect, so a consumer that mounts triggers a batched read and the value lands on a later
   * render. Pass `undefined` for "nothing to look up".
   */
  useValue: (key: K | undefined) => V | null;
  /**
   * Drop `keys` from the cache so the next consumer that mounts re-reads them. THIS IS THE THING THE
   * four hand-rolled caches did not have, and its absence is why useSelfProfile polls and why
   * ProfileHoverCard shows a stale name for the rest of the session after you edit your profile.
   */
  useInvalidate: () => (...keys: K[]) => void;
}

/** Internal envelope: a successful read of `null` is NOT a failure (see divergence 2). */
type Resolved<V> = { key: string; value: V } | null;

/**
 * The batching core — deliberately OUTSIDE React, so the divergences above are testable against the
 * real code rather than a re-implementation of it. The Provider is a thin shell over one of these.
 */
export interface Batcher<K, V> {
  /** Idempotent: a key already fetched or already queued is ignored. */
  request: (key: K) => void;
  /** Resolve everything queued, in ONE Promise.all, and hand back what committed. */
  flush: (api: CognoApi) => Promise<Array<{ key: string; value: V }>>;
  /** Uncommit keys so the next `request` re-reads them. */
  invalidate: (keys: K[]) => string[];
  queued: () => number;
  /** Test-only view of what is committed (in-flight or resolved). */
  isCommitted: (key: K) => boolean;
}

export function createBatcher<K, V>(spec: ChainCacheSpec<K, V>): Batcher<K, V> {
  const requested = new Set<string>(); // committed to a fetch (in-flight or resolved)
  const queue = new Map<string, K>(); // registered, waiting for the next batch

  return {
    request(key) {
      const k = spec.toKey(key);
      if (requested.has(k) || queue.has(k)) return;
      queue.set(k, key);
    },
    queued: () => queue.size,
    isCommitted: (key) => requested.has(spec.toKey(key)),
    invalidate(keys) {
      const ks = keys.map(spec.toKey);
      for (const k of ks) requested.delete(k);
      return ks;
    },
    async flush(api) {
      const batch = [...queue.entries()];
      queue.clear();
      for (const [k] of batch) requested.add(k);

      const entries = await Promise.all(
        batch.map(async ([keyStr, key]): Promise<Resolved<V>> => {
          try {
            return { key: keyStr, value: await spec.read(api, key) };
          } catch {
            if (spec.onError.mode === "commit") {
              return { key: keyStr, value: spec.onError.fallback };
            }
            // retry: uncommit, so this key is re-read the next time a consumer for it MOUNTS. An
            // already-mounted one will not auto-retry, which is acceptable for a coarse hint.
            requested.delete(keyStr);
            return null;
          }
        }),
      );
      // Filter on the ENVELOPE, never the value — `null` is a legitimate value (divergence 2).
      return entries.filter((e): e is { key: string; value: V } => e !== null);
    },
  };
}

export function createChainCache<K, V>(spec: ChainCacheSpec<K, V>): ChainCache<K, V> {
  interface Ctx {
    values: Map<string, V>;
    request: (key: K) => void;
    invalidate: (keys: K[]) => void;
  }
  const Context = createContext<Ctx | null>(null);
  Context.displayName = spec.name;

  function Provider({ children }: { children: ReactNode }) {
    const { api } = useSession();
    const [values, setValues] = useState<Map<string, V>>(new Map());

    // Reach the LATEST api from the deferred (microtask) flush closure without re-subscribing on identity.
    const apiRef = useRef(api);
    apiRef.current = api;
    const batcher = useRef(createBatcher<K, V>(spec)).current;
    const flushScheduled = useRef(false);
    const mounted = useRef(true);

    // Re-arm `mounted` on the SETUP pass, not just the cleanup: React 19 StrictMode (on in `next dev`)
    // double-invokes this effect mount → cleanup → remount. A cleanup-only body would leave `mounted`
    // stuck `false` after that dev-time cleanup, so every resolved batch's setState would be silently
    // swallowed and no value would ever appear while developing.
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    const flush = useCallback(() => {
      flushScheduled.current = false;
      const api0 = apiRef.current;
      // No socket yet — leave the queue INTACT; the [api] effect below re-flushes once it connects.
      if (!api0 || batcher.queued() === 0) return;
      void batcher.flush(api0).then((got) => {
        if (!mounted.current) return;
        if (got.length === 0) return; // nothing committed → don't churn a re-render
        setValues((prev) => {
          const next = new Map(prev);
          for (const { key, value } of got) next.set(key, value);
          return next;
        });
      });
    }, [batcher]);

    const scheduleFlush = useCallback(() => {
      if (flushScheduled.current) return;
      flushScheduled.current = true;
      queueMicrotask(flush);
    }, [flush]);

    const request = useCallback(
      (key: K) => {
        const before = batcher.queued();
        batcher.request(key);
        if (batcher.queued() > before) scheduleFlush();
      },
      [batcher, scheduleFlush],
    );

    const invalidate = useCallback(
      (keys: K[]) => {
        if (keys.length === 0) return;
        batcher.invalidate(keys); // uncommit, so `request` will queue the key for a fresh read
        // Re-QUEUE, don't just uncommit. An ALREADY-MOUNTED consumer never re-requests on its own —
        // useValue's effect is keyed on [key, request] and neither changes when a value is invalidated —
        // so uncommitting alone re-reads the key on the NEXT MOUNT and never for the surface that asked.
        // Every caller invalidates because it just WROTE (a profile save, a vote, a stake bind), and
        // ModalRouteHost — which invalidates after the profile save — is mounted once in AppShell and
        // never unmounts, so "the next mount" can be the rest of the session.
        //
        // The stale value is deliberately KEPT until the fresh one lands. Deleting it here blanked a
        // mounted consumer to `null`, which renders as a raw ss58 where a display name was: correct-then-
        // wrong is worse than stale-then-correct, and the flush overwrites it a microtask later anyway.
        for (const key of keys) request(key);
      },
      [batcher, request],
    );

    // When the socket connects (api null → ready), fetch anything registered while it was still offline.
    useEffect(() => {
      if (api && batcher.queued() > 0) scheduleFlush();
    }, [api, batcher, scheduleFlush]);

    const value = useMemo<Ctx>(() => ({ values, request, invalidate }), [values, request, invalidate]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
  }

  function useValue(key: K | undefined): V | null {
    const ctx = useContext(Context);
    const request = ctx?.request;
    // `key !== undefined`, NOT `if (key)` — post id 0n is falsy and valid (divergence 3). `request` is a
    // STABLE reference (it does not change when `values` updates), so this re-runs only on a key change.
    useEffect(() => {
      if (key !== undefined && request) request(key);
    }, [key, request]);
    if (key === undefined || !ctx) return null;
    return ctx.values.get(spec.toKey(key)) ?? null;
  }

  function useInvalidate(): (...keys: K[]) => void {
    const ctx = useContext(Context);
    const invalidate = ctx?.invalidate;
    return useCallback((...keys: K[]) => invalidate?.(keys), [invalidate]);
  }

  return { Provider, useValue, useInvalidate };
}
