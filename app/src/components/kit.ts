// components/kit.ts — the SHARED TYPE SURFACE for the cogno-chain component kit.
//
// This module holds ONLY the view-model / shared-prop types the components need beyond the data
// seam in `@/lib/types`. It NEVER redefines a seam type: it re-exports the canonical shapes
// (CognoPost, QuotedRef, ViewerPostState, PollView, PollOptionView, Suggestion, FollowEdges,
// ProfileView, ThreadView, Ss58, TxUpdate/TxPhase) so every component imports them from one place
// and the kit stays welded to the seam.
//
// Components bind to `CognoPost` / `PollView` DIRECTLY — there is no separate view-model layer. A
// post is `id: bigint` + `at: blockHeight` (NEVER rendered as a time), with the author profile
// FLATTENED onto it (`authorDisplayName` / `authorAvatar` / `authorWeight` / `authorRevoked`) rather
// than nested, and the poll fetched separately via `source.poll(id)` → `PollView`. The only
// author-shaped helper the kit adds is `AuthorRef` (below), derived from a CognoPost or a QuotedRef,
// so Avatar / DisplayName / Handle have one tidy input.

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

// ── Re-exports of the seam types the kit binds to (single import site) ───────────────────────────
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

// ── Viewer / session summary ─────────────────────────────────────────────────────────────────────
// The connected user as the kit consumes it. Derived ONCE in AppShell from useSigner + useIdentity
// (and `deriveSessionState` in @/lib/session) and passed down. Components NEVER compute gate state;
// they read `viewer.status`. `status` is the three-state gate; `session` carries the richer
// @/lib/session SessionState for surfaces that need the binding/connecting nuance.

/** The gate triad every write affordance branches on. */
export type ViewerStatus = "not-connected" | "not-identity-bound" | "ready";

export interface Viewer {
  /** Coarse READ/entry-gate state. `not-connected` → route to /welcome; `not-identity-bound` → disable + "Finish setup"; `ready` → identity-bound (may browse). */
  status: ViewerStatus;
  /** ss58 (prefix 42) of the derived posting account — the @handle source + identicon seed. Undefined until connected. */
  address?: Ss58;
  /** 0x beacon name; undefined until identity-bound. */
  identityHash?: string;
  /** The viewer's own Profile.display_name (for the composer avatar/name). */
  displayName?: string;
  /** The viewer's own Profile.avatar URL/CID. */
  avatar?: string;
  /**
   * The single authoritative WRITE gate: all required onboarding is complete → may post/vote/follow/
   * poll/edit-profile. True only when identity-bound AND stake-bound AND posting power (locked-ADA
   * weight) > 0. `status === "ready"` gates browsing/entry; `writeReady` gates every write. False while
   * any of bind / stake / lock is missing OR still loading — a `!writeReady` write intent routes to
   * /welcome to finish setup (reading stays open). Note stake is a MANDATORY onboarding step, so a
   * bound, locked, but never-stake-bound account is intentionally not writeReady.
   */
  writeReady: boolean;
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

// ── Optimistic per-action state machine ──────────────────────────────────────────────────────────
// The union every optimistic write control carries. `rate-limited` is the special-cased
// CheckCapacity pool rejection → RateLimitNotice (NOT a generic error toast).
export type ActionState = "idle" | "pending" | "ok" | "error" | "rate-limited";

// ── Avatar / size unions ─────────────────────────────────────────────────────────────────────────
/** Named avatar sizes (px resolved from tokens: sm 24 / md 40 / lg 48 / xl 133) or a raw px number. */
export type AvatarSize = "sm" | "md" | "lg" | "xl" | number;
/** Generic control size used by FollowButton / ConnectWalletButton / SearchBar / ByteCounter. */
export type ControlSize = "sm" | "md";

// ── PostCard variants ────────────────────────────────────────────────────────────────────────────
export type PostCardVariant = "timeline" | "detail" | "reply" | "thread";

// ── Overflow menu ────────────────────────────────────────────────────────────────────────────────
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

// ── Toaster / Toast ──────────────────────────────────────────────────────────────────────────────
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
  /** Convenience: the canonical rate-limit toast (copy from `errorCopy({ kind: "rate-limit" })`). */
  rateLimit: () => string;
}

// ── Composer drafts ──────────────────────────────────────────────────────────────────────────────
export type ComposerMode = "post" | "reply" | "quote" | "poll";

/** The controlled poll draft (PollComposer). 2..=4 options, each ≤ 80 bytes; question reuses 512 B. */
export interface PollDraft {
  question: string;
  options: string[];
  /**
   * Optional close deadline in DAYS (spec 205). `undefined` / `0` ⇒ the poll floats forever (no
   * deadline). The surface converts this to a block-number `close_at` at submit time (`bestBlock +
   * days × blocks-per-day`).
   */
  closeInDays?: number;
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

// ── ByteCounter measurement ──────────────────────────────────────────────────────────────────────
/** Re-exported from the pure measure in @/lib/bytes (UTF-8 bytes, never .length; `over` is strictly-over). */
export type { ByteMeasure } from "@/lib/bytes";

// ── EmptyState / Skeleton variants ───────────────────────────────────────────────────────────────
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

// ── RateLimitNotice ──────────────────────────────────────────────────────────────────────────────
export type RateLimitVariant = "inline" | "toast";

// ── Modal-route store (the History-API ModalRouteHost) ───────────────────────────────────────────
/** Which overlay the ModalRouteHost is showing (null = none). `edit-profile` standalone-falls-back to /settings/. */
export type ModalKind = "compose" | "reply" | "quote" | "poll" | "edit-profile" | null;

export interface ModalState {
  kind: ModalKind;
  /** The reply/quote target post id (string form for the ?reply=/?quote= URL sync), when applicable. */
  targetId?: string;
}

/** The tiny client modal store AppShell mounts once and the action callbacks drive. */
export interface ModalStoreApi {
  state: ModalState;
  openCompose: () => void;
  openReply: (postId: bigint) => void;
  openQuote: (postId: bigint) => void;
  openPoll: () => void;
  openEditProfile: () => void;
  close: () => void;
}

// ── Shared action-callback bundle (forwarded PostCard → PostCardActions) ─────────────────────────
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
  /** Is the viewer following `target`? Supplied (with onToggleFollow) by surfaces that wire the shared
   *  useFollow, so the ··· menu can show Follow/Unfollow. Omitted → no follow item. */
  isFollowing?: (target: Ss58) => boolean;
  /** Follow/unfollow the post author from the ··· menu (a chain write; gated on writeReady). */
  onToggleFollow?: (target: Ss58, next: boolean) => void;
}
