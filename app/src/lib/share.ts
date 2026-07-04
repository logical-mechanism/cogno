// share — copy-to-clipboard for the "Copy link" post action, with a legacy fallback so the user
// ALWAYS gets feedback instead of a silent no-op. `navigator.clipboard` is undefined in insecure
// contexts / some in-app browsers; when it's missing or rejects we fall back to a hidden-textarea
// document.execCommand("copy"). Returns whether the copy succeeded so the caller can toast.

/** Build the shareable absolute URL for a post id (empty origin during SSR/static export). */
export function postLink(id: bigint): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/post/${id}/`;
}

/** Copy `text` to the clipboard; resolves true on success, false if no method worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / insecure context → try the legacy path below.
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    // execCommand is deprecated but remains the only clipboard path in insecure contexts.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
