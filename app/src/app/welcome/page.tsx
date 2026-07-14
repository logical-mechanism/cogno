"use client";

// WelcomePage — /welcome. The connect → derive → CIP-8 bind onboarding stepper, then the
// power-ups step, which now has TWO required, non-skippable sub-steps in order: (1) bind the stake key
// (voting power) — required and ordered first so a wallet that can't sign its stake is caught before any
// ADA is locked; (2) lock 100 ADA into the L1 vault for talk-capacity (a bound account with zero locked
// ADA cannot post). It is the canonical target for any write intent attempted before setup is fully
// complete — every write affordance funnels here until `viewer.writeReady` (bound + stake-bound +
// posting power). Reading stays open throughout (read-only browse).
//
// The stepper is driven by session.sessionState (@/lib/session) + a local subStep within
// connected_unbound:
//   connecting / disconnected → 'connect'
//   binding                   → 'bind'
//   connected_unbound         → subStep ('account' then 'bind')
//   bound*                    → 'powerups'
// Fast-path to 'powerups' when bound===true on connect (returning user).
//
// HONESTY PURGE: no verified badge, no trust labels, no "signed ≠ finalized", no block
// numbers / finalized chips, no anchor UI, no capacity battery. The dual-key model surfaces only as
// friendly copy. No dev-account UI here (the dev-account picker was removed — the //Alice path is now
// programmatic-only via signerCtl.setDevAccount, not surfaced in Settings).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/Providers";
import { useVault } from "@/hooks/useVault";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { usePendingLockSync } from "@/hooks/usePendingLockSync";
import { useToaster } from "@/components/toast/ToasterProvider";
import { readReturnTo } from "@/lib/returnTo";
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
    // PAPI v2: watchValue takes an options object and emits { block, value } (destructure .value).
    const sub = api.query.TalkStake.AllowedStake.watchValue(ss58, { at: "best" }).subscribe(
      ({ value: w }) => setPostingPower((w as bigint) ?? 0n),
      // Subscription errored: fall through to the zero-power branch (lock CTA + read-only escape)
      // rather than sit on the indefinite "Checking your posting power…" state forever.
      () => setPostingPower(0n),
    );
    return () => sub.unsubscribe();
  }, [api, signerCtl.signer.ss58]);

  // The lock→credit pending state (explained, timed) + persistence of the in-flight lock so it survives
  // navigate/reload and follows a relock. usePendingLockSync writes the record when a lock submits (and
  // clears it on exit); usePendingCapacity turns record + observer frontier + AllowedStake into a status.
  usePendingLockSync(vault, signerCtl.signer.ss58);
  const pending = usePendingCapacity(api, signerCtl.signer.ss58, postingPower);

  // Derive the active step.
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
  // Only a user who just registered THIS session needs to walk the power-ups steps. A returning user is
  // either FULLY set up (bounce straight to the feed) or an existing account that predates a now-
  // mandatory step (drop onto power-ups to finish it — e.g. bound + locked but never stake-bound). We
  // must NOT infer "did they onboard?" purely from session states: on an in-app reconnect the identity
  // read is briefly stale (bound === false for the reverted //Alice key), so the session flaps through a
  // PHANTOM `connected_unbound` — which is why we latch registration on the actual Register action
  // (onRegister) rather than the session state, and reset it on a real disconnect. It is STATE (not a
  // ref) so the routing below re-derives from it during render.
  //
  // "Fully set up" = stake bound AND posting power > 0 — the same rule `viewer.writeReady` gates writes
  // on. For a returning user we must WAIT for the stake + posting-power reads before deciding, else a
  // fully-set-up user flashes the power-ups "checking" UI for a frame before the bounce; `decidingReturn`
  // holds the loader until both resolve. Fresh registrants skip the wait and continue through the steps.
  const [registeredThisSession, setRegisteredThisSession] = useState(false);
  useEffect(() => {
    if (sessionState === "disconnected") setRegisteredThisSession(false);
  }, [sessionState]);
  const fullySetUp = identity.stakeBound === true && (postingPower ?? 0n) > 0n;
  const returningOnPowerups = welcomeStep === "powerups" && !registeredThisSession;
  const decidingReturn =
    returningOnPowerups && (identity.stakeBound === null || postingPower === null);
  const bouncingToFeed = returningOnPowerups && !decidingReturn && fullySetUp;
  // Land them where they were actually HEADED, not on the feed. A returning, fully-set-up visitor is
  // precisely the person who pasted a share link: every cold load is logged out, so the auth wall bounced
  // them here carrying `?next=` — and finishing by sending them to the timeline is what made a post link
  // unopenable by its own URL. `readReturnTo` validates the target (it came off the URL, so it is
  // attacker-chosen: see the open-redirect guard in lib/returnTo) and falls back to the feed.
  //
  // Read off `window.location` rather than useSearchParams(): this page has no Suspense boundary, and
  // useSearchParams() here would force a client-side bailout under `output: export`.
  useEffect(() => {
    if (!bouncingToFeed) return;
    router.replace(readReturnTo(window.location.search));
  }, [bouncingToFeed, router]);

  // ── connect-error routing (toast vs inline) ────────────────────────────────────────────────────
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

  // ── focus the step heading on each transition (a11y) ───────────────────────────────────────────
  // The powerups step swaps its own heading as on-chain state lands (checking → "Lock ADA" → "Almost
  // there" → "You're all set"), all under welcomeStep==='powerups'. Key the focus on that sub-state too
  // so focus follows (and screen readers re-announce) the new heading instead of dropping to <body>.
  const powerupsBanner =
    welcomeStep === "powerups"
      ? `${identity.stakeBound}|${(postingPower ?? 0n) > 0n}|${pending.kind}|${postingPower === null}`
      : "";
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Defer to after paint so the new heading is mounted.
    const id = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [welcomeStep, powerupsBanner]);

  // ── actions ────────────────────────────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    (walletId: string) => {
      setConnectInlineError(null);
      return signerCtl.connectWallet(walletId);
    },
    [signerCtl],
  );

  // Cancel an in-flight derive: there is no abort handle on the CIP-30 signData promise, so disconnect()
  // abandons it (a derive-generation bump makes its late/never-arriving result a no-op) and releases the
  // spinner immediately — returning to the picker list. The derive moves no funds. We CAN'T close the
  // wallet's own popup, so remind the user it may still be asking (otherwise they might sign a request
  // we've already thrown away).
  const onCancelConnect = useCallback(() => {
    signerCtl.disconnect();
    toast({
      kind: "info",
      message: "Cancelled. If your wallet still shows a signature request, you can reject it there.",
    });
  }, [signerCtl, toast]);

  const onRegister = useCallback(() => {
    if (!signerCtl.connectedWalletId) return;
    // Latch that onboarding started HERE this session, so the power-ups steps aren't skipped for a
    // genuine new registrant (see the returning-user fast path above).
    setRegisteredThisSession(true);
    identity.bind(signerCtl.connectedWalletId);
  }, [identity, signerCtl.connectedWalletId]);

  const goToTimeline = useCallback(() => router.push("/"), [router]);
  const openSettings = useCallback(() => router.push("/settings/"), [router]);

  // "Use a different wallet" from the (now-required) stake step: a wallet that can't sign over its
  // reward address can't finish, so drop back to the wallet picker to re-derive from another wallet.
  const useDifferentWallet = useCallback(() => {
    setSubStep("account");
    signerCtl.disconnect();
  }, [signerCtl]);

  const walletName = signerCtl.connectedWalletId
    ? capitalize(signerCtl.connectedWalletId)
    : "your wallet";

  const chainReady = !!api && !!client;
  const bootOk = boot?.ok ?? true;

  // Neutral "deciding" loader: shown while a reconnecting key's bound-read is in flight
  // (checkingBound) — so the connect/account step never flashes, incl. the first post-derive frame since
  // checkingBound is set during render, not an effect — while we're bouncing an already-onboarded user
  // to the feed (so power-ups never flashes), OR while a returning user's stake/posting-power reads are
  // still resolving (decidingReturn), so a fully-set-up user never flashes a power-ups step before the
  // bounce. checkingBound flips false on error OR timeout, so a failed/hung read falls through to the
  // connect step instead of wedging the loader on a blank screen.
  const showLoader =
    (signerCtl.postingEnabled && !signerCtl.deriving && identity.checkingBound) ||
    bouncingToFeed ||
    decidingReturn;

  // ── render ─────────────────────────────────────────────────────────────────────────────────────
  if (showLoader) return <WelcomeShell loading />;

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
            stakeBindPhase: identity.stakeBindPhase,
            stakeError: identity.stakeError,
            votingPower: identity.votingPower,
            bindStake: identity.bindStake,
          }}
          postingPower={postingPower}
          pending={pending}
          ss58={signerCtl.signer.ss58}
          onGoToTimeline={goToTimeline}
          onOpenSettings={openSettings}
          onUseDifferentWallet={useDifferentWallet}
          headingRef={headingRef}
        />
      )}
    </WelcomeShell>
  );
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
