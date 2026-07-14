"use client";

// FollowsPanel — the full-screen Followers / Following sub-view of a profile (reached by tapping a
// follow count; the profile surface syncs it to ?follows=followers|following). A StickyHeader (back +
// the account's name / @handle + a Followers | Following tab strip) over FollowsList.
//
// The follow graph is read ONCE via source.followEdges(address); switching sides just re-slices the
// already-fetched edges (no refetch). Only reachable through the follow counts, which the profile
// omits when the graph can't be read — so this never surfaces without data behind it.

import { useEffect, useState } from "react";
import styles from "./FollowsPanel.module.css";
import { StickyHeader } from "@/components/AppShell";
import { Tabs } from "@/components/ui/Tabs";
import { FollowsList } from "./FollowsList";
import { handleOf } from "@/lib/ss58";
import type { FeedSource } from "@/lib/feed/source";
import { readErrorCopy } from "@/lib/chain/errors";
import type { Ss58, Viewer } from "@/components/kit";

export type FollowsSide = "followers" | "following";

const GROUP = new Intl.NumberFormat("en-US");

export interface FollowsPanelProps {
  address: Ss58;
  /** The account's display name (already resolved by the profile surface) for the header title. */
  name: string;
  side: FollowsSide;
  followerCount: number;
  followingCount: number;
  source: FeedSource | null;
  viewer: Viewer;
  isFollowing: (target: string) => boolean;
  onToggleFollow: (target: string, next: boolean) => void;
  /** Switch the active side (the surface mirrors it to ?follows= without stacking history). */
  onSwitch: (side: FollowsSide) => void;
}

export function FollowsPanel({
  address,
  name,
  side,
  followerCount,
  followingCount,
  source,
  viewer,
  isFollowing,
  onToggleFollow,
  onSwitch,
}: FollowsPanelProps) {
  const [edges, setEdges] = useState<{ followers: Ss58[]; following: Ss58[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!source) return; // wait for the reader
    let cancelled = false;
    setLoading(true);
    setError(null);
    source
      .followEdges(address)
      .then((e) => {
        if (cancelled) return;
        setEdges({ followers: e.followers, following: e.following });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(readErrorCopy(err, "Couldn't load this list."));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, address, nonce]);

  const people = side === "followers" ? (edges?.followers ?? []) : (edges?.following ?? []);
  const handle = handleOf(address);
  const isSelf = viewer.address != null && viewer.address === address;
  const emptyTitle =
    side === "followers"
      ? isSelf
        ? "You have no followers yet."
        : `${handle} has no followers yet.`
      : isSelf
        ? "You aren't following anyone yet."
        : `${handle} isn't following anyone yet.`;

  const tabs: { id: FollowsSide; label: string; count: number }[] = [
    { id: "followers", label: "Followers", count: followerCount },
    { id: "following", label: "Following", count: followingCount },
  ];


  return (
    <>
      <StickyHeader
        showBack
        title={name}
        // Omit the subtitle when there's no set display name (name falls back to the handle) — else the
        // header would show the same @handle twice.
        subtitle={name !== handle ? handle : undefined}
        tabs={
          <Tabs
            tabs={tabs.map((t) => ({
              id: t.id,
              // A ReactNode label, so the count keeps its own class from THIS module — which is what lets
              // the `[data-active] .count` rule below still reach it after the strip moved to ui/Tabs.
              label: (
                <>
                  {t.label} <span className={styles.count}>{GROUP.format(t.count)}</span>
                </>
              ),
            }))}
            active={side}
            onChange={onSwitch}
            idPrefix="cg-follows-tab"
            panelId="cg-follows-panel"
            ariaLabel="Followers and following"
          />
        }
      />

      <div id="cg-follows-panel" role="tabpanel" aria-labelledby={`cg-follows-tab-${side}`}>
        <FollowsList
          people={people}
          viewer={viewer}
          loading={loading && !edges}
          error={error}
          onRetry={() => setNonce((n) => n + 1)}
          emptyTitle={emptyTitle}
          isFollowing={isFollowing}
          onToggleFollow={onToggleFollow}
        />
      </div>
    </>
  );
}
