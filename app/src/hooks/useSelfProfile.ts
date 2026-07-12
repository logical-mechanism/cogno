"use client";

// useSelfProfile — the connected viewer's OWN display name + avatar, for app chrome (the composer
// avatar/name, the account menu, optimistic pending-post authorship). The Viewer object carries these
// so every kit surface shows the real profile, not just the identicon + @handle.
//
// Reads source.profile({author: self}) once connected, refreshes silently each block (so an edit lands
// here too), and merges the optimistic profile overlay so a just-saved edit shows INSTANTLY — without
// the overlay, the chrome avatar would flash back to the pre-edit value in the gap between confirm and
// re-read. Returns bare fields (never a cover concern — chrome renders the own avatar `eager`).

import { useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "@/hooks/useOptimistic";
import type { FeedSource } from "@/lib/feed/source";

export interface SelfProfile {
  displayName?: string;
  avatar?: string;
}

export function useSelfProfile(
  source: FeedSource | null,
  ss58: string | null,
  /** Only read for a real, actively-chosen posting account (never the //Alice background default). */
  enabled: boolean,
  /** A changing value (best block) that triggers a SILENT refresh so out-of-band edits land. */
  liveKey?: number | null,
): SelfProfile {
  const { overlay } = useOptimistic();
  const [base, setBase] = useState<SelfProfile>({});
  // Track which account we've shown data for, so a fresh account resets (not a stale carry-over).
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !ss58 || !source) {
      setBase({});
      loadedFor.current = null;
      return;
    }
    let cancelled = false;
    const firstForAccount = loadedFor.current !== ss58;
    if (firstForAccount) setBase({}); // drop the previous account's avatar immediately on switch
    source
      .profile({ author: ss58 })
      .then((p) => {
        if (cancelled) return;
        loadedFor.current = ss58;
        setBase({ displayName: p.displayName, avatar: p.avatar });
      })
      .catch(() => {
        // Keep the last good value on a silent-refresh miss; a first-load miss just leaves the identicon.
      });
    return () => {
      cancelled = true;
    };
  }, [source, ss58, enabled, liveKey]);

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
