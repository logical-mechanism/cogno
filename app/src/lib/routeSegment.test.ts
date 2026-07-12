import { describe, it, expect } from "vitest";
import { routeSegmentOf } from "./routeSegment";

// The static export serves ONE placeholder shell per dynamic route, so this parse — not useParams() —
// is what resolves every profile and every thread. Getting it wrong renders the in-app not-found for
// the whole surface, and only in a production build. Pin the shape.

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("routeSegmentOf", () => {
  it("reads the address off a profile path (trailingSlash: true)", () => {
    expect(routeSegmentOf(`/u/${ALICE}/`, "u")).toBe(ALICE);
  });

  it("reads it without the trailing slash too", () => {
    expect(routeSegmentOf(`/u/${ALICE}`, "u")).toBe(ALICE);
  });

  it("reads a post id", () => {
    expect(routeSegmentOf("/post/42/", "post")).toBe("42");
  });

  it("stops at the first segment, ignoring anything deeper", () => {
    expect(routeSegmentOf(`/u/${ALICE}/followers/`, "u")).toBe(ALICE);
  });

  it("returns the export's placeholder verbatim, so the caller's validation rejects it", () => {
    // /u/_/ is the one path that really is the shell — it must NOT masquerade as a real profile.
    expect(routeSegmentOf("/u/_/", "u")).toBe("_");
  });

  it("does not match a different base that merely shares a prefix", () => {
    expect(routeSegmentOf("/user/foo/", "u")).toBe("");
    expect(routeSegmentOf("/posts/1/", "post")).toBe("");
  });

  it("returns '' when the path isn't under the base at all", () => {
    expect(routeSegmentOf("/explore/", "u")).toBe("");
    expect(routeSegmentOf("/", "u")).toBe("");
    expect(routeSegmentOf("", "u")).toBe("");
  });

  it("returns '' for the bare base with no segment", () => {
    expect(routeSegmentOf("/u/", "u")).toBe("");
  });

  it("percent-decodes (usePathname yields an encoded pathname)", () => {
    expect(routeSegmentOf("/u/a%20b/", "u")).toBe("a b");
  });

  it("passes a malformed %-escape through rather than throwing", () => {
    // decodeURIComponent("%zz") throws URIError; a crash here would take out the whole route.
    expect(routeSegmentOf("/u/%zz/", "u")).toBe("%zz");
  });
});
