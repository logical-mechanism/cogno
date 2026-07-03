"use client";

// WelcomePage — /welcome (surface 11). The connect → derive → CIP-8 bind onboarding stepper, then the
// power-ups step: locking 100 ADA into the L1 vault is REQUIRED to post (it earns the talk-capacity
// every post consumes — a bound account with zero locked ADA cannot post), while binding the stake key
// for voting weight is the only genuinely optional boost. It is the canonical write-gate target for any
// write intent attempted while not connected / not bound.
//
// The stepper is driven by session.sessionState (@/lib/session) + a local subStep within
// connected_unbound (surface 11 §6.1):
//   connecting / disconnected → 'connect'
//   binding                   → 'bind'
//   connected_unbound         → subStep ('account' then 'bind')
//   bound*                    → 'powerups'
// Fast-path to 'powerups' when bound===true on connect (returning user).
//
// HONESTY PURGE (surface 11 §13): no verified badge, no trust labels, no "signed ≠ finalized", no block
// numbers / finalized chips, no anchor UI, no capacity battery. The dual-key model surfaces only as
// friendly copy. No dev-account UI here (the dev-account picker was removed — the //Alice path is now
// programmatic-only via signerCtl.setDevAccount, not surfaced in Settings).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/Providers";
import { useVault } from "@/hooks/useVault";
import { useToaster } from "@/components/toast/ToasterProvider";
import { WelcomeShell } from "@/components/welcome/WelcomeShell";
import { WalletPicker } from "@/components/welcome/WalletPicker";
import { AccountConfirm } from "@/components/welcome/AccountConfirm";
import { BindStep } from "@/components/welcome/BindStep";
import { PowerUps } from "@/components/welcome/PowerUps";

type WelcomeStep = "connect" | "account" | "bind" | "powerups";

const STEP_INDEX: Record<WelcomeStep, number> = {
  connect: 1,
  account: 2,
  bind: 3,
  powerups: 4,
};

// Connect-step error classification: some failures are TOASTs (transient — declined / no signature),
// others are INLINE under the list (non-vkey script address / not-installed / wrong network). Returns
// the inline copy (or null) plus whether a toast should fire. The hook's raw string is the source.
function classifyConnectError(raw: string): { inline: string | null; toast: string | null } {
  const m = raw.toLowerCase();
  if (/script payment credential|script\/vault|non-vkey|script\/contract/.test(m)) {
    return {
      inline: "That's a script/contract address. Connect a normal wallet account.",
      toast: null,
    };
  }
  if (/wrong network|mainnet|preprod|network id|network mismatch/.test(m)) {
    return {
      inline: "Switch your wallet to the Cardano preprod testnet, then reconnect.",
      toast: null,
    };
  }
  if (/no signature|empty.*signature|did ?n.?t return a signature|return.*no.*signature/.test(m)) {
    return { inline: null, toast: "Your wallet didn't return a signature. Try again." };
  }
  if (/declin|cancel|user.*denied|reject/.test(m)) {
    return { inline: null, toast: "Connection cancelled." };
  }
  if (/not installed|enable|is it installed|cannot find|no such wallet|unavailable/.test(m)) {
    return { inline: "Couldn't open that wallet. Is it installed and unlocked?", toast: null };
  }
  // Default: show it inline so nothing is silently swallowed.
  return { inline: raw, toast: null };
}

export default function WelcomePage() {
  const router = useRouter();
  const { signerCtl, identity, sessionState, api, client, boot } = useSession();
  const vault = useVault();
  const { toast } = useToaster();

  const [subStep, setSubStep] = useState<"account" | "bind">("account");

  // Live posting power (TalkStake.AllowedStake = locked-ADA weight) for the active key. Drives whether
  // the power-ups step says "you can post" (weight > 0) or "lock ADA to post". null while loading →
  // treated as no-power-yet so we never falsely claim "all set" before the read resolves.
  const [postingPower, setPostingPower] = useState<bigint | null>(null);
  useEffect(() => {
    if (!api) {
      setPostingPower(null);
      return;
    }
    const ss58 = signerCtl.signer.ss58;
    const sub = api.query.TalkStake.AllowedStake.watchValue(ss58, "best").subscribe(
      (w) => setPostingPower((w as bigint) ?? 0n),
      () => setPostingPower(null),
    );
    return () => sub.unsubscribe();
  }, [api, signerCtl.signer.ss58]);

  // Derive the active step (surface 11 §6.1).
  const welcomeStep: WelcomeStep =
    sessionState === "connecting"
      ? "connect"
      : sessionState === "disconnected"
        ? "connect"
        : sessionState === "binding"
          ? "bind"
          : sessionState === "connected_unbound"
            ? subStep
            : "powerups"; // bound / bound_no_stake / bound_staked

  // A returning user whose live bound-watch resolves true while on the account sub-step should jump
  // straight past account/bind. The derivation already lands them on 'powerups' once sessionState
  // flips to a bound state; nothing extra to do — but reset subStep so a later disconnect starts fresh.
  useEffect(() => {
    if (sessionState === "disconnected") setSubStep("account");
  }, [sessionState]);

  // ── returning-user fast path ───────────────────────────────────────────────────────────────────
  // A new user passes through the account/bind steps (connected_unbound → binding) before reaching a
  // bound state; a RETURNING user reconnects straight into a bound state, never touching them. Only the
  // former needs the power-ups interstitial — the latter is already set up, so we drop them directly
  // into the feed ("log in → see posts"). We latch "did we start onboarding this session?" and, when a
  // bound session lands on power-ups without it, replace to Home.
  const startedOnboarding = useRef(false);
  useEffect(() => {
    if (sessionState === "connected_unbound" || sessionState === "binding") {
      startedOnboarding.current = true;
    }
    if (sessionState === "disconnected") startedOnboarding.current = false;
  }, [sessionState]);
  useEffect(() => {
    if (welcomeStep === "powerups" && !startedOnboarding.current) router.replace("/");
  }, [welcomeStep, router]);

  // ── connect-error routing (toast vs inline) ──────────────────────────────────────────────────
  const [connectInlineError, setConnectInlineError] = useState<string | null>(null);
  const lastHandledError = useRef<string | null>(null);
  useEffect(() => {
    const err = signerCtl.error;
    if (!err) {
      setConnectInlineError(null);
      lastHandledError.current = null;
      return;
    }
    if (lastHandledError.current === err) return;
    lastHandledError.current = err;
    const { inline, toast: toastCopy } = classifyConnectError(err);
    setConnectInlineError(inline);
    if (toastCopy) toast({ kind: "error", message: toastCopy });
  }, [signerCtl.error, toast]);

  // ── focus the step heading on each transition (a11y, §12) ────────────────────────────────────
  // The powerups step swaps its own heading as on-chain state lands (checking → "Lock ADA" → "Almost
  // there" → "You're all set"), all under welcomeStep==='powerups'. Key the focus on that sub-state too
  // so focus follows (and screen readers re-announce) the new heading instead of dropping to <body>.
  const powerupsBanner =
    welcomeStep === "powerups"
      ? `${(postingPower ?? 0n) > 0n}|${vault.phase === "submitted"}|${postingPower === null}`
      : "";
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Defer to after paint so the new heading is mounted.
    const id = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [welcomeStep, powerupsBanner]);

  // ── actions ──────────────────────────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    (walletId: string) => {
      setConnectInlineError(null);
      return signerCtl.connectWallet(walletId);
    },
    [signerCtl],
  );

  // Cancel an in-flight derive: there is no abort handle on the promise, so we just disconnect back to
  // the picker (the resolved promise's setState is harmless; the derive doesn't move funds).
  const onCancelConnect = useCallback(() => {
    signerCtl.disconnect();
  }, [signerCtl]);

  const onRegister = useCallback(() => {
    if (!signerCtl.connectedWalletId) return;
    identity.bind(signerCtl.connectedWalletId);
  }, [identity, signerCtl.connectedWalletId]);

  const goToTimeline = useCallback(() => router.push("/"), [router]);
  const openSettings = useCallback(() => router.push("/settings/"), [router]);

  const walletName = signerCtl.connectedWalletId
    ? capitalize(signerCtl.connectedWalletId)
    : "your wallet";

  const chainReady = !!api && !!client;
  const bootOk = boot?.ok ?? true;

  // ── render ─────────────────────────────────────────────────────────────────────────────────────
  return (
    <WelcomeShell step={STEP_INDEX[welcomeStep]}>
      {welcomeStep === "connect" && (
        <WalletPicker
          deriving={signerCtl.deriving}
          errorCopy={connectInlineError}
          onConnect={onConnect}
          onCancel={onCancelConnect}
          headingRef={headingRef}
        />
      )}

      {welcomeStep === "account" && (
        <AccountConfirm
          ss58={signerCtl.signer.ss58}
          walletName={walletName}
          onContinue={() => setSubStep("bind")}
          onUseDifferent={() => {
            setSubStep("account");
            signerCtl.disconnect();
          }}
          headingRef={headingRef}
        />
      )}

      {welcomeStep === "bind" && (
        <BindStep
          ss58={signerCtl.signer.ss58}
          binding={identity.binding}
          bindPhase={identity.bindPhase}
          error={identity.error}
          chainReady={chainReady}
          bootOk={bootOk}
          onRegister={onRegister}
          headingRef={headingRef}
        />
      )}

      {welcomeStep === "powerups" && (
        <PowerUps
          vault={vault}
          walletId={signerCtl.connectedWalletId}
          stake={{
            stakeBound: identity.stakeBound,
            stakeBinding: identity.stakeBinding,
            stakeError: identity.stakeError,
            votingPower: identity.votingPower,
            bindStake: identity.bindStake,
          }}
          postingPower={postingPower}
          onGoToTimeline={goToTimeline}
          onOpenSettings={openSettings}
          headingRef={headingRef}
        />
      )}
    </WelcomeShell>
  );
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
