"use client";

// DiagnosticsSection — Settings (doc 12). A read-only, prod-safe snapshot of what the app is connected
// to + the chain identity it sees. Replaces the old "Advanced" section: the dev-account picker is gone
// (the consumer build posts only through a real wallet). NO secrets — the Blockfrost project id is
// shown only as "configured" (it is client-side BY DESIGN for the in-browser vault, but is never
// printed here), and nothing is editable. Block numbers appear ONLY here and in the Civic-Ledger strip.

import { useEffect, useState } from "react";
import styles from "./DiagnosticsSection.module.css";
import { useSession } from "@/components/Providers";
import { useHeads } from "@/hooks/useHeads";
import { getGenesisHex } from "@/lib/chain/identity";
import { getActiveWsUrl, getGraphqlUrl, getBlockfrostProjectId } from "@/lib/config/endpoints";
import { gqlRequest } from "@/lib/graphql/client";

function shortHex(hex: string | null, head = 10): string {
  if (!hex) return "—";
  const h = hex.startsWith("0x") ? hex : `0x${hex}`;
  return h.length > head + 2 ? `${h.slice(0, head)}…` : h;
}

type Reach = "checking" | "ok" | "unreachable" | "off";
type Dot = "ok" | "pending" | "err";

export function DiagnosticsSection() {
  const { api, client, status } = useSession();
  const heads = useHeads(client);
  const [genesis, setGenesis] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<{ specV: number; txV: number } | null>(null);
  const [indexerReach, setIndexerReach] = useState<Reach>("off");

  const wsUrl = getActiveWsUrl();
  const indexerUrl = getGraphqlUrl();
  const blockfrostSet = getBlockfrostProjectId().length > 0;

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

  // Indexer reachability — a tiny `{ __typename }` probe; "off" when none is configured.
  useEffect(() => {
    if (!indexerUrl) {
      setIndexerReach("off");
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    setIndexerReach("checking");
    void gqlRequest<{ __typename: string }>(indexerUrl, "{ __typename }", undefined, ac.signal)
      .then(() => !cancelled && setIndexerReach("ok"))
      .catch((e) => {
        if (!cancelled && !(e instanceof DOMException && e.name === "AbortError")) setIndexerReach("unreachable");
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [indexerUrl]);

  const connDot: Dot = status === "connected" ? "ok" : status === "connecting" ? "pending" : "err";
  const connLabel =
    status === "connected" ? "connected" : status === "connecting" ? "connecting…" : "disconnected";
  const indexerDot: Dot | undefined = !indexerUrl
    ? undefined
    : indexerReach === "ok"
      ? "ok"
      : indexerReach === "checking"
        ? "pending"
        : "err";

  return (
    <div className={styles.card}>
      <p className={styles.note}>Read-only.</p>

      <Row label="Node (RPC)" value={wsUrl} mono />
      <Row label="Connection" value={connLabel} dot={connDot} />
      <Row label="Genesis" value={shortHex(genesis)} mono title={genesis ?? undefined} />
      <Row label="Runtime" value={runtime ? `spec ${runtime.specV} · tx ${runtime.txV}` : "—"} mono />
      <Row
        label="Best / finalized"
        value={`${heads.best ? `#${heads.best.number}` : "—"} / ${heads.finalized ? `#${heads.finalized.number}` : "—"}`}
        mono
      />
      <Row
        label="Indexer"
        value={indexerUrl || "not configured — reading node-direct"}
        mono={!!indexerUrl}
        dot={indexerDot}
      />
      <Row
        label="Cardano provider"
        value={blockfrostSet ? "Blockfrost configured (in-browser, preprod)" : "not configured"}
      />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  dot,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  dot?: Dot;
  title?: string;
}) {
  const dotCls = dot === "ok" ? styles.dotOk : dot === "pending" ? styles.dotPending : styles.dotErr;
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.valueWrap}>
        {dot && <span className={`${styles.dot} ${dotCls}`} aria-hidden />}
        <span className={mono ? styles.mono : styles.value} title={title}>
          {value}
        </span>
      </span>
    </div>
  );
}
