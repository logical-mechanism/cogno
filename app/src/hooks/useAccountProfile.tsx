"use client";

// useAccountProfile — a session-lived, shared cache of each account's profile display name + avatar,
// keyed by ss58. It powers surfaces that reference an account which is NOT the author of an on-screen
// post (so the feed's per-post `authorDisplayName` enrichment doesn't already cover it): the @mention
// chips inside a post body (`MentionChip`) and the actor rows in the notifications feed.
//
// WHY A SHARED PROVIDER (mirrors useReputation): a mentioned/acting account recurs across many posts
// and surfaces; keying the cache by account — app-wide — means the same account costs exactly ONE
// `Profile.Profiles` read no matter how many mentions of them are on screen, and a name resolved on
// Home is already warm when you open a thread. A leaf `<MentionChip>` / notification row consumes it.
//
// READS: POINT reads of `Profile.Profiles` per DISTINCT account, BATCHED (a microtask coalesces every
// account registered in the same tick into ONE `Promise.all`) and cached for the session. A failed or
// empty read resolves to an EMPTY record `{}` (not re-tried per render) — the chip degrades to the
// truncated ss58, exactly the graceful fallback for an unbound/nameless account.

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
import { binTextOpt } from "@/lib/chain/reads";
import type { CognoApi, Ss58 } from "@/lib/types";

/** A resolved (possibly empty) profile snapshot for one account. */
export interface AccountProfile {
  displayName?: string;
  avatar?: string;
}

interface AccountProfileCtx {
  /** Resolved profiles, keyed by ss58. Absent ⇒ unknown / still loading. */
  profiles: Map<string, AccountProfile>;
  /** Register an account for a batched, cached profile read (idempotent; safe to call every render). */
  request: (address: Ss58) => void;
}

const AccountProfileContext = createContext<AccountProfileCtx | null>(null);

/** Read one `Profile.Profiles` row → the display name + avatar (both BoundedVec<u8> → trimmed string). */
async function readAccountProfile(api: CognoApi, account: Ss58): Promise<AccountProfile> {
  const rec = (await api.query.Profile.Profiles.getValue(account)) as unknown as
    | { display_name?: Uint8Array; avatar?: Uint8Array }
    | undefined;
  return { displayName: binTextOpt(rec?.display_name), avatar: binTextOpt(rec?.avatar) };
}

export function AccountProfileProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [profiles, setProfiles] = useState<Map<string, AccountProfile>>(new Map());

  // Reach the LATEST api from the deferred (microtask) flush closure without re-subscribing on identity.
  const apiRef = useRef(api);
  apiRef.current = api;
  const requested = useRef<Set<string>>(new Set()); // committed to a fetch (in-flight or resolved)
  const queue = useRef<Set<string>>(new Set()); // registered, waiting for the next batch
  const flushScheduled = useRef(false);
  const mounted = useRef(true);
  // Re-arm `mounted` on SETUP (not just cleanup): React 19 StrictMode double-invokes the effect in
  // `next dev`; a cleanup-only body would leave `mounted` stuck false and swallow every resolved batch.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const flush = useCallback(() => {
    flushScheduled.current = false;
    const api0 = apiRef.current;
    // No socket yet — leave the queue INTACT; the [api] effect re-flushes once the client connects.
    if (!api0 || queue.current.size === 0) return;
    const batch = Array.from(queue.current);
    queue.current.clear();
    for (const a of batch) requested.current.add(a);
    void Promise.all(
      batch.map(async (addr) => {
        try {
          return [addr, await readAccountProfile(api0, addr)] as const;
        } catch {
          // Read failed — resolve to empty so the chip shows the truncated-ss58 fallback (identical to
          // an unbound/nameless account) rather than retrying forever. A reload refetches.
          return [addr, {} as AccountProfile] as const;
        }
      }),
    ).then((entries) => {
      if (!mounted.current) return;
      setProfiles((prev) => {
        const next = new Map(prev);
        for (const [addr, prof] of entries) next.set(addr, prof);
        return next;
      });
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(flush);
  }, [flush]);

  const request = useCallback(
    (address: Ss58) => {
      if (!address || requested.current.has(address) || queue.current.has(address)) return;
      queue.current.add(address);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // When the socket connects (api null → ready), fetch anything registered while it was still offline.
  useEffect(() => {
    if (api && queue.current.size > 0) scheduleFlush();
  }, [api, scheduleFlush]);

  const value = useMemo<AccountProfileCtx>(() => ({ profiles, request }), [profiles, request]);
  return <AccountProfileContext.Provider value={value}>{children}</AccountProfileContext.Provider>;
}

/**
 * The cached profile (display name + avatar) for one account, or `null` while unknown / loading /
 * outside the provider. Registering the address is a side effect, so a chip that mounts triggers a
 * batched read; the profile lands on a later render once the batch resolves. `request` is a STABLE
 * reference, so this effect re-runs only when the address changes — never in a loop as profiles fill in.
 */
export function useAccountProfile(address: string | undefined): AccountProfile | null {
  const ctx = useContext(AccountProfileContext);
  const request = ctx?.request;
  useEffect(() => {
    if (address && request) request(address);
  }, [address, request]);
  return address && ctx ? (ctx.profiles.get(address) ?? null) : null;
}
