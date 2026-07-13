import { describe, it, expect } from "vitest";
import { safeReturnTo, readReturnTo, welcomeUrlFor, DEFAULT_RETURN } from "./returnTo";

describe("safeReturnTo", () => {
  it("keeps a same-origin path (the whole point: a shared post link survives the auth wall)", () => {
    expect(safeReturnTo("/post/123/")).toBe("/post/123/");
    expect(safeReturnTo("/u/5Grw/")).toBe("/u/5Grw/");
    expect(safeReturnTo("/explore/?q=cardano")).toBe("/explore/?q=cardano");
  });

  it("falls back to the feed when there is nothing to return to", () => {
    expect(safeReturnTo(null)).toBe(DEFAULT_RETURN);
    expect(safeReturnTo(undefined)).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("")).toBe(DEFAULT_RETURN);
  });

  // THE open redirect. The browser reads "//evil.tld" and "/\evil.tld" as PROTOCOL-RELATIVE — they are
  // fully-qualified offsite URLs that merely look like paths, and a naive startsWith("/") waves them
  // straight through. An attacker who can hand you a cogno link that silently lands on their phishing
  // page (asking you to "reconnect your wallet") gets everything.
  it("rejects protocol-relative URLs — they look like paths but navigate OFFSITE", () => {
    expect(safeReturnTo("//evil.tld")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("//evil.tld/post/1/")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("/\\evil.tld")).toBe(DEFAULT_RETURN);
  });

  it("rejects absolute and scheme-bearing URLs", () => {
    expect(safeReturnTo("https://evil.tld")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("http://evil.tld/post/1/")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("javascript:alert(1)")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("data:text/html,x")).toBe(DEFAULT_RETURN);
  });

  it("rejects relative paths (only an absolute in-app path is trustworthy)", () => {
    expect(safeReturnTo("post/1/")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("../settings/")).toBe(DEFAULT_RETURN);
  });

  it("rejects control characters and whitespace", () => {
    expect(safeReturnTo("/post/1/\n")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("/\tjavascript:alert(1)")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("/post /1/")).toBe(DEFAULT_RETURN);
  });

  it("never returns to /welcome — that is the wall itself, and it would loop", () => {
    expect(safeReturnTo("/welcome")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("/welcome/")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("/welcome/?next=%2Fwelcome%2F")).toBe(DEFAULT_RETURN);
  });
});

describe("readReturnTo", () => {
  it("pulls the destination out of a query string", () => {
    expect(readReturnTo("?next=%2Fpost%2F123%2F")).toBe("/post/123/");
  });

  it("defaults to the feed when the parameter is absent or hostile", () => {
    expect(readReturnTo("")).toBe(DEFAULT_RETURN);
    expect(readReturnTo("?other=1")).toBe(DEFAULT_RETURN);
    expect(readReturnTo("?next=https%3A%2F%2Fevil.tld")).toBe(DEFAULT_RETURN);
    expect(readReturnTo("?next=%2F%2Fevil.tld")).toBe(DEFAULT_RETURN);
  });
});

describe("welcomeUrlFor", () => {
  it("remembers the post you were trying to open", () => {
    expect(welcomeUrlFor("/post/123/", "")).toBe("/welcome/?next=%2Fpost%2F123%2F");
  });

  it("carries the query string along (an Explore search survives too)", () => {
    expect(welcomeUrlFor("/explore/", "?q=cardano")).toBe("/welcome/?next=%2Fexplore%2F%3Fq%3Dcardano");
  });

  it("does not tack ?next=/ onto the common case — opening the app plainly", () => {
    expect(welcomeUrlFor("/", "")).toBe("/welcome/");
  });

  it("round-trips: what welcomeUrlFor writes, readReturnTo reads back", () => {
    const url = welcomeUrlFor("/post/123/", "");
    expect(readReturnTo(url.slice(url.indexOf("?")))).toBe("/post/123/");
  });

  it("a hostile pathname cannot smuggle an offsite target into the welcome url", () => {
    expect(welcomeUrlFor("//evil.tld", "")).toBe("/welcome/");
  });
});
