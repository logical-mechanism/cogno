"use client";

// Avatar — circular avatar (doc 03 §13).
//
// Uses Profile.avatar (`src`) when present; otherwise a DETERMINISTIC, OFFLINE, pure identicon derived
// from the ss58 (lib/identicon) — same address → same image, no network (D6). A remote/IPFS `src`
// image stays behind a click-to-reveal cover (the browser never auto-fetches an arbitrary host until
// the user taps); once revealed it renders in an <img> with loading="lazy" + referrerPolicy=
// "no-referrer" and an onError fallback to the identicon. The OFFLINE identicon needs no cover. ipfs://
// avatars are resolved to a gateway (lib/media). SAFETY: avatar URLs are arbitrary user input; we
// render them ONLY via <img> (browser-sandboxed) and NEVER inject them as a CSS url().

import { useMemo, useState } from "react";
import styles from "./Avatar.module.css";
import { identiconFor } from "@/lib/identicon";
import { resolveImageSrc } from "@/lib/media";
import { reveal, unreveal, useRevealed } from "@/lib/reveal";
import { IconEye, IconEyeOff } from "./icons";
import type { AvatarSize } from "./kit";

export interface AvatarProps {
  /** ss58 — identicon seed + alt fallback. */
  address: string;
  /** Profile.avatar URL/CID; null/undefined → identicon. */
  src?: string | null;
  /** Named token size (sm/md/lg/xl) or a raw px number. */
  size?: AvatarSize;
  /** Banned-author dimming (D10). */
  dim?: boolean;
  /** Optional accessible name (display name); falls back to the address. */
  name?: string;
  /**
   * Skip the click-to-reveal cover and load the image straight away — for a TRUSTED avatar (the
   * viewer's OWN, in app chrome: the composer, the account menu, the edit/settings previews). The gate
   * exists to not auto-fetch an ARBITRARY host's image; your own avatar you chose is not that, and a
   * cover over it in chrome reads as broken. Still a sandboxed <img> (no-referrer, identicon onError).
   */
  eager?: boolean;
  onClick?: () => void;
}

const SIZE_VAR: Record<Exclude<AvatarSize, number>, string> = {
  sm: "var(--cg-avatar-sm)",
  md: "var(--cg-avatar-md)",
  lg: "var(--cg-avatar-lg)",
  xl: "var(--cg-avatar-xl)",
};

function Identicon({ address }: { address: string }) {
  const icon = useMemo(() => identiconFor(address), [address]);
  return (
    <svg
      className={styles.identicon}
      viewBox={`0 0 ${icon.size} ${icon.size}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
    >
      <rect x="0" y="0" width={icon.size} height={icon.size} fill={icon.bg} />
      {icon.cells.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={c.fill} />
      ))}
    </svg>
  );
}

export function Avatar({ address, src, size = "md", dim, name, eager, onClick }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const resolvedSrc = useMemo(() => (src ? resolveImageSrc(src) : null), [src]);
  const revealed = useRevealed(resolvedSrc ?? "");
  const dimension = typeof size === "number" ? `${size}px` : SIZE_VAR[size];
  const hasImg = !!resolvedSrc && !broken;
  // A remote/IPFS avatar stays covered until tapped; the offline identicon needs no cover. A `eager`
  // (trusted, own) avatar skips the cover and loads straight away.
  const gated = hasImg && !revealed && !eager;
  const alt = `${name?.trim() || address} avatar`;

  const cls = [styles.avatar, dim ? styles.dim : "", onClick ? styles.clickable : ""]
    .filter(Boolean)
    .join(" ");

  const style = { width: dimension, height: dimension } as React.CSSProperties;

  // Covered avatar: a NON-interactive <span> (not a <button>). Avatars often sit inside a clickable
  // parent — a row link, the Account menu <button>, a who-to-follow <a> — and interactive content may
  // not nest inside a <button>/<a>; a span may. preventDefault + stopPropagation keep the reveal tap
  // from also triggering that parent. (No keyboard reveal here — the parent stays reachable and the
  // avatar image is non-essential; the prominent post-media reveal IS keyboard-accessible.)
  if (gated) {
    return (
      <span
        className={[cls, styles.cover].join(" ")}
        style={style}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          reveal(resolvedSrc as string);
        }}
        role="img"
        aria-label={`Show ${alt}`}
        title={`Show ${alt}`}
      >
        <IconEye className={styles.coverIcon} aria-hidden />
      </span>
    );
  }

  const inner = hasImg ? (
    // Deliberately a sandboxed <img>, not next/image: src is an arbitrary user-supplied URL/CID and
    // this is a static export — next/image would need configured remote hosts and adds cost (see §13).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.img}
      src={resolvedSrc as string}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      draggable={false}
    />
  ) : (
    <Identicon address={address} />
  );

  // Re-cover ("hide") overlay for a REVEALED remote avatar — undo an unwanted reveal. Only on the
  // prominent sizes (lg/xl) where it's legible + not noise on tiny feed avatars; the identicon has
  // nothing to hide. A NON-interactive <span> (like the cover) so it can live inside a clickable
  // parent/button; mouse-first (no keyboard path), mirroring the avatar's reveal affordance. On hover
  // it previews the covered state (solid fill + eye-off); a tap re-covers the src everywhere.
  // Re-cover only applies to a GATED image (an eager/trusted avatar has no cover to restore).
  const hideable = hasImg && !eager && (size === "lg" || size === "xl");
  const hideOverlay = hideable ? (
    <span
      className={styles.hide}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        unreveal(resolvedSrc as string);
      }}
      aria-label={`Hide ${alt}`}
      title={`Hide ${alt}`}
    >
      <IconEyeOff className={styles.hideIcon} aria-hidden />
    </span>
  ) : null;

  if (onClick) {
    return (
      <button type="button" className={cls} style={style} onClick={onClick} aria-label={alt}>
        {inner}
        {hideOverlay}
      </button>
    );
  }
  return (
    <span className={cls} style={style} role="img" aria-label={alt}>
      {inner}
      {hideOverlay}
    </span>
  );
}
