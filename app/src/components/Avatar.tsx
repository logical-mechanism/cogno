"use client";

// Avatar — circular avatar (doc 03 §13).
//
// Uses Profile.avatar (`src`) when present; otherwise a DETERMINISTIC, OFFLINE, pure identicon derived
// from the ss58 (lib/identicon) — same address → same image, no network (D6). `src` images render in
// an <img> with loading="lazy" + referrerPolicy="no-referrer" and an onError fallback to the
// identicon, so a broken/abuse URL never breaks layout. SAFETY: avatar URLs are arbitrary user input;
// we render them ONLY via <img> (browser-sandboxed) and NEVER inject them as a CSS url().

import { useMemo, useState } from "react";
import styles from "./Avatar.module.css";
import { identiconFor } from "@/lib/identicon";
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

export function Avatar({ address, src, size = "md", dim, name, onClick }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const dimension = typeof size === "number" ? `${size}px` : SIZE_VAR[size];
  const showImg = !!src && !broken;
  const alt = `${name?.trim() || address} avatar`;

  const cls = [styles.avatar, dim ? styles.dim : "", onClick ? styles.clickable : ""]
    .filter(Boolean)
    .join(" ");

  const inner = showImg ? (
    <img
      className={styles.img}
      src={src as string}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      draggable={false}
    />
  ) : (
    <Identicon address={address} />
  );

  const style = { width: dimension, height: dimension } as React.CSSProperties;

  if (onClick) {
    return (
      <button type="button" className={cls} style={style} onClick={onClick} aria-label={alt}>
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} style={style} role="img" aria-label={alt}>
      {inner}
    </span>
  );
}
