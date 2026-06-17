"use client";

// ConnState — a small mono pill reflecting the WS socket lifecycle. Colour is
// never the sole signal: each state carries explicit text AND a distinct dot
// style. Clicking opens the endpoint settings (the URL is endpoint-as-config).

import type { ConnStatus } from "@/lib/types";
import styles from "./ConnState.module.css";

export interface ConnStateProps {
  status: ConnStatus;
  wsUrl: string | null;
  onOpenSettings: () => void;
}

interface View {
  text: string;
  cls: string;
  live: "polite" | "off";
}

function viewFor(status: ConnStatus, wsUrl: string | null): View {
  switch (status) {
    case "connected":
      return {
        text: `connected · ${wsUrl ?? "?"}`,
        cls: styles.connected,
        live: "polite",
      };
    case "reconnecting":
      return { text: "reconnecting…", cls: styles.reconnecting, live: "polite" };
    case "error":
      return { text: "offline · check endpoint", cls: styles.error, live: "polite" };
    case "connecting":
    default:
      return { text: "connecting…", cls: styles.connecting, live: "polite" };
  }
}

export function ConnState({ status, wsUrl, onOpenSettings }: ConnStateProps) {
  const view = viewFor(status, wsUrl);
  return (
    <button
      type="button"
      className={`${styles.pill} ${view.cls}`}
      onClick={onOpenSettings}
      aria-label={`Connection: ${view.text}. Click to edit endpoints.`}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label} aria-live={view.live}>
        {view.text}
      </span>
    </button>
  );
}

export default ConnState;
