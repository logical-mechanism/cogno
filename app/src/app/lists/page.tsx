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
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { MAX_FEED_MEMBERS } from "@/lib/chain/node-reads";
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

export default function ListsPage() {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower } = useSession();
  const me = viewer.address ?? null;

  const lists = useLocalLists(me);
  const actions = useMemo(() => localListActionsFor(me), [me]);

  const [draftName, setDraftName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The selected list, resolved from the live store each render so a rename/removal is reflected without
  // a second source of truth. Falls back to the first list so the surface is never blank with lists present.
  const selected = useMemo(
    () => lists.find((l) => l.id === selectedId) ?? lists[0] ?? null,
    [lists, selectedId],
  );

  const onCreate = useCallback(() => {
    const id = actions.create(draftName);
    if (id !== null) {
      setSelectedId(id);
      setDraftName("");
    }
  }, [actions, draftName]);

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
          Lists stay on this device — nothing is written to the chain and nobody is labelled. Reading a
          list&apos;s timeline does ask the node for each member&apos;s posts, so &ldquo;private&rdquo;
          means not published, not invisible.
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
                onClick={() => setSelectedId(l.id)}
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
              <h2 className={styles.detailTitle}>{sanitizeInline(selected.name)}</h2>
              <button
                type="button"
                className={styles.danger}
                onClick={() => {
                  actions.remove(selected.id);
                  setSelectedId(null);
                }}
              >
                Delete list
              </button>
            </div>

            {selected.members.length === 0 ? (
              <p className={styles.note}>
                No accounts yet. Add someone from the ··· menu on any post or profile. Up to{" "}
                {MAX_LIST_MEMBERS} accounts per list.
              </p>
            ) : (
              <ul className={styles.members}>
                {selected.members.map((m) => (
                  <li key={m} className={styles.member}>
                    <span className={styles.memberName}>{truncateSs58(m)}</span>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => actions.removeMember(selected.id, m)}
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
                remaining {members.length - MAX_FEED_MEMBERS} are not shown.
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
          hasMore={feed.hasNextPage}
          onLoadMore={feed.loadMore}
          loadingMore={feed.loading}
          paginationCapable={source != null}
          emptyVariant="feed"
          emptyTitle="No posts from this list yet"
          emptyDescription="Nobody in this list has posted."
          emptyAction={{ label: "Explore", onClick: () => router.push("/explore/") }}
        />
      ) : null}
    </>
  );
}
