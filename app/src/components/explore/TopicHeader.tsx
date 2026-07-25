"use client";

// TopicHeader — the topic band on /explore, shown when the committed query is exactly one #hashtag.
//
// A topic is a CONVENTION, not a chain field (see lib/topics): the feed under it is the node's substring
// search narrowed client-side to an exact tag. Following a topic is device-local — a topic follow is not
// verifiable, carries no weight, and on a ledger with no delete would publish a permanent interest graph
// to buy nothing.
//
// The note explains WHY a near-miss tag isn't here, because the difference is otherwise invisible: the
// ASCII-only case fold means `#café` and `#CAFÉ` are two topics (the node matches with
// `eq_ignore_ascii_case`, so it cannot fold them together).

import { tagLabel } from "@/lib/topics";
import styles from "./TopicHeader.module.css";

export interface TopicHeaderProps {
  /** The canonical topic (no leading '#'). */
  topic: string;
  followed: boolean;
  onToggleFollow: () => void;
  /** True while the first page is still resolving. */
  loading: boolean;
  /** True when the scan came back with nothing for this topic. */
  empty: boolean;
}

export function TopicHeader({ topic, followed, onToggleFollow, loading, empty }: TopicHeaderProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.text}>
        <p className={styles.tag}>{tagLabel(topic)}</p>
        {/* NO POST COUNT HERE, deliberately. Any number this band could show is the count BEFORE the
            timeline drops blocked authors and hidden posts, so it would contradict the rows underneath —
            including sitting over a no-results state. And an "N posts" figure reads as a total, which it
            can never be: the topic feed is a BOUNDED scan of recent posts that stops with a continuation
            cursor, so absence here is never absence from the chain. */}
        <p className={styles.note}>
          {loading
            ? "Looking for posts with this tag…"
            : empty
              ? "Nothing with this tag in the recent posts we scanned."
              : "Posts tagged this, newest first, from the recent posts we scanned."}
        </p>
      </div>
      {/* "Save"/"Saved", not "Follow"/"Following": every other Follow control in this app spends a CHAIN
          write on a real follow edge, and reusing the word for a device-local reading preference would
          imply this one does too. The title spells out where it lives. */}
      <button
        type="button"
        className={`${styles.follow} ${followed ? styles.followActive : ""}`}
        onClick={onToggleFollow}
        aria-pressed={followed}
        title="Saved on this device only — not written to the chain"
      >
        {followed ? "Saved" : "Save topic"}
      </button>
    </div>
  );
}
