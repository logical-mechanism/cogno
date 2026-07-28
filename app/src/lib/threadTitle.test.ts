// A suppression guard applied to one of several sibling renders. The title effect checked the
// operator's serve denylist and not the viewer's own block, so a blocked author's name and post text
// went into the tab strip, the window switcher and any bookmark taken from the page — while the card
// underneath rendered "You've blocked this account".

import { describe, it, expect } from "vitest";
import { threadDocumentTitle, DEFAULT_THREAD_TITLE } from "./threadTitle";
import { handleOf } from "./ss58";

const AUTHOR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const focal = { author: AUTHOR, authorDisplayName: "Alice", text: "hello world" };
const clear = { denied: false, blocked: false };

describe("threadDocumentTitle", () => {
  it("names the author and quotes the post when nothing is suppressed", () => {
    expect(threadDocumentTitle(focal, clear)).toBe("Alice on cogno: “hello world”");
  });

  it("says nothing about a BLOCKED author", () => {
    expect(threadDocumentTitle(focal, { denied: false, blocked: true })).toBe(DEFAULT_THREAD_TITLE);
  });

  it("says nothing about a DENIED post", () => {
    expect(threadDocumentTitle(focal, { denied: true, blocked: false })).toBe(DEFAULT_THREAD_TITLE);
  });

  it("falls back to the handle when the author has no display name", () => {
    expect(threadDocumentTitle({ ...focal, authorDisplayName: undefined }, clear)).toBe(
      `${handleOf(AUTHOR)} on cogno: “hello world”`,
    );
  });

  it("hardens the name and the snippet — a tab label is user text too", () => {
    const t = threadDocumentTitle(
      { author: AUTHOR, authorDisplayName: "Al‮ice", text: "line\nbreak" },
      clear,
    );
    expect(t).not.toContain("‮");
    expect(t).not.toContain("\n");
  });

  it("clips a long post and keeps the author line", () => {
    const t = threadDocumentTitle({ ...focal, text: "x".repeat(200) }, clear);
    expect(t.startsWith("Alice on cogno: “")).toBe(true);
    expect(t).toContain("…");
    expect(t.length).toBeLessThan(120);
  });

  it("degrades to the bare title with no focal (loading / missing)", () => {
    expect(threadDocumentTitle(null, clear)).toBe(DEFAULT_THREAD_TITLE);
  });
});
