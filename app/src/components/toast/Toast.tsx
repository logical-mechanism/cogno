"use client";

// Toast — one notification. Colour/icon driven by `kind`: success=--cg-accent.
// error=--cg-danger, rate-limit=--cg-warning (the two main cases are error + rate-limit), pending=
// spinner, info=neutral. Optional action button (Retry/View). Errors additionally carry role="alert".

import { IconCheck, IconClose, IconLink, Spinner } from "../icons";
import styles from "./Toast.module.css";
import type { ToastKind, ToastSpec } from "../kit";

export interface ToastProps {
  spec: ToastSpec;
  onDismiss: (id: string) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

const KIND_CLASS: Record<ToastKind, string> = {
  success: styles.success,
  error: styles.error,
  "rate-limit": styles.rateLimit,
  pending: styles.pending,
  info: styles.info,
};

function KindIcon({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case "success":
      return <IconCheck className={styles.icon} />;
    case "pending":
      // Decorative: the Toast wrapper is already a live region, so a role="status" spinner inside it
      // double-announces "Loading" on top of the toast message.
      return <Spinner size="sm" decorative />;
    case "error":
      return <span className={styles.glyph} aria-hidden>!</span>;
    case "rate-limit":
      return <span className={styles.glyph} aria-hidden>⏳</span>;
    case "info":
    default:
      return <IconLink className={styles.icon} />;
  }
}

export function Toast({ spec, onDismiss, onMouseEnter, onMouseLeave, onFocus, onBlur }: ToastProps) {
  const { id, kind, message, action } = spec;
  return (
    <div
      className={`${styles.toast} ${KIND_CLASS[kind]}`}
      role={kind === "error" ? "alert" : "status"}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <span className={styles.iconWrap}>
        <KindIcon kind={kind} />
      </span>
      <span className={styles.message}>{message}</span>
      {action && (
        <button type="button" className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss notification"
        onClick={() => onDismiss(id)}
      >
        <IconClose className={styles.icon} />
      </button>
    </div>
  );
}
