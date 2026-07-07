// recentEmoji — device-local most-recently-used emoji for the picker (client-only, no chain state).
// A plain localStorage list (ordered most-recent-first, deduped, capped); the picker pins a "Recently
// used" row on top so common picks are one tap away, like the OS/X emoji pickers.

const KEY = "cg:emoji:recent";
const MAX = 24;

export function loadRecentEmoji(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

/** Record a pick (move-to-front, capped) and return the new list. */
export function pushRecentEmoji(emoji: string): string[] {
  const next = [emoji, ...loadRecentEmoji().filter((x) => x !== emoji)].slice(0, MAX);
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / storage disabled → in-memory only */
  }
  return next;
}
