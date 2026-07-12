// share — copy-to-clipboard for the "Copy link" post action, with a legacy fallback so the user
// ALWAYS gets feedback instead of a silent no-op. `navigator.clipboard` is undefined in insecure
// contexts / some in-app browsers; when it's missing or rejects we fall back to a hidden-textarea
// document.execCommand("copy"). Returns whether the copy succeeded so the caller can toast.

/** Build the shareable absolute URL for a post id (empty origin during SSR/static export). */
export function postLink(id: bigint): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/post/${id}/`;
}

/** Outcome of {@link sharePost}: the OS share sheet handled it (no toast needed), or we fell back to
 *  copying the link (`ok` says whether the copy worked, so the caller can toast). */
export type ShareResult = { kind: "shared" } | { kind: "copied"; ok: boolean };

/**
 * Share a post: use the native OS share sheet (`navigator.share`) when available — mobile especially —
 * else fall back to copying the link. A dismissed sheet (AbortError) is a no-op success, not a copy.
 * The caller toasts only on the "copied" branch (the OS sheet gives its own feedback).
 */
export async function sharePost(id: bigint): Promise<ShareResult> {
  const url = postLink(id);
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ url });
      return { kind: "shared" };
    } catch (e) {
      // User dismissed the sheet → nothing to do. Any other error falls through to the copy path.
      if (e instanceof DOMException && e.name === "AbortError") return { kind: "shared" };
    }
  }
  return { kind: "copied", ok: await copyToClipboard(url) };
}

/** The minimal toast bus this helper needs — structurally satisfied by `useToaster().toast`. */
type ShareToast = (spec: { kind: "success" | "error"; message: string }) => void;

/**
 * Share a post and give the user feedback: the OS share sheet handles its own, so we only toast on the
 * copy fallback (success "Link copied" / failure "Couldn't copy the link"). Centralizes the onShare
 * handler every post surface (home / explore / thread / bookmarks / profile) otherwise hand-copied.
 */
export async function sharePostWithToast(id: bigint, toast: ShareToast): Promise<void> {
  const r = await sharePost(id);
  if (r.kind === "copied") {
    toast(
      r.ok
        ? { kind: "success", message: "Link copied" }
        : { kind: "error", message: "Couldn't copy the link" },
    );
  }
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
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
