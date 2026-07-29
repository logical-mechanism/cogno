"use client";

// FollowButton — toggle following an account. Optimistic. Matches X exactly:
//   not following → "Follow" (filled --cg-accent pill, --cg-accent-contrast text)
//   following     → "Following" (outline pill) → on HOVER morphs to "Unfollow" in --cg-danger red.
// No confirm dialog on unfollow (X doesn't confirm). Returns NOTHING on self (target === own
// address). not-connected → routes to /welcome via onToggle's gate at the call site; not-bound →
// disabled + tooltip. The edge state + onToggle are passed in (the surface owns useFollow); this is a
// presentational toggle that NEVER builds an extrinsic.

import { useState } from "react";
import { affordanceFor, affordanceTitle } from "@/lib/writeAffordance";
import styles from "./FollowButton.module.css";
import { Spinner } from "./icons";
import { handleOf } from "@/lib/ss58";
import type { ActionState, ControlSize, Viewer } from "./kit";

export interface FollowButtonProps {
  target: string;
  isFollowing: boolean;
  viewer: Viewer;
  state?: ActionState;
  onToggle: (target: string, next: boolean) => void;
  size?: ControlSize;
}

export function FollowButton({
  target,
  isFollowing,
  viewer,
  state = "idle",
  onToggle,
  size = "md",
}: FollowButtonProps) {
  const [hovering, setHovering] = useState(false);

  // Self → render nothing (ProfileHeader decides to show "Edit profile" instead).
  if (viewer.address && target === viewer.address) return null;

  const pending = state === "pending";
  // See lib/writeAffordance. A guest keeps a live Follow button that says what it will actually do.
  const mode = affordanceFor({ status: viewer.status, writeReady: viewer.writeReady });

  // Visual label: following + hover → "Unfollow"; otherwise the edge state.
  const label = pending
    ? ""
    : isFollowing
      ? hovering
        ? "Unfollow"
        : "Following"
      : "Follow";

  // Mirrors the VISIBLE resting label on purpose. Naming the action instead ("Unfollow …") looks
  // like the kinder choice on touch, where the label never morphs to "Unfollow" — but it breaks
  // WCAG 2.5.3 Label in Name: the accessible name would no longer contain the only word on screen,
  // so a voice-control user saying "tap Following" would stop matching this button. It would also
  // contradict aria-pressed, which already carries the state and wants a name that does not change
  // with it. The touch gap is real and belongs in the visible label, not in the accessible name.
  const ariaLabel = isFollowing
    ? `Following ${handleOf(target)}`
    : `Follow ${handleOf(target)}`;

  const cls = [
    styles.btn,
    size === "sm" ? styles.sm : styles.md,
    isFollowing ? styles.following : styles.follow,
    isFollowing && hovering ? styles.unfollow : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cls}
      aria-pressed={isFollowing}
      aria-label={ariaLabel}
      disabled={pending || mode === "blocked"}
      title={affordanceTitle(mode, "follow")}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
      onClick={() => onToggle(target, !isFollowing)}
    >
      {pending ? <Spinner size="sm" /> : label}
    </button>
  );
}
