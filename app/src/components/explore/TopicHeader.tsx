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
  /** Posts currently on screen for this topic — reported as "found", never as a total. */
  count: number;
  loading: boolean;
}

export function TopicHeader({ topic, followed, onToggleFollow, count, loading }: TopicHeaderProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.text}>
        <p className={styles.tag}>{tagLabel(topic)}</p>
        <p className={styles.note}>
          {loading
            ? "Looking for posts with this tag…"
            : count === 0
              ? "No posts carry this tag yet."
              : `${count} post${count === 1 ? "" : "s"} found with this tag.`}
        </p>
      </div>
      <button
        type="button"
        className={`${styles.follow} ${followed ? styles.followActive : ""}`}
        onClick={onToggleFollow}
        aria-pressed={followed}
      >
        {followed ? "Following" : "Follow topic"}
      </button>
    </div>
  );
}
