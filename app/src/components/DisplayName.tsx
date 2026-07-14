"use client";

// DisplayName — an account's display name. Uses the profile display name; FALLS BACK to
// a stable `cogno-…` label derived from the ss58 when none is set (D6, names are non-unique). Bold,
// --cg-text. Dimmed when the author's identity is revoked (D10 — the parent header renders the
// "restricted" chip; here we only dim). Sanitised: display names are user input → rendered as TEXT,
// never HTML.

import Link from "next/link";
import styles from "./DisplayName.module.css";
import { Highlight } from "./Highlight";
import { fallbackDisplayName } from "@/lib/ss58";

export interface DisplayNameProps {
  address: string;
  /** Profile.display_name (or authorDisplayName on a CognoPost); blank → fallback. */
  displayName?: string;
  /** Author identity revoked → dim (D10). */
  authorRevoked?: boolean;
  as?: "span" | "a";
  truncate?: boolean;
  /** Search term to <mark> in the name (set only on search-result surfaces). */
  highlight?: string;
}

export function DisplayName({
  address,
  displayName,
  authorRevoked,
  as = "span",
  truncate = true,
  highlight,
}: DisplayNameProps) {
  const label = displayName?.trim() || fallbackDisplayName(address);
  const cls = [styles.name, truncate ? styles.truncate : "", authorRevoked ? styles.dim : ""]
    .filter(Boolean)
    .join(" ");
  const content = <Highlight text={label} query={highlight} />;

  if (as === "a") {
    return (
      <Link href={`/u/${address}/`} className={cls} title={address}>
        {content}
      </Link>
    );
  }
  return (
    <span className={cls} title={address}>
      {content}
    </span>
  );
}
