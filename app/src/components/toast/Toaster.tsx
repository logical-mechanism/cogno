"use client";

// Toaster — the singleton container. Mounted once by ToasterProvider; stacks up to 3
// toasts, newest on top, bottom-center. Each Toast carries its OWN live role (status=polite /
// alert=assertive), so the container is NOT itself a live region — nesting them makes NVDA/JAWS
// double-announce.

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
    <div className={styles.toaster}>
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
