import { describe, it, expect } from "vitest";
import { ABUSE_EMAIL, MIN_AGE, OPERATOR_LEGAL_NAME, REPO_URL, reportMailto } from "./operator";

// No mocks: this module is pure constants plus one string builder, and it deliberately reads no
// `window` and no localStorage (see its header). The point of pinning it is that three surfaces
// (/policy, /legal, Settings > About) and the post ··· menu all render these values, so a silent
// change here is a contact address that is right on one page and wrong on another.

describe("operator identity", () => {
  it("publishes the same abuse address the repo does", () => {
    // POLICY.md and SECURITY.md both name this address. A drift here sends reports nowhere.
    expect(ABUSE_EMAIL).toBe("support@logicalmechanism.io");
  });

  it("uses the entity name the app already published, not the repo's one-word form", () => {
    // LICENSE/NOTICE say "LogicalMechanism"; every user-facing surface says the LLC form.
    expect(OPERATOR_LEGAL_NAME).toBe("Logical Mechanism LLC");
  });

  it("states a minimum age as a number, so /policy and /legal cannot disagree on it", () => {
    expect(typeof MIN_AGE).toBe("number");
    expect(MIN_AGE).toBeGreaterThanOrEqual(13);
  });

  it("points at the canonical repo over https", () => {
    expect(REPO_URL.startsWith("https://github.com/")).toBe(true);
  });
});

describe("reportMailto", () => {
  const link = "https://cogno.forum/post/42/";

  it("addresses the abuse mailbox", () => {
    expect(reportMailto("Report: post 42", link).startsWith(`mailto:${ABUSE_EMAIL}?`)).toBe(true);
  });

  it("puts the permalink in the body so a report is actionable without a follow-up", () => {
    const url = new URL(reportMailto("Report: post 42", link));
    expect(url.searchParams.get("body")).toContain(link);
  });

  it("carries the subject through verbatim", () => {
    const url = new URL(reportMailto("Report: post 42", link));
    expect(url.searchParams.get("subject")).toBe("Report: post 42");
  });

  it("percent-encodes, so a subject with & or # cannot truncate the mailto or forge a field", () => {
    // The failure this pins: an unencoded "&cc=" in a subject would become a real mailto header, and
    // an unencoded "#" would end the URL early and drop the body (the link) entirely.
    const raw = reportMailto("a&cc=evil@x.test#frag", link);
    expect(raw).not.toContain("&cc=evil");
    expect(raw).not.toContain("#frag");
    const url = new URL(raw);
    expect(url.searchParams.get("subject")).toBe("a&cc=evil@x.test#frag");
    expect(url.searchParams.get("body")).toContain(link);
  });

  it("keeps the link on its own first line, ahead of the prompt", () => {
    const url = new URL(reportMailto("s", link));
    const body = url.searchParams.get("body") ?? "";
    expect(body.split("\n")[0]).toBe(link);
  });
});
