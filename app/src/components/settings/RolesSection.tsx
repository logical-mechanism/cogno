"use client";

// RolesSection — Settings › Verified roles. An optional, post-onboarding add-on (like the stake bind in
// AccountSection): a payment-bound account proves control of a Cardano role key to earn a verified tag on
// its profile. SPO first (Calidus pool key, CIP-0151); dRep / CC ride the same wizard in later phases.
//
// Unlike the in-browser CIP-8 binds, the role key is an OFFLINE key — so the wizard bakes a fully-pinned
// `cardano-signer` command the operator runs on their key machine, then a strict paste-back pre-flight
// (lib/cardano/role-proof) verifies the returned COSE blobs before the feeless, bare claim is submitted
// (useRoles). The badge itself reads the observer-written `ObservedRoles`, so a claim only becomes a
// visible tag once the chain confirms the pool is live.

import { useCallback, useState } from "react";
import styles from "./RolesSection.module.css";
import { Spinner } from "@/components/icons";
import { Loading } from "@/components/Loading";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import { useRoles } from "@/hooks/useRoles";
import {
  buildRoleProofRequest,
  preflightRolePasteback,
  type RoleProofRequest,
} from "@/lib/cardano/role-proof";
import { getGenesisHex } from "@/lib/chain/identity";
import { copyToClipboard } from "@/lib/share";

/** `0x…`/bare 28-byte hex → `1a2b3c…c3d4` for a compact display. */
function truncId(idHex: string): string {
  const h = idHex.replace(/^0x/, "");
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

export function RolesSection() {
  const { api, client, signer, signerCtl, identity } = useSession();
  const { toast } = useToaster();
  const roles = useRoles(api, client, signer);

  const [keyInput, setKeyInput] = useState("");
  const [request, setRequest] = useState<RoleProofRequest | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const postingEnabled = signerCtl.postingEnabled;

  // Typing a new key invalidates a previously-built command (it committed the old key + a nonce).
  const onKeyInputChange = useCallback((v: string) => {
    setKeyInput(v);
    setRequest(null);
    setPasted("");
    setBuildError(null);
    setPreflightError(null);
  }, []);

  const onBuild = useCallback(async () => {
    if (!api || building) return;
    setBuilding(true);
    setBuildError(null);
    setRequest(null);
    setPasted("");
    setPreflightError(null);
    try {
      // The live genesis the proof must commit (anti-cross-chain), read straight from the node.
      const genesisHex = await getGenesisHex(api);
      const req = await buildRoleProofRequest({
        keyInput,
        sr25519PubkeyHex: signer.publicKeyHex,
        genesisHex,
        role: "spo",
      });
      setRequest(req);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }, [api, building, keyInput, signer.publicKeyHex]);

  const onVerifySubmit = useCallback(async () => {
    if (!request || verifying || roles.claiming) return;
    setVerifying(true);
    setPreflightError(null);
    try {
      const pf = await preflightRolePasteback(pasted, request);
      if (!pf.ok || !pf.coseSign1 || !pf.coseKey) {
        setPreflightError(pf.error || "the pasted proof failed pre-flight");
        return;
      }
      const ok = await roles.claim(pf.coseSign1, pf.coseKey);
      if (ok) {
        toast({ kind: "success", message: "Role claim submitted" });
        setKeyInput("");
        setRequest(null);
        setPasted("");
      }
    } finally {
      setVerifying(false);
    }
  }, [request, verifying, roles, pasted, toast]);

  const copyCommand = useCallback(async () => {
    if (!request) return;
    const ok = await copyToClipboard(request.command);
    toast(ok ? { kind: "success", message: "Command copied" } : { kind: "error", message: "Couldn't copy" });
  }, [request, toast]);

  // ── disconnected: a single connect prompt (the global Account control owns the connect button) ──
  if (!postingEnabled) {
    return (
      <div className={styles.cards}>
        <div className={styles.card}>
          <p className={styles.prompt}>Connect a Cardano wallet to claim a verified role.</p>
        </div>
      </div>
    );
  }

  // ── deciding onboarded-or-not (a key just changed) ──
  if (identity.checkingBound || identity.bound === null) {
    return (
      <div className={styles.cards}>
        <div className={styles.card}>
          <Loading variant="panel" label="Checking your account…" />
        </div>
      </div>
    );
  }

  // ── payment-bound is a precondition (the runtime rejects a role claim from an unbound account) ──
  if (identity.bound !== true) {
    return (
      <div className={styles.cards}>
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>Verified roles</h3>
          <p className={styles.prompt}>
            Register your posting key first. A verified role attaches to an account that can already post.
          </p>
        </div>
      </div>
    );
  }

  const submitting = verifying || roles.claiming;
  const submitLabel = roles.claiming
    ? roles.claimPhase === "confirming"
      ? "Confirming…"
      : "Submitting…"
    : verifying
      ? "Verifying…"
      : "Verify & submit";

  return (
    <div className={styles.cards}>
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Stake pool operator (SPO)</h3>
        <p className={styles.cardHint}>
          Prove you run a Cardano stake pool with your Calidus pool key (CIP-0151). A ✓ SPO tag shows on
          your profile once the chain confirms the pool is live — and clears automatically if it retires.
        </p>

        {roles.spoObserved ? (
          // ── verified: the observer confirmed a live pool ──
          <div className={styles.statusRow}>
            <span className={styles.verifiedMark}>✓ Verified SPO</span>
            <span className={styles.mono}>{truncId(roles.spoObserved.id)}</span>
          </div>
        ) : roles.spoClaimCredHex ? (
          // ── claimed, but the observer hasn't confirmed a live pool yet ──
          <div className={styles.statusRow}>
            <span className={styles.pendingMark}>
              <Spinner size="sm" label="Awaiting confirmation" /> Claimed — awaiting on-chain confirmation
              that your pool is live.
            </span>
          </div>
        ) : (
          // ── the claim wizard ──
          <div className={styles.wizard}>
            {/* Step 1 — enter the Calidus key */}
            <div className={styles.step}>
              <div className={styles.stepHead}>
                <span className={styles.stepNum}>1</span>
                <span className={styles.stepTitle}>Enter your Calidus verification key</span>
              </div>
              <input
                type="text"
                className={styles.input}
                value={keyInput}
                onChange={(e) => onKeyInputChange(e.target.value)}
                placeholder="calidus .vkey cborHex / 64-hex public key / 56-hex key hash"
                spellCheck={false}
                autoComplete="off"
                aria-label="Calidus verification key"
              />
              <p className={styles.hint}>
                Paste your Calidus <code>.vkey</code> file (or its hex), or the 28-byte key hash. This is a
                public key — never your secret key.
              </p>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={onBuild}
                disabled={!keyInput.trim() || building}
              >
                {building ? (
                  <>
                    <Spinner size="sm" label="Building" /> Building…
                  </>
                ) : (
                  "Generate signing command"
                )}
              </button>
              {buildError && (
                <p className={styles.error} role="alert">
                  {buildError}
                </p>
              )}
            </div>

            {request && (
              <>
                {/* Step 2 — run offline */}
                <div className={styles.step}>
                  <div className={styles.stepHead}>
                    <span className={styles.stepNum}>2</span>
                    <span className={styles.stepTitle}>Sign it offline with cardano-signer</span>
                  </div>
                  <p className={styles.hint}>
                    Run this where your <code>calidus.skey</code> lives (replace <code>calidus.skey</code>{" "}
                    with its path). It produces a one-time proof and never exposes your cold key.
                  </p>
                  <pre className={styles.codeBlock}>{request.command}</pre>
                  <div className={styles.actions}>
                    <button type="button" className={styles.outlineBtn} onClick={copyCommand}>
                      Copy command
                    </button>
                  </div>
                  <p className={styles.hintMono}>Signs over: {request.syntheticAddress}</p>
                </div>

                {/* Step 3 — paste + submit */}
                <div className={styles.step}>
                  <div className={styles.stepHead}>
                    <span className={styles.stepNum}>3</span>
                    <span className={styles.stepTitle}>Paste the result</span>
                  </div>
                  <textarea
                    className={styles.textarea}
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    placeholder="Paste the cardano-signer --json-extended output"
                    spellCheck={false}
                    rows={4}
                    aria-label="cardano-signer output"
                  />
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={onVerifySubmit}
                    disabled={!pasted.trim() || submitting}
                  >
                    {submitting ? (
                      <>
                        <Spinner size="sm" label={submitLabel} /> {submitLabel}
                      </>
                    ) : (
                      submitLabel
                    )}
                  </button>
                  {preflightError && (
                    <p className={styles.error} role="alert">
                      {preflightError}
                    </p>
                  )}
                  {roles.claimError && (
                    <p className={styles.error} role="alert">
                      {roles.claimError}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
