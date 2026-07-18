import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rememberContentRoute, consumeReturnTarget } from "./onboardingReturn";

const KEY = "cg:returnAfterOnboarding";

// vitest runs under `environment: "node"`, so window/sessionStorage don't exist. Install a minimal
// in-memory sessionStorage on globalThis.window for the duration of each test (the browser supplies the
// real one; the module already tolerates its absence via try/catch).
function installStorage() {
  const map = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
  return map;
}

describe("onboardingReturn", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("records a post or profile deep-link", () => {
    rememberContentRoute("/post/123/");
    expect(store.get(KEY)).toBe("/post/123/");
    rememberContentRoute("/u/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY/");
    expect(store.get(KEY)).toBe("/u/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY/");
  });

  it("never records a hub surface itself", () => {
    for (const p of ["/", "/explore/", "/legal/", "/privacy/"]) rememberContentRoute(p);
    expect(store.has(KEY)).toBe(false);
  });

  it("forgets a remembered content route on arriving at a hub surface", () => {
    for (const hub of ["/", "/explore/", "/legal/", "/privacy/"]) {
      store.set(KEY, "/post/7/");
      rememberContentRoute(hub);
      expect(store.has(KEY)).toBe(false); // wandered to the feed → the timeline is the right landing
    }
  });

  it("preserves a remembered content route through /welcome and walled routes", () => {
    for (const passthrough of ["/welcome/", "/settings/", "/compose/", "/notifications/"]) {
      store.set(KEY, "/post/7/");
      rememberContentRoute(passthrough);
      expect(store.get(KEY)).toBe("/post/7/"); // funnelling to onboard must keep the content route
    }
  });

  it("prefers an explicit ?next= over the remembered route, leaving it intact", () => {
    store.set(KEY, "/post/1/");
    expect(consumeReturnTarget("?next=%2Fu%2Fabc%2F")).toBe("/u/abc/");
    expect(store.get(KEY)).toBe("/post/1/"); // ?next won → remembered not consumed
  });

  it("returns the remembered route when there is no ?next=, and clears it", () => {
    store.set(KEY, "/post/9/");
    expect(consumeReturnTarget("")).toBe("/post/9/");
    expect(store.has(KEY)).toBe(false); // consumed → cleared so a later onboarding can't reuse it
  });

  it("falls back to the timeline when nothing is remembered", () => {
    expect(consumeReturnTarget("")).toBe("/");
  });

  it("validates a tampered remembered value through safeReturnTo", () => {
    store.set(KEY, "//evil.tld"); // protocol-relative = offsite
    expect(consumeReturnTarget("")).toBe("/");
  });
});
