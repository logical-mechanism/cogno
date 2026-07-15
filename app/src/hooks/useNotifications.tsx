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
import { useBlockedList } from "@/lib/blockStore";
import { loadNotifications, orderNotifs, type Notif } from "@/lib/chain/notifications";
import {
  notificationReadActions,
  useNotificationReadState,
  isUnread as isUnreadOf,
} from "@/lib/notificationReadState";

/** Stable empty fold — keeps the `items` memo from re-running on every render when nothing is folded. */
const EMPTY_NOTIFS: Notif[] = [];

const REFRESH_INTERVAL_MS = 120_000; // catches edge signals (likes/follows/votes) that don't bump the head
const LIVE_DEBOUNCE_MS = 6_000; // coalesce a burst of new posts into one refold

export interface NotificationsFeed {
  items: Notif[];
  unreadCount: number;
  loading: boolean;
  /** true once the FIRST fold for the current account has settled. Distinguishes a genuinely-empty
   *  feed from a not-yet-folded one — a consumer must gate "mark all read on open" on this, never on
   *  `!loading` (which is also false in the pre-fold window). */
  loaded: boolean;
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
  loaded: false,
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
  const mutedList = useMutedList(me);
  const blockedList = useBlockedList(me);
  const readState = useNotificationReadState(me);

  // The fold and the "has settled" flag are STAMPED WITH THE ACCOUNT THEY BELONG TO, and `loaded` /
  // `items` are derived from that stamp rather than reset in an effect. Effects run child-first, so a
  // consumer's effect fires BEFORE this provider's on an in-place account switch — a `loaded` held in
  // plain state would still read `true` there, handing the consumer the previous account's items under
  // the new account's read-state. Deriving it makes that window impossible: the moment `me` changes,
  // `loaded` is already false in the same render.
  const [fold, setFold] = useState<{ account: string; notifs: Notif[]; truncated: boolean } | null>(
    null,
  );
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setFold({ account: me, notifs, truncated: trunc });
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
      if (seq === loadSeq.current) {
        setLoading(false);
        // The first (and every) fold has settled for THIS account — the feed is now authoritative.
        // Stamped even on the error path, so a failed fold surfaces the error instead of a forever-spinner.
        setLoadedFor(me);
      }
    }
  }, [me]);

  useEffect(() => {
    if (!me) {
      setFold(null);
      setLoadedFor(null);
      setError(null);
      return;
    }
    void runLoad();
    // The fold is EXPENSIVE (a fan-out over the viewer's own posts plus a mention search). Skip it while
    // the tab is hidden — nobody is looking at the badge, and a backgrounded tab was re-folding on a
    // fixed interval forever.
    const iv = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void runLoad();
    }, REFRESH_INTERVAL_MS);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let sub: { unsubscribe(): void } | undefined;
    const src = sourceRef.current;
    if (src?.liveHeadId) {
      // PAPI's watchValue REPLAYS its current value on subscribe, so the first emission is not a new
      // post — it is the head as it already stood. Acting on it scheduled a SECOND full fold 6s after
      // every mount and every account switch, on top of the runLoad() directly above. Skip it.
      let primed = false;
      sub = src.liveHeadId().subscribe({
        next: () => {
          if (!primed) {
            primed = true;
            return;
          }
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

  // Muted AND blocked actors are folded out of notifications (block is the harder suppression, but for
  // the notification feed both simply mean "don't surface this actor"). Both are device-local + small;
  // key the set on its contents so it's stable across renders.
  const suppressedKey = [...mutedList, ...blockedList].join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suppressedSet = useMemo(() => new Set([...mutedList, ...blockedList]), [suppressedKey]);

  // Only the CURRENT account's fold is ever surfaced. A fold left over from the previous account is
  // dropped here rather than by an effect, so there is no frame in which it is visible.
  const mine = fold && fold.account === me ? fold : null;
  const loaded = me != null && loadedFor === me;
  const truncated = mine?.truncated ?? false;
  const notifs = mine?.notifs ?? EMPTY_NOTIFS;

  const items = useMemo(
    () => orderNotifs(notifs, readState.firstSeen, suppressedSet),
    [notifs, readState.firstSeen, suppressedSet],
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
      loaded,
      // A failed fold belongs to the account it failed for; never leak it across a switch.
      error: loaded ? error : null,
      enabled: me != null,
      truncated,
      refresh,
      markAllRead,
      isUnread,
    }),
    [items, unreadCount, loading, loaded, error, me, truncated, refresh, markAllRead, isUnread],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/** The shared notifications feed. Returns an inert disabled feed outside the provider / when logged out. */
export function useNotificationsFeed(): NotificationsFeed {
  return useContext(NotificationsContext) ?? DISABLED;
}
