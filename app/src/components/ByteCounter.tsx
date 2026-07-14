"use client";

// ByteCounter — X's circular count ring, re-tuned to UTF-8 BYTES (D1).
//
// Measures `new TextEncoder().encode(value).length` — NOT value.length — against a byte cap
// (512 post / 80 poll-option / 64 display_name / 256 bio / 128 avatar). Hard-blocks at the cap:
// the ring fills, the remaining count appears near the limit, and at/over the cap it turns
// --cg-danger and shows a negative count. Reports the measurement up to the Composer via onMeasure so
// the CTA gates off the SAME bytes.

import { useEffect, useMemo, useRef } from "react";
import styles from "./ByteCounter.module.css";
import type { ByteMeasure, ControlSize } from "./kit";

export interface ByteCounterProps {
  value: string;
  maxBytes: number;
  /** bytes-remaining threshold at which the number appears (default 32). */
  warnAt?: number;
  size?: ControlSize;
  onMeasure?: (m: ByteMeasure) => void;
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** UTF-8 byte length of a string — the canonical D1 measure. */
export function utf8Bytes(s: string): number {
  if (encoder) return encoder.encode(s).length;
  // SSR/edge fallback (no TextEncoder): approximate via encodeURIComponent.
  return unescape(encodeURIComponent(s)).length;
}

/**
 * Clamp a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multibyte code point (D1).
 * Walks code points (for..of iterates by code point, not UTF-16 unit) and accumulates bytes.
 */
export function clampToBytes(s: string, maxBytes: number): string {
  let total = 0;
  let out = "";
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (total + b > maxBytes) break;
    total += b;
    out += ch;
  }
  return out;
}

const R = 10; // ring radius in the 24-viewBox
const CIRC = 2 * Math.PI * R;

export function ByteCounter({ value, maxBytes, warnAt = 32, size = "md", onMeasure }: ByteCounterProps) {
  const bytes = useMemo(() => utf8Bytes(value), [value]);
  const remaining = maxBytes - bytes;
  const over = bytes >= maxBytes;
  const near = remaining <= warnAt;

  // Report up to the parent. Keep the latest callback in a ref to avoid re-subscribing each render.
  const cbRef = useRef(onMeasure);
  cbRef.current = onMeasure;
  useEffect(() => {
    cbRef.current?.({ bytes, remaining, over });
  }, [bytes, remaining, over]);

  const frac = Math.max(0, Math.min(1, bytes / Math.max(1, maxBytes)));
  const dash = over ? CIRC : CIRC * (1 - frac);
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
