import { describe, it, expect } from "vitest";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import {
  mentionToken,
  serializeMentions,
  parseMentionBody,
  validSs58Prefix,
  type MentionRef,
} from "./mentions";

// Two real, checksummed AccountId32 addresses (dev keys), encoded at the chain prefix (42).
const ALICE = ss58Address("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d", 42);
const BOB = ss58Address("0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48", 42);

const ref = (display: string, ss58: string): MentionRef => ({ display, ss58 });

describe("serializeMentions", () => {
  it("expands a display token to @<ss58>", () => {
    const text = `${mentionToken("elon")} hi`;
    expect(serializeMentions(text, [ref("elon", ALICE)])).toBe(`@${ALICE} hi`);
  });

  it("is a no-op with no mentions or no '@' in the text", () => {
    expect(serializeMentions("just text", [])).toBe("just text");
    expect(serializeMentions("no at here", [ref("elon", ALICE)])).toBe("no at here");
  });

  it("expands several distinct mentions, each to its own ss58", () => {
    const text = `hey ${mentionToken("elon")} and ${mentionToken("bob")}!`;
    expect(serializeMentions(text, [ref("elon", ALICE), ref("bob", BOB)])).toBe(
      `hey @${ALICE} and @${BOB}!`,
    );
  });

  it("matches the LONGEST display first (a name that is a prefix of another)", () => {
    const text = `${mentionToken("elon musk")} vs ${mentionToken("elon")}`;
    const out = serializeMentions(text, [ref("elon", BOB), ref("elon musk", ALICE)]);
    expect(out).toBe(`@${ALICE} vs @${BOB}`);
  });

  it("supports a display name containing spaces", () => {
    const text = `cc ${mentionToken("Elon Musk")} thanks`;
    expect(serializeMentions(text, [ref("Elon Musk", ALICE)])).toBe(`cc @${ALICE} thanks`);
  });

  it("leaves a token the user extended into a longer word as plain text (no mis-serialize)", () => {
    // "@elonx" must NOT serialize to elon's ss58 — the token boundary requires a non-name char after.
    expect(serializeMentions("@elonx", [ref("elon", ALICE)])).toBe("@elonx");
    // …but a real boundary (punctuation / whitespace / end) DOES match.
    expect(serializeMentions("@elon.", [ref("elon", ALICE)])).toBe(`@${ALICE}.`);
    expect(serializeMentions("@elon", [ref("elon", ALICE)])).toBe(`@${ALICE}`);
  });
});

describe("parseMentionBody", () => {
  it("finds a checksum-valid @<ss58> mention", () => {
    const body = `hi @${ALICE} there`;
    const found = parseMentionBody(body);
    expect(found).toHaveLength(1);
    expect(found[0].ss58).toBe(ALICE);
    expect(found[0].raw).toBe(`@${ALICE}`);
    expect(body.slice(found[0].index, found[0].index + found[0].length)).toBe(`@${ALICE}`);
  });

  it("rejects a well-formed-looking but checksum-invalid base58 run", () => {
    // '5'.repeat(48) passes the loose length/charset gate but fails the blake2b checksum.
    expect(parseMentionBody(`@${"5".repeat(48)}`)).toEqual([]);
    expect(parseMentionBody("@notanaddressjusttext")).toEqual([]);
  });

  it("finds multiple mentions in order", () => {
    const found = parseMentionBody(`@${ALICE} and @${BOB}`);
    expect(found.map((m) => m.ss58)).toEqual([ALICE, BOB]);
  });

  it("consumes only the valid ss58 prefix when a char is glued to the address", () => {
    // A trailing '.' or a glued base58 char must not defeat detection.
    const dot = parseMentionBody(`@${ALICE}.`);
    expect(dot).toHaveLength(1);
    expect(dot[0].ss58).toBe(ALICE);
    expect(dot[0].raw).toBe(`@${ALICE}`);
  });
});

describe("validSs58Prefix", () => {
  it("returns the address + consumed length for a valid run", () => {
    const hit = validSs58Prefix(ALICE);
    expect(hit?.ss58).toBe(ALICE);
    expect(hit?.length).toBe(ALICE.length);
  });
  it("returns null for junk", () => {
    expect(validSs58Prefix("5".repeat(48))).toBeNull();
    expect(validSs58Prefix("short")).toBeNull();
  });
});

describe("serialize → parse round-trip (the cross-client interop contract)", () => {
  it("a composed draft round-trips to the same accounts, in order", () => {
    const mentions = [ref("Elon Musk", ALICE), ref("bob", BOB)];
    const draft = `gm ${mentionToken("Elon Musk")}, ping ${mentionToken("bob")} 👋`;
    const body = serializeMentions(draft, mentions);
    const parsed = parseMentionBody(body);
    expect(parsed.map((m) => m.ss58)).toEqual([ALICE, BOB]);
  });
});
