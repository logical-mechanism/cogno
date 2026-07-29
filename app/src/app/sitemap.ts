// sitemap.ts — the crawlable route list, as a Next metadata route so `output: export` emits a real
// /sitemap.xml at build.
//
// ONLY THE STATIC PUBLIC ROUTES. `/post/[id]` and `/u/[address]` are deliberately absent, and that is
// not an oversight to fix later: under `output: export` they prerender as a single `_` placeholder and
// their real content is fetched client-side from the chain, so there is no build-time list of post ids
// or accounts to enumerate. Listing the placeholder would advertise one URL that renders an empty
// shell. A sitemap that omits what it cannot know is worth more than one that pads itself.
//
// Derived from PUBLIC_SEGMENTS rather than hand-listed, because that set is already the fail-closed
// answer to "may a logged-out visitor see this", which is exactly the question a sitemap asks. A new
// public route joins the sitemap by being classified, and `routeClassification.test.ts` fails the build
// until it is classified either way.

import type { MetadataRoute } from "next";
import { PUBLIC_SEGMENTS } from "@/lib/routeAccess";
import { SITE_ORIGIN as BASE } from "@/lib/config/operator";

// Required under `output: export` — see the note in robots.ts. Without it the build errors.
export const dynamic = "force-static";

/**
 * Public segments that are dynamic, so there is nothing static to list. Named rather than pattern
 * matched: if a future dynamic route is added and not named here, it lands in the sitemap as a bare
 * segment URL and somebody notices, which is the failure direction we want.
 */
const DYNAMIC = new Set(["post", "u"]);

/**
 * Device-local surfaces. They are public (a guest may browse them) but they render one person's own
 * bookmarks and lists out of localStorage, so for a crawler they are permanently empty pages.
 */
const DEVICE_LOCAL = new Set(["bookmarks", "lists"]);

/** Rough crawl priority. The timeline is the front door; the legal pages are reference. */
const PRIORITY: Record<string, number> = {
  "": 1.0,
  explore: 0.8,
  governance: 0.8,
};

export default function sitemap(): MetadataRoute.Sitemap {
  return [...PUBLIC_SEGMENTS]
    .filter((seg) => !DYNAMIC.has(seg) && !DEVICE_LOCAL.has(seg))
    .sort()
    .map((seg) => ({
      url: seg === "" ? `${BASE}/` : `${BASE}/${seg}/`,
      changeFrequency: seg === "" || seg === "explore" || seg === "governance" ? "hourly" : "yearly",
      priority: PRIORITY[seg] ?? 0.5,
    }));
}
