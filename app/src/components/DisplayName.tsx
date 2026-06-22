"use client";

// DisplayName — an account's display name (doc 03 §14). Uses the profile display name; FALLS BACK to
// a stable `cogno-…` label derived from the ss58 when none is set (D6, names are non-unique). Bold,
// --cg-text. Dimmed when the author's identity is revoked (D10 — the parent header renders the
// "restricted" chip; here we only dim). Sanitised: display names are user input → rendered as TEXT,
// never HTML.

import Link from "next/link";
import styles from "./DisplayName.module.css";
import { fallbackDisplayName } from "@/lib/ss58";

export interface DisplayNameProps {
  address: string;
  /** Profile.display_name (or authorDisplayName on a CognoPost); blank → fallback. */
  displayName?: string;
  /** Author identity revoked → dim (D10). */
  authorRevoked?: boolean;
  as?: "span" | "a";
  truncate?: boolean;
}

export function DisplayName({
  address,
  displayName,
  authorRevoked,
  as = "span",
  truncate = true,
}: DisplayNameProps) {
  const label = displayName?.trim() || fallbackDisplayName(address);
  const cls = [styles.name, truncate ? styles.truncate : "", authorRevoked ? styles.dim : ""]
    .filter(Boolean)
    .join(" ");

  if (as === "a") {
    return (
      <Link href={`/u/${address}/`} className={cls} title={address}>
        {label}
      </Link>
    );
  }
  return (
    <span className={cls} title={address}>
      {label}
    </span>
  );
}
