"use client";

// usePoll — fetch a poll's options + stake-weighted tallies (gated on caps.tallies) AND the viewer's
// existing choice, then cast/re-cast the viewer's vote optimistically. Polls NEVER expire (no on-chain
// deadline) — results are live and a re-cast moves the viewer's choice. The optimistic update bumps
// the option count immediately and reloads the true (weighted) tallies + choice on confirm.
//
// Loading the prior choice (`viewerPollChoice`, keyed on the connected `who`) is what lets a poll you
// have ALREADY voted on render its results + a ✓ on reload, instead of re-offering empty radio rows —
// and it blocks a same-option re-click, so the optimistic count no longer transiently double-bumps a
// vote you'd already cast (the chain never double-counts; the UI now matches it).

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "./useMutation";
import { submitPollVote } from "@/lib/chain/mutations";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, PostingSigner, PollView, Ss58 } from "@/lib/types";

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
  /** The CONNECTED viewer's address (gate.address) — NOT the background signer; null when unconnected. */
  who: Ss58 | null,
): UsePoll {
  const { run } = useMutation();
  const [poll, setPoll] = useState<PollView | null>(null);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the poll's options/tallies and the viewer's prior choice together. Only the poll() failure
  // surfaces an error; the choice read fails soft to null (a missing/erroring choice just means "show
  // the radio rows"). `who == null` (unconnected) skips the choice read entirely.
  const load = useCallback(() => {
    if (!source || hostId == null || !source.caps.tallies) {
      setPoll(null);
      setMyChoice(null);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all([
      source.poll(hostId),
      who ? source.viewerPollChoice(hostId, who).catch(() => null) : Promise.resolve(null),
    ])
      .then(([p, choice]) => {
        setPoll(p);
        setMyChoice(choice);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "could not load the poll"))
      .finally(() => setLoading(false));
  }, [source, hostId, who]);

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
