// The route table, asserted against the FILESYSTEM rather than against itself.
//
// `PUBLIC_SEGMENTS` is a fail-closed allowlist and is correct as a mechanism — every defect around it
// has been an OMISSION, not a bypass, and an omission is exactly what no test or lint could see:
//
//   • /bookmarks and /lists were walled although both are purely device-local, so a guest could
//     bookmark a post, get a "Saved to bookmarks" toast, and never reach it again.
//   • /governance was in neither of onboardingReturn's two sets, so browsing there took the third
//     branch (meant for /welcome and the walled routes) and did not clear a stale remembered post,
//     and onboarding teleported the visitor to it.
//
// Both are the same shape: a route exists, and one of the three hand-maintained tables does not know
// about it. Reading `src/app` is what closes that — a new route fails this test until it is
// deliberately classified, which is the only moment anybody is thinking about it.
//
// Pure fs + set algebra. No rendering, so it is safe under `environment: "node"`.

import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_SEGMENTS, WELCOME_SEGMENT } from "./routeAccess";
import { RETURNABLE_SEGMENTS, HUB_SEGMENTS } from "./onboardingReturn";

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));

/**
 * The deliberate OTHER half of the wall. Not derived from `PUBLIC_SEGMENTS` — deriving it would make
 * "nobody classified this route" indistinguishable from "somebody decided to wall it", which is the
 * failure this whole file exists to catch. Adding a route means adding it here or to PUBLIC_SEGMENTS.
 */
const WALLED_SEGMENTS: ReadonlySet<string> = new Set(["compose", "notifications", "settings"]);

/**
 * Every routable top-level segment, read off disk. A dynamic segment (`post/[id]`) is routable through
 * its PARENT, which is the segment the wall matches, so a directory counts when it holds a `page.tsx`
 * itself or one directly inside a single dynamic child.
 */
function routableSegments(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(APP_DIR, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const dir = join(APP_DIR, name.name);
    const direct = existsSync(join(dir, "page.tsx"));
    const viaDynamic = readdirSync(dir, { withFileTypes: true }).some(
      (child) =>
        child.isDirectory() &&
        child.name.startsWith("[") &&
        existsSync(join(dir, child.name, "page.tsx")),
    );
    if (direct || viaDynamic) out.push(name.name);
  }
  return out.sort();
}

describe("route classification", () => {
  const segments = routableSegments();

  it("finds the routes at all (a broken walk would make every assertion below vacuous)", () => {
    expect(segments.length).toBeGreaterThan(8);
    expect(segments).toContain("settings"); // a known walled one
    expect(segments).toContain("post"); // a known public, dynamic one
  });

  it("classifies every routable segment EXPLICITLY: public, walled, or the welcome canvas", () => {
    // The walled half is spelled out here rather than inferred as "not public" — inferring it is what
    // makes an omission invisible. A new route is in neither list, so this fails and somebody has to
    // decide which side of the wall it belongs on. That decision is the whole point of the test.
    const classified = new Set([...PUBLIC_SEGMENTS, ...WALLED_SEGMENTS, WELCOME_SEGMENT]);
    const unclassified = segments.filter((s) => !classified.has(s));
    expect(unclassified).toEqual([]);
  });

  it("does not classify a segment as both public and walled", () => {
    for (const seg of WALLED_SEGMENTS) expect(PUBLIC_SEGMENTS.has(seg)).toBe(false);
    expect(PUBLIC_SEGMENTS.has(WELCOME_SEGMENT)).toBe(false);
    expect(WALLED_SEGMENTS.has(WELCOME_SEGMENT)).toBe(false);
  });

  it("names only segments that exist (no stale entry outliving its route)", () => {
    const onDisk = new Set([...segments, ""]); // "" is the index route, src/app/page.tsx
    for (const seg of PUBLIC_SEGMENTS) expect(onDisk.has(seg)).toBe(true);
    for (const seg of RETURNABLE_SEGMENTS) expect(onDisk.has(seg)).toBe(true);
    for (const seg of HUB_SEGMENTS) expect(onDisk.has(seg)).toBe(true);
  });

  it("splits the PUBLIC set into RETURNABLE ∪ HUB, exactly", () => {
    // THE F24 assertion. A public segment in neither set falls through `rememberContentRoute`'s third
    // branch, which exists for /welcome and the walled routes, so it neither remembers nor forgets.
    const union = new Set([...RETURNABLE_SEGMENTS, ...HUB_SEGMENTS]);
    expect([...union].sort()).toEqual([...PUBLIC_SEGMENTS].sort());
  });

  it("keeps RETURNABLE and HUB disjoint", () => {
    for (const seg of RETURNABLE_SEGMENTS) expect(HUB_SEGMENTS.has(seg)).toBe(false);
  });

  it("keeps the device-local surfaces public", () => {
    // F4. Neither needs an identity, and both already tell the reader they stay on this device.
    expect(PUBLIC_SEGMENTS.has("bookmarks")).toBe(true);
    expect(PUBLIC_SEGMENTS.has("lists")).toBe(true);
  });

  it("keeps the write and config surfaces walled, and they really exist", () => {
    for (const seg of WALLED_SEGMENTS) expect(segments).toContain(seg);
  });
});
