"use client";

// Handle — the "@handle". There are NO unique usernames on cogno-chain (D6); the handle
// is the account's ss58 address, middle-truncated, in MONOSPACE (--cg-font-mono), secondary tint.
// Optional copy-to-clipboard (used on ProfileHeader) raises a success toast via the toaster.

import Link from "next/link";
import { useCallback } from "react";
import styles from "./Handle.module.css";
import { truncateSs58 } from "@/lib/ss58";
import { useToaster } from "./toast/ToasterProvider";

export interface HandleProps {
  /** ss58 (prefix 42). */
  address: string;
  truncate?: "middle" | "none";
  as?: "span" | "a";
  /** Click-to-copy the full address → toast. */
  copyable?: boolean;
}

export function Handle({ address, truncate = "middle", as = "span", copyable }: HandleProps) {
  const { toast } = useToaster();
  const label = `@${truncate === "none" ? address : truncateSs58(address)}`;

  const onCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(address);
        toast({ kind: "success", message: "Address copied" });
      } catch {
        toast({ kind: "error", message: "Couldn't copy address" });
      }
    },
    [address, toast],
  );

  if (copyable) {
    return (
      <button
        type="button"
        className={`${styles.handle} ${styles.copyBtn}`}
        title={address}
        aria-label={`Copy address ${address}`}
        onClick={onCopy}
      >
        {label}
      </button>
    );
  }

  if (as === "a") {
    return (
      <Link
        href={`/u/${address}/`}
        className={styles.handle}
        title={address}
        aria-label={`Profile ${address}`}
      >
        {label}
      </Link>
    );
  }

  return (
    <span className={styles.handle} title={address}>
      {label}
    </span>
  );
}
