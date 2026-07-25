import { describe, it, expect } from "vitest";
import {
  canonicalTag,
  isCanonicalTag,
  parseTopics,
  topicOfQuery,
  bodyHasTopic,
  tagSearchTerm,
  TOPIC_MAX_LEN,
} from "./topics";
import { segment } from "./postText";

describe("canonicalTag", () => {
  it("strips the leading # and folds ASCII case", () => {
    expect(canonicalTag("#Cardano")).toBe("cardano");
    expect(canonicalTag("Cardano")).toBe("cardano");
    expect(canonicalTag("#DEV")).toBe("dev");
  });

  it("leaves non-ASCII case ALONE — the node folds ASCII only", () => {
    // eq_ignore_ascii_case: é and É are different bytes to the node's scan, so canonicalizing them
    // together would produce a topic whose search can never match. They stay two topics.
    expect(canonicalTag("#café")).toBe("café");
    expect(canonicalTag("#CAFÉ")).toBe("cafÉ");
    expect(canonicalTag("#café")).not.toBe(canonicalTag("#CAFÉ"));
  });

  it("accepts unicode letters, numbers and underscore", () => {
    expect(canonicalTag("#日本語")).toBe("日本語");
    expect(canonicalTag("#a_1")).toBe("a_1");
    expect(canonicalTag("#2026")).toBe("2026");
  });

  it("rejects empty, punctuation-bearing and over-long tags", () => {
    expect(canonicalTag("#")).toBeNull();
    expect(canonicalTag("")).toBeNull();
    expect(canonicalTag("#a-b")).toBeNull();
    expect(canonicalTag("#a b")).toBeNull();
    expect(canonicalTag("#a.b")).toBeNull();
    expect(canonicalTag(`#${"a".repeat(TOPIC_MAX_LEN)}`)).toBe("a".repeat(TOPIC_MAX_LEN));
    expect(canonicalTag(`#${"a".repeat(TOPIC_MAX_LEN + 1)}`)).toBeNull();
  });
});

describe("isCanonicalTag", () => {
  it("is the storage validator — only already-canonical values pass", () => {
    expect(isCanonicalTag("cardano")).toBe(true);
    expect(isCanonicalTag("Cardano")).toBe(false); // not folded
    expect(isCanonicalTag("#cardano")).toBe(false); // carries the '#'
    expect(isCanonicalTag("a b")).toBe(false);
    expect(isCanonicalTag("")).toBe(false);
    expect(isCanonicalTag("a".repeat(TOPIC_MAX_LEN + 1))).toBe(false);
  });

  it("accepts what canonicalTag produces, for every valid input", () => {
    for (const raw of ["#Cardano", "#café", "#日本語", "#a_1", "#2026"]) {
      const t = canonicalTag(raw);
      expect(t).not.toBeNull();
      expect(isCanonicalTag(t as string)).toBe(true);
    }
  });
});

describe("parseTopics", () => {
  it("collects tags in first-appearance order, deduped and folded", () => {
    expect(parseTopics("hello #Cardano and #dev and #cardano again")).toEqual(["cardano", "dev"]);
  });

  it("ignores a URL fragment — the tokenizer classifies it as a URL, never a tag", () => {
    expect(parseTopics("see https://example.org/#cardano")).toEqual([]);
  });

  it("does not treat a longer tag as the shorter one", () => {
    expect(parseTopics("#cardanoNFT")).toEqual(["cardanonft"]);
    expect(parseTopics("#cardanoNFT")).not.toContain("cardano");
  });

  it("sees through invisible separators, matching what the reader sees", () => {
    // `#car<ZWSP>dano` renders as `#cardano` because sanitizeText strips the ZWSP. If the parser did
    // not sanitize, the post would render under a tag it was excluded from.
    const body = "#car​dano";
    expect(parseTopics(body)).toEqual(["cardano"]);
  });

  it("is idempotent under re-sanitizing (safe to call on already-clean text)", () => {
    const body = "#a #b";
    expect(parseTopics(body)).toEqual(parseTopics(`${body}`));
  });

  it("returns [] for a body with no tags", () => {
    expect(parseTopics("")).toEqual([]);
    expect(parseTopics("plain text, no tags")).toEqual([]);
  });

  it("drops an over-long tag rather than truncating it", () => {
    expect(parseTopics(`#${"a".repeat(TOPIC_MAX_LEN + 1)}`)).toEqual([]);
  });
});

describe("topicOfQuery", () => {
  it("recognizes exactly one hashtag token as a topic", () => {
    expect(topicOfQuery("#cardano")).toBe("cardano");
    expect(topicOfQuery("  #Cardano  ")).toBe("cardano");
  });

  it("is null for a multi-term or non-tag query — those stay plain searches", () => {
    expect(topicOfQuery("#a #b")).toBeNull();
    expect(topicOfQuery("#a foo")).toBeNull();
    expect(topicOfQuery("cardano")).toBeNull();
    expect(topicOfQuery("")).toBeNull();
    expect(topicOfQuery("#")).toBeNull();
  });
});

describe("bodyHasTopic", () => {
  it("is exact, not substring — this is what narrows the node's superset", () => {
    expect(bodyHasTopic("about #cardano", "cardano")).toBe(true);
    expect(bodyHasTopic("about #cardanoNFT", "cardano")).toBe(false);
    expect(bodyHasTopic("see https://x.org/#cardano", "cardano")).toBe(false);
  });

  it("matches regardless of the author's casing", () => {
    expect(bodyHasTopic("about #CARDANO", "cardano")).toBe(true);
  });
});

describe("tagSearchTerm", () => {
  it("is the term handed to the node's substring scan", () => {
    expect(tagSearchTerm("cardano")).toBe("#cardano");
  });
});

describe("render/parse agreement", () => {
  it("every hashtag segment the renderer emits canonicalizes to a parsed topic", () => {
    const body = "#Cardano #café #a_1 https://x.org/#frag #cardanoNFT plain";
    const rendered = segment(body)
      .filter((s) => s.kind === "hashtag")
      .map((s) => canonicalTag(s.value))
      .filter((t): t is string => t !== null);
    expect(parseTopics(body)).toEqual([...new Set(rendered)]);
  });
});
