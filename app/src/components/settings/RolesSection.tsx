"use client";

// RolesSection — Settings › Verified roles. An optional, post-onboarding add-on (like the stake bind in
// AccountSection): a payment-bound account proves control of a Cardano role key to earn a verified tag on
// its profile. One reusable RoleClaimCard drives each role (SPO via a Calidus pool key; dRep via a
// key-based dRep key). CC rides the same card once its observer branch lands.
//
// Unlike the in-browser CIP-8 binds, the role key is an OFFLINE key — so each card bakes a fully-pinned
// `cardano-signer` command the operator runs on their key machine, then a strict paste-back pre-flight
// (lib/cardano/role-proof) verifies the returned COSE blobs before the feeless claim is submitted. The
// badge itself reads the observer-written `ObservedRoles`, so a claim only becomes a visible tag once the
// chain confirms the pool / dRep is live.

import { useCallback, useState, type ReactNode } from "react";
import styles from "./RolesSection.module.css";
import { Spinner } from "@/components/icons";
import { Loading } from "@/components/Loading";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import { useRoles, type UseRoles } from "@/hooks/useRoles";
import {
  buildRoleProofRequest,
  preflightRolePasteback,
  produceRoleProofWallet,
  type RoleProofRequest,
  type RoleToken,
} from "@/lib/cardano/role-proof";
import { isBlankRoleId, type RoleKindType } from "@/lib/chain/roles";
import { getGenesisHex } from "@/lib/chain/identity";
import { copyToClipboard } from "@/lib/share";
import type { CognoApi, PostingSigner } from "@/lib/types";

/** `0x…`/bare 28-byte hex → `1a2b3c…c3d4` for a compact display. */
function truncId(idHex: string): string {
  const h = idHex.replace(/^0x/, "");
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

/** Per-role copy for a claim card. */
interface RoleSpec {
  role: RoleToken;
  kind: RoleKindType;
  label: string; // short, e.g. "SPO"
  title: string;
  cardHint: string;
  keyPlaceholder: string;
  keyHint: ReactNode;
  /** The key can be signed IN-WALLET (dRep via CIP-95; SPO via the wallet's root payment key, from which
   *  Eternl derives the Calidus key). Both then also offer the offline command as a fallback. */
  walletSignable?: boolean;
  /** One-line note shown under the wallet-sign buttons (role-specific: dRep needs CIP-95, SPO needs the
   *  wallet the Calidus key derives from). Only rendered when `walletSignable`. */
  walletHint?: string;
}

const ROLE_SPECS: RoleSpec[] = [
  {
    role: "spo",
    kind: "Spo",
    label: "SPO",
    title: "Stake pool operator (SPO)",
    cardHint: "Prove control of your Calidus pool key (CIP-0151); the tag clears if the pool retires.",
    walletSignable: true,
    walletHint:
      "Signs in Eternl with your Calidus key — connect the account it's derived from. Or sign offline.",
    keyPlaceholder: "calidus1… id / calidus_vk1… / .vkey cborHex / 56-hex key hash",
    keyHint: "Public key — never your secret key.",
  },
  {
    role: "drep",
    kind: "DRep",
    label: "dRep",
    title: "Delegated representative (dRep)",
    cardHint: "Prove control of your dRep key (CIP-0105); the tag clears if you deregister.",
    walletSignable: true,
    walletHint: "Needs a CIP-95 wallet (Eternl, Lace). No key file, no CLI.",
    keyPlaceholder: "drep1… id  /  drep .vkey cborHex  /  56-hex dRep ID",
    keyHint: "Key-based dReps only (script dReps can't sign). Public key — never your secret key.",
  },
];

function RoleClaimCard({
  spec,
  roles,
  api,
  signer,
  walletId,
}: {
  spec: RoleSpec;
  roles: UseRoles;
  api: CognoApi;
  signer: PostingSigner;
  /** the connected CIP-30 wallet id — needed for the in-wallet (CIP-95) signing path; null if disconnected. */
  walletId: string | null;
}) {
  const { toast } = useToaster();
  const [keyInput, setKeyInput] = useState("");
  const [request, setRequest] = useState<RoleProofRequest | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [walletSigning, setWalletSigning] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const observed = roles.observedFor(spec.kind);
  const claimCred = roles.claimCredHex[spec.kind];

  const onKeyInputChange = useCallback((v: string) => {
    setKeyInput(v);
    setRequest(null);
    setPasted("");
    setBuildError(null);
    setPreflightError(null);
    setSubmitError(null);
    setWalletError(null);
  }, []);

  const onBuild = useCallback(async () => {
    if (building) return;
    setBuilding(true);
    setBuildError(null);
    setRequest(null);
    setPasted("");
    setPreflightError(null);
    setSubmitError(null);
    try {
      const genesisHex = await getGenesisHex(api);
      const req = await buildRoleProofRequest({
        keyInput,
        sr25519PubkeyHex: signer.publicKeyHex,
        genesisHex,
        role: spec.role,
      });
      setRequest(req);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }, [api, building, keyInput, signer.publicKeyHex, spec.role]);

  // The wallet-pops-up path (dRep, CIP-95): build the request, have the wallet sign the pinned payload with
  // its dRep key, pre-flight, and submit — all in one click. On ANY failure the offline command stays
  // available as the fallback, so `walletError` is a nudge, not a dead end.
  const onWalletSign = useCallback(async () => {
    if (walletSigning) return;
    if (!walletId) {
      setWalletError("connect a Cardano wallet first");
      return;
    }
    setWalletSigning(true);
    setWalletError(null);
    setBuildError(null);
    try {
      const genesisHex = await getGenesisHex(api);
      const req = await buildRoleProofRequest({
        keyInput,
        sr25519PubkeyHex: signer.publicKeyHex,
        genesisHex,
        role: spec.role,
      });
      const pf = await produceRoleProofWallet({ walletId, request: req, keyInput });
      if (!pf.ok || !pf.coseSign1 || !pf.coseKey) {
        setWalletError(pf.error || "the wallet couldn't produce a valid proof");
        return;
      }
      const res = await roles.claim(pf.coseSign1, pf.coseKey);
      if (res.ok) {
        toast({ kind: "success", message: `${spec.label} claim submitted` });
        setKeyInput("");
        setRequest(null);
        setPasted("");
      } else {
        setWalletError(res.error || "the on-chain claim was rejected");
      }
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    } finally {
      setWalletSigning(false);
    }
  }, [walletSigning, walletId, api, keyInput, signer.publicKeyHex, spec.role, spec.label, roles, toast]);

  const onVerifySubmit = useCallback(async () => {
    if (!request || submitting) return;
    setSubmitting(true);
    setPreflightError(null);
    setSubmitError(null);
    try {
      const pf = await preflightRolePasteback(pasted, request);
      if (!pf.ok || !pf.coseSign1 || !pf.coseKey) {
        setPreflightError(pf.error || "the pasted proof failed pre-flight");
        return;
      }
      const res = await roles.claim(pf.coseSign1, pf.coseKey);
      if (res.ok) {
        toast({ kind: "success", message: `${spec.label} claim submitted` });
        setKeyInput("");
        setRequest(null);
        setPasted("");
      } else {
        setSubmitError(res.error || "the on-chain claim was rejected");
      }
    } finally {
      setSubmitting(false);
    }
  }, [request, submitting, pasted, roles, spec.label, toast]);

  const onRemove = useCallback(async () => {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    const res = await roles.unclaim(spec.kind);
    if (!res.ok) setRemoveError(res.error || "the on-chain removal was rejected");
    setRemoving(false);
  }, [removing, roles, spec.kind]);

  const copyCommand = useCallback(async () => {
    if (!request) return;
    const ok = await copyToClipboard(request.command);
    toast(ok ? { kind: "success", message: "Command copied" } : { kind: "error", message: "Couldn't copy" });
  }, [request, toast]);

  const removeBtn = (
    <button
      type="button"
      className={styles.outlineBtn}
      onClick={onRemove}
      disabled={removing}
      aria-label={`Remove ${spec.label} role`}
    >
      {removing ? "Removing…" : "Remove"}
    </button>
  );

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>{spec.title}</h3>
      <p className={styles.cardHint}>{spec.cardHint}</p>

      {observed ? (
        // ── verified: the observer confirmed a live role ──
        <div className={styles.statusRow}>
          <span className={styles.verifiedMark}>✓ Verified {spec.label}</span>
          {/* A Calidus SPO names no pool (blank id) → show nothing; an ownership SPO / dRep shows its id. */}
          {!isBlankRoleId(observed.id) && <span className={styles.mono}>{truncId(observed.id)}</span>}
          {/* Only offer "Remove" when a CLAIM backs the badge — a badge from the free SpoOwner path (live
              pool ownership, no `RoleClaimOf` entry) has nothing to unclaim, and unclaim_role would fail
              `NotClaimed` + can't-pay for a zero-balance account. Ownership-derived badges clear only when
              the pool retires, not by a user action. */}
          {claimCred && removeBtn}
        </div>
      ) : claimCred ? (
        // ── claimed, but the observer hasn't confirmed a live role yet ──
        <div className={styles.statusRow}>
          <span className={styles.pendingMark}>
            <Spinner size="sm" label="Awaiting confirmation" /> Claimed — awaiting on-chain confirmation.
          </span>
          {removeBtn}
        </div>
      ) : (
        // ── the claim wizard ──
        <div className={styles.wizard}>
          {/* Step 1 — enter the role key */}
          <div className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.stepNum}>1</span>
              <span className={styles.stepTitle}>Enter your {spec.label} verification key</span>
            </div>
            {/* A wrapping textarea, not a single-line input: a bech32 id / .vkey JSON is long, and the
                settings column is narrow — this keeps the whole value visible instead of scrolling off. */}
            <textarea
              className={styles.keyField}
              value={keyInput}
              onChange={(e) => onKeyInputChange(e.target.value)}
              placeholder={spec.keyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              rows={2}
              aria-label={`${spec.label} verification key`}
            />
            <p className={styles.hint}>{spec.keyHint}</p>
            {spec.walletSignable ? (
              <>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={onWalletSign}
                    disabled={!keyInput.trim() || walletSigning}
                  >
                    {walletSigning ? (
                      <>
                        <Spinner size="sm" label="Signing" /> Waiting for wallet…
                      </>
                    ) : (
                      "Sign with wallet"
                    )}
                  </button>
                  <button
                    type="button"
                    className={styles.outlineBtn}
                    onClick={onBuild}
                    disabled={!keyInput.trim() || building}
                  >
                    {building ? "Preparing…" : "Sign offline instead"}
                  </button>
                </div>
                {spec.walletHint && <p className={styles.hint}>{spec.walletHint}</p>}
                {walletError && (
                  <p className={styles.error} role="alert">
                    {walletError}
                  </p>
                )}
              </>
            ) : (
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
            )}
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
                  Run where your secret key lives; point <code>--secret-key</code> at its file. Key stays
                  local.
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
                      <Spinner size="sm" label="Submitting" /> Submitting…
                    </>
                  ) : (
                    "Verify & submit"
                  )}
                </button>
                {preflightError && (
                  <p className={styles.error} role="alert">
                    {preflightError}
                  </p>
                )}
                {submitError && (
                  <p className={styles.error} role="alert">
                    {submitError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {removeError && (
        <p className={styles.error} role="alert">
          {removeError}
        </p>
      )}
    </div>
  );
}

export function RolesSection() {
  const { api, client, signer, signerCtl, identity } = useSession();
  const roles = useRoles(api, client, signer);

  const postingEnabled = signerCtl.postingEnabled;

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
  if (identity.bound !== true || !api) {
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

  return (
    <div className={styles.cards}>
      {ROLE_SPECS.map((spec) => (
        <RoleClaimCard
          key={spec.role}
          spec={spec}
          roles={roles}
          api={api}
          signer={signer}
          walletId={signerCtl.connectedWalletId}
        />
      ))}
    </div>
  );
}
