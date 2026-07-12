"use client";

// Providers — the single client provider stack the whole App Router tree lives inside (doc 01 §4.1).
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

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PolkadotClient } from "polkadot-api";
import { useChain } from "@/hooks/useChain";
import { useSigner, type UseSigner } from "@/hooks/useSigner";
import { useIdentity, type UseIdentity } from "@/hooks/useIdentity";
import { useFeedSource } from "@/hooks/useFeedSource";
import { useHeads } from "@/hooks/useHeads";
import { useSelfProfile } from "@/hooks/useSelfProfile";
import { deriveSessionState, type SessionState } from "@/lib/session";
import { ToasterProvider } from "@/components/toast/ToasterProvider";
import { OptimisticProvider } from "@/hooks/useOptimistic";
import { ReputationProvider } from "@/hooks/useReputation";
import { AuthorWeightProvider } from "@/hooks/useAuthorWeight";
import { NestedQuoteProvider } from "@/hooks/useNestedQuote";
import { AccountProfileProvider } from "@/hooks/useAccountProfile";
import { NotificationsProvider } from "@/hooks/useNotifications";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, ConnStatus, BootGuard, PostingSigner } from "@/lib/types";
import type { Viewer, ViewerStatus } from "@/components/kit";

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
  /** The doc-03 Viewer (coarse status + avatar/name/identity) every kit component consumes. */
  viewer: Viewer;
  /** The feed reader seam (the PAPI-direct node reader). Null before connect. */
  source: FeedSource | null;
  /** Live best-block number (one shared head subscription) — drives relative post times, capacity, etc. */
  bestBlock: number | null;
}

const SessionContext = createContext<Session | null>(null);

/** Map the rich SessionState to the doc-03 coarse Viewer.status triad (§0.2 of the kit). */
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

  const identity = useIdentity(api, client, signer);

  // The feed reader seam — the PAPI-direct node reader, memoized on [api] inside the hook (the node
  // serves feed / thread / profile / search directly since the all-Rust restart; no indexer config).
  const source = useFeedSource(api);

  // One shared head subscription for all block-relative UI (post times, capacity, live profile).
  const bestBlock = useHeads(client).best?.number ?? null;

  // The viewer's OWN profile (display name + avatar) for app chrome — the composer avatar/name, the
  // account menu, optimistic pending-post authorship. Only for a real chosen account; live + overlay-
  // merged so an edit shows instantly. Fed into the Viewer below.
  const self = useSelfProfile(
    source,
    signerCtl.postingEnabled ? signer.ss58 : null,
    signerCtl.postingEnabled,
    bestBlock,
  );

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
    };
  }, [
    sessionState,
    signerCtl.postingEnabled,
    signer.ss58,
    identity.bound,
    identity.boundStakeCredHex,
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
      bestBlock,
    }),
    [api, client, status, boot, wsUrl, reconnect, signer, signerCtl, identity, sessionState, viewer, source, bestBlock],
  );

  // ReputationProvider + AccountProfileProvider live INSIDE the session context (they read `api` via
  // useSession) so the whole tree shares one batched, cached lookup each — AccountVoteTally for the
  // author-reputation badges, and Profile.Profiles for @mention chips + notification actor rows.
  return (
    <SessionContext.Provider value={value}>
      <ReputationProvider>
        <AuthorWeightProvider>
          <NestedQuoteProvider>
            <AccountProfileProvider>
              <NotificationsProvider>{children}</NotificationsProvider>
            </AccountProfileProvider>
          </NestedQuoteProvider>
        </AuthorWeightProvider>
      </ReputationProvider>
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
