// Scroll helpers.
//
// There is NO inner scroll container: `.main` flows with the document at every breakpoint
// (AppShell.module.css — "main FLOWS with the document (no own scroll container)"), which is what lets
// a wheel/touch scroll over the rails or the side margins move the feed. So "the top of the feed" is
// always the top of the document, and `window.scrollTo` is the whole implementation. (Home used to
// walk the ancestor chain for an `overflow-y: auto` scroller first; there has never been one, so the
// walk always returned null and always fell through to this.)

/** Scroll the document to the top. Honours prefers-reduced-motion (jump instead of smooth-scroll). */
export function scrollToTop(): void {
  if (typeof window === "undefined") return; // static export: no window while prerendering
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}
