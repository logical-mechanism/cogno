"use client";

// PostCard — the load-bearing unit: one post in any list context.
//
// Composes PostCardHeader + an optional "Replying to" line + PostBody + an optional QuotedPostEmbed
// OR InlinePoll + PostCardActions. Carries the optimistic-pending rendering (opacity 0.6, actions
// disabled, no row nav) and the banned/authorRevoked dimming (D10 — content STAYS, we dim + chip,
// never hide). Clicking anywhere on the row (outside an interactive child) navigates to /post/[id]/
// via an X-style overlay <a> covering the non-interactive area, so the whole card is a real link
// without nesting buttons inside an anchor; every inner control stopPropagation()s so it doesn't
// trigger the row link.
//
// TIME (D11): CognoPost.at is a block height, never a wall-clock timestamp; PostCardHeader surfaces
// only a relative age from it via <PostTime> (e.g. "· 2h"), never the raw block number.
// The up/down weight breakdown is NOT rendered here (detail-only, D2/D12) — the net score is.
//
// Presentational + optimistic. It NEVER imports a reader and NEVER builds an extrinsic — every write
// is a callback (the PostActionCallbacks bundle) supplied by the surface, optimistically overridden.

import { useCallback, useMemo, useState } from "react";
import styles from "./PostCard.module.css";
import { PostCardHeader } from "./PostCardHeader";
import { PostBody } from "./PostBody";
import { QuotedPostEmbed } from "./QuotedPostEmbed";
import { InlinePoll } from "./InlinePoll";
import { PostCardActions } from "./PostCardActions";
import { Spinner } from "./icons";
import { handleOf } from "@/lib/ss58";
import { useMuted, muteActionsFor } from "@/lib/muteStore";
import { useBlocked, blockActionsFor } from "@/lib/blockStore";
import { useHidden, hiddenActionsFor, MAX_HIDDEN } from "@/lib/hiddenStore";
import { useBookmarked, bookmarkActionsFor, MAX_BOOKMARKS } from "@/lib/bookmarkStore";
import { useLocalLists, localListActionsFor, MAX_LIST_MEMBERS } from "@/lib/localListStore";
import { sanitizeInline } from "@/lib/sanitize";
import { viewerBucket } from "@/lib/viewerBucket";
import { postLink } from "@/lib/share";
import { ABUSE_EMAIL, reportMailto } from "@/lib/config/operator";
import { isDenied } from "@/lib/config/denylist";
import { useToaster } from "./toast/ToasterProvider";
import type {
  CognoPost,
  ViewerPostState,
  Viewer,
  AuthorRef,
  OverflowMenuItem,
  PostActionCallbacks,
  PostCardVariant,
} from "./kit";

export interface PostCardProps {
  /** The post. */
  post: CognoPost;
  /** The viewer's relationship to this post — drives the filled up-vote / poll choice. */
  viewer: ViewerPostState;
  /** Coarse write-gate state — supplied by AppShell, never computed here. */
  gate: Viewer;
  /** The shared callback bundle every list surface forwards (open / author / reply / quote / like / …). */
  handlers: PostActionCallbacks;
  /** dense timeline row / focused detail / threaded reply. */
  variant?: PostCardVariant;
  /** This card is an optimistic, not-yet-confirmed post → renders at opacity 0.6, actions disabled. */
  pending?: boolean;
  /** Draw the connecting vertical thread line (reply/thread context). */
  showThreadLine?: boolean;
  /** Surface-specific header slot (e.g. a "Pinned" marker on a profile). */
  headerExtra?: React.ReactNode;
  /** Search term to <mark> in the body (set only on search-result surfaces). */
  highlight?: string;
}

/** Build the minimal author descriptor the header/embed need from a CognoPost's flattened fields. */
function authorOf(post: CognoPost): AuthorRef {
  return {
    address: post.author,
    displayName: post.authorDisplayName,
    avatar: post.authorAvatar,
    banned: post.authorRevoked === true,
    roles: post.authorRoles,
  };
}

export function PostCard({
  post,
  viewer,
  gate,
  handlers,
  variant = "timeline",
  pending,
  showThreadLine,
  headerExtra,
  highlight,
}: PostCardProps) {
  const author = useMemo(() => authorOf(post), [post]);
  const dim = post.authorRevoked === true;
  const detail = variant === "detail";
  const isReply = post.parent != null;
  // The detail (focal) card is the post you're already on → not a self-opening link; pending cards
  // aren't navigable yet. Everything else is a clickable row.
  const clickable = !pending && !detail;

  // The WHOLE card opens the post: any click that isn't on an interactive child (button / link /
  // input) and isn't a text selection navigates. Replaces the old inset overlay button, which sat
  // under the content and only caught the thin padding → users couldn't tell the card was clickable.
  const onCardClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a,button,input,textarea,select,label,[role='button']")) {
        return;
      }
      if (window.getSelection()?.toString()) return; // don't hijack a text selection
      handlers.onOpen(post.id);
    },
    [handlers, post.id],
  );

  const onCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return; // only when the card itself is focused
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handlers.onOpen(post.id);
      }
    },
    [handlers, post.id],
  );

  // The "···" overflow menu now carries exactly one owner-only action: "Pin to profile" (the rest —
  // down-vote, clear-vote, copy-link — are buttons in the action row). Shown only on YOUR OWN, already
  // posted (non-pending) posts, and only when the surface wired onPin. Unpin lives in Settings → Profile.
  const isOwnPost =
    gate.status === "ready" && gate.address != null && gate.address === post.author;
  // Bookmarks + mutes are device-local but scoped PER ACCOUNT (null = the signed-out bucket), so a
  // shared device never shows one wallet's saved posts or mute list to the next. `viewerBucket`, NOT a
  // `status === "ready"` ternary: the two disagree for the whole window before the CIP-8 bind resolves,
  // and this card would then write `cg-blocked:anon` while every other surface reads `cg-blocked:<ss58>`.
  const me = viewerBucket(gate);
  // Client-local mute (device-only, no chain state): collapse another account's posts everywhere.
  const muted = useMuted(post.author, me);
  // Client-local block (device-only): HARD-suppress the author — a stub here, removed from every list.
  const blocked = useBlocked(post.author, me);
  // Client-local hide (device-only): drop THIS one post from every list (still reachable by permalink).
  const hidden = useHidden(post.id, me);
  // Client-local bookmark (device-only, no chain state): save any post to the /bookmarks shortlist.
  const bookmarked = useBookmarked(post.id, me);
  // The viewer's device-local lists — drives the "Add to <list>" rows in the ··· menu.
  const localLists = useLocalLists(me);
  // Bookmarking lives only in the ··· menu (which closes on select) → toast so the save is confirmed,
  // mirroring the "Link copied" feedback on the sibling copy-link action.
  const { toast } = useToaster();
  const [revealed, setRevealed] = useState(false);
  // Every ··· action here is a device-local WRITE, and every one of them used to paint its success toast
  // unconditionally on top of a store that swallowed its own storage throw. "Saved to bookmarks" over a
  // save that did not happen is worse than no feedback at all: the reader stops looking for the post.
  // The store layer now returns whether the write landed; this turns a false into an error toast.
  const confirm = useCallback(
    (ok: boolean, success: { kind: "success" | "info"; message: string }, failure: string) => {
      toast(ok ? success : { kind: "error", message: failure });
    },
    [toast],
  );
  const menuItems = useMemo<OverflowMenuItem[] | undefined>(() => {
    if (pending) return undefined;
    const items: OverflowMenuItem[] = [];
    if (isOwnPost && handlers.onPin) {
      items.push({ id: "pin", label: "Pin to profile", onSelect: () => handlers.onPin!(post) });
    }
    // Bookmark is available on EVERY post (your own included) — a personal, device-local save.
    items.push({
      id: "bookmark",
      label: bookmarked ? "Remove bookmark" : "Bookmark",
      onSelect: () => {
        const ok = bookmarkActionsFor(me).toggle(post.id);
        confirm(
          ok,
          bookmarked
            ? { kind: "info", message: "Removed from bookmarks" }
            : { kind: "success", message: "Saved to bookmarks" },
          bookmarked
            ? "Couldn't remove that bookmark. Your browser is blocking storage for this site."
            : `Couldn't save that bookmark. You may be at the ${MAX_BOOKMARKS} bookmark limit, or your browser is blocking storage for this site.`,
        );
      },
    });
    if (!isOwnPost) {
      const handle = handleOf(post.author);
      // Follow / unfollow the author — a CHAIN write, so it's wired through the shared handlers bundle
      // (one useFollow per surface, not per card). Shown only where the surface supplies it.
      if (handlers.onToggleFollow && handlers.isFollowing) {
        const following = handlers.isFollowing(post.author);
        items.push({
          id: "follow",
          label: following ? `Unfollow ${handle}` : `Follow ${handle}`,
          onSelect: () => handlers.onToggleFollow!(post.author, !following),
        });
      }
      // Add/remove the author on a device-local list (lib/localListStore). One row per list the viewer
      // already has — a viewer with no lists sees nothing here and creates one on /lists first (reachable
      // from the left rail), which is also where the empty state points. A full list shows its row
      // DISABLED rather than silently no-op'ing the tap.
      for (const list of localLists) {
        const inList = list.members.includes(post.author);
        const name = sanitizeInline(list.name);
        items.push({
          id: `list-${list.id}`,
          label: inList ? `Remove from ${name}` : `Add to ${name}`,
          disabled: !inList && list.members.length >= MAX_LIST_MEMBERS,
          onSelect: () => {
            const ok = localListActionsFor(me).toggleMember(list.id, post.author);
            confirm(
              ok,
              inList
                ? { kind: "info", message: `Removed from ${name}` }
                : { kind: "success", message: `Added to ${name}` },
              `Couldn't update ${name}. Your browser is blocking storage for this site.`,
            );
          },
        });
      }
      // Hide THIS post (device-local): a "not this one" dismissal, undoable here or in Settings.
      items.push({
        id: "hide",
        label: hidden ? "Unhide post" : "Hide post",
        onSelect: () => {
          const ok = hiddenActionsFor(me).toggle(post.id);
          confirm(
            ok,
            hidden
              ? { kind: "info", message: "Post unhidden" }
              : { kind: "success", message: "Post hidden" },
            hidden
              ? "Couldn't unhide that post. Your browser is blocking storage for this site."
              : `Couldn't hide that post. You may be at the ${MAX_HIDDEN} hidden-post limit, or your browser is blocking storage for this site.`,
          );
        },
      });
      items.push({
        id: "mute",
        label: muted ? `Unmute ${handle}` : `Mute ${handle}`,
        onSelect: () => muteActionsFor(me).toggle(post.author),
      });
      // Block (device-local hard suppression).
      items.push({
        id: "block",
        label: blocked ? `Unblock ${handle}` : `Block ${handle}`,
        danger: !blocked,
        onSelect: () => {
          const ok = blockActionsFor(me).toggle(post.author);
          confirm(
            ok,
            blocked
              ? { kind: "info", message: `Unblocked ${handle}` }
              : { kind: "success", message: `Blocked ${handle}` },
            // The sharpest one in the menu: a block that silently did not save keeps showing the
            // account the reader just decided never to see again.
            `Couldn't ${blocked ? "unblock" : "block"} ${handle}. Your browser is blocking storage for this site.`,
          );
        },
      });
      // Report — the escalation to a HUMAN, and the only item in this menu that reaches anyone but the
      // viewer. It goes last because it is the heaviest, not because it is the most dangerous.
      //
      // A mailto:, not a form and not a chain write. The deployed CSP sets `form-action 'none'`
      // (deploy/nginx/security-headers.conf), so a POSTing form would work under `next dev` and fail
      // silently in production; and there is no report extrinsic, because on-chain moderation is out of
      // scope by design. The permalink is pre-filled from `postLink`, since the link is the one thing a
      // report is useless without and the one thing that is annoying to fetch by hand.
      //
      // location.assign rather than an <a>: menu items are DATA (OverflowMenuItem), so there is no
      // element here to hang an href on, and the menu's roving-focus/Esc handling keys off
      // [role^="menuitem"] buttons. A blocked mail handler leaves the page untouched, so the toast is
      // fired first and names the address rather than claiming a mail client opened.
      items.push({
        id: "report",
        label: "Report post",
        onSelect: () => {
          toast({ kind: "info", message: `Opening a report to ${ABUSE_EMAIL}` });
          window.location.assign(reportMailto(`Report: post ${post.id}`, postLink(post.id)));
        },
      });
    }
    return items.length > 0 ? items : undefined;
  }, [pending, isOwnPost, handlers, post, muted, blocked, hidden, bookmarked, localLists, toast, confirm, me]);

  // On the operator's serve denylist. Lists and the reader itself already strip these, so this only
  // fires where a card is rendered DIRECTLY: a permalink to a delisted post, or a thread whose focal
  // post is one (the source deliberately does not drop a thread root, because there is no shape for
  // "the post you asked for is gone" and returning somebody else's reply as the root would be worse).
  //
  // Checked FIRST, ahead of block and mute, because it is not the viewer's decision and there is no
  // affordance to undo it. The copy says what is true — this site is not showing it — and does not
  // claim the post does not exist, because it does, in every block, on every node.
  if (isDenied(post) && !pending) {
    return (
      <article
        className={[styles.card, styles[variant], styles.mutedRow, showThreadLine ? styles.threadLine : ""]
          .filter(Boolean)
          .join(" ")}
        data-post-id={String(post.id)}
      >
        <div className={styles.mutedStub}>
          <span className={styles.mutedText}>This post is not available on this site.</span>
        </div>
      </article>
    );
  }

  // A blocked author is a HARD suppression: lists strip the post before it reaches here (useModeration),
  // so this branch only fires where a card is rendered directly — the detail focal / a permalink. No
  // "Show" (that is mute); the only way back is Unblock. Block wins over mute when both are set.
  if (blocked && !isOwnPost && !pending) {
    return (
      <article
        className={[styles.card, styles[variant], styles.mutedRow, showThreadLine ? styles.threadLine : ""]
          .filter(Boolean)
          .join(" ")}
        data-post-id={String(post.id)}
      >
        <div className={styles.mutedStub}>
          <span className={styles.mutedText}>You&apos;ve blocked this account</span>
          <button
            type="button"
            className={styles.mutedShow}
            onClick={() => blockActionsFor(me).unblock(post.author)}
          >
            Unblock
          </button>
        </div>
      </article>
    );
  }

  // A muted author's post collapses to a "Show" stub everywhere EXCEPT the detail focal (you opened it
  // on purpose). Revealing is local + reversible; the full card keeps its "Unmute" in the ··· menu.
  const collapsed = muted && !detail && !isOwnPost && !pending && !revealed;
  if (collapsed) {
    return (
      <article
        className={[styles.card, styles[variant], styles.mutedRow, showThreadLine ? styles.threadLine : ""]
          .filter(Boolean)
          .join(" ")}
        data-post-id={String(post.id)}
      >
        <div className={styles.mutedStub}>
          <span className={styles.mutedText}>Post from a muted account</span>
          <button type="button" className={styles.mutedShow} onClick={() => setRevealed(true)}>
            Show
          </button>
        </div>
      </article>
    );
  }

  const cls = [
    styles.card,
    styles[variant],
    pending ? styles.pending : "",
    dim ? styles.dimmed : "",
    showThreadLine ? styles.threadLine : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={cls}
      data-post-id={String(post.id)}
      aria-busy={pending || undefined}
      role={clickable ? "link" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? "Open post" : undefined}
      onClick={clickable ? onCardClick : undefined}
      onKeyDown={clickable ? onCardKeyDown : undefined}
    >
      <div className={styles.inner}>
        <PostCardHeader
          author={author}
          at={post.at}
          menuItems={menuItems}
          onAuthorOpen={handlers.onAuthorOpen}
          detail={detail}
          headerExtra={
            <>
              {headerExtra}
              {pending && (
                <span className={styles.pendingMark}>
                  <Spinner size="sm" label="Posting" />
                </span>
              )}
            </>
          }
        />

        <div className={styles.column}>
          {isReply && variant !== "thread" && (
            <p className={styles.replyContext}>
              Replying to{" "}
              <button
                type="button"
                className={styles.replyTarget}
                // parent is a post id, not an account — link to the parent post (not a fake @handle).
                onClick={(e) => {
                  e.stopPropagation();
                  if (post.parent != null) handlers.onOpen(post.parent);
                }}
              >
                a post
              </button>
            </p>
          )}

          <PostBody text={post.text} size={detail ? "lg" : "base"} dim={dim} highlight={highlight} />

          {post.quote && (
            <QuotedPostEmbed
              quoted={post.quote}
              onOpen={handlers.onOpen}
              isPoll={false}
              viewerId={me}
            />
          )}

          {/* InlinePoll is the SOLE poll owner. This used to be a ternary between a surface-supplied
              poll and a self-fetching InlinePoll — and because the surface's read starts at null, the
              first render ALWAYS took the InlinePoll branch, then flipped once the read landed. Two
              usePoll instances per card, and the second one's optimistic cast died with it. */}
          {post.isPoll && !pending && <InlinePoll postId={post.id} gate={gate} detail={detail} />}

          <PostCardActions
            post={post}
            viewer={viewer}
            gate={gate}
            onReply={handlers.onReply}
            onQuote={handlers.onQuote}
            onLike={handlers.onLike}
            onDownvote={handlers.onDownvote}
            onCopyLink={handlers.onShare}
            dense={detail ? false : undefined}
          />
        </div>
      </div>
    </article>
  );
}
