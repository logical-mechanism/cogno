"use client";

// Toaster — the singleton container (doc 03 §16). Mounted once by ToasterProvider; stacks up to 3
// toasts, newest on top, bottom-center. aria-live="polite" so it's announced without stealing focus.

import styles from "./Toast.module.css";
import { Toast } from "./Toast";
import type { ToastSpec } from "../kit";

export interface ToasterProps {
  toasts: ToastSpec[];
  onDismiss: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}

export function Toaster({ toasts, onDismiss, onPause, onResume }: ToasterProps) {
  return (
    <div className={styles.toaster} aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          spec={t}
          onDismiss={onDismiss}
          onMouseEnter={() => onPause(t.id)}
          onMouseLeave={() => onResume(t.id)}
          onFocus={() => onPause(t.id)}
          onBlur={() => onResume(t.id)}
        />
      ))}
    </div>
  );
}
