"use client";

// DiagnosticsSection — Settings. A read-only, prod-safe snapshot of the node connection + the
// chain identity it sees. Replaces the old "Advanced" section: the dev-account picker is gone (the
// consumer build posts only through a real wallet). NO secrets and nothing editable — just the
// connection, genesis/runtime, and block heights. Block numbers appear ONLY here and in the
// Civic-Ledger strip.

import { useCallback, useEffect, useState } from "react";
import styles from "./DiagnosticsSection.module.css";
import { useSession } from "@/components/Providers";
import { useHeads } from "@/hooks/useHeads";
import { useToaster } from "@/components/toast/ToasterProvider";
import { getGenesisHex } from "@/lib/chain/identity";

function shortHex(hex: string | null, head = 10): string {
  if (!hex) return "—";
  const h = hex.startsWith("0x") ? hex : `0x${hex}`;
  return h.length > head + 2 ? `${h.slice(0, head)}…` : h;
}

type Dot = "ok" | "pending" | "err";

export function DiagnosticsSection() {
  const { api, client, status } = useSession();
  const heads = useHeads(client);
  const [genesis, setGenesis] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<{ specV: number; txV: number } | null>(null);

  // Genesis hash — the chain's identity.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void getGenesisHex(api)
      .then((g) => !cancelled && setGenesis(`0x${g}`))
      .catch(() => !cancelled && setGenesis(null));
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Runtime spec / tx version — read from PAPI metadata (never hardcoded).
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.constants.System.Version()
      .then((v) => !cancelled && setRuntime({ specV: v.spec_version, txV: v.transaction_version }))
      .catch(() => !cancelled && setRuntime(null));
    return () => {
      cancelled = true;
    };
  }, [api]);

  const connDot: Dot = status === "connected" ? "ok" : status === "connecting" ? "pending" : "err";
  const connLabel =
    status === "connected" ? "connected" : status === "connecting" ? "connecting…" : "disconnected";

  return (
    <div className={styles.card}>
      <p className={styles.note}>Read-only.</p>

      <Row label="Connection" value={connLabel} dot={connDot} />
      <Row label="Genesis" value={shortHex(genesis)} mono title={genesis ?? undefined} copy={genesis ?? undefined} />
      <Row label="Runtime" value={runtime ? `spec ${runtime.specV} · tx ${runtime.txV}` : "—"} mono />
      {/* Best + finalized on their OWN lines — the combined "#n / #n" overflowed the value column. */}
      <Row label="Best" value={heads.best ? `#${heads.best.number}` : "—"} mono />
      <Row label="Finalized" value={heads.finalized ? `#${heads.finalized.number}` : "—"} mono />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  dot,
  title,
  copy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  dot?: Dot;
  title?: string;
  /** When set, the value becomes a click-to-copy button (copies this full string → toast). */
  copy?: string;
}) {
  const { toast } = useToaster();
  const dotCls = dot === "ok" ? styles.dotOk : dot === "pending" ? styles.dotPending : styles.dotErr;

  const onCopy = useCallback(async () => {
    if (!copy) return;
    try {
      await navigator.clipboard.writeText(copy);
      toast({ kind: "success", message: "Copied" });
    } catch {
      toast({ kind: "error", message: "Couldn't copy" });
    }
  }, [copy, toast]);

  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.valueWrap}>
        {dot && <span className={`${styles.dot} ${dotCls}`} aria-hidden />}
        {copy ? (
          <button
            type="button"
            className={styles.copyValue}
            title={title ?? copy}
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={onCopy}
          >
            {value}
          </button>
        ) : (
          <span className={mono ? styles.mono : styles.value} title={title}>
            {value}
          </span>
        )}
      </span>
    </div>
  );
}
