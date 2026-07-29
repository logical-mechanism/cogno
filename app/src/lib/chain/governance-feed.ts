// governance-feed.ts — enumerate the chain's GOVERNANCE polls (action-tagged) for the /governance
// discovery surface, so they don't drown in a busy timeline.
//
// There is no on-chain index of "governance polls", so we scan the `Polls` map and keep the ones carrying a
// gov-action tag. That is O(all polls) — fine at preprod cardinality (capped below); a node API / indexer
// would replace it at scale. Each summary carries only what the LIST needs (question + action type + close
// state) — the per-chamber tally is read lazily by the PollCard when the poll is opened.

import { Binary } from "polkadot-api";
import type { CognoApi, GovActionType } from "@/lib/types";
import type { RoleKindType } from "@/lib/chain/roles";
import { isDeniedAuthor, isDeniedPost } from "@/lib/config/denylist";
import { sanitizeInline } from "@/lib/sanitize";
import { actionBodies } from "@/lib/cardano/governance";

/** Read at the best block (near-real-time) — a just-created poll should surface without waiting for finality. */
const BEST = { at: "best" } as const;
/** Defensive cap on the full-map scan (preprod has few governance polls). */
const MAX_SCAN = 200;

/** `GovActionType` discriminant (u8, `#[codec(index)]`) → the app union, for the numeric decode fallback. */
const GOV_ACTION_BY_IX: readonly GovActionType[] = [
  "Info",
  "NoConfidence",
  "UpdateCommittee",
  "NewConstitution",
  "HardFork",
  "ParamChange",
  "TreasuryWithdrawal",
];

/** The stored `action_type` decodes as an enum `{ type }`; tolerate a bare u8 too. */
function actionTypeOf(raw: unknown): GovActionType {
  if (raw && typeof raw === "object" && "type" in raw) {
    return (raw as { type: GovActionType }).type;
  }
  if (typeof raw === "number") return GOV_ACTION_BY_IX[raw] ?? "Info";
  return "Info";
}

/** Decode the GovAction's `anchor_url` (a `Binary`) into a plain string, length-capped, or `undefined`.
 *  NOT sanitized for display — it is used only as a URL (parsed/validated in `proposalMeta`), never rendered. */
function decodeAnchor(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw.slice(0, 2048) || undefined;
  try {
    // The on-chain anchor is a `Binary` (BoundedVec<u8>) — decode it the same way this file decodes the
    // post text. Cast via the fn's own parameter type (`Binary` is a value here, not a usable type name);
    // a non-Binary shape throws and falls through to `undefined`.
    const s = Binary.toText(raw as Parameters<typeof Binary.toText>[0]);
    return s ? s.slice(0, 2048) || undefined : undefined; // defensive cap on an author-provided URL
  } catch {
    return undefined;
  }
}

/** A governance poll as the discovery list needs it (no tally — that loads when the poll is opened). */
export interface GovPollSummary {
  hostId: bigint;
  actionType: GovActionType;
  /** The host post's text (the question), sanitized + truncated. Kept as data; the feed row shows the
   *  resolved proposal title instead. */
  question: string;
  /** The CIP-1694 proposal's off-chain anchor URL (decoded, length-capped), for the glanceable title. */
  anchorUrl?: string;
  /**
   * blake2b-256 of the document the poll was created from, when its author pinned one. Carried here so
   * the LIST can check it too: without it the row would render a fetched title with no way to tell that
   * the document behind it had been swapped, which is the one surface where that matters most (a reader
   * scans dozens of rows and opens none). `anchor_hash: Option<[u8;32]>` decodes as a `0x…` hex string.
   */
  anchorHash?: string;
  /** Block-number deadline, or undefined for a floating poll. */
  closeAt?: number;
  /** `true` once `close_poll` has frozen the result. */
  finalized: boolean;
  /**
   * DIRECT replies to the host post (the runtime's `ReplyCount` aggregate, which is per-parent, not
   * thread size). Drives the "most discussed" order. 0 for a poll whose host is denylisted, so a
   * delisted thread cannot ride real engagement to the top of the list under a blank title.
   */
  replyCount: number;
}

/**
 * All governance (action-tagged) polls on chain, newest first. Never throws — a read failure yields `[]`.
 * The `Polls` map is scanned and filtered to entries carrying an `action`; each poll's question is the host
 * post's text (`Posts.getValue`), and `finalized` comes from the `PollResults` map.
 */
export async function readGovernancePolls(api: CognoApi): Promise<GovPollSummary[]> {
  const [pollEntries, resultEntries] = await Promise.all([
    api.query.Microblog.Polls.getEntries(BEST).catch(() => []),
    api.query.Microblog.PollResults.getEntries(BEST).catch(() => []),
  ]);
  const finalized = new Set(resultEntries.map((e) => e.keyArgs[0] as bigint));
  const govs = pollEntries
    .filter((e) => e.value.action != null)
    .sort((a, b) => Number((b.keyArgs[0] as bigint) - (a.keyArgs[0] as bigint))) // newest (highest id) first
    .slice(0, MAX_SCAN);

  // One batched read for every host's direct-reply count, rather than a point read per row. Kept
  // outside the per-poll map below for that reason. `ReplyCount` is ValueQuery so an unreplied host
  // answers 0 rather than None; a failed or absent read degrades to 0, which orders those rows last
  // under "most discussed" instead of hiding them.
  //
  // In a `try`, not merely `.catch`-ed: this function's contract is that it never throws, and a
  // trailing `.catch` only covers a REJECTED promise. If the storage item is absent from the reader
  // the throw happens on the member access, in the expression that produces the promise, where no
  // `.catch` can reach it.
  let replyCounts: (number | undefined)[] = [];
  try {
    replyCounts = await api.query.Microblog.ReplyCount.getValues(
      govs.map((e) => [e.keyArgs[0] as bigint] as const),
      BEST,
    );
  } catch {
    replyCounts = [];
  }

  return Promise.all(
    govs.map(async (e, i) => {
      const hostId = e.keyArgs[0] as bigint;
      // This reads Microblog.Posts DIRECTLY rather than through the FeedSource, so the serve denylist
      // has to be applied here by hand — by post id AND by author. Checking only the post id was a
      // hole: an operator who denied an ACCOUNT saw the delisting hold on Home, Explore, search, that
      // account's profile and the post's own permalink, while /governance quietly kept rendering
      // their poll question. The author is only knowable AFTER the read, so unlike the post-id case
      // this cannot skip the fetch; it drops the text instead.
      //
      // BOTH author-supplied fields go, not just the question. `anchor_url` is a URL the poll's author
      // put on chain, and the row renders it through ProposalTitle, which lazily fetches the CIP-108
      // document and renders ITS title. Withholding the question while keeping the anchor left the
      // delisted account with author-controlled text on the page and, worse, made every /governance
      // visitor's browser issue a request to a host that account chose. Dropping it falls back to
      // "Open the poll to see the proposal", which is the gated state ProposalTitle already draws.
      const deniedById = isDeniedPost(hostId);
      const post = deniedById
        ? null
        : await api.query.Microblog.Posts.getValue(hostId, BEST).catch(() => null);
      const denied = deniedById || (post != null && isDeniedAuthor(post.author));
      const question = post && !denied ? sanitizeInline(Binary.toText(post.text)).slice(0, 160) : "";
      return {
        hostId,
        actionType: actionTypeOf(e.value.action?.action_type),
        question,
        anchorUrl: denied ? undefined : decodeAnchor(e.value.action?.anchor_url),
        // Moves with the URL it commits to. A hash without the anchor it pins is unusable, and a
        // denied row fetches nothing to compare against.
        anchorHash: denied ? undefined : (e.value.action?.anchor_hash ?? undefined),
        closeAt: e.value.close_at ?? undefined,
        finalized: finalized.has(hostId),
        // Zeroed for a denied host along with its text: "most discussed" is a claim about a thread the
        // reader can go and read, and this deployment is not serving that one.
        replyCount: denied ? 0 : (replyCounts[i] ?? 0),
      };
    }),
  );
}

/** Whether `who` (via their observed roles) may cast a real vote on an action of this type — i.e. they hold
 *  a role in one of the chambers that decides it. `null` roles (unknown / not connected) ⇒ `undefined`. */
export function eligibleToVote(
  action: GovActionType,
  viewerRoles: readonly RoleKindType[] | null,
): boolean | undefined {
  if (viewerRoles == null) return undefined;
  const bodies = actionBodies(action);
  return bodies.some((b) => viewerRoles.includes(b === "spo" ? "Spo" : "DRep"));
}

/** The three-state close status of a summary, given the current best block. */
export function govCloseState(
  s: Pick<GovPollSummary, "closeAt" | "finalized">,
  bestBlock: number | null,
): "open" | "provisional" | "final" {
  if (s.finalized) return "final";
  if (s.closeAt != null && bestBlock != null && bestBlock >= s.closeAt) return "provisional";
  return "open";
}
