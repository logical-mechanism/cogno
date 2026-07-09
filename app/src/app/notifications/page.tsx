"use client";

// /notifications — the activity feed for the connected account (doc 04 §5.4), folded client-side from
// the reverse indexes (useNotifications). A single non-dynamic route (bookmarks shape). Two filters:
// All and Mentions (the @<my-ss58> body-search hits). Opening the page freezes which items were unread
// (so the highlight persists for this view) and clears the nav badge.

import { useEffect, useRef, useState } from "react";
import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/icons";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { useNotificationsFeed } from "@/hooks/useNotifications";
import styles from "./page.module.css";

type NotifTab = "all" | "mentions";

export default function NotificationsPage() {
  const feed = useNotificationsFeed();
  const [tab, setTab] = useState<NotifTab>("all");

  // Freeze the unread set at open (so the highlight is stable while you read), then clear the badge.
  // Runs once the first fold has settled (enabled + not loading).
  const frozen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (frozen.current === null && feed.enabled && !feed.loading) {
      frozen.current = new Set(feed.items.filter((i) => feed.isUnread(i.key)).map((i) => i.key));
      feed.markAllRead();
    }
  }, [feed]);
  const wasUnread = (key: string) => frozen.current?.has(key) ?? false;

  const items = tab === "mentions" ? feed.items.filter((i) => i.kind === "mention") : feed.items;
  const showEmpty = !feed.loading && items.length === 0;

  const tabsNode = (
    <div className={styles.tabs} role="tablist" aria-label="Notification filters">
      {(["all", "mentions"] as NotifTab[]).map((t) => {
        const selected = tab === t;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`${styles.tab} ${selected ? styles.tabActive : ""}`}
            onClick={() => setTab(t)}
          >
            <span>{t === "all" ? "All" : "Mentions"}</span>
            {selected && <span className={styles.indicator} aria-hidden />}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <StickyHeader
        title="Notifications"
        tabs={tabsNode}
        actions={
          feed.items.length > 0 ? (
            <button type="button" className={styles.markRead} onClick={() => feed.markAllRead()}>
              Mark all read
            </button>
          ) : undefined
        }
      />

      {!feed.enabled ? (
        <EmptyState
          variant="generic"
          title="Sign in to see notifications"
          description="Connect your wallet to follow replies, likes, mentions and new followers."
        />
      ) : feed.loading && items.length === 0 ? (
        <div className={styles.loading} aria-busy>
          <Spinner size="md" label="Loading notifications" />
        </div>
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
    </>
  );
}
