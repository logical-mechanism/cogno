"use client";

// PendingCapacityNotice — the "you locked ADA; posting is crediting" surface. Renders the
// usePendingCapacity status as an explained, timed wait instead of a silent "Lock ADA to post" that a
// just-locked user reads as "it's broken / lock again". Presentational: the caller computes the status
// (usePendingCapacity) and passes it. Two variants: a compact `inline` row for the Composer notice area
// and a bigger `card` for the /welcome power-ups step.

import { CardanoTxLink } from "./CardanoTxLink";
import { Spinner } from "./icons";
import styles from "./PendingCapacityNotice.module.css";
import type { PendingCapacityStatus } from "@/hooks/usePendingCapacity";

/** Friendly relative wait, e.g. "in about 9 minutes" / "in about 1h 20m" / "any moment now". */
function formatEta(etaMs: number): string {
  if (etaMs <= 0) return "any moment now";
  const sec = Math.ceil(etaMs / 1000);
  if (sec < 60) return "in under a minute";
  const min = Math.round(sec / 60);
  if (min < 60) return `in about ${min} minute${min === 1 ? "" : "s"}`;
  const hours = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `in about ${hours}h ${rem}m` : `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** An absolute clock/date, added for long (mainnet-scale) waits where a relative countdown is unhelpful. */
function formatAbsolute(unlockAtMs: number): string {
  const d = new Date(unlockAtMs);
  const sameDay = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, {
    weekday: sameDay ? undefined : "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface View {
  title: string;
  detail: string;
  /** show the settle-window "why" line (only while genuinely counting down). */
  why: boolean;
  bar: number | null; // 0..1 progress, or null for no bar
  spinner: boolean;
  txHash: string | null;
  dismissible: boolean;
}

function toView(status: PendingCapacityStatus): View | null {
  switch (status.kind) {
    case "none":
      return null;
    case "confirming":
      return {
        title: "Lock submitted",
        detail: "Confirming your lock on Cardano…",
        why: false,
        bar: null,
        spinner: true,
        txHash: null,
        dismissible: false,
      };
    case "overdue":
      return {
        title: "Taking longer than expected",
        detail:
          "Your lock confirmed on Cardano, but your posting power hasn't landed yet. It should still land.",
        why: false,
        bar: null,
        spinner: false,
        txHash: status.txHash,
        dismissible: true,
      };
    case "crediting": {
      if (status.frozen) {
        return {
          title: "Posting power on the way",
          detail:
            "Your lock is confirmed. Crediting is paused right now; your posting power lands once it resumes.",
          why: false,
          bar: null,
          spinner: true,
          txHash: null,
          dismissible: false,
        };
      }
      const almost = status.etaMs <= 0 || status.progress >= 1;
      if (almost) {
        return {
          title: "Almost there",
          detail: "Crediting your posting power…",
          why: false,
          bar: status.progress,
          spinner: true,
          txHash: null,
          dismissible: false,
        };
      }
      const eta = formatEta(status.etaMs);
      const abs = status.etaMs > 60 * 60 * 1000 ? ` (around ${formatAbsolute(status.unlockAtMs)})` : "";
      return {
        title: "Lock confirmed",
        detail: `Posting unlocks ${eta}${abs}.`,
        why: true,
        bar: status.progress,
        spinner: false,
        txHash: null,
        dismissible: false,
      };
    }
  }
}

const WHY_LINE =
  "We wait for Cardano to settle first, so a rollback can't take your posting power back.";

/** The status title (e.g. for a surface that wants to render it as its own heading). Null when none. */
export function pendingTitle(status: PendingCapacityStatus): string | null {
  return toView(status)?.title ?? null;
}

export function PendingCapacityNotice({
  status,
  variant = "inline",
  hideTitle = false,
  onDismiss,
}: {
  status: PendingCapacityStatus;
  variant?: "card" | "inline";
  /** skip the in-notice title — for a surface (welcome step) that renders the title as its own heading. */
  hideTitle?: boolean;
  onDismiss?: () => void;
}) {
  const view = toView(status);
  if (!view) return null;

  return (
    <div className={`${styles.notice} ${variant === "card" ? styles.card : styles.inline}`} role="status">
      {(view.spinner || !hideTitle) && (
        <div className={styles.head}>
          {view.spinner ? (
            <Spinner size="sm" />
          ) : (
            <span className={styles.glyph} aria-hidden>
              {view.dismissible ? "⚠️" : "🔒"}
            </span>
          )}
          {!hideTitle && <span className={styles.title}>{view.title}</span>}
        </div>
      )}

      <p className={styles.detail}>{view.detail}</p>
      {view.why && <p className={styles.why}>{WHY_LINE}</p>}

      {view.bar != null && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Posting power crediting"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(view.bar * 100)}
        >
          <div className={styles.fill} style={{ width: `${Math.round(view.bar * 100)}%` }} />
        </div>
      )}

      {(view.txHash || view.dismissible) && (
        <div className={styles.actions}>
          {view.txHash && <CardanoTxLink txHash={view.txHash} label="Lock transaction" />}
          {view.dismissible && onDismiss && (
            <button type="button" className={styles.dismiss} onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default PendingCapacityNotice;
