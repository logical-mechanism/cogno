"use client";

// ProfileHoverCard — desktop hover quick-view over a username/avatar (doc 03 §12 follow-up). Wraps a
// trigger; after a short hover delay it LAZILY fetches the author's profile (node-direct profile()
// reader: name / bio / avatar / follower+following counts) and shows a popover with a Follow button.
//
// HOVER-ONLY — a no-op on touch / coarse-pointer devices (the trigger's own click/navigation is
// untouched). The fetch happens only WHILE hovering, so wrapping every feed name/avatar costs nothing
// until the user actually hovers. The popover is PORTALED to <body> and fixed-positioned from the
// trigger's rect, so it escapes any feed-row overflow clipping.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import styles from "./ProfileHoverCard.module.css";
import { Avatar } from "./Avatar";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import { FollowButton } from "./FollowButton";
import { Spinner } from "./icons";
import { useSession } from "./Providers";
import { useFollow } from "@/hooks/useFollow";
import type { AuthorRef } from "./kit";
import type { ProfileView } from "@/lib/types";

const OPEN_DELAY = 350;
const CLOSE_DELAY = 200;
const CARD_W = 300;
const EST_H = 220;

// Session-lived cache so the avatar + name triggers (and re-hovers) share ONE profile() fetch per
// author — profile() returns the full ProfileView (incl. the author's posts page), so refetching it on
// every hover would be wasteful. Counts can go slightly stale (the live profile page is the truth).
const profileCache = new Map<string, ProfileView>();

function supportsHover(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;
}

interface Coords {
  top: number;
  left: number;
}

export function ProfileHoverCard({ author, children }: { author: AuthorRef; children: ReactNode }) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpen = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const doOpen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - CARD_W - 8));
    const top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - EST_H - 8));
    setCoords({ top, left });
  }, []);

  const scheduleOpen = useCallback(() => {
    if (!supportsHover()) return; // hover-only — touch devices keep the trigger's normal click
    cancelClose();
    if (coords || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      doOpen();
    }, OPEN_DELAY);
  }, [coords, cancelClose, doOpen]);

  const scheduleClose = useCallback(() => {
    cancelOpen();
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setCoords(null);
    }, CLOSE_DELAY);
  }, []);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelClose],
  );

  return (
    <span
      ref={wrapRef}
      className={styles.wrap}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      {children}
      {coords && (
        <HoverPopover
          author={author}
          coords={coords}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </span>
  );
}

function HoverPopover({
  author,
  coords,
  onMouseEnter,
  onMouseLeave,
}: {
  author: AuthorRef;
  coords: Coords;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const router = useRouter();
  const { api, signer, source, viewer } = useSession();
  const me = viewer.address ?? null;
  const follow = useFollow(api, signer, source, me);
  const [profile, setProfile] = useState<ProfileView | null>(
    () => profileCache.get(author.address) ?? null,
  );

  // Lazily fetch the full profile (node-direct: name/bio/avatar/counts), cache it. Keeps the seed
  // name+avatar from the post visible while it loads; a failed read just leaves the seed.
  useEffect(() => {
    if (!source) return;
    const cached = profileCache.get(author.address);
    if (cached) {
      setProfile(cached);
      return;
    }
    let cancelled = false;
    void source
      .profile({ author: author.address })
      .then((p) => {
        profileCache.set(author.address, p);
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        /* keep the seed */
      });
    return () => {
      cancelled = true;
    };
  }, [source, author.address]);

  const displayName = profile?.displayName ?? author.displayName;
  const avatar = profile?.avatar ?? author.avatar;
  const banned = profile?.banned ?? author.banned ?? false;
  const bio = profile?.bio?.trim() ?? "";
  const hasCounts = source != null && profile != null;

  const openProfile = useCallback(
    () => router.push(`/u/${author.address}/`),
    [router, author.address],
  );

  const onToggle = useCallback(
    (target: string, next: boolean) => {
      if (viewer.status !== "ready") {
        router.push("/welcome/");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.status, follow, router],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={styles.card}
      style={{ top: coords.top, left: coords.left }}
      role="dialog"
      aria-label={`${displayName ?? author.address} profile`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Inside a clickable feed row conceptually, but portaled to <body> — stop clicks anyway.
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.topRow}>
        <button type="button" className={styles.avatarBtn} onClick={openProfile} aria-label="Open profile">
          <Avatar address={author.address} src={avatar} size="lg" dim={banned} name={displayName} />
        </button>
        <FollowButton
          target={author.address}
          isFollowing={follow.isFollowing(author.address)}
          viewer={viewer}
          onToggle={onToggle}
          size="sm"
        />
      </div>

      <button type="button" className={styles.nameBtn} onClick={openProfile}>
        <DisplayName address={author.address} displayName={displayName} authorRevoked={banned} />
      </button>
      <Handle address={author.address} />

      {bio.length > 0 && <p className={styles.bio}>{bio}</p>}

      {hasCounts ? (
        <div className={styles.counts}>
          <span>
            <strong>{profile?.followingCount ?? 0}</strong> Following
          </span>
          <span>
            <strong>{profile?.followerCount ?? 0}</strong> Followers
          </span>
        </div>
      ) : profile == null ? (
        <div className={styles.loading}>
          <Spinner size="sm" label="Loading profile" />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
