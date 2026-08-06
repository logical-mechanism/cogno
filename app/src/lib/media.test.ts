import { describe, it, expect } from "vitest";
import { isImageUrl, resolveImageSrc, urlLabel, IMAGE_EXTENSIONS, IPFS_GATEWAY } from "./media";

describe("isImageUrl — http(s) detection by extension", () => {
  it("matches every supported image extension", () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(isImageUrl(`https://example.com/pic.${ext}`)).toBe(true);
      expect(isImageUrl(`http://example.com/pic.${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(isImageUrl("https://example.com/PIC.PNG")).toBe(true);
    expect(isImageUrl("https://example.com/Pic.JpEg")).toBe(true);
  });

  it("ignores query string and hash fragment", () => {
    expect(isImageUrl("https://example.com/a.jpg?w=400&h=300")).toBe(true);
    expect(isImageUrl("https://example.com/a.webp#frag")).toBe(true);
  });

  it("rejects http(s) URLs with no / a non-image extension", () => {
    expect(isImageUrl("https://example.com/page")).toBe(false);
    expect(isImageUrl("https://example.com/")).toBe(false);
    expect(isImageUrl("https://example.com/doc.pdf")).toBe(false);
    expect(isImageUrl("https://example.com/img?id=5")).toBe(false);
  });

  it("rejects non-http/ipfs schemes and bare text", () => {
    expect(isImageUrl("ftp://host/a.png")).toBe(false);
    expect(isImageUrl("mailto:a@b.com")).toBe(false);
    expect(isImageUrl("not a url at all")).toBe(false);
    expect(isImageUrl("")).toBe(false);
  });
});

describe("isImageUrl — ipfs:// handling", () => {
  it("treats a bare CID (no extension) as an image", () => {
    expect(isImageUrl("ipfs://bafybeigdyrexamplecid")).toBe(true);
  });

  it("matches an ipfs path carrying an image extension", () => {
    expect(isImageUrl("ipfs://bafy/cat.png")).toBe(true);
  });

  it("rejects an ipfs path with a non-image extension", () => {
    expect(isImageUrl("ipfs://bafy/meta.json")).toBe(false);
  });

  it("rejects an ipfs URI with no CID", () => {
    expect(isImageUrl("ipfs://")).toBe(false);
    expect(isImageUrl("ipfs://ipfs/")).toBe(false);
  });
});

describe("resolveImageSrc — ipfs:// → gateway", () => {
  it("maps ipfs://<cid>/<path> onto the gateway", () => {
    expect(resolveImageSrc("ipfs://bafyCID/cat.png")).toBe(`${IPFS_GATEWAY}bafyCID/cat.png`);
  });

  it("normalises the ipfs://ipfs/<cid> double prefix", () => {
    expect(resolveImageSrc("ipfs://ipfs/bafyCID")).toBe(`${IPFS_GATEWAY}bafyCID`);
  });

  it("passes http(s) URLs through unchanged", () => {
    expect(resolveImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(resolveImageSrc("http://example.com/b")).toBe("http://example.com/b");
  });

  it("strips leading dot-segments so a crafted path can't escape the /ipfs/ root", () => {
    const out = resolveImageSrc("ipfs://../../etc/passwd");
    expect(out.startsWith(IPFS_GATEWAY)).toBe(true);
    expect(out).toBe(`${IPFS_GATEWAY}etc/passwd`);
  });

  it("leaves a CID-less ipfs URI untouched instead of resolving to the gateway root", () => {
    expect(resolveImageSrc("ipfs://ipfs/")).toBe("ipfs://ipfs/");
  });

  it("does not resolve a smuggled absolute URL to a foreign origin", () => {
    // `new URL('https://attacker.example/x.png', gateway)` ignores the base and yields the attacker
    // origin; the gateway-root guard must fall back to returning the raw input instead.
    const out = resolveImageSrc("ipfs://https://attacker.example/x.png");
    expect(out.startsWith("https://attacker.example")).toBe(false);
    expect(out).toBe("ipfs://https://attacker.example/x.png");
  });
});

describe("urlLabel — the label may never name a host the link does not go to", () => {
  // Both of these shipped in ProfileHeader's hand-rolled regex version and were found by the
  // adversarial fixture seeder (scripts/seed-fixtures.mjs).
  it("names the REAL host when userinfo fakes a prefix", () => {
    expect(urlLabel("https://good.com@evil.com/login")).toBe("evil.com/login");
  });

  it("shows punycode for an IDN homograph, not the lookalike", () => {
    // Cyrillic а — pixel-identical to apple.com if rendered raw.
    expect(urlLabel("https://аpple.com/account")).toBe("xn--pple-43d.com/account");
  });

  it("shortens a long path instead of rendering the whole URL", () => {
    expect(urlLabel(`https://example.com/${"a".repeat(230)}`)).toBe(`example.com/${"a".repeat(24)}…`);
    expect(urlLabel("https://example.com/a/b/c")).toBe("example.com/a/…");
    // A long segment is clipped in the multi-segment form too, not just the single-segment one.
    expect(urlLabel(`https://example.com/${"b".repeat(50)}/x`)).toBe(`example.com/${"b".repeat(24)}…/…`);
  });

  it("NEVER truncates the host — a host reads right-to-left, so clipping it inverts who it names", () => {
    const long = "good.com.and.more.subdomains.that.go.on.a.while.evil.com";
    expect(urlLabel(`https://${long}/x`)).toBe(`${long}/x`);
  });

  it("drops the scheme and a leading www", () => {
    expect(urlLabel("https://www.example.com")).toBe("example.com");
  });

  it("returns an unparseable value verbatim rather than inventing a host", () => {
    expect(urlLabel("https://javascript:alert(1)")).toBe("https://javascript:alert(1)");
  });

  it("shortens an ipfs URI by CID", () => {
    expect(urlLabel("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe(
      "ipfs://bafybeigdyrzt5sf…",
    );
  });
});
