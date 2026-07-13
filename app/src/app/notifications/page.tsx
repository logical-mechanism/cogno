"use client";

// /notifications — the activity feed for the connected account (doc 04 §5.4), folded client-side from
// the reverse indexes (useNotifications). A single non-dynamic route (bookmarks shape). Two filters:
// All and Mentions (the @<my-ss58> body-search hits). Opening the page ARMS the unread highlight (so it
// persists while you read) and clears the nav badge; activity landing while the page is open arms itself
// the same way. "Mark all read" dismisses the highlight — the badge is already clear by then.

import { useEffect, useRef, useState } from "react";
import { StickyHeader } from "@/components/AppShell";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/EmptyState";
import { Loading } from "@/components/Loading";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { useNotificationsFeed } from "@/hooks/useNotifications";
import { useSession } from "@/components/Providers";
import styles from "./page.module.css";

type NotifTab = "all" | "mentions";

/** Stable identity — `setHighlighted(EMPTY_KEYS)` on an already-empty set bails out instead of looping. */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

const TABS: { id: NotifTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions" },
];

const PANEL_ID = "cg-notifications-panel";

export default function NotificationsPage() {
  const feed = useNotificationsFeed();
  const { viewer } = useSession();
  const me = viewer.address ?? null;
  const [tab, setTab] = useState<NotifTab>("all");

  // `highlighted` = the keys drawn with the unread wash. Gate the arming on `loaded` — NOT `!loading` —
  // because on a hard load / deep-link the fold hasn't run yet (loading is still false, items empty), and
  // arming then would markAllRead an empty set and leave the badge stuck once the fold lands.
  //
  // It is STATE, not a ref, and it is armed DURING RENDER rather than in an effect: a ref written in a
  // passive effect does not re-render, so the rows painted one frame as read before flipping to unread.
  // Merging only keys not already armed makes the render-phase update converge in one extra pass, and
  // lets live activity re-arm itself (a one-way "dismissed" flag left new arrivals permanently unlit).
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  // Re-arm on an in-place account switch (viewer.address changes without a remount). `armed` must drop
  // the previous account's keys in THIS pass too: a render-phase setState does not update `highlighted`
  // for the current pass, so reading it below would merge the old account's set into the new one.
  const prevMe = useRef(me);
  const accountChanged = prevMe.current !== me;
  if (accountChanged) {
    prevMe.current = me;
    setHighlighted(EMPTY_KEYS);
  }

  let armed = accountChanged ? EMPTY_KEYS : highlighted;
  if (feed.enabled && feed.loaded) {
    const fresh = feed.items.filter((i) => feed.isUnread(i.key) && !armed.has(i.key));
    if (fresh.length > 0) {
      armed = new Set([...armed, ...fresh.map((i) => i.key)]);
      setHighlighted(armed);
    }
  }

  // Clearing the badge is a store write, so it can never happen during render. Keyed on the armed set:
  // it runs when we arm (on open, and again when live activity lands) and not when we dismiss.
  const feedRef = useRef(feed);
  feedRef.current = feed;
  useEffect(() => {
    if (highlighted.size > 0) feedRef.current.markAllRead();
  }, [highlighted]);

  const wasUnread = (key: string) => armed.has(key);
  // "Mark all read" dismisses the wash. The badge is already clear (armed ⇒ markAllRead ran), so there
  // is no read-state work left to do — later activity re-arms itself through the render path above.
  const onMarkAllRead = () => setHighlighted(EMPTY_KEYS);

  const items = tab === "mentions" ? feed.items.filter((i) => i.kind === "mention") : feed.items;
  const showEmpty = feed.loaded && items.length === 0;
  // Offer the action only when there is a wash to clear, and never floating above an empty state.
  const showMarkAllRead = !showEmpty && armed.size > 0;


  const tabsNode = (
    <Tabs
      tabs={TABS}
      active={tab}
      onChange={setTab}
      idPrefix="cg-notif-tab"
      panelId={PANEL_ID}
      ariaLabel="Notification filters"
    />
  );

  return (
    <>
      <StickyHeader
        title="Notifications"
        tabs={tabsNode}
        actions={
          showMarkAllRead ? (
            <button type="button" className={styles.markRead} onClick={onMarkAllRead}>
              Mark all read
            </button>
          ) : undefined
        }
      />

      {/* The tabpanel the tablist's aria-controls points at — present in every state, like Timeline's. */}
      <div id={PANEL_ID} role="tabpanel" aria-labelledby={`cg-notif-tab-${tab}`}>
        {!feed.enabled ? (
          <EmptyState
            variant="generic"
            title="Sign in to see notifications"
            description="Connect your wallet to follow replies, likes, mentions and new followers."
          />
        ) : (!feed.loaded || feed.loading) && items.length === 0 ? (
          <Loading variant="surface" label="Loading notifications…" />
        ) : showEmpty ? (
          <EmptyState
            variant="generic"
            title={tab === "mentions" ? "No mentions yet" : "No notifications yet"}
            description={
              tab === "mentions"
                ? "When someone @mentions you in a post, it shows up here."
                : "Replies, likes, mentions, poll votes and new followers show up here."
            }
          />
        ) : (
          <div className={styles.list}>
            {items.map((n) => (
              <NotificationRow key={n.key} notif={n} unread={wasUnread(n.key)} />
            ))}
            {feed.truncated && tab === "all" && (
              <p className={styles.truncated}>
                Showing your most recent activity — older items aren’t listed.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
