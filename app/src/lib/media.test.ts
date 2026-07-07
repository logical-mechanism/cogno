import { describe, it, expect } from "vitest";
import {
  isImageUrl,
  classifyMedia,
  countMediaUrls,
  resolveImageSrc,
  resolveMediaSrc,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  IPFS_GATEWAY,
} from "./media";

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

describe("classifyMedia — image / video / audio by extension", () => {
  it("classifies every image extension as 'image'", () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(classifyMedia(`https://example.com/pic.${ext}`)).toBe("image");
    }
  });

  it("classifies every video extension as 'video'", () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(classifyMedia(`https://example.com/clip.${ext}`)).toBe("video");
    }
  });

  it("classifies every audio extension as 'audio'", () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(classifyMedia(`https://example.com/song.${ext}`)).toBe("audio");
    }
  });

  it("is case-insensitive and ignores query / hash", () => {
    expect(classifyMedia("https://example.com/CLIP.MP4?t=3")).toBe("video");
    expect(classifyMedia("https://example.com/a.WebM#x")).toBe("video");
    expect(classifyMedia("https://example.com/track.MP3?dl=1")).toBe("audio");
  });

  it("returns null for a non-media / no-extension http(s) link", () => {
    expect(classifyMedia("https://youtube.com/watch?v=abc")).toBeNull();
    expect(classifyMedia("https://example.com/page")).toBeNull();
    expect(classifyMedia("https://example.com/doc.pdf")).toBeNull();
  });

  it("returns null for non-http/ipfs schemes (never a media/href/src sink)", () => {
    expect(classifyMedia("javascript:alert(1)")).toBeNull();
    expect(classifyMedia("data:image/png;base64,AAAA")).toBeNull();
    expect(classifyMedia("ftp://host/a.mp4")).toBeNull();
    expect(classifyMedia("mailto:a@b.com")).toBeNull();
    expect(classifyMedia("")).toBeNull();
  });

  it("classifies ipfs media by extension, bare CID as image, unknown ext as null", () => {
    expect(classifyMedia("ipfs://bafyCID")).toBe("image"); // bare CID assumed image
    expect(classifyMedia("ipfs://bafy/cat.png")).toBe("image");
    expect(classifyMedia("ipfs://bafy/clip.mp4")).toBe("video");
    expect(classifyMedia("ipfs://bafy/song.mp3")).toBe("audio");
    expect(classifyMedia("ipfs://bafy/meta.json")).toBeNull();
    expect(classifyMedia("ipfs://")).toBeNull();
  });

  it("keeps isImageUrl a strict image predicate (video/audio are NOT images)", () => {
    expect(isImageUrl("https://example.com/a.mp4")).toBe(false);
    expect(isImageUrl("https://example.com/a.mp3")).toBe(false);
    expect(isImageUrl("https://example.com/a.png")).toBe(true);
  });
});

describe("countMediaUrls — counts image/video/audio links in text", () => {
  it("counts every media kind and ignores plain links / trailing punctuation", () => {
    const text =
      "pic https://x.io/a.png a clip https://x.io/b.mp4. audio https://x.io/c.mp3, " +
      "and a page https://x.io/read plus ipfs://bafy/d.webm";
    expect(countMediaUrls(text)).toBe(4); // png + mp4 + mp3 + ipfs webm; the /read page is not counted
  });

  it("is zero when there is no media link", () => {
    expect(countMediaUrls("just words and https://x.io/page here")).toBe(0);
  });
});

describe("resolveMediaSrc — alias of resolveImageSrc", () => {
  it("resolves ipfs:// and passes http(s) through, same as resolveImageSrc", () => {
    expect(resolveMediaSrc("ipfs://bafyCID/clip.mp4")).toBe(`${IPFS_GATEWAY}bafyCID/clip.mp4`);
    expect(resolveMediaSrc("https://example.com/a.mp4")).toBe("https://example.com/a.mp4");
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
