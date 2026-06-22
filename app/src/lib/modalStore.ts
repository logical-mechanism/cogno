"use client";

// modalStore — the tiny client store the ModalRouteHost subscribes to (doc 01 §5.4 / §7.2).
//
// Compose / reply / quote / poll / edit-profile open as OVERLAYS over the current surface so
// <main> never unmounts (the live source.watch() subscription keeps streaming behind the modal).
// The store holds only `{ kind, targetId }`; the URL is kept in sync by the ModalRouteHost via the
// History API (?reply=/?quote=), not by next/router (which would swap <main>). It is a module-level
// singleton with a useSyncExternalStore hook so any component (LeftNav "Post" pill, ComposeFab,
// PostCard reply/quote callbacks, ProfileHeader edit) can drive it without prop-drilling.
//
// `kind` mirrors the kit `ModalKind`; `targetId` is the reply/quote target post id in STRING form
// (the URL-sync shape). The action callbacks accept a `bigint` and stringify it here.

import { useSyncExternalStore } from "react";
import type { ModalKind, ModalState, ModalStoreApi } from "@/components/kit";

const EMPTY: ModalState = { kind: null };

let state: ModalState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(next: ModalState) {
  // Identity-stable no-op guard (avoids a spurious re-render when nothing changed).
  if (next.kind === state.kind && next.targetId === state.targetId) return;
  state = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ModalState {
  return state;
}

// SSG-safe: the server snapshot is always the empty (closed) state.
function getServerSnapshot(): ModalState {
  return EMPTY;
}

// ── imperative actions (also usable outside React, e.g. from the mutation layer) ───────────────

export const modalActions = {
  openCompose: () => set({ kind: "compose" }),
  openReply: (postId: bigint) => set({ kind: "reply", targetId: String(postId) }),
  openQuote: (postId: bigint) => set({ kind: "quote", targetId: String(postId) }),
  openPoll: () => set({ kind: "poll" }),
  openEditProfile: () => set({ kind: "edit-profile" }),
  close: () => set(EMPTY),
  /** Apply a raw kind/targetId (used by the ModalRouteHost when reconciling the URL on cold load). */
  set: (kind: ModalKind, targetId?: string) => set(kind === null ? EMPTY : { kind, targetId }),
};

/** Subscribe to the modal store from a component. Returns the live state + the action bundle. */
export function useModalStore(): ModalStoreApi {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    state: current,
    openCompose: modalActions.openCompose,
    openReply: modalActions.openReply,
    openQuote: modalActions.openQuote,
    openPoll: modalActions.openPoll,
    openEditProfile: modalActions.openEditProfile,
    close: modalActions.close,
  };
}
