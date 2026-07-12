// The tablist keyboard rule, as a pure function.
//
// Extracted so it can be tested in `environment: "node"` — the rest of <Tabs> is orchestration, and this
// repo has no jsdom/RTL (a deliberate choice). It is the only part with logic worth pinning, and it was
// the part that had drifted: of the five tab strips, two implemented Home/End and three did not, so
// whether the End key jumped to the last tab depended on which page you were on.
//
// This is the WAI-ARIA tabs pattern: arrows wrap, Home/End jump to the ends, everything else is ignored
// (and must NOT be preventDefault()ed, or Tab/Enter/typing break).

/**
 * The index to move to for a keydown on a tablist, or `null` when the key is not ours to handle.
 *
 * @param key   KeyboardEvent.key
 * @param idx   the currently-active tab index
 * @param count how many tabs are rendered (Home's tab strip drops "Following" when follows are off)
 */
export function nextTabIndex(key: string, idx: number, count: number): number | null {
  if (count <= 0 || idx < 0) return null;
  switch (key) {
    case "ArrowRight":
      return (idx + 1) % count;
    case "ArrowLeft":
      return (idx - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
