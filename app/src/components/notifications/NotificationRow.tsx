"use client";

// NotificationRow — one folded notification: a leading kind icon, the actor's avatar + display name
// (resolved + cached via useAccountProfile), the action verb, and an unread dot. The whole row links to
// the most useful target (the post for reply/mention/like/poll; the actor's profile for follow/rep).

import Link from "next/link";
import { Avatar } from "../Avatar";
import { DisplayName } from "../DisplayName";
import { Handle } from "../Handle";
import { IconReply, IconLike, IconDownvote, IconBell, IconProfile, IconPoll } from "../icons";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { sanitizeInline } from "@/lib/sanitize";
import type { IconProps } from "../icons";
import type { Notif } from "@/lib/chain/notifications";
import styles from "./NotificationRow.module.css";

/** Where the row navigates: the referenced post, else the actor's profile. */
function targetHref(n: Notif): string {
  if (
    (n.kind === "reply" || n.kind === "mention" || n.kind === "like" || n.kind === "pollvote") &&
    n.postId != null
  ) {
    return `/post/${n.postId}/`;
  }
  return `/u/${n.actor}/`;
}

function verb(n: Notif): string {
  switch (n.kind) {
    case "reply":
      return "replied to your post";
    case "mention":
      return "mentioned you";
    case "like":
      return n.dir === "Down" ? "downvoted your post" : "upvoted your post";
    case "reputation":
      return n.dir === "Down" ? "disputed your account" : "endorsed your account";
    case "follow":
      return "followed you";
    case "pollvote":
      return "voted on your poll";
  }
}

function KindIcon({ n }: { n: Notif }): React.ReactElement {
  const p: IconProps = { size: "var(--cg-icon-md)" };
  const down = n.dir === "Down";
  switch (n.kind) {
    case "reply":
      return <IconReply {...p} />;
    case "mention":
      return <IconBell {...p} />;
    case "like":
      return down ? <IconDownvote {...p} /> : <IconLike {...p} />;
    case "reputation":
      return down ? <IconDownvote {...p} /> : <IconLike {...p} />;
    case "follow":
      return <IconProfile {...p} />;
    case "pollvote":
      return <IconPoll {...p} />;
  }
}

/** Tone class for the leading kind icon (accent endorsement, danger for down, neutral otherwise). */
function toneClass(n: Notif): string {
  if (n.dir === "Down") return styles.toneDown;
  if (n.kind === "like" || n.kind === "reputation") return styles.toneUp;
  return styles.toneNeutral;
}

export function NotificationRow({ notif, unread }: { notif: Notif; unread: boolean }) {
  const profile = useAccountProfile(notif.actor);
  return (
    <Link
      href={targetHref(notif)}
      className={`${styles.row} ${unread ? styles.unread : ""}`}
      aria-label={`${sanitizeInline(profile?.displayName ?? "") || notif.actor} ${verb(notif)}`}
    >
      <span className={`${styles.kind} ${toneClass(notif)}`} aria-hidden>
        <KindIcon n={notif} />
      </span>
      <Avatar address={notif.actor} src={profile?.avatar} size="md" name={profile?.displayName} />
      <span className={styles.body}>
        <span className={styles.line}>
          <DisplayName address={notif.actor} displayName={profile?.displayName} truncate />
          <span className={styles.verb}>{verb(notif)}</span>
        </span>
        <Handle address={notif.actor} />
      </span>
      {unread && <span className={styles.dot} aria-hidden />}
    </Link>
  );
}
