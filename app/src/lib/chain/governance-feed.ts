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

/** A governance poll as the discovery list needs it (no tally — that loads when the poll is opened). */
export interface GovPollSummary {
  hostId: bigint;
  actionType: GovActionType;
  /** The host post's text (the question), sanitized + truncated. */
  question: string;
  /** Block-number deadline, or undefined for a floating poll. */
  closeAt?: number;
  /** `true` once `close_poll` has frozen the result. */
  finalized: boolean;
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

  return Promise.all(
    govs.map(async (e) => {
      const hostId = e.keyArgs[0] as bigint;
      const post = await api.query.Microblog.Posts.getValue(hostId, BEST).catch(() => null);
      const question = post ? sanitizeInline(Binary.toText(post.text)).slice(0, 160) : "";
      return {
        hostId,
        actionType: actionTypeOf(e.value.action?.action_type),
        question,
        closeAt: e.value.close_at ?? undefined,
        finalized: finalized.has(hostId),
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
