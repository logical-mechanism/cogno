"use client";

// EmptyState — the friendly placeholder when a list/section has no data. Centered
// icon + headline + optional subtext + optional CTA pill. Presets carry canonical copy; explicit
// title/description override a preset. The `search-unavailable` preset is the honest cap message
// (framed as a feature dependency, NOT an honesty disclaimer — the trust layer is dropped).

import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { IconSearch } from "./icons";
import type { EmptyStateVariant } from "./kit";

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title?: string;
  description?: string;
  icon?: ReactNode;
  /** Substring query, for the `search` preset copy. */
  query?: string;
  /** Handle, for the `profile` preset copy. */
  handle?: string;
  action?: { label: string; onClick: () => void };
}

interface Preset {
  title: string;
  description?: string;
  icon?: ReactNode;
}

function presetFor(v: EmptyStateVariant, query?: string, handle?: string): Preset {
  switch (v) {
    case "feed":
      return {
        title: "Your feed is empty",
        description: "Be the first to post.",
      };
    case "search":
      return {
        title: query ? `No results for "${query}"` : "No results",
        description: "Try different keywords.",
        icon: <IconSearch className={styles.glyph} />,
      };
    case "search-unavailable":
      return {
        title: "Search unavailable",
        description: "Search needs a node connection.",
        icon: <IconSearch className={styles.glyph} />,
      };
    case "profile":
      return { title: handle ? `${handle} hasn't posted yet.` : "No posts yet" };
    case "replies":
      return { title: "No replies yet", description: "Be the first to reply." };
    case "follows":
      return { title: "Not following anyone yet" };
    case "generic":
    default:
      return { title: "Nothing here yet" };
  }
}

export function EmptyState({
  variant = "generic",
  title,
  description,
  icon,
  query,
  handle,
  action,
}: EmptyStateProps) {
  const preset = presetFor(variant, query, handle);
  const finalTitle = title ?? preset.title;
  const finalDesc = description ?? preset.description;
  const finalIcon = icon ?? preset.icon;

  return (
    <div className={styles.root} role="status">
      {finalIcon && <div className={styles.iconWrap}>{finalIcon}</div>}
      <h2 className={styles.title}>{finalTitle}</h2>
      {finalDesc && <p className={styles.description}>{finalDesc}</p>}
      {action && (
        <button type="button" className={styles.cta} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
