"use client";

// ListsPage — /lists. The viewer's device-local LISTS of accounts (see lib/localListStore): name a list,
// put accounts in it, read a timeline of just those accounts.
//
// Client-only (localStorage['cg-lists:<account>']). Nothing is written to the chain, no label is applied
// to anyone, and the list never leaves this device.
//
// "PRIVATE" MEANS NOT PUBLISHED — IT DOES NOT MEAN UN-INFERABLE, and the copy below says so. Rendering a
// list's timeline reads each member's posts from the RPC node, so the node sees the membership as a burst
// of author reads. That is the honest limit of a device-local list against a shared reader, and hiding it
// would be the dishonest choice.
//
// The timeline is a fan-out over each member's own author index (nodeMembersFeedPage), one read per
// member, merged newest-first — NOT a filtered firehose, which would chase for hundreds of hops to find a
// handful of accounts. It paginates normally: the merge preserves a monotone id cursor (unlike a ranked
// window, which cannot page — see lib/feed/rank).
//
// Reach: LeftNav "Lists" (desktop/tablet). Not a public route — a shareable/published list is a separate
// decision, since a public list puts a permanent label on third parties who cannot remove themselves.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StickyHeader } from "@/components/AppShell";
import { Timeline } from "@/components/Timeline";
import { useSession } from "@/components/Providers";
import { useFeedPage } from "@/hooks/useFeed";
import { useViewerStates } from "@/hooks/useViewerStates";
import { usePostActions } from "@/hooks/usePostActions";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useFollow } from "@/hooks/useFollow";
import { carriedViewerStates, MAX_FEED_MEMBERS } from "@/lib/chain/node-reads";
import { useToaster } from "@/components/toast/ToasterProvider";
import {
  useLocalLists,
  localListActionsFor,
  isValidListName,
  MAX_LOCAL_LISTS,
  MAX_LIST_MEMBERS,
  MAX_LIST_NAME_BYTES,
} from "@/lib/localListStore";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { sanitizeInline } from "@/lib/sanitize";
import { truncateSs58 } from "@/lib/ss58";
import { utf8Bytes } from "@/lib/bytes";
import type { FeedQuery } from "@/lib/types";
import styles from "./page.module.css";
import { viewerBucket } from "@/lib/viewerBucket";

/** A write that did not reach storage. NOT the message for a refused INPUT — see `onRename`. */
const STORAGE_BLOCKED = "Your browser is blocking storage for this site, so lists can't be saved.";
const NAME_TOO_LONG = `Names are limited to ${MAX_LIST_NAME_BYTES} bytes.`;

export default function ListsPage() {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower } = useSession();
  const me = viewerBucket(viewer);

  const lists = useLocalLists(me);
  const actions = useMemo(() => localListActionsFor(me), [me]);

  const [draftName, setDraftName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Delete is a two-step: the first click arms, the second confirms. A list is device-local and
  // unrecoverable, so an armed button must not stay armed: every other action on this surface —
  // selecting a list, renaming, creating, removing a member — disarms it through `disarm()` below.
  // Leaving it latched was the accident the two-step exists to prevent: arm Delete, remove a member,
  // scroll away, and the next stray tap on a button still reading "Tap again to delete" destroys the list.
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftRename, setDraftRename] = useState("");

  // The selected list, resolved from the live store each render so a rename/removal is reflected without
  // a second source of truth.
  //
  // NO `?? lists[0]` FALLBACK, deliberately: auto-selecting on mount would fire the timeline's fan-out
  // (one read per member, up to MAX_FEED_MEMBERS concurrently) before the reader asked for any list. It
  // also made delete dangerous — the selection silently advanced to the next list, so a second click
  // landed on a list the user never chose.
  const selected = useMemo(
    () => (selectedId === null ? null : lists.find((l) => l.id === selectedId) ?? null),
    [lists, selectedId],
  );

  /** Cancel a pending delete confirmation. Called from every other action on this surface. */
  const disarm = useCallback(() => setArmedDeleteId(null), []);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      disarm();
      setRenaming(false);
    },
    [disarm],
  );

  // `create` already had a return channel and it was read only for validation. It now also reports a
  // write that did not reach storage, which is what the surface has to say out loud: selecting and
  // naming a list that will not be there on the next load is worse than refusing it.
  const [writeError, setWriteError] = useState<string | null>(null);

  const onCreate = useCallback(() => {
    disarm();
    const id = actions.create(draftName);
    if (id !== null) {
      setWriteError(null);
      select(id);
      setDraftName("");
    } else if (isValidListName(draftName)) {
      // The name is fine and the cap is shown separately, so the only remaining reason is storage.
      setWriteError(STORAGE_BLOCKED);
    }
  }, [actions, draftName, select, disarm]);

  const onRemoveMember = useCallback(
    (listId: string, member: string) => {
      disarm();
      setWriteError(actions.removeMember(listId, member) ? null : STORAGE_BLOCKED);
    },
    [actions, disarm],
  );

  // `rename` returns false for TWO different reasons — an invalid name (the store's deliberate "a bad
  // keystroke can't wipe a name" guard) and a write that never reached storage — and this surface has to
  // tell them apart before it says anything. Mapping both to STORAGE_BLOCKED told a user who merely
  // cleared the field that their browser was blocking storage, which is a false statement about their
  // device on a one-keystroke path. An empty name is a silent no-op (the old name stands); an over-long
  // one says which limit it hit; only a refused WRITE claims storage.
  const onRename = useCallback(
    (listId: string, name: string) => {
      setRenaming(false);
      if (!isValidListName(name)) {
        setWriteError(utf8Bytes(name.trim()) > MAX_LIST_NAME_BYTES ? NAME_TOO_LONG : null);
        return;
      }
      setWriteError(actions.rename(listId, name) ? null : STORAGE_BLOCKED);
    },
    [actions],
  );

  // ── the selected list's timeline ────────────────────────────────────────────────────────────────
  const members = useMemo(() => selected?.members ?? [], [selected]);
  // Order-independent CONTENT key. `members` takes a new identity on ANY store commit (the store maps a
  // fresh array), so keying the query on it would refetch this timeline when an unrelated list was renamed.
  const membersKey = useMemo(() => [...members].sort().join(","), [members]);
  const listQuery = useMemo<FeedQuery>(
    // `viewer: me` lets the node stamp the myVote overlay in the same read.
    () => ({ first: FEED_PAGE_SIZE, members, viewer: me ?? undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [membersKey, me],
  );
  const feedEnabled = source != null && members.length > 0;
  const feed = useFeedPage(source, listQuery, feedEnabled);

  const postIds = useMemo(() => feed.posts.map((p) => p.id), [feed.posts]);
  const carriedStates = useMemo(() => carriedViewerStates(feed.posts), [feed.posts]);
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  const follow = useFollow(api, signer, source, me);
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const { toast } = useToaster();
  const handlers = usePostActions({ viewer, viewerStates, vote, pin, toast, follow });

  const atListCap = lists.length >= MAX_LOCAL_LISTS;
  const nameTooLong = utf8Bytes(draftName.trim()) > MAX_LIST_NAME_BYTES;
  const truncatedMembers = members.length > MAX_FEED_MEMBERS;

  return (
    <>
      <StickyHeader showBack title="Lists" />

      <div className={styles.manager}>
        <p className={styles.note}>
          Lists stay on this device. Nothing goes on the chain, and nobody is told they are on one.
          Opening a list asks the node for each account&apos;s posts, so the node can see who you put in
          it. Private here means unpublished, not hidden.
        </p>

        <div className={styles.createRow}>
          <input
            className={styles.input}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCreate();
            }}
            placeholder={atListCap ? "List limit reached" : "New list name"}
            aria-label="New list name"
            disabled={atListCap}
          />
          <button
            type="button"
            className={styles.primary}
            onClick={onCreate}
            disabled={atListCap || !isValidListName(draftName)}
          >
            Create
          </button>
        </div>
        {nameTooLong && (
          <p className={styles.error}>
            Names are limited to {MAX_LIST_NAME_BYTES} bytes.
          </p>
        )}
        {writeError && (
          <p className={styles.error} role="alert">
            {writeError}
          </p>
        )}
        {atListCap && (
          <p className={styles.note}>
            You have the maximum of {MAX_LOCAL_LISTS} lists. Delete one to add another.
          </p>
        )}

        {lists.length > 0 && (
          <div className={styles.chips}>
            {lists.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`${styles.chip} ${selected?.id === l.id ? styles.chipActive : ""}`}
                onClick={() => select(l.id)}
                aria-pressed={selected?.id === l.id}
              >
                {/* Raw name stored; sanitize at RENDER only (never before a byte count or a write). */}
                <span>{sanitizeInline(l.name)}</span>
                <span className={styles.count}>{l.members.length}</span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className={styles.detail}>
            <div className={styles.detailHead}>
              {renaming ? (
                <input
                  className={styles.input}
                  value={draftRename}
                  autoFocus
                  aria-label="Rename list"
                  onChange={(e) => setDraftRename(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRename(selected.id, draftRename);
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  onBlur={() => onRename(selected.id, draftRename)}
                />
              ) : (
                <h2 className={styles.detailTitle}>{sanitizeInline(selected.name)}</h2>
              )}
              {!renaming && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => {
                    setDraftRename(selected.name);
                    setRenaming(true);
                    disarm();
                  }}
                >
                  Rename
                </button>
              )}
              {/* Two-step: arm, then confirm. Deleting a device-local list cannot be undone. */}
              <button
                type="button"
                className={styles.danger}
                onClick={() => {
                  if (armedDeleteId === selected.id) {
                    setWriteError(actions.remove(selected.id) ? null : STORAGE_BLOCKED);
                    setSelectedId(null);
                    setArmedDeleteId(null);
                  } else {
                    setArmedDeleteId(selected.id);
                  }
                }}
              >
                {armedDeleteId === selected.id ? "Tap again to delete" : "Delete list"}
              </button>
            </div>

            {selected.members.length === 0 ? (
              <p className={styles.note}>
                No accounts yet. Open the ··· menu on any post by someone else and choose &ldquo;Add to{" "}
                {sanitizeInline(selected.name)}&rdquo;. Up to {MAX_LIST_MEMBERS} accounts per list.
              </p>
            ) : (
              <ul className={styles.members}>
                {selected.members.map((m) => (
                  <li key={m} className={styles.member}>
                    <span className={styles.memberName}>{truncateSs58(m)}</span>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => onRemoveMember(selected.id, m)}
                      aria-label={`Remove ${truncateSs58(m)} from ${sanitizeInline(selected.name)}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {truncatedMembers && (
              <p className={styles.note}>
                This timeline reads the first {MAX_FEED_MEMBERS} accounts in the list. Posts from the
                other {members.length - MAX_FEED_MEMBERS} are not shown.
              </p>
            )}
          </div>
        )}
      </div>

      {selected && selected.members.length > 0 ? (
        <Timeline
          posts={feed.posts}
          gate={viewer}
          viewerStates={viewerStates}
          handlers={handlers}
          loading={feed.loading && feed.posts.length === 0}
          error={feed.error}
          // A failed member read raises on the FIRST page rather than rendering a hole (see
          // nodeMembersFeedPage), so the error row needs a way back — without this the only recovery
          // would be switching lists and back. `reload`, NOT `refresh`: refresh sets no loading flag and
          // swallows its rejection, so on a read that keeps failing the button would look inert.
          onRetry={feed.reload}
          hasMore={feed.hasNextPage}
          onLoadMore={feed.loadMore}
          loadingMore={feed.loading}
          lastPage={feed.page?.posts ?? null}
          paginationCapable={source != null}
          emptyVariant="feed"
          emptyTitle="No posts from this list yet"
          // Scope-accurate: the fan-out reads each member's TOP-LEVEL index (replies excluded), and only
          // the first MAX_FEED_MEMBERS of them. "Nobody has posted" would claim more than was read.
          emptyDescription={
            truncatedMembers
              ? `No posts from the first ${MAX_FEED_MEMBERS} accounts in this list. Replies are not shown here.`
              : "No posts from these accounts. Replies are not shown here."
          }
          emptyAction={{ label: "Explore", onClick: () => router.push("/explore/") }}
        />
      ) : null}
    </>
  );
}
