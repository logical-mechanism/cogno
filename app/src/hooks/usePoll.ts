"use client";

// usePoll — fetch a poll's options + stake-weighted tallies (gated on caps.tallies) and cast/re-cast
// the viewer's vote optimistically. Polls NEVER expire (no on-chain deadline) — results are live and
// a re-cast moves the viewer's choice. The optimistic update bumps the option count immediately and
// reloads true (weighted) tallies on confirm.

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "./useMutation";
import { submitPollVote } from "@/lib/chain/mutations";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, PostingSigner, PollView } from "@/lib/types";

export interface UsePoll {
  poll: PollView | null;
  myChoice: number | null;
  castVote: (option: number) => void;
  loading: boolean;
  error: string | null;
}

export function usePoll(
  source: FeedSource | null,
  hostId: bigint | null,
  api: CognoApi | null,
  signer: PostingSigner | null,
): UsePoll {
  const { run } = useMutation();
  const [poll, setPoll] = useState<PollView | null>(null);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!source || hostId == null || !source.caps.tallies) {
      setPoll(null);
      return;
    }
    setLoading(true);
    setError(null);
    source
      .poll(hostId)
      .then((p) => setPoll(p))
      .catch((e) => setError(e instanceof Error ? e.message : "could not load the poll"))
      .finally(() => setLoading(false));
  }, [source, hostId]);

  useEffect(() => {
    load();
  }, [load]);

  const castVote = useCallback(
    (option: number) => {
      if (!api || !signer || hostId == null) return;
      const prev = myChoice;
      setMyChoice(option);
      // Optimistic: move the count from the previous option to the new one (true weights reload on confirm).
      setPoll((cur) => {
        if (!cur) return cur;
        const options = cur.options.map((o) => {
          let count = o.count;
          if (prev === o.index) count = Math.max(0, count - 1);
          if (option === o.index) count += 1;
          return { ...o, count };
        });
        return { ...cur, options, totalCount: options.reduce((s, o) => s + o.count, 0) };
      });
      void run(submitPollVote(api, signer, hostId, option), {
        onConfirm: () => load(),
        onError: () => {
          setMyChoice(prev);
          load();
        },
      }).catch(() => {});
    },
    [api, signer, hostId, myChoice, run, load],
  );

  return { poll, myChoice, castVote, loading, error };
}
