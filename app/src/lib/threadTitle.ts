// threadDocumentTitle — the browser tab title for /post/[id].
//
// It is here, pure, because a suppression guard applied to ONE of several sibling renders is exactly
// how this went wrong: ThreadView's title effect checked the operator's serve denylist and not the
// viewer's own block, so a blocked author's display name and the first 60 characters of their post
// went into the tab strip, the window switcher, the browser history and any bookmark taken from the
// page — while the card underneath rendered the "You've blocked this account" stub. The ancestor line
// three hundred lines up got it right, which is the tell: the rule was in four places and agreed in
// three of them.
//
// Both suppressions are equally binding here even though they mean different things — the denylist is
// the operator's and cannot be undone by the reader, block is the reader's own choice and is
// reversible — because a tab title outlives the page either way.

import { sanitizeInline } from "./sanitize";
import { handleOf } from "./ss58";

/** The tab title for a thread with no readable focal (loading, missing, or suppressed). */
export const DEFAULT_THREAD_TITLE = "cogno";

/** Longest post snippet carried into the title before it is clipped. */
const SNIPPET_LEN = 60;

/** Just the focal fields the title needs, so the rule is testable without a whole CognoPost. */
export interface ThreadTitleFocal {
  author: string;
  authorDisplayName?: string;
  text: string;
}

export interface ThreadTitleFlags {
  /** On the operator's serve denylist. */
  denied: boolean;
  /** Blocked by THIS viewer, device-locally. */
  blocked: boolean;
}

/**
 * The document title for a thread focal. Author text is hardened via `sanitizeInline` — a bidi
 * override or a newline in a display name would otherwise corrupt the tab label itself.
 */
export function threadDocumentTitle(
  focal: ThreadTitleFocal | null | undefined,
  flags: ThreadTitleFlags,
): string {
  if (!focal || flags.denied || flags.blocked) return DEFAULT_THREAD_TITLE;
  const who = sanitizeInline(focal.authorDisplayName ?? "") || handleOf(focal.author);
  const snippet = sanitizeInline(focal.text);
  const clipped = snippet.length > SNIPPET_LEN ? `${snippet.slice(0, SNIPPET_LEN)}…` : snippet;
  return clipped ? `${who} on cogno: “${clipped}”` : `${who} on cogno`;
}
