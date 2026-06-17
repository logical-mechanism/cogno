"use client";

// EndpointSettings — endpoint-as-config. The reader picks which node to trust for
// reads/writes; there is no privileged backend. Edits the ORDERED ws endpoint list
// (the first is the active one), validates ws:// / wss://, and reconnects on save.

import { useEffect, useState } from "react";
import { getEndpoints, setEndpoints } from "@/lib/config/endpoints";
import styles from "./EndpointSettings.module.css";

export interface EndpointSettingsProps {
  open: boolean;
  onClose: () => void;
  /** Apply the saved list by reconnecting to the new active (first) endpoint. */
  onReconnect: (url: string) => void;
}

function isWsUrl(s: string): boolean {
  const t = s.trim();
  if (!/^wss?:\/\//i.test(t)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(t);
    return true;
  } catch {
    return false;
  }
}

export function EndpointSettings({ open, onClose, onReconnect }: EndpointSettingsProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Load the current list whenever the panel opens (client-only, SSG-safe).
  useEffect(() => {
    if (!open) return;
    setText(getEndpoints().join("\n"));
    setError(null);
  }, [open]);

  if (!open) return null;

  const onSave = () => {
    const list = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (list.length === 0) {
      setError("Add at least one ws:// or wss:// endpoint.");
      return;
    }
    const bad = list.find((l) => !isWsUrl(l));
    if (bad) {
      setError(`Not a valid WS endpoint: ${bad}`);
      return;
    }

    setEndpoints(list);
    setError(null);
    onReconnect(list[0]);
    onClose();
  };

  return (
    <section className={styles.panel} aria-label="WebSocket endpoint settings">
      <header className={styles.head}>
        <h2 className={styles.title}>endpoints</h2>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close endpoint settings"
        >
          ×
        </button>
      </header>

      <p className={styles.note}>
        One WS endpoint per line; the first is the active one. These are
        endpoint-as-config — reads are credibly neutral, so point this at whichever
        node you choose to trust. M1 ships a single operator-run dev node.
      </p>

      <label className={styles.fieldLabel} htmlFor="cogno-endpoints">
        ws:// or wss:// endpoints
      </label>
      <textarea
        id="cogno-endpoints"
        className={styles.textarea}
        value={text}
        spellCheck={false}
        rows={4}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
      />

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose}>
          cancel
        </button>
        <button type="button" className={styles.save} onClick={onSave}>
          save &amp; reconnect
        </button>
      </div>
    </section>
  );
}

export default EndpointSettings;
