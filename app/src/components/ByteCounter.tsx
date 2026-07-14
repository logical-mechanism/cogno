"use client";

// ByteCounter — X's circular count ring, re-tuned to UTF-8 BYTES (D1).
//
// Measures `new TextEncoder().encode(value).length` — NOT value.length — against a byte cap
// (512 post / 80 poll-option / 64 display_name / 256 bio / 128 avatar). The ring FILLS at the cap and
// the remaining count appears near it; a draft sitting exactly ON the cap is legal (the chain's
// BoundedVec accepts len == bound) and stays postable. Only a body strictly OVER the cap turns
// --cg-danger with a negative count — reachable via the un-clamped @mention path, where a short-looking
// `@name` serializes to a ~48-byte ss58. The measurement itself lives in @/lib/bytes (pure, unit-tested);
// this reports it up to the Composer via onMeasure so the CTA gates off the SAME bytes.

import { useEffect, useMemo, useRef } from "react";
import styles from "./ByteCounter.module.css";
import { measureBytes } from "@/lib/bytes";
import type { ByteMeasure, ControlSize } from "./kit";

export interface ByteCounterProps {
  value: string;
  maxBytes: number;
  /** bytes-remaining threshold at which the number appears (default 32). */
  warnAt?: number;
  size?: ControlSize;
  onMeasure?: (m: ByteMeasure) => void;
}

const R = 10; // ring radius in the 24-viewBox
const CIRC = 2 * Math.PI * R;

export function ByteCounter({ value, maxBytes, warnAt = 32, size = "md", onMeasure }: ByteCounterProps) {
  const { bytes, remaining, over } = useMemo(() => measureBytes(value, maxBytes), [value, maxBytes]);
  const near = remaining <= warnAt;

  // Report up to the parent. Keep the latest callback in a ref to avoid re-subscribing each render.
  const cbRef = useRef(onMeasure);
  cbRef.current = onMeasure;
  useEffect(() => {
    cbRef.current?.({ bytes, remaining, over });
  }, [bytes, remaining, over]);

  // `frac` is clamped, so at AND over the cap the offset is 0 — a full ring (danger-coloured when over).
  const frac = Math.max(0, Math.min(1, bytes / Math.max(1, maxBytes)));
  const dash = CIRC * (1 - frac);
  const ringCls = over ? styles.over : near ? styles.near : styles.under;

  return (
    <div
      className={`${styles.root} ${size === "sm" ? styles.sm : styles.md}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={maxBytes}
      aria-valuenow={Math.min(bytes, maxBytes)}
      aria-label={`${bytes} of ${maxBytes} bytes used`}
    >
      <svg className={styles.ring} viewBox="0 0 24 24" aria-hidden focusable="false">
        <circle className={styles.track} cx="12" cy="12" r={R} fill="none" strokeWidth="2.5" />
        <circle
          className={ringCls}
          cx="12"
          cy="12"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={dash}
          transform="rotate(-90 12 12)"
        />
      </svg>
      {(near || over) && (
        <span className={`${styles.num} ${over ? styles.numOver : ""}`}>{remaining}</span>
      )}
    </div>
  );
}
