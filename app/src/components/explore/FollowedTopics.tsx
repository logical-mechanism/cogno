"use client";

// FollowedTopics — a strip of the viewer's followed topics on /explore's DEFAULT surface, each linking to
// its topic feed.
//
// LINKS, NOT PREVIEWS, and that is a cost decision rather than a layout one. Every topic preview would be
// its own `search_posts` scan, and each of those rebuilds the staker-weight map node-side; N topics on
// mount would be N of those to render a handful of rows nobody asked for. So the strip navigates.
//
// Device-local (lib/topicStore), per account. Topics are a convention, never chain state.

import Link from "next/link";
import { tagLabel, tagSearchTerm } from "@/lib/topics";
import styles from "./FollowedTopics.module.css";

export interface FollowedTopicsProps {
  /** Canonical topics (no leading '#'), already sorted. */
  topics: readonly string[];
}

export function FollowedTopics({ topics }: FollowedTopicsProps) {
  if (topics.length === 0) return null;
  return (
    <nav className={styles.bar} aria-label="Followed topics">
      <span className={styles.label}>Your topics</span>
      {topics.map((t) => (
        <Link
          key={t}
          className={styles.topic}
          href={`/explore/?q=${encodeURIComponent(tagSearchTerm(t))}`}
        >
          {tagLabel(t)}
        </Link>
      ))}
    </nav>
  );
}
