"use client";

// components/icons — the full inline-SVG icon set for the kit.
//
// Every icon is a tiny presentational SVG: 24px viewBox, `fill="currentColor"` (so colour comes from
// the consuming element's `color`/token), no external resource, no state. X-style silhouettes. The
// like/repost/nav icons that have an active state ship an `outline` (default) + `filled` variant via
// a `filled?: boolean` prop. `cg-spin` (the Spinner) lives here too.
//
// Sizing: the SVG defaults to width/height "1em" so it scales with font-size or an explicit
// width/height/style from the caller (we pass --cg-icon-* through inline style at call sites). Colour
// is always inherited.

import type { CSSProperties, SVGProps } from "react";
import styles from "./icons.module.css";

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Filled variant for stateful icons (like/repost/nav). Ignored by single-variant icons. */
  filled?: boolean;
  /** px or any CSS length; defaults to 1em (inherits font-size). */
  size?: number | string;
}

function svgProps(p: IconProps): SVGProps<SVGSVGElement> {
  const { filled: _filled, size, style, ...rest } = p;
  const dim = size != null ? (typeof size === "number" ? `${size}px` : size) : "1em";
  const merged: CSSProperties = { width: dim, height: dim, ...style };
  return {
    viewBox: "0 0 24 24",
    "aria-hidden": rest["aria-label"] ? undefined : true,
    focusable: false,
    fill: "currentColor",
    style: merged,
    ...rest,
  };
}

// ── Action-row icons ─────────────────────────────────────────────────────────────────────────

export function IconReply(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.74-6.13-6.129-6.13H9.756z" />
    </svg>
  );
}

export function IconRepost(p: IconProps) {
  if (p.filled) {
    return (
      <svg {...svgProps(p)}>
        <path d="M4.75 3.79l4.603 4.3-1.706 1.82L6 8.38v7.37c0 .97.784 1.75 1.75 1.75H13V20H7.75c-2.347 0-4.25-1.9-4.25-4.25V8.38L1.853 9.91.147 8.09l4.603-4.3zm11.5 2.71H11V4h5.25c2.347 0 4.25 1.9 4.25 4.25v7.37l1.647-1.53 1.706 1.82-4.603 4.3-4.603-4.3 1.706-1.82L18 15.62V8.25c0-.97-.784-1.75-1.75-1.75z" />
      </svg>
    );
  }
  return (
    <svg {...svgProps(p)}>
      <path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z" />
    </svg>
  );
}

export function IconLike(p: IconProps) {
  if (p.filled) {
    return (
      <svg {...svgProps(p)}>
        <path d="M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z" />
      </svg>
    );
  }
  return (
    <svg {...svgProps(p)}>
      <path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.030-3.7.478-4.82-.561-1.13-1.666-1.84-2.909-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z" />
    </svg>
  );
}

export function IconQuote(p: IconProps) {
  // Solid double-quotation-mark glyph (Material "format_quote" silhouette) — a single clean closed
  // path that stays legible at action-row sizes, where the old multi-piece outline broke up.
  return (
    <svg {...svgProps(p)}>
      <path d="M6 17h3l2-4V7H5v6h3l-2 4zm8 0h3l2-4V7h-6v6h3l-2 4z" />
    </svg>
  );
}

export function IconShare(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z" />
    </svg>
  );
}

export function IconDownvote(p: IconProps) {
  if (p.filled) {
    return (
      <svg {...svgProps(p)}>
        <path d="M3.79 14.94l8.21 6.06 8.21-6.06-1.42-1.42L13 17.58V3h-2v14.58l-3.79-3.06-1.42 1.42z" />
      </svg>
    );
  }
  return (
    <svg {...svgProps(p)}>
      <path d="M11 3v12.17l-4.59-3.58L5 12.99 12 18.5l7-5.51-1.41-1.4L13 15.17V3h-2z" />
    </svg>
  );
}

export function IconMore(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" />
    </svg>
  );
}

// ── Nav icons (outline default + filled active) ──────────────────────────────────────────────

export function IconHome(p: IconProps) {
  if (p.filled) {
    return (
      <svg {...svgProps(p)}>
        <path d="M21.591 7.146L12.52 1.157c-.316-.21-.724-.21-1.04 0l-9.071 5.99c-.26.173-.409.456-.409.757v13.183c0 .502.418.913.929.913H9.14c.51 0 .929-.41.929-.913v-7.075h3.909v7.075c0 .502.418.913.929.913h6.165c.511 0 .929-.41.929-.913V7.904c0-.301-.158-.584-.408-.758z" />
      </svg>
    );
  }
  return (
    <svg {...svgProps(p)}>
      <path d="M21.591 7.146L12.52 1.157c-.316-.21-.724-.21-1.04 0l-9.071 5.99c-.26.173-.409.456-.409.757v13.183c0 .502.418.913.929.913h6.638c.511 0 .929-.41.929-.913v-7.075h3.008v7.075c0 .502.418.913.929.913h6.639c.51 0 .928-.41.928-.913V7.904c0-.301-.158-.584-.408-.758zm-1.087 12.97h-4.5v-7.075c0-.502-.418-.913-.928-.913H9.476c-.511 0-.929.41-.929.913v7.075h-4.5V8.319l8.452-5.582 8.005 5.285v12.094z" />
    </svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z" />
    </svg>
  );
}

export function IconProfile(p: IconProps) {
  if (p.filled) {
    return (
      <svg {...svgProps(p)}>
        <path d="M12 11.816c1.355 0 2.872-.15 3.84-1.256.814-.93 1.078-2.368.806-4.392-.38-2.825-2.117-4.512-4.646-4.512S7.734 3.343 7.354 6.168c-.272 2.024-.008 3.462.806 4.392.968 1.106 2.485 1.256 3.84 1.256zM20 22c.553 0 1.012-.452.964-1.002-.448-5.146-4.532-8.198-8.964-8.198s-8.516 3.052-8.964 8.198C2.988 21.548 3.447 22 4 22h16z" />
      </svg>
    );
  }
  return (
    <svg {...svgProps(p)}>
      <path d="M5.651 19h12.698c-.337-1.8-1.023-3.21-1.945-4.19C15.318 13.65 13.838 13 12 13s-3.317.65-4.404 1.81c-.922.98-1.608 2.39-1.945 4.19zm.486-5.56C7.627 11.85 9.648 11 12 11s4.373.85 5.863 2.44c1.477 1.58 2.366 3.8 2.632 6.46l.11 1.1H3.395l.11-1.1c.266-2.66 1.155-4.88 2.632-6.46zM12 4c-1.105 0-2 .9-2 2s.895 2 2 2 2-.9 2-2-.895-2-2-2zM8 6c0-2.21 1.791-4 4-4s4 1.79 4 4-1.791 4-4 4-4-1.79-4-4z" />
    </svg>
  );
}

export function IconSettings(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M10.54 1.75h2.92l1.57 2.36c.11.17.32.25.53.21l2.53-.59 2.17 2.17-.58 2.54c-.05.2.04.41.21.53l2.36 1.57v2.92l-2.36 1.57c-.17.12-.26.33-.21.53l.58 2.54-2.17 2.17-2.53-.59c-.21-.04-.42.04-.53.21l-1.57 2.36h-2.92l-1.58-2.36c-.11-.17-.32-.25-.52-.21l-2.54.59-2.17-2.17.59-2.54c.04-.2-.05-.41-.22-.53L1.75 13.46v-2.92l2.36-1.57c.17-.12.26-.33.22-.53L3.74 5.9l2.17-2.17 2.54.59c.2.04.41-.04.52-.21l1.58-2.36zm1.07 2l-.98 1.47C10.05 6.08 9 6.5 7.99 6.27l-1.46-.34-.6.6.34 1.46c.24 1.01-.18 2.07-1.05 2.64l-1.47.98v.78l1.47.98c.87.57 1.29 1.63 1.05 2.64l-.34 1.46.6.6 1.46-.34c1.01-.24 2.06.18 2.64 1.05l.98 1.47h.78l.98-1.47c.58-.87 1.63-1.29 2.64-1.05l1.46.34.6-.6-.34-1.46c-.24-1.01.18-2.07 1.05-2.64l1.47-.98v-.78l-1.47-.98c-.87-.57-1.29-1.63-1.05-2.64l.34-1.46-.6-.6-1.46.34c-1.01.23-2.06-.19-2.64-1.05l-.98-1.47h-.78zM12 9c-1.657 0-3 1.34-3 3s1.343 3 3 3 3-1.34 3-3-1.343-3-3-3zm-5 3c0-2.76 2.239-5 5-5s5 2.24 5 5-2.239 5-5 5-5-2.24-5-5z" />
    </svg>
  );
}

// ── Affordance / chrome icons ────────────────────────────────────────────────────────────────

export function IconCompose(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M23 3c-6.62-.1-10.38 2.421-13.05 6.03C7.29 12.61 6 17.331 6 22h2c0-1.007.07-2.012.19-3H12c4.1 0 7.48-3.082 7.94-7.054C22.79 10.147 23.17 6.359 23 3zm-7 8h-1.5v2H16c.63-.016 1.2-.08 1.72-.188C16.95 15.24 14.68 17 12 17H8.55c.57-2.512 1.57-4.851 3-6.78 2.16-2.912 5.29-4.911 9.45-5.187C21 8.079 19.9 11 16 11zM4 9V6H1V4h3V1h2v3h3v2H6v3H4z" />
    </svg>
  );
}

export function IconPoll(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M6 5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2H6zm0 2h12v10H6V7zm2 2v6h2V9H8zm4 2v4h2v-4h-2zm4-1v5h2v-5h-2z" />
    </svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z" />
    </svg>
  );
}

export function IconBack(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M9 20.42l-6.21-6.21 1.42-1.42L9 17.58 20.79 5.79l1.42 1.42L9 20.42z" />
    </svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.65 0-3-1.35-3-3s1.35-3 3-3 3 1.35 3 3-1.35 3-3 3zm0-12a1 1 0 011 1v1a1 1 0 01-2 0V4a1 1 0 011-1zm0 15a1 1 0 011 1v1a1 1 0 01-2 0v-1a1 1 0 011-1zM4 11a1 1 0 010 2H3a1 1 0 010-2h1zm17 0a1 1 0 010 2h-1a1 1 0 010-2h1zM5.64 5.64a1 1 0 011.42 0l.7.7a1 1 0 01-1.41 1.42l-.71-.71a1 1 0 010-1.41zm10.6 10.6a1 1 0 011.42 0l.7.7a1 1 0 01-1.41 1.42l-.71-.71a1 1 0 010-1.41zM18.36 5.64a1 1 0 010 1.41l-.71.71a1 1 0 01-1.41-1.42l.7-.7a1 1 0 011.42 0zM7.76 16.24a1 1 0 010 1.41l-.71.71a1 1 0 01-1.41-1.42l.7-.7a1 1 0 011.42 0z" />
    </svg>
  );
}

export function IconMoon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M9.353 2.939a1 1 0 01.22 1.08 7.5 7.5 0 0010.408 9.598 1 1 0 011.434 1.142A9.5 9.5 0 1110.273 2.5a1 1 0 01-.92.439zM8.34 5.31a7.5 7.5 0 109.05 11.16 9.5 9.5 0 01-9.05-11.16z" />
    </svg>
  );
}

export function IconLink(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M10.59 13.41a1 1 0 010-1.41l3-3a3 3 0 014.24 4.24l-1.5 1.5a1 1 0 01-1.42-1.42l1.5-1.5a1 1 0 10-1.41-1.41l-3 3a1 1 0 01-1.41 0zm2.82-2.82a1 1 0 010 1.41l-3 3a3 3 0 01-4.24-4.24l1.5-1.5a1 1 0 011.42 1.42l-1.5 1.5a1 1 0 101.41 1.41l3-3a1 1 0 011.41 0z" />
    </svg>
  );
}

export function IconEye(p: IconProps) {
  // Material "visibility" silhouette — the click-to-reveal cover affordance for gated images.
  return (
    <svg {...svgProps(p)}>
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 13c-3.04 0-5.5-2.46-5.5-5.5S8.96 6.5 12 6.5s5.5 2.46 5.5 5.5-2.46 5.5-5.5 5.5zm0-9c-1.93 0-3.5 1.57-3.5 3.5s1.57 3.5 3.5 3.5 3.5-1.57 3.5-3.5-1.57-3.5-3.5-3.5z" />
    </svg>
  );
}

// ── Spinner (cg-spin keyframe lives in tokens.css) ──────────────────────────────────────────────

export interface SpinnerProps {
  size?: "sm" | "md";
  label?: string;
  className?: string;
}

export function Spinner({ size = "md", label = "Loading", className }: SpinnerProps) {
  return (
    <span
      className={[styles.spinner, size === "sm" ? styles.spinnerSm : styles.spinnerMd, className]
        .filter(Boolean)
        .join(" ")}
      role="status"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false" className={styles.spinnerSvg}>
        <circle cx="12" cy="12" r="10" className={styles.spinnerTrack} strokeWidth="2.5" />
        <path d="M12 2a10 10 0 0110 10" className={styles.spinnerHead} strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}
