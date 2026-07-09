"use client";

// useNotifications — the session-shared notifications feed, folded CLIENT-SIDE from the reverse indexes
// the chain already maintains (lib/chain/notifications). Mounted ONCE (NotificationsProvider) so the
// nav bell badge and the /notifications page share a single bounded fold rather than each running their
// own. It records device-local first-seen per item (notificationReadState) so edge signals order stably
// and the unread badge works, applies device-local mute + self-filter, and orders newest-first.
//
// Reloads: on mount / account change, on an interval (catches likes/follows/votes, which don't bump the
// post head), and — debounced — on each new post head (catches fresh replies/mentions). All best-effort:
// a failed fold degrades to the last good set, never throws into the UI.

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
import { useMutedList } from "@/lib/muteStore";
import { loadNotifications, orderNotifs, type Notif } from "@/lib/chain/notifications";
import {
  notificationReadActions,
  useNotificationReadState,
  isUnread as isUnreadOf,
} from "@/lib/notificationReadState";

const REFRESH_INTERVAL_MS = 120_000; // catches edge signals (likes/follows/votes) that don't bump the head
const LIVE_DEBOUNCE_MS = 6_000; // coalesce a burst of new posts into one refold

export interface NotificationsFeed {
  items: Notif[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  /** false when there is no connected account (nothing to fold). */
  enabled: boolean;
  /** the viewer has more posts than the scan cap — older activity is not surfaced. */
  truncated: boolean;
  refresh: () => void;
  markAllRead: () => void;
  isUnread: (key: string) => boolean;
}

const DISABLED: NotificationsFeed = {
  items: [],
  unreadCount: 0,
  loading: false,
  error: null,
  enabled: false,
  truncated: false,
  refresh: () => {},
  markAllRead: () => {},
  isUnread: () => false,
};

const NotificationsContext = createContext<NotificationsFeed | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { api, source, viewer } = useSession();
  const me = viewer.address ?? null;
  const mutedList = useMutedList();
  const readState = useNotificationReadState(me);

  const [raw, setRaw] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // Reach the latest api/source from the reload closure without re-subscribing on identity.
  const apiRef = useRef(api);
  apiRef.current = api;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const loadSeq = useRef(0);

  const runLoad = useCallback(async () => {
    const api0 = apiRef.current;
    if (!api0 || !me) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const { notifs, truncated: trunc } = await loadNotifications(api0, sourceRef.current, me);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      setRaw(notifs);
      setTruncated(trunc);
      setError(null);
      // Stamp first-seen for any new item keys (drives the unread badge + edge-signal ordering).
      notificationReadActions.recordSeen(
        me,
        notifs.map((n) => n.key),
      );
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : "could not load notifications");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    if (!me) {
      setRaw([]);
      setTruncated(false);
      return;
    }
    void runLoad();
    const iv = setInterval(() => void runLoad(), REFRESH_INTERVAL_MS);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let sub: { unsubscribe(): void } | undefined;
    const src = sourceRef.current;
    if (src?.liveHeadId) {
      sub = src.liveHeadId().subscribe({
        next: () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void runLoad(), LIVE_DEBOUNCE_MS);
        },
        error: () => {},
      });
    }
    return () => {
      clearInterval(iv);
      if (debounce) clearTimeout(debounce);
      sub?.unsubscribe();
    };
  }, [me, source, runLoad]);

  // Mute is device-local + small; key the set on its contents so it's stable across renders.
  const mutedKey = mutedList.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mutedSet = useMemo(() => new Set(mutedList), [mutedKey]);

  const items = useMemo(
    () => orderNotifs(raw, readState.firstSeen, mutedSet),
    [raw, readState.firstSeen, mutedSet],
  );
  const unreadCount = useMemo(
    () => items.reduce((n, it) => n + (isUnreadOf(readState, it.key) ? 1 : 0), 0),
    [items, readState],
  );

  const markAllRead = useCallback(() => {
    if (me) notificationReadActions.markAllRead(me);
  }, [me]);
  const refresh = useCallback(() => {
    void runLoad();
  }, [runLoad]);
  const isUnread = useCallback((key: string) => isUnreadOf(readState, key), [readState]);

  const value = useMemo<NotificationsFeed>(
    () => ({
      items,
      unreadCount,
      loading,
      error,
      enabled: me != null,
      truncated,
      refresh,
      markAllRead,
      isUnread,
    }),
    [items, unreadCount, loading, error, me, truncated, refresh, markAllRead, isUnread],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/** The shared notifications feed. Returns an inert disabled feed outside the provider / when logged out. */
export function useNotificationsFeed(): NotificationsFeed {
  return useContext(NotificationsContext) ?? DISABLED;
}
