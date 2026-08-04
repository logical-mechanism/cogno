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
import { useObserverHealth, useScanCoverage } from "@/hooks/useObserverHealth";
import { useToaster } from "@/components/toast/ToasterProvider";
import { copyToClipboard } from "@/lib/share";
import { getGenesisHex } from "@/lib/chain/identity";
import type { ObserverHealth } from "@/lib/chain/observer";

function shortHex(hex: string | null, head = 10): string {
  if (!hex) return "—";
  const h = hex.startsWith("0x") ? hex : `0x${hex}`;
  return h.length > head + 2 ? `${h.slice(0, head)}…` : h;
}

type Dot = "ok" | "pending" | "err";

export function DiagnosticsSection() {
  const { api, client, status } = useSession();
  const heads = useHeads(client);
  // This panel already subscribes to heads, so pass THAT height through rather than pulling in
  // useBestBlock and opening a third source of truth for the same number on one screen.
  const observer = useObserverHealth(api, heads.best?.number ?? null);
  const coverage = useScanCoverage(api, heads.best?.number ?? null);
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

  // The one fact on this panel that a green "connected" actively hides. The observer inherent is the
  // sole writer of posting power, voting power and role tags; when it freezes, blocks keep arriving and
  // every other row here stays healthy while nothing about Cardano is being read at all.
  const obsLabel: Record<ObserverHealth["kind"], string> = {
    ok: "up to date",
    stalled: "paused",
    "never-started": "not started",
    unknown: "checking…",
  };
  const obsDot: Record<ObserverHealth["kind"], Dot> = {
    ok: "ok",
    stalled: "err",
    "never-started": "pending",
    unknown: "pending",
  };

  // The second thing "Cardano reads: up to date" hides. Since spec 220 the observer rotates a window
  // over the bound population instead of scanning all of it every block, so an account outside the
  // current window keeps its last observed values rather than being re-derived. A healthy observer and
  // a stale account are therefore not a contradiction, and this is the row that says which.
  //
  // No threshold and no red state. A lap taking many blocks is the DESIGNED behaviour on a chain larger
  // than one window, so colouring it as a fault would page on health. The number is the signal; a reader
  // who wants a bound compares it to the population divided by the scan window.
  const coverageValue =
    coverage.kind === "swept"
      ? coverage.ageBlocks === 0
        ? "just now"
        : `${coverage.ageBlocks} block${coverage.ageBlocks === 1 ? "" : "s"} ago`
      : coverage.kind === "never-swept"
        ? "not yet"
        : "checking…";

  return (
    <div className={styles.card}>
      <Row label="Connection" value={connLabel} dot={connDot} />
      <Row
        label="Cardano reads"
        value={
          observer.kind === "stalled"
            ? `${obsLabel.stalled} (${observer.blocks} blocks)`
            : obsLabel[observer.kind]
        }
        dot={obsDot[observer.kind]}
      />
      <Row
        label="Credential scan"
        value={coverageValue}
        dot={coverage.kind === "unknown" ? "pending" : "ok"}
        title="How recently the observer finished checking every bound account. It works through them a window at a time, so an account it has not reached yet keeps its last known posting power, voting power and role tags."
      />
      <Row label="Genesis" value={shortHex(genesis)} mono title={genesis ?? undefined} copy={genesis ?? undefined} />
      <Row label="Network version" value={runtime ? `spec ${runtime.specV} · tx ${runtime.txV}` : "—"} mono />
      {/* Best + finalized on their OWN lines — the combined "#n / #n" overflowed the value column. */}
      <Row label="Best" value={heads.best ? `#${heads.best.number}` : "—"} mono />
      <Row label="Confirmed" value={heads.finalized ? `#${heads.finalized.number}` : "—"} mono />
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
    // Legacy-fallback copy so it also works in insecure contexts / in-app webviews (navigator.clipboard
    // undefined) — the genesis/runtime hex should be copyable even there for support diagnostics.
    const ok = await copyToClipboard(copy);
    toast(ok ? { kind: "success", message: "Copied" } : { kind: "error", message: "Couldn't copy" });
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
