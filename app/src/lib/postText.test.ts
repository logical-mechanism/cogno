// capImageSegments — the image-block flood cap.
//
// PostBody itself cannot be tested here (vitest runs in a `node` environment, so no component renders),
// which is exactly why the cap is a pure function in this module rather than inline JSX.

import { describe, it, expect } from "vitest";
import {
  segment,
  capImageSegments,
  exceedsLineCap,
  expanderLabel,
  MAX_IMAGE_BLOCKS,
  MAX_BODY_LINES,
  IMAGE_REVEAL_STEP,
} from "@/lib/postText";

/** Pack a body with `token` up to the chain's 512-byte MaxLength, the way an attacker would. */
function packToMaxLength(token: string): string {
  let body = "";
  while (new TextEncoder().encode(`${body}${token} `).length <= 512) body += `${token} `;
  return body.trim();
}

describe("capImageSegments", () => {
  it("keeps the first image and HIDES the rest, leaving surrounding text in place", () => {
    const segs = segment("a https://x.co/1.png b https://x.co/2.png c https://x.co/3.png d");
    const { segs: capped, hidden } = capImageSegments(segs, 1);

    expect(hidden).toBe(2);
    // The over-cap images are gone entirely — NOT turned into url segments, which rendered an ordinary
    // multi-photo post as one image followed by a wall of raw URL text.
    expect(capped.map((s) => s.kind)).toEqual(["text", "image", "text", "text", "text"]);
    expect(capped.some((s) => s.kind === "url")).toBe(false);
  });

  it("returns the ORIGINAL array when nothing is hidden, so useMemo consumers keep identity", () => {
    const segs = segment("one image https://x.co/1.png and text");
    const { segs: capped, hidden } = capImageSegments(segs, MAX_IMAGE_BLOCKS);

    expect(hidden).toBe(0);
    expect(capped).toBe(segs); // referential, not just deep-equal
  });

  it("is a no-op at Infinity — the expanded state renders every block", () => {
    const segs = segment(packToMaxLength("ipfs://a"));
    const { segs: capped, hidden } = capImageSegments(segs, Infinity);

    expect(hidden).toBe(0);
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

    const { segs: capped, hidden } = capImageSegments(segs, MAX_IMAGE_BLOCKS);
    expect(capped.filter((s) => s.kind === "image")).toHaveLength(1);
    expect(hidden).toBe(55);
  });

  it("caps the cheapest http flood too", () => {
    const segs = segment(packToMaxLength("https://a.co/b.png"));
    expect(segs.filter((s) => s.kind === "image")).toHaveLength(26);

    const { hidden } = capImageSegments(segs, MAX_IMAGE_BLOCKS);
    expect(hidden).toBe(25);
  });

  it("handles a body that is nothing but images", () => {
    const segs = segment("https://x.co/1.png https://x.co/2.png");
    const { segs: capped, hidden } = capImageSegments(segs, 1);

    expect(hidden).toBe(1);
    expect(capped.map((s) => s.kind)).toEqual(["image", "text"]);
  });

  it("does nothing to a body with no images at all", () => {
    const segs = segment("just text with a #tag and https://x.co/page");
    const { segs: capped, hidden } = capImageSegments(segs, 1);

    expect(hidden).toBe(0);
    expect(capped).toBe(segs);
  });

  it("does not disturb a non-image url alongside a hidden image", () => {
    const segs = segment("see https://x.co/page and https://x.co/1.png and https://x.co/2.png");
    const { segs: capped, hidden } = capImageSegments(segs, 1);

    expect(hidden).toBe(1);
    // The genuine link is still a link; only the over-cap IMAGE went away.
    expect(capped.filter((s) => s.kind === "url").map((s) => s.value)).toEqual(["https://x.co/page"]);
    expect(capped.filter((s) => s.kind === "image")).toHaveLength(1);
  });
});

describe("exceedsLineCap", () => {
  it("is false at the cap and true one line past it", () => {
    expect(exceedsLineCap("x\n".repeat(MAX_BODY_LINES - 1) + "x")).toBe(false);
    expect(exceedsLineCap("x\n".repeat(MAX_BODY_LINES) + "x")).toBe(true);
  });

  it("leaves ordinary prose alone, however long", () => {
    // 512 bytes — the chain's whole MaxLength — as one paragraph. It wraps to ~10 rendered lines in a
    // 560px column, so nothing but explicit newlines can reach the cap.
    expect(exceedsLineCap("a".repeat(512))).toBe(false);
    expect(exceedsLineCap("word ".repeat(102))).toBe(false);
    expect(exceedsLineCap("a short post\nwith a second line")).toBe(false);
  });

  it("catches the 512-byte newline flood, which needs no images", () => {
    // `a` + 510 newlines + `b` is a legal post that renders ~511 lines ≈ 10 200px.
    const flood = `a${"\n".repeat(510)}b`;
    expect(new TextEncoder().encode(flood).length).toBe(512);
    expect(exceedsLineCap(flood)).toBe(true);
  });

  it("handles the empty and single-line bodies without tripping", () => {
    expect(exceedsLineCap("")).toBe(false);
    expect(exceedsLineCap("one line")).toBe(false);
    expect(exceedsLineCap("\n")).toBe(false);
  });

  it("honours an explicit cap", () => {
    expect(exceedsLineCap("a\nb\nc", 3)).toBe(false);
    expect(exceedsLineCap("a\nb\nc", 2)).toBe(true);
  });
});

describe("expanderLabel — the button must not promise more than the press delivers", () => {
  it("names the exact count when one press clears it", () => {
    expect(expanderLabel(1)).toBe("Show 1 more image");
    expect(expanderLabel(2)).toBe("Show 2 more images");
    expect(expanderLabel(IMAGE_REVEAL_STEP)).toBe(`Show ${IMAGE_REVEAL_STEP} more images`);
  });

  it("names the STEP plus the remaining scale when it will take several", () => {
    // The remaining count is the reader's only signal that a post is a flood, not a photo album.
    expect(expanderLabel(55)).toBe("Show 3 more images (55 hidden)");
    expect(expanderLabel(IMAGE_REVEAL_STEP + 1)).toBe(`Show 3 more images (4 hidden)`);
  });

  it("falls back to the generic label for a clamped body holding back no images", () => {
    expect(expanderLabel(0)).toBe("Show more");
  });

  it("carries no em dash, per the user-facing copy rule", () => {
    for (const n of [0, 1, 2, 3, 4, 55]) expect(expanderLabel(n)).not.toContain("—");
  });
});

describe("stepped reveal reaches every image without ever dumping them all", () => {
  it("walks 56 blocks to full visibility a step at a time", () => {
    const segs = segment(packToMaxLength("ipfs://a"));
    let shown = MAX_IMAGE_BLOCKS;
    let presses = 0;
    let { hidden } = capImageSegments(segs, shown);

    expect(hidden).toBe(55); // the first press must never be able to reveal all of them
    while (hidden > 0) {
      shown += IMAGE_REVEAL_STEP;
      presses += 1;
      ({ hidden } = capImageSegments(segs, shown));
      expect(presses).toBeLessThan(100); // guard: the loop must converge
    }
    expect(capImageSegments(segs, shown).segs.filter((s) => s.kind === "image")).toHaveLength(56);
    expect(presses).toBe(19);
  });

  it("clears an ordinary four-photo post in ONE press", () => {
    const segs = segment("a https://x.co/1.png https://x.co/2.png https://x.co/3.png https://x.co/4.png");
    expect(capImageSegments(segs, MAX_IMAGE_BLOCKS).hidden).toBe(3);
    expect(capImageSegments(segs, MAX_IMAGE_BLOCKS + IMAGE_REVEAL_STEP).hidden).toBe(0);
  });
});
