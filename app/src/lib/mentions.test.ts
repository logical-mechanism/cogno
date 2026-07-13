import { describe, it, expect } from "vitest";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import {
  mentionToken,
  mentionLabel,
  serializeMentions,
  reconcileMentions,
  parseMentionBody,
  validSs58Prefix,
  type MentionRef,
} from "./mentions";

// Two real, checksummed AccountId32 addresses (dev keys), encoded at the chain prefix (42).
const ALICE = ss58Address("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d", 42);
const BOB = ss58Address("0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48", 42);

const ref = (display: string, ss58: string): MentionRef => ({ display, ss58 });

describe("mentionLabel", () => {
  it("shows the display name when there is one", () => {
    expect(mentionLabel("alice", ALICE)).toBe("alice");
  });

  it("falls back to the truncated ss58 when the account is nameless / unbound / still loading", () => {
    expect(mentionLabel(undefined, ALICE)).toBe(mentionLabel(undefined, ALICE));
    expect(mentionLabel(undefined, ALICE)).toContain("…");
    expect(mentionLabel(undefined, ALICE)).not.toBe("");
  });

  it("never returns an empty label (a whitespace-only name falls back too)", () => {
    expect(mentionLabel("", ALICE)).toContain("…");
    expect(mentionLabel("   ", ALICE)).toContain("…");
    expect(mentionLabel("\n\t", ALICE)).toContain("…");
  });

  // The griefing case. A post body is `white-space: pre-wrap` and a display name is attacker-controlled
  // (pallet-profile bounds it by length only, feelessly). An un-collapsed name carrying newlines would
  // render them as HARD LINE BREAKS inside someone ELSE's permanent, undeletable post.
  it("collapses newlines in a name, so a mention can never break the line of the post that mentions it", () => {
    expect(mentionLabel("a\n".repeat(31) + "b", ALICE)).not.toContain("\n");
    expect(mentionLabel("Alice\nSmith", BOB)).toBe("Alice Smith");
  });

  it("collapses tabs and interior space runs too", () => {
    expect(mentionLabel("Alice\t\tSmith", ALICE)).toBe("Alice Smith");
    expect(mentionLabel("Alice     Smith", ALICE)).toBe("Alice Smith");
    expect(mentionLabel("  Alice Smith  ", ALICE)).toBe("Alice Smith");
  });
});

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

// The composer's registry rule. Both ways it can go wrong put a WRONG BODY on chain, and this chain has
// no `delete_post` — so each case below is a permanent-corruption regression test, not a UX one.
describe("reconcileMentions", () => {
  const DRAFT = `hey ${mentionToken("alice")} welcome`; // "hey @alice welcome"
  const picked = [ref("alice", ALICE)];

  it("prunes a ref whose token the user deleted (it degrades to plain text, never mis-binds)", () => {
    expect(reconcileMentions(picked, "hey welcome", null)).toEqual([]);
  });

  it("keeps a ref whose token is still in the text", () => {
    expect(reconcileMentions(picked, DRAFT, null)).toEqual(picked);
  });

  it("returns the SAME array when nothing changed (so the effect does not churn a re-render)", () => {
    expect(reconcileMentions(picked, DRAFT, { text: "x", refs: [] })).toBe(picked);
  });

  // THE BUG THIS RULE EXISTS FOR. Submit clears the box, which prunes the registry to []. If the tx
  // FAILS, the surface hands the display text back — and without the restore, `serializeMentions` (a
  // no-op on an empty registry) would leave "@alice" LITERAL and the retry would post an UNBOUND mention.
  it("restores the submitted draft's bindings when the surface hands that exact text back", () => {
    const submitted = { text: DRAFT, refs: picked };
    expect(reconcileMentions([], "", submitted)).toEqual([]); // the optimistic clear prunes to empty
    expect(reconcileMentions([], DRAFT, submitted)).toEqual(picked); // ...and the restore brings them back
  });

  it("restores even if the user typed while the tx was in flight (the box is not disabled)", () => {
    const submitted = { text: DRAFT, refs: picked };
    expect(reconcileMentions([], "a new thought", submitted)).toEqual([]);
    expect(reconcileMentions([], DRAFT, submitted)).toEqual(picked);
  });

  // THE OPPOSITE FAILURE, which is WORSE: a mention bound to the WRONG ACCOUNT. The snapshot outlives a
  // SUCCESSFUL post, and a display name is not unique across accounts. A user who later picks a DIFFERENT
  // "alice" and retypes the same sentence must keep THEIR pick — restoring over it would silently swap
  // the mention back to the first alice.
  it("NEVER overwrites a ref the user actively picked, even on an exact text match", () => {
    const submitted = { text: DRAFT, refs: [ref("alice", ALICE)] };
    const repicked = [ref("alice", BOB)]; // same display name, a DIFFERENT account
    expect(reconcileMentions(repicked, DRAFT, submitted)).toEqual(repicked);
    // and the body really does bind to the account the user picked, not the snapshot's
    expect(serializeMentions(DRAFT, reconcileMentions(repicked, DRAFT, submitted))).toContain(BOB);
  });

  it("does not restore into an unrelated draft that merely contains the same token", () => {
    const submitted = { text: DRAFT, refs: picked };
    expect(reconcileMentions([], `different sentence ${mentionToken("alice")}`, submitted)).toEqual([]);
  });

  it("ignores an empty-text snapshot (nothing was ever submitted)", () => {
    expect(reconcileMentions([], "", { text: "", refs: picked })).toEqual([]);
  });
});
