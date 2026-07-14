"use client";

// Skeleton — shimmering placeholder rows matching the shape of loading content.
// Pure presentational: a `variant` selects a shape preset; `count` repeats it. Shimmer is a token
// gradient sweep; under prefers-reduced-motion it falls back to a static block (handled in CSS).

import styles from "./Skeleton.module.css";
import type { SkeletonVariant } from "./kit";

export interface SkeletonProps {
  variant: SkeletonVariant;
  /** Repeat the preset (e.g. 8 post rows for an initial timeline). */
  count?: number;
  /** Width override for `line` / `avatar` presets. */
  width?: string;
}

function Block({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={`${styles.block} ${className ?? ""}`} style={style} aria-hidden />;
}

function PostSkeleton() {
  return (
    <div className={styles.post}>
      <Block className={styles.avatar} />
      <div className={styles.postMain}>
        <div className={styles.headerRow}>
          <Block className={styles.name} />
          <Block className={styles.handle} />
        </div>
        <Block className={styles.bodyLine} />
        <Block className={`${styles.bodyLine} ${styles.bodyLineShort}`} />
        <div className={styles.actionRow}>
          <Block className={styles.action} />
          <Block className={styles.action} />
          <Block className={styles.action} />
          <Block className={styles.action} />
        </div>
      </div>
    </div>
  );
}

function ProfileHeaderSkeleton() {
  return (
    <div className={styles.profileHeader}>
      <Block className={styles.banner} />
      <Block className={styles.avatarXl} />
      <Block className={styles.name} style={{ width: "40%" }} />
      <Block className={styles.handle} style={{ width: "30%" }} />
      <Block className={styles.bodyLine} style={{ width: "70%" }} />
    </div>
  );
}

function PollCardSkeleton() {
  return (
    <div className={styles.pollCard}>
      <Block className={styles.pollOption} />
      <Block className={styles.pollOption} />
      <Block className={styles.pollOption} />
    </div>
  );
}

function PersonSkeleton() {
  return (
    <div className={styles.person}>
      <Block className={styles.avatar} />
      <div className={styles.personMain}>
        <Block className={styles.name} style={{ width: "50%" }} />
        <Block className={styles.handle} style={{ width: "35%" }} />
      </div>
      <Block className={styles.followPill} />
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div>
      <PostSkeleton />
      <PostSkeleton />
      <PostSkeleton />
    </div>
  );
}

export function Skeleton({ variant, count = 1, width }: SkeletonProps) {
  const one = (key: number) => {
    switch (variant) {
      case "post":
        return <PostSkeleton key={key} />;
      case "profileHeader":
        return <ProfileHeaderSkeleton key={key} />;
      case "pollCard":
        return <PollCardSkeleton key={key} />;
      case "thread":
        return <ThreadSkeleton key={key} />;
      case "person":
        return <PersonSkeleton key={key} />;
      case "avatar":
        return <Block key={key} className={styles.avatar} style={width ? { width, height: width } : undefined} />;
      case "line":
      default:
        return <Block key={key} className={styles.line} style={width ? { width } : undefined} />;
    }
  };

  return (
    <div className={styles.root} aria-busy="true" role="status">
      {Array.from({ length: Math.max(1, count) }, (_, i) => one(i))}
      <span className={styles.srOnly}>Loading</span>
    </div>
  );
}
