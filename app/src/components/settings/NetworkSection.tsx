"use client";

// NetworkSection — Settings §6 (doc 12). The endpoint knobs the whole app's reads/writes flow through:
// Node (ws), Indexer (GraphQL), Cardano provider (Blockfrost), + Follower (legacy, no effect in spec
// 117). Plain field labels, no honesty framing. All validation lives in lib/config/endpoints.ts; the
// setters throw on invalid → we surface the message inline.
//
// EFFECT: on any endpoint Save we use the documented reload fallback — show a "Settings saved —
// reloading…" Toast then window.location.reload() (state is in localStorage; the static export
// tolerates it). The Node status dot reads useSession().status live.

import { useCallback, useState } from "react";
import styles from "./NetworkSection.module.css";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import {
  getActiveWsUrl,
  getEndpoints,
  setEndpoints,
  getGraphqlUrl,
  setGraphqlUrl,
  getBlockfrostProjectId,
  setBlockfrostProjectId,
  getFollowerUrl,
  setFollowerUrl,
} from "@/lib/config/endpoints";

function reloadWithToast(toast: (s: { kind: "info"; message: string }) => void) {
  toast({ kind: "info", message: "Settings saved — reloading…" });
  if (typeof window !== "undefined") {
    setTimeout(() => window.location.reload(), 250);
  }
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  /** Persist; throws on invalid (the setter's message is shown inline). */
  save: (value: string) => void;
  /** Show a Clear button (clears to ""). */
  clearable?: boolean;
  /** Extra control rendered beside Save (e.g. the status dot). */
  trailing?: React.ReactNode;
  onSaved: () => void;
}

function EndpointField({ id, label, hint, initial, placeholder, save, clearable, trailing, onSaved }: FieldProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const errId = `${id}-err`;
  const changed = value !== initial;

  const onSave = useCallback(
    (next: string) => {
      setError(null);
      try {
        save(next);
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [save, onSaved],
  );

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputRow}>
        <input
          id={id}
          className={styles.input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? errId : undefined}
        />
        <button
          type="button"
          className={styles.saveBtn}
          onClick={() => onSave(value)}
          disabled={!changed}
        >
          Save
        </button>
        {clearable && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={() => {
              setValue("");
              onSave("");
            }}
            disabled={value.length === 0}
          >
            Clear
          </button>
        )}
        {trailing}
      </div>
      {hint && <p className={styles.hint}>{hint}</p>}
      {error && (
        <p className={styles.error} id={errId} role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}

export function NetworkSection() {
  const { status } = useSession();
  const { toast } = useToaster();
  const [legacyOpen, setLegacyOpen] = useState(false);

  const onSaved = useCallback(() => reloadWithToast(toast), [toast]);

  const statusLabel =
    status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";
  const dotCls =
    status === "connected" ? styles.dotOk : status === "connecting" ? styles.dotPending : styles.dotErr;

  return (
    <div className={styles.card}>
      <EndpointField
        id="net-node"
        label="Node (WebSocket)"
        initial={getActiveWsUrl()}
        placeholder="ws://127.0.0.1:9944"
        save={(v) => setEndpoints([v, ...getEndpoints().slice(1)])}
        onSaved={onSaved}
        trailing={
          <span className={styles.statusDot}>
            <span className={dotCls} aria-hidden />
            {statusLabel}
          </span>
        }
      />

      <EndpointField
        id="net-indexer"
        label="Indexer (GraphQL)"
        hint="Search and the Following tab need the indexer."
        initial={getGraphqlUrl()}
        placeholder="https://indexer.example/"
        save={(v) => setGraphqlUrl(v)}
        clearable
        onSaved={onSaved}
      />

      <EndpointField
        id="net-blockfrost"
        label="Cardano provider (Blockfrost project id)"
        initial={getBlockfrostProjectId()}
        placeholder="preprod…"
        save={(v) => setBlockfrostProjectId(v)}
        clearable
        onSaved={onSaved}
      />

      {/* Legacy: the Follower URL has no effect in spec 117 (binds are feeless bare unsigned txs). */}
      <div className={styles.legacy}>
        <button
          type="button"
          className={styles.disclosure}
          onClick={() => setLegacyOpen((o) => !o)}
          aria-expanded={legacyOpen}
        >
          <span className={`${styles.chevron} ${legacyOpen ? styles.chevronOpen : ""}`} aria-hidden>
            ▸
          </span>
          Legacy
        </button>
        {legacyOpen && (
          <div className={styles.legacyBody}>
            <EndpointField
              id="net-follower"
              label="Follower URL"
              hint="No effect in this version — the bind path no longer uses a follower."
              initial={getFollowerUrl()}
              placeholder="http://127.0.0.1:8090"
              save={(v) => setFollowerUrl(v)}
              onSaved={onSaved}
            />
          </div>
        )}
      </div>
    </div>
  );
}
