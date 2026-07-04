"use client";

// ConfirmDialog — a minimal centered alertdialog (scrim + card + cancel/confirm). Used for a
// destructive confirmation such as discarding an in-progress draft. It layers ABOVE the ComposerModal
// (z-index cg-z-modal + 10). Esc / scrim-click = cancel; the non-destructive button is focused on open
// so a stray Enter/Space never triggers the destructive action.

import { useCallback, useEffect, useRef } from "react";
import styles from "./ConfirmDialog.module.css";

export interface ConfirmDialogProps {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    },
    [onCancel],
  );

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={styles.card}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <h2 className={styles.title}>{title}</h2>
        {body && <p className={styles.body}>{body}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel} ref={cancelRef}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? styles.danger : styles.confirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
