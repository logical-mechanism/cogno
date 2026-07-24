"use client";

// Providers — the single client provider stack the whole App Router tree lives inside.
//
// It lifts the foundation's three socket-owning hooks (useChain → useSigner → useIdentity) into ONE
// shared React context so every route reads {api, client, signer, identity, source, sessionState,
// votingPower, viewer} WITHOUT re-instantiating the PAPI socket. There is exactly one ChainHandle for
// the lifetime of the SPA — the shell persists across client navigations (only <main> swaps), so the
// ws connection, the live source.watch() subscription, and the connected wallet/identity survive route
// changes (X-exact: the rails never reload).
//
// Stack (outer → inner):
//   ToasterProvider     — the imperative toast bus (errors + rate-limit + sparse success)
//   OptimisticProvider  — the app-wide optimistic overlay (write hooks patch, read hooks merge)
//   ChainProvider       — owns the socket; derives the session + Viewer; exposes useSession()
// FeedSource is derived inside ChainProvider (memoized on [api]) and handed out via the same context,
// so a surface calls useSession() once instead of re-deriving the source per route.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PolkadotClient } from "polkadot-api";
import { useChain } from "@/hooks/useChain";
import { useSigner, type UseSigner } from "@/hooks/useSigner";
import { useIdentity, type UseIdentity } from "@/hooks/useIdentity";
import { useFeedSource } from "@/hooks/useFeedSource";
import { useHeads } from "@/hooks/useHeads";
import { useSelfProfile } from "@/hooks/useSelfProfile";
import { deriveSessionState, type SessionState } from "@/lib/session";
import { useDocumentVisible, useFrozenWhileHidden } from "@/lib/visibility";
import { ToasterProvider } from "@/components/toast/ToasterProvider";
import { OptimisticProvider } from "@/hooks/useOptimistic";
import { ReputationProvider } from "@/hooks/useReputation";
import { AccountVoteStateProvider } from "@/hooks/useAccountVoteState";
import { AccountVoteProvider } from "@/hooks/useAccountVote";
import { AuthorWeightProvider } from "@/hooks/useAuthorWeight";
import { NestedQuoteProvider } from "@/hooks/useNestedQuote";
import { AccountProfileProvider } from "@/hooks/useAccountProfile";
import { FollowEdgesProvider } from "@/hooks/useFollowEdges";
import { NotificationsProvider } from "@/hooks/useNotifications";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, ConnStatus, BootGuard, PostingSigner } from "@/lib/types";
import type { Viewer, ViewerStatus } from "@/components/kit";
import type { RoleKindType } from "@/lib/chain/roles";

export interface Session {
  // ── connection (one socket) ──
  api: CognoApi | null;
  client: PolkadotClient | null;
  status: ConnStatus;
  boot: BootGuard | null;
  wsUrl: string | null;
  reconnect: (url?: string) => void;

  // ── the active posting key + wallet ──
  signer: PostingSigner;
  signerCtl: UseSigner;

  // ── identity / stake bind ──
  identity: UseIdentity;
  /** Live voting power (TalkStake.VotingPower) for the active key; 0n until observed, null while loading. */
  votingPower: bigint | null;

  // ── derived ──
  /** The canonical write-gate state (@/lib/session) the surfaces branch on. */
  sessionState: SessionState;
  /** The Viewer (coarse status + avatar/name/identity) every kit component consumes. */
  viewer: Viewer;
  /** The feed reader seam (the PAPI-direct node reader). Null before connect. */
  source: FeedSource | null;
  /**
   * The active posting account's live observed Cardano roles (`CardanoRoles.ObservedRoles`) — SPO / dRep /
   * committee. `null` while loading or when no posting account is chosen; `[]` once known to hold none.
   * Watched ONCE here (not per-card) so every poll surface can gate a single-chamber poll on the viewer's
   * chamber membership without each InlinePoll re-subscribing for the same account.
   */
  viewerRoles: readonly RoleKindType[] | null;
}

const SessionContext = createContext<Session | null>(null);

/**
 * The live best-block number, in its OWN context — deliberately not a field of {@link Session}.
 *
 * It is the only value in the provider stack that changes on a fixed ~6s tick, and while it lived on
 * the session context every one of the 41 `useSession()` consumers re-rendered every block, whether or
 * not it cared about block height — into a component tree with no `React.memo` boundaries, so a Home
 * with five "load more" pages reconciled 250 PostCards every 6 seconds for a number most of them never
 * read. Split out, a block tick re-renders exactly the components that ask for it (PostTime, the
 * capacity meter, the live re-read effects) and nothing else.
 *
 * `null` until the first head arrives. Consumers must handle that — it is not "block 0".
 */
const BlockContext = createContext<number | null>(null);

/** The live best-block number (null until the first head lands). See {@link BlockContext}. */
export function useBestBlock(): number | null {
  return useContext(BlockContext);
}

/** Map the rich SessionState to the coarse Viewer.status triad (of the kit). */
function viewerStatusOf(s: SessionState): ViewerStatus {
  switch (s) {
    case "disconnected":
    case "connecting":
      return "not-connected";
    case "connected_unbound":
    case "binding":
      return "not-identity-bound";
    case "bound":
    case "bound_no_stake":
    case "bound_staked":
      return "ready";
  }
}

function ChainProvider({ children }: { children: ReactNode }) {
  const { api, client, status, boot, wsUrl, reconnect } = useChain();

  const signerCtl = useSigner();
  const signer = signerCtl.signer;

  // `postingEnabled` gates the identity reads off the BACKGROUND //Alice default — see the param doc
  // on useIdentity. Same guard `postingPower` and `viewerRoles` below already apply.
  const identity = useIdentity(api, client, signer, signerCtl.postingEnabled);

  // The feed reader seam — the PAPI-direct node reader, memoized on [api] inside the hook.
  const source = useFeedSource(api);

  // One shared head subscription for all block-relative UI (post times, capacity, live profile).
  // Deliberately NOT part of the session context value — see BlockContext below.
  //
  // FROZEN WHILE THE TAB IS HIDDEN. Every per-block refetch in the app keys off this number — the
  // thread re-read on /post, the profile re-read on /u, the feed's vote-reconcile page-1 fetch — so
  // holding it still is how a backgrounded tab stops working. It snaps to the live value in ONE step
  // when the tab comes back, so returning costs a single catch-up tick, not one per elapsed block.
  const visible = useDocumentVisible();
  const liveBlock = useHeads(client).best?.number ?? null;
  const bestBlock = useFrozenWhileHidden(liveBlock, visible);

  // The viewer's OWN profile (display name + avatar) for app chrome — the composer avatar/name, the
  // account menu, optimistic pending-post authorship. Only for a real chosen account; live + overlay-
  // merged so an edit shows instantly. Fed into the Viewer below.
  const self = useSelfProfile(api, signerCtl.postingEnabled ? signer.ss58 : null, signerCtl.postingEnabled);

  // The active account's posting power (TalkStake.AllowedStake = locked-ADA weight), watched globally so
  // `viewer.writeReady` can gate EVERY write affordance on the same "fully set up" signal instead of each
  // surface re-deriving it. 0n = registered-but-unlocked (or a lock still crediting), null = still loading.
  // Composers still read their own useCapacity for the rate-limit math; this is only for the coarse gate.
  const [postingPower, setPostingPower] = useState<bigint | null>(null);
  useEffect(() => {
    const active = signerCtl.postingEnabled ? signer.ss58 : null;
    if (!api || !active) {
      setPostingPower(null);
      return;
    }
    // PAPI v2: watchValue takes an options object and emits { block, value } (destructure .value). On a
    // subscription error fall through to 0n (not-ready) rather than sit on null (loading) forever.
    const sub = api.query.TalkStake.AllowedStake.watchValue(active, { at: "best" }).subscribe(
      ({ value: w }) => setPostingPower((w as bigint) ?? 0n),
      () => setPostingPower(0n),
    );
    return () => sub.unsubscribe();
  }, [api, signerCtl.postingEnabled, signer.ss58]);

  // The active account's live observed Cardano roles, watched globally (same pattern as `postingPower`)
  // so a single-chamber poll can gate voting on the viewer's chamber membership without each poll card
  // re-reading `ObservedRoles` for the same account. `null` = not connected / UNKNOWN (still loading, or a
  // read error) → the chamber gate FAILS OPEN; `[]` = confirmed to hold no live role → a non-member is
  // blocked. The gate is FE-only (the chain accepts anyone's vote; a non-member's never enters the
  // chamber), so `null`/fail-open is the safe direction — we must never wrongly block a real SPO/dRep.
  const [viewerRoles, setViewerRoles] = useState<readonly RoleKindType[] | null>(null);
  useEffect(() => {
    const active = signerCtl.postingEnabled ? signer.ss58 : null;
    if (!api || !active) {
      setViewerRoles(null);
      return;
    }
    // Reset to UNKNOWN (fail-open) whenever the active account changes, so a chamber poll is never briefly
    // gated on the PREVIOUS account's roles while this account's ObservedRoles resolves.
    setViewerRoles(null);
    // Same decode as `papi-source`'s ObservedRoles read: each entry is `{ kind: { type }, id }`. On a
    // subscription error fall back to `null` (UNKNOWN → fail-open), NOT `[]` — `[]` is a CONFIRMED
    // non-member and would wrongly block a real SPO/dRep from voting after a transient RPC hiccup.
    const sub = api.query.CardanoRoles.ObservedRoles.watchValue(active, { at: "best" }).subscribe(
      ({ value }) => {
        const next = (value ?? []).map((r) => r.kind.type);
        // KEEP THE PREVIOUS ARRAY when the roles have not actually changed. `watchValue` is a
        // per-block poll and `.map` mints a fresh array every time, so a plain setState re-rendered
        // ChainProvider — and therefore invalidated the session context value — every ~6s for an
        // unchanged answer. That is exactly the churn splitting bestBlock out of this context was
        // meant to stop; roles move on the observer's schedule (minutes at best), never per block.
        setViewerRoles((prev) =>
          prev && prev.length === next.length && prev.every((r, i) => r === next[i]) ? prev : next,
        );
      },
      () => setViewerRoles(null),
    );
    return () => sub.unsubscribe();
  }, [api, signerCtl.postingEnabled, signer.ss58]);

  const sessionState = useMemo(
    () =>
      deriveSessionState(
        {
          deriving: signerCtl.deriving,
          postingEnabled: signerCtl.postingEnabled,
          walletConnected: signerCtl.walletConnected,
        },
        { bound: identity.bound, binding: identity.binding, stakeBound: identity.stakeBound },
      ),
    [
      signerCtl.deriving,
      signerCtl.postingEnabled,
      signerCtl.walletConnected,
      identity.bound,
      identity.binding,
      identity.stakeBound,
    ],
  );

  const viewer = useMemo<Viewer>(() => {
    const status0 = viewerStatusOf(sessionState);
    return {
      status: status0,
      // address is only meaningful once a posting key is actively chosen (wallet or dev) — never the
      // background //Alice default that posting stays disabled on.
      address: signerCtl.postingEnabled ? signer.ss58 : undefined,
      identityHash: identity.bound ? (identity.boundStakeCredHex ?? undefined) : undefined,
      displayName: self.displayName,
      avatar: self.avatar,
      // The one authoritative write gate: bound + stake-bound + locked-ADA weight. Stake is a MANDATORY
      // onboarding step, so a bound, locked, but never-stake-bound account is intentionally NOT writeReady
      // (it browses read-only and every write funnels to /welcome to finish). False while any read loads.
      writeReady:
        identity.bound === true && identity.stakeBound === true && (postingPower ?? 0n) > 0n,
    };
  }, [
    sessionState,
    signerCtl.postingEnabled,
    signer.ss58,
    identity.bound,
    identity.stakeBound,
    identity.boundStakeCredHex,
    postingPower,
    self.displayName,
    self.avatar,
  ]);

  const value = useMemo<Session>(
    () => ({
      api,
      client,
      status,
      boot,
      wsUrl,
      reconnect,
      signer,
      signerCtl,
      identity,
      votingPower: identity.votingPower,
      sessionState,
      viewer,
      source,
      viewerRoles,
    }),
    [api, client, status, boot, wsUrl, reconnect, signer, signerCtl, identity, sessionState, viewer, source, viewerRoles],
  );

  // ReputationProvider + AccountProfileProvider live INSIDE the session context (they read `api` via
  // useSession) so the whole tree shares one batched, cached lookup each — AccountVoteTally for the
  // author-reputation badges, and Profile.Profiles for @mention chips + notification actor rows.
  // BlockContext sits INSIDE the session context: a block tick then re-renders only this subtree's
  // block consumers, and never invalidates `value` itself.
  return (
    <SessionContext.Provider value={value}>
      <BlockContext.Provider value={bestBlock}>
      <ReputationProvider>
        <AccountVoteStateProvider>
          <AuthorWeightProvider>
            <NestedQuoteProvider>
              <AccountProfileProvider>
                {/* One shared follow graph per account. Home alone asked for the viewer's four times
                    (this page, RightRail's useFollow, useWhoToFollow, the followees probe). */}
                <FollowEdgesProvider>
                {/* The account-vote WRITE side. It must outlive every surface that can cast a vote: a
                    hover card unmounts ~200ms after the mouse leaves, and useMutation kills an unsettled
                    run's callbacks when its caller unmounts — so a vote cast from a popover would lose
                    both its confirm (nothing would refresh the tally) and its failure toast. It sits
                    inside both vote caches because it invalidates them once a vote lands. */}
                <AccountVoteProvider>
                  <NotificationsProvider>{children}</NotificationsProvider>
                </AccountVoteProvider>
                </FollowEdgesProvider>
              </AccountProfileProvider>
            </NestedQuoteProvider>
          </AuthorWeightProvider>
        </AccountVoteStateProvider>
      </ReputationProvider>
      </BlockContext.Provider>
    </SessionContext.Provider>
  );
}

/** The single composed provider stack mounted once in the root layout (around AppShell). */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToasterProvider>
      <OptimisticProvider>
        <ChainProvider>{children}</ChainProvider>
      </OptimisticProvider>
    </ToasterProvider>
  );
}

/**
 * Read the shared session. Throws outside <Providers> — every interactive surface lives inside the
 * AppShell, which is inside Providers, so this is a logic-slip guard, not an expected state.
 */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within <Providers>");
  }
  return ctx;
}
