// components/kit.ts — the SHARED TYPE SURFACE for the cogno-chain component kit (doc 03).
//
// This module holds ONLY the view-model / shared-prop types that doc 03's components need beyond
// the data seam in `@/lib/types`. It NEVER redefines a seam type: it re-exports the canonical
// shapes (CognoPost, QuotedRef, ViewerPostState, PollView, PollOptionView, Suggestion, FollowEdges,
// ProfileView, ThreadView, Ss58, TxUpdate/TxPhase) so every component imports them from one place
// and the kit stays welded to the seam.
//
// IMPORTANT mapping note (doc 03 vocabulary → seam reality):
//   doc 03 sketches `PostVM` / `AuthorVM` / `PollVM` with string ids + ISO timestamps. The LIVE
//   seam is `CognoPost` (id: bigint, `at`: blockHeight — NEVER rendered as a time), with the author
//   profile FLATTENED onto the post (`authorDisplayName` / `authorAvatar` / `authorWeight` /
//   `authorRevoked`) rather than a nested AuthorVM, and the poll fetched separately via
//   `source.poll(id)` → `PollView`. Components bind to `CognoPost` / `PollView` DIRECTLY; the only
//   author-shaped helper the kit adds is `AuthorRef` (below), derived from a CognoPost or a
//   QuotedRef, so Avatar / DisplayName / Handle have one tidy input. Do NOT reintroduce PostVM.

import type {
  CognoPost,
  QuotedRef,
  ViewerPostState,
  PollView,
  PollOptionView,
  ProfileView,
  ThreadView,
  Suggestion,
  FollowEdges,
  Ss58,
  TxUpdate,
  TxPhase,
} from "@/lib/types";
import type { ReactNode } from "react";

// ── Re-exports of the seam types the kit binds to (single import site) ───────────────────────
export type {
  CognoPost,
  QuotedRef,
  ViewerPostState,
  PollView,
  PollOptionView,
  ProfileView,
  ThreadView,
  Suggestion,
  FollowEdges,
  Ss58,
  TxUpdate,
  TxPhase,
};

// ── Viewer / session summary (doc 03 §0.2 / §0.4) ────────────────────────────────────────────
// The connected user as the kit consumes it. Derived ONCE in AppShell from useSigner + useIdentity
// (and `deriveSessionState` in @/lib/session) and passed down. Components NEVER compute gate state;
// they read `viewer.status`. `status` is the doc-03 three-state gate; `session` carries the richer
// @/lib/session SessionState for surfaces that need the binding/connecting nuance.

/** The doc-03 gate triad every write affordance branches on (§0.2). */
export type ViewerStatus = "not-connected" | "not-identity-bound" | "ready";

export interface Viewer {
  /** Coarse write-gate state. `not-connected` → route to /welcome; `not-identity-bound` → disable + "Finish setup"; `ready` → act. */
  status: ViewerStatus;
  /** ss58 (prefix 42) of the derived posting account — the @handle source + identicon seed. Undefined until connected. */
  address?: Ss58;
  /** 0x beacon name; undefined until identity-bound. */
  identityHash?: string;
  /** true once link_stake_signed is observed (VotingPower > 0). Gates the "votes carry weight" nudge, never blocks voting. */
  hasVotingPower: boolean;
  /** The viewer's own Profile.display_name (for the composer avatar/name). */
  displayName?: string;
  /** The viewer's own Profile.avatar URL/CID. */
  avatar?: string;
}

/**
 * A minimal author descriptor for Avatar / DisplayName / Handle. Built by the kit's
 * `authorOf(post)` / `authorOfQuote(quoted)` helpers from a CognoPost's flattened author fields
 * or a QuotedRef — there is no nested AuthorVM on the seam.
 */
export interface AuthorRef {
  address: Ss58;
  displayName?: string;
  avatar?: string;
  /** Author identity revoked → render dimmed + "restricted" chip (D10). Never hide. */
  banned: boolean;
}

// ── Optimistic per-action state machine (doc 03 §0.1) ────────────────────────────────────────
// The union every optimistic write control carries. `rate-limited` is the special-cased
// CheckCapacity pool rejection → RateLimitNotice (NOT a generic error toast).
export type ActionState = "idle" | "pending" | "ok" | "error" | "rate-limited";

// ── Avatar / size unions (doc 03 §13, §12, §3) ───────────────────────────────────────────────
/** Named avatar sizes (px resolved from tokens: sm 24 / md 40 / lg 48 / xl 133) or a raw px number. */
export type AvatarSize = "sm" | "md" | "lg" | "xl" | number;
/** Generic control size used by FollowButton / ConnectWalletButton / SearchBar / ByteCounter. */
export type ControlSize = "sm" | "md";

// ── PostCard variants (doc 03 §1) ────────────────────────────────────────────────────────────
export type PostCardVariant = "timeline" | "detail" | "reply" | "thread";

// ── Overflow menu (doc 03 §2.1) ──────────────────────────────────────────────────────────────
export interface OverflowMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** filled/checked state (e.g. "Downvote" active when viewer downvoted). */
  checked?: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

// ── Toaster / Toast (doc 03 §16) ─────────────────────────────────────────────────────────────
export type ToastKind = "success" | "pending" | "error" | "rate-limit" | "info";

export interface ToastSpec {
  id: string;
  kind: ToastKind;
  /** Already-localized copy. */
  message: string;
  action?: { label: string; onClick: () => void };
  /** ms before auto-dismiss; null = sticky (pending). */
  duration?: number | null;
}

/** The imperative toast bus the ToasterProvider exposes (consumed by the mutation layer + components). */
export interface ToastApi {
  /** Raise a toast (id auto-generated when omitted); returns the id. Dedupes by id. */
  toast: (spec: Omit<ToastSpec, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  /** Convenience: the canonical rate-limit toast ("You are over the rate limit. Try again shortly."). */
  rateLimit: () => string;
}

// ── Composer drafts (doc 03 §7, §10, §11) ────────────────────────────────────────────────────
export type ComposerMode = "post" | "reply" | "quote" | "poll";

/** The controlled poll draft (PollComposer §11). 2..=4 options, each ≤ 80 bytes; question reuses 512 B. */
export interface PollDraft {
  question: string;
  options: string[];
}

/** What a Composer hands back on submit; the surface maps it to the right extrinsic in @/lib/chain/mutations. */
export interface ComposerDraft {
  mode: ComposerMode;
  text: string;
  parentId?: bigint;
  quotedId?: bigint;
  pollOptions?: string[];
}

/** Optional pre-flight capacity hint for the Composer CTA (from @/lib/chain/capacity.draftStatus). */
export interface CapacityHint {
  /** false → pre-disable the CTA and show the inline RateLimitNotice before submit. */
  ok: boolean;
  /** Soft "try again in ~N blocks/seconds" when cheaply knowable (no capacity units exposed). */
  retryInSeconds?: number | null;
}

// ── ByteCounter measurement (doc 03 §8) ──────────────────────────────────────────────────────
/** The byte measurement a ByteCounter reports up to its Composer via onMeasure (UTF-8 bytes, never .length). */
export interface ByteMeasure {
  bytes: number;
  remaining: number;
  over: boolean;
}

// ── EmptyState / Skeleton variants (doc 03 §18, §19) ─────────────────────────────────────────
export type EmptyStateVariant =
  | "feed"
  | "search"
  | "search-unavailable"
  | "profile"
  | "replies"
  | "follows"
  | "generic";

export type SkeletonVariant =
  | "post"
  | "profileHeader"
  | "pollCard"
  | "line"
  | "avatar"
  | "thread"
  | "person";

// ── RateLimitNotice (doc 03 §17) ─────────────────────────────────────────────────────────────
export type RateLimitVariant = "inline" | "toast";

// ── Modal-route store (doc 01 §7.2 — the History-API ModalRouteHost) ─────────────────────────
/** Which overlay the ModalRouteHost is showing (null = none). `edit-profile` standalone-falls-back to /settings/. */
export type ModalKind = "compose" | "reply" | "quote" | "poll" | "edit-profile" | null;

export interface ModalState {
  kind: ModalKind;
  /** The reply/quote target post id (string form for the ?reply=/?quote= URL sync), when applicable. */
  targetId?: string;
}

/** The tiny client modal store AppShell mounts once and the action callbacks drive (doc 01 §5.4 / §7.2). */
export interface ModalStoreApi {
  state: ModalState;
  openCompose: () => void;
  openReply: (postId: bigint) => void;
  openQuote: (postId: bigint) => void;
  openPoll: () => void;
  openEditProfile: () => void;
  close: () => void;
}

// ── Shared action-callback bundle (doc 03 §1/§3 — forwarded PostCard → PostCardActions) ───────
// Every list surface (Timeline / ThreadView / ExploreList / ProfileTabs) supplies ONE of these and
// forwards it to each PostCard, which splits it into the per-button props. Centralizing the bundle
// keeps the callback names identical across surfaces.
export interface PostActionCallbacks {
  onOpen: (id: bigint) => void;
  onAuthorOpen: (address: Ss58) => void;
  onReply: (post: CognoPost) => void;
  onQuote: (post: CognoPost) => void;
  /** toggle the heart (UP vote); next=true → like, next=false → clear. */
  onLike: (post: CognoPost, next: boolean) => void;
  /** down-vote (the ▼ in the action row); next=true → downvote, next=false → clear. */
  onDownvote: (post: CognoPost, next: boolean) => void;
  /** copy /post/[id] link → success toast. */
  onShare: (post: CognoPost) => void;
  /** Pin one of YOUR OWN posts to your profile (own-post overflow menu only). Optional: a surface
   *  that doesn't wire it simply shows no pin item. */
  onPin?: (post: CognoPost) => void;
}
