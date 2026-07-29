// robots.ts — the crawl policy, as a Next metadata route so `output: export` emits a real
// /robots.txt at build rather than a hand-maintained file in public/ that nobody re-reads.
//
// THE REASONING LIVES IN THE FILE, not in a commit message. A crawl policy on a permanent,
// undeletable corpus outlives whoever wrote it, and a bare list of user-agents tells the next person
// what was decided without telling them why, which is how a policy gets "cleaned up" by accident.
//
// WHY INDEXABLE AT ALL. The read surfaces are public and the whole point of a governance discussion is
// that people find it. Being a preprod testnet is not a reason to hide from search: the service is
// live and honestly labeled, and a thread nobody can find is a thread nobody joins. Walled surfaces
// (compose, settings, notifications) are listed as disallowed even though they are client-rendered
// shells with nothing in them, because a crawler spending its budget on four empty app shells is
// budget not spent on the pages that do have content.
//
// WHY THE TRAINING CRAWLERS ARE BLOCKED AND THE ANSWER ENGINES ARE NOT. These are two different
// things wearing similar user-agent strings. An answer engine fetches a page to cite it, and sends a
// reader; that is the same trade as a search engine and is why nobody here is blocked for it. A
// training crawler takes a permanent copy of text its authors cannot delete, since nothing posted to
// this chain can be unposted. Somebody who accepted "this is public and permanent" did not thereby
// accept "this is a training corpus", and they have no way to change their mind later. So the block
// is on the corpus-collection use, not on the AI-ness of the client.

import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/config/operator";

// Required under `output: export`. A metadata route is a Route Handler, and Next treats one as dynamic
// unless told otherwise, so without this the export fails outright ("dynamic = force-static not
// configured on route /robots.txt"). It is not a hint or an optimization: the build errors.
export const dynamic = "force-static";

/**
 * Crawlers whose declared purpose is collecting a training corpus. See the header for the rationale.
 *
 * Deliberately NOT here: PerplexityBot and the other answer-engine crawlers. They fetch a page in order
 * to cite it and send a reader, which is the search-engine trade, and blocking them would contradict
 * the reason the rest of this file allows crawling at all. The line is the USE, not the vendor: several
 * names below belong to companies whose search crawlers are welcome under a different user-agent.
 */
const TRAINING_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "meta-externalagent",
  "Bytespider",
  "Diffbot",
  "Omgilibot",
];

/** The write and config surfaces. Client-rendered shells with no content to index. */
const WALLED = ["/compose", "/settings", "/notifications", "/welcome"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: WALLED },
      { userAgent: TRAINING_CRAWLERS, disallow: "/" },
    ],
    // Absolute, and from the same constant sitemap.ts builds its entries from: a crawler discards a
    // sitemap whose URLs sit on a different host than the robots.txt that pointed at it.
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
