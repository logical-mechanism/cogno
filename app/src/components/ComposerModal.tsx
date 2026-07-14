"use client";

// ComposerModal — the modal-presentation wrapper for a Composer.
//
// PRESENTATIONAL chrome only: a --cg-overlay scrim + a centered --cg-radius-card / --cg-shadow-modal
// dialog (full-screen sheet on mobile via CSS), a close ✕, focus-trap + Esc + scroll-lock, and
// return-focus to the trigger on close. It hosts WHATEVER composer mode the surface passes as
// `children` (Composer / ReplyComposer / QuoteComposer / PollComposer). It NEVER builds an extrinsic
// and owns no draft state — `onClose` is the surface's close (which raises the dirty-discard confirm
// if the draft is dirty; this wrapper just reports the close intent).

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { IconClose } from "./icons";
import styles from "./ComposerModal.module.css";

export interface ComposerModalProps {
  /** Accessible dialog title per mode ("Compose post" / "Reply" / "Quote" / "Create poll"). */
  title: string;
  /** Close intent (Esc / ✕ / dim-click). The surface decides whether to confirm a dirty discard. */
  onClose: () => void;
  /** The hosted composer (already wired with mode/props by the surface). */
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ComposerModal({ title, onClose, children }: ComposerModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Remember the trigger so focus returns to it on close.
  useEffect(() => {
    returnFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    return () => returnFocusRef.current?.focus?.();
  }, []);

  // Scroll-lock the body while the dialog is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc closes; Tab is trapped within the dialog.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        // dim-click (outside the card) → close intent
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <div className={styles.header}>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size="var(--cg-icon-md)" />
          </button>
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}

export default ComposerModal;
