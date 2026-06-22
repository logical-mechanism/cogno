"use client";

// FollowButton — toggle following an account (doc 03 §12). Optimistic. Matches X exactly:
//   not following → "Follow" (filled --cg-accent pill, --cg-accent-contrast text)
//   following     → "Following" (outline pill) → on HOVER morphs to "Unfollow" in --cg-danger red.
// No confirm dialog on unfollow (X doesn't confirm). Returns NOTHING on self (target === own
// address). not-connected → routes to /welcome via onToggle's gate at the call site; not-bound →
// disabled + tooltip. The edge state + onToggle are passed in (the surface owns useFollow); this is a
// presentational toggle that NEVER builds an extrinsic.

import { useState } from "react";
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
  const notBound = viewer.status === "not-identity-bound";

  // Visual label: following + hover → "Unfollow"; otherwise the edge state.
  const label = pending
    ? ""
    : isFollowing
      ? hovering
        ? "Unfollow"
        : "Following"
      : "Follow";

  const ariaLabel = isFollowing
    ? `Following ${handleOf(target)}, click to unfollow`
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
      disabled={pending || notBound}
      title={notBound ? "Finish setup to follow accounts." : undefined}
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
