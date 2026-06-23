"use client";

// PostCardHeader — the single identity line of a PostCard (doc 03 §2).
//
//   (•) DisplayName  @ha…le                                              [···]
//    ▲      ▲           ▲                                                  ▲
//  Avatar  name        handle (truncated ss58, mono)              overflow menu
//
// IMPORTANT — NO TIME / NO BLOCK MARGINALIA (locked decision + D11): CognoPost.at is a BLOCK HEIGHT,
// not a timestamp, and the trust/honesty layer is dropped, so we render NOTHING time-ish — no "· 2h",
// no "· #1234". The doc's wireframe shows a "· 2h" marker, but with no real clock available the right
// call here is to render nothing rather than a misleading block number or trust label. (If the seam
// later carries a real timestamp, a <time> chip can slot in after the handle.)
//
// The "···" opens the overflow menu (doc 03 §2.1): Downvote / Remove downvote (the SECONDARY weighted
// vote), Copy link, etc. — supplied as OverflowMenuItem[] by the PostCard. Mute/Block/Report/Delete
// are intentionally absent (no on-chain moderation; content permanent). The menu is a real
// role="menu" with click-out + Esc close and arrow-key roving focus.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./PostCardHeader.module.css";
import { Avatar } from "./Avatar";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import { PostTime } from "./PostTime";
import { ProfileHoverCard } from "./ProfileHoverCard";
import { IconMore } from "./icons";
import type { AuthorRef, OverflowMenuItem, AvatarSize } from "./kit";

export interface PostCardHeaderProps {
  /** The post's author (derived from CognoPost's flattened author fields). */
  author: AuthorRef;
  /** Post block height (CognoPost.at) → a relative "· 2h" age after the handle. Omit to hide. */
  at?: number;
  /** Items for the "···" overflow menu (§2.1). Empty/omitted → no menu button. */
  menuItems?: OverflowMenuItem[];
  /** Navigate to the author's profile (/u/[address]/). Avatar/name/handle all route here. */
  onAuthorOpen: (address: string) => void;
  /** Stack avatar over name (detail variant). Default is the inline single-line layout. */
  detail?: boolean;
  /** Avatar size override (detail uses a larger avatar). */
  avatarSize?: AvatarSize;
  /** Surface-specific trailing slot (e.g. a "Pinned" marker on a profile). */
  headerExtra?: React.ReactNode;
}

export function PostCardHeader({
  author,
  at,
  menuItems,
  onAuthorOpen,
  detail,
  avatarSize = "md",
  headerExtra,
}: PostCardHeaderProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const dim = author.banned;
  const hasMenu = !!menuItems && menuItems.length > 0;

  const openAuthor = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onAuthorOpen(author.address);
    },
    [author.address, onAuthorOpen],
  );

  // Close on click-out + Esc; restore focus to the trigger on Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the first item when the menu opens (roving focus thereafter).
  useEffect(() => {
    if (open) {
      const first = menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]');
      first?.focus();
    }
  }, [open]);

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next.focus();
  }, []);

  return (
    <div className={`${styles.header} ${detail ? styles.detail : ""}`} ref={wrapRef}>
      <ProfileHoverCard author={author}>
        <Avatar
          address={author.address}
          src={author.avatar}
          size={avatarSize}
          dim={dim}
          name={author.displayName}
          onClick={() => onAuthorOpen(author.address)}
        />
      </ProfileHoverCard>

      <div className={styles.identity}>
        <span className={styles.nameLine}>
          <ProfileHoverCard author={author}>
            <button type="button" className={styles.nameBtn} onClick={openAuthor}>
              <DisplayName
                address={author.address}
                displayName={author.displayName}
                authorRevoked={dim}
              />
            </button>
          </ProfileHoverCard>
          <Handle address={author.address} />
          {at != null && <PostTime at={at} />}
          {dim && (
            <span className={styles.restricted} title="This account's identity binding was revoked">
              This account has been restricted
            </span>
          )}
          {headerExtra}
        </span>
      </div>

      {hasMenu && (
        <div className={styles.menuWrap}>
          <button
            ref={btnRef}
            type="button"
            className={styles.moreBtn}
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            <IconMore style={{ width: "var(--cg-icon-md)", height: "var(--cg-icon-md)" }} />
          </button>

          {open && (
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-orientation="vertical"
              className={styles.menu}
              onKeyDown={onMenuKeyDown}
              onClick={(e) => e.stopPropagation()}
            >
              {menuItems!.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  // A checkable item (e.g. "Downvote" active) is a menuitemcheckbox — the only menu
                  // role that supports aria-checked; plain actions stay role="menuitem".
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  className={`${styles.menuItem} ${item.danger ? styles.danger : ""}`}
                  disabled={item.disabled}
                  aria-checked={item.checked}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon && <span className={styles.menuIcon}>{item.icon}</span>}
                  <span className={styles.menuLabel}>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
