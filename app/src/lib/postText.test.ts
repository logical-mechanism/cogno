// capImageSegments — the image-block flood cap.
//
// PostBody itself cannot be tested here (vitest runs in a `node` environment, so no component renders),
// which is exactly why the cap is a pure function in this module rather than inline JSX.

import { describe, it, expect } from "vitest";
import { segment, capImageSegments, MAX_IMAGE_BLOCKS } from "@/lib/postText";

/** Pack a body with `token` up to the chain's 512-byte MaxLength, the way an attacker would. */
function packToMaxLength(token: string): string {
  let body = "";
  while (new TextEncoder().encode(`${body}${token} `).length <= 512) body += `${token} `;
  return body.trim();
}

describe("capImageSegments", () => {
  it("keeps the first image and demotes the rest to links, preserving order and position", () => {
    const segs = segment("a https://x.co/1.png b https://x.co/2.png c https://x.co/3.png d");
    const { segs: capped, demoted } = capImageSegments(segs, 1);

    expect(demoted).toBe(2);
    expect(capped.map((s) => s.kind)).toEqual([
      "text", "image", "text", "url", "text", "url", "text",
    ]);
    // Demoted, not dropped — every URL survives verbatim, in place.
    expect(capped.map((s) => s.value)).toEqual(segs.map((s) => s.value));
  });

  it("returns the ORIGINAL array when nothing is demoted, so useMemo consumers keep identity", () => {
    const segs = segment("one image https://x.co/1.png and text");
    const { segs: capped, demoted } = capImageSegments(segs, MAX_IMAGE_BLOCKS);

    expect(demoted).toBe(0);
    expect(capped).toBe(segs); // referential, not just deep-equal
  });

  it("is a no-op at Infinity — the expanded state renders every block", () => {
    const segs = segment(packToMaxLength("ipfs://a"));
    const { segs: capped, demoted } = capImageSegments(segs, Infinity);

    expect(demoted).toBe(0);
    expect(capped).toBe(segs);
  });

  it("leaves non-image segments alone", () => {
    const segs = segment("#tag https://x.co/page @nobody https://x.co/1.png text");
    const { segs: capped } = capImageSegments(segs, 1);

    expect(capped.filter((s) => s.kind === "hashtag")).toHaveLength(1);
    expect(capped.filter((s) => s.kind === "image")).toHaveLength(1);
  });

  it("caps the 512-byte worst case: 56 blocks become 1", () => {
    // `ipfs://a` is a bare CID with no extension, which isImageUrl assumes is an image — 8 bytes an
    // image block, the cheapest flood there is.
    const segs = segment(packToMaxLength("ipfs://a"));
    expect(segs.filter((s) => s.kind === "image")).toHaveLength(56);

    const { segs: capped, demoted } = capImageSegments(segs, MAX_IMAGE_BLOCKS);
    expect(capped.filter((s) => s.kind === "image")).toHaveLength(1);
    expect(demoted).toBe(55);
  });

  it("caps the cheapest http flood too", () => {
    const segs = segment(packToMaxLength("https://a.co/b.png"));
    expect(segs.filter((s) => s.kind === "image")).toHaveLength(26);

    const { demoted } = capImageSegments(segs, MAX_IMAGE_BLOCKS);
    expect(demoted).toBe(25);
  });

  it("handles a body that is nothing but images", () => {
    const segs = segment("https://x.co/1.png https://x.co/2.png");
    const { segs: capped, demoted } = capImageSegments(segs, 1);

    expect(demoted).toBe(1);
    expect(capped.map((s) => s.kind)).toEqual(["image", "text", "url"]);
  });

  it("does nothing to a body with no images at all", () => {
    const segs = segment("just text with a #tag and https://x.co/page");
    const { segs: capped, demoted } = capImageSegments(segs, 1);

    expect(demoted).toBe(0);
    expect(capped).toBe(segs);
  });
});
