"use client";

// useSelfProfile — the connected viewer's OWN display name + avatar, for app chrome (the composer
// avatar/name, the account menu, optimistic pending-post authorship). The Viewer object carries these
// so every kit surface shows the real profile, not just the identicon + @handle.
//
// It watches ONE storage key — `Profile.Profiles[ss58]` — and merges the optimistic profile overlay so
// a just-saved edit shows INSTANTLY (without the overlay, the chrome avatar would flash back to the
// pre-edit value in the gap between confirm and re-read). Returns bare fields (never a cover concern —
// chrome renders the own avatar `eager`).
//
// IT USED TO POLL, AND THE POLL WAS EXPENSIVE. The old shape took `liveKey = bestBlock` in its dep
// array and re-ran `source.profile({author: ss58})` on EVERY block — and that call is a Promise.all of
// eight cross-pallet reads PLUS a full `nodeAuthorFeedPage(limit: 50)` state_call (papi-source.ts), a
// 50-post enriched page that this hook threw away to keep two strings fresh. That was ~9 RPCs and a
// 50-post payload every ~6 seconds, forever, for every connected visitor. `watchValue` is strictly
// better on every axis: it is still live (an edit made on another device still lands), it is one
// subscription instead of a nine-read poll, and it reads exactly the row the two strings come from.
//
// DELIBERATELY NOT ROUTED THROUGH `useAccountProfile`. That cache's error policy is
// commit-empty-and-never-retry — correct for a mention chip settling on a truncated ss58, wrong here:
// one transient miss would pin a blank avatar in the app chrome for the rest of the session. The
// watch self-heals on the next block.

import { useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "@/hooks/useOptimistic";
import { binTextOpt } from "@/lib/chain/reads";
import type { CognoApi } from "@/lib/types";

export interface SelfProfile {
  displayName?: string;
  avatar?: string;
}

export function useSelfProfile(
  api: CognoApi | null,
  ss58: string | null,
  /** Only read for a real, actively-chosen posting account (never the //Alice background default). */
  enabled: boolean,
): SelfProfile {
  const { overlay } = useOptimistic();
  const [base, setBase] = useState<SelfProfile>({});
  // Track which account we've shown data for, so a fresh account resets (not a stale carry-over).
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !ss58 || !api) {
      setBase({});
      loadedFor.current = null;
      return;
    }
    // Drop the previous account's avatar immediately on a switch, rather than showing it until the
    // first emission for the new one lands.
    if (loadedFor.current !== ss58) setBase({});
    loadedFor.current = ss58;
    // At BEST, not finalized: this row is READ-AFTER-WRITE. Saving a profile invalidates the chrome
    // from an `onConfirm` that fires at `inBestBlock`, blocks before finalization — at the finalized
    // default the watch would keep re-emitting the PRE-save row over the optimistic overlay until
    // finality caught up. Same rule and same reason as the sibling read in papi-source's `profile()`.
    const sub = api.query.Profile.Profiles.watchValue(ss58, { at: "best" }).subscribe(
      ({ value: rec }) => {
        const displayName = binTextOpt(rec?.display_name);
        const avatar = binTextOpt(rec?.avatar);
        // KEEP THE PREVIOUS OBJECT when nothing actually changed. `watchValue` is a per-block poll, so
        // a plain `setBase({...})` mints a fresh object every ~6s and re-renders ChainProvider (which
        // owns this hook) for an unchanged answer — the same churn the sibling ObservedRoles watch in
        // Providers guards against, and a profile moves far less often than roles do.
        setBase((prev) =>
          prev.displayName === displayName && prev.avatar === avatar ? prev : { displayName, avatar },
        );
      },
      // Keep the last good value on a subscription error — a first-load miss just leaves the identicon,
      // and blanking a working avatar because of a transient hiccup is the worse failure.
      () => {},
    );
    return () => sub.unsubscribe();
  }, [api, ss58, enabled]);

  // Merge the optimistic overlay (set_profile overwrites the whole record) so a save shows at once.
  const patch = ss58 ? overlay.profiles[ss58] : undefined;
  return useMemo<SelfProfile>(() => {
    if (!patch) return base;
    return {
      displayName: patch.displayName.trim() || undefined,
      avatar: patch.avatar.trim() || undefined,
    };
  }, [base, patch]);
}
