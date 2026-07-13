import { describe, it, expect, vi } from "vitest";
import { createSignal } from "./homeSignal";
import { isSamePath } from "@/hooks/useNavReTap";

describe("createSignal", () => {
  it("fires every subscriber on emit", () => {
    const s = createSignal();
    const a = vi.fn();
    const b = vi.fn();
    s.subscribe(a);
    s.subscribe(b);

    s.emit();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("emitting with no subscribers is a no-op (Home is unmounted → the nav link just navigates)", () => {
    const s = createSignal();
    expect(() => s.emit()).not.toThrow();
    expect(s.size()).toBe(0);
  });

  it("unsubscribe detaches only that listener", () => {
    const s = createSignal();
    const a = vi.fn();
    const b = vi.fn();
    const offA = s.subscribe(a);
    s.subscribe(b);

    offA();
    s.emit();

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(s.size()).toBe(1);
  });

  it("a listener that unsubscribes DURING emit does not make the next one get skipped", () => {
    const s = createSignal();
    const second = vi.fn();
    const off = s.subscribe(() => off());
    s.subscribe(second);

    s.emit();

    // Mutating the Set mid-iteration would drop `second` if emit() iterated it live.
    expect(second).toHaveBeenCalledTimes(1);
    expect(s.size()).toBe(1);
  });

  it("re-emits (a second Home tap fires the listener again)", () => {
    const s = createSignal();
    const fn = vi.fn();
    s.subscribe(fn);

    s.emit();
    s.emit();

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isSamePath", () => {
  it("ignores a trailing slash (nav hrefs carry one, usePathname may not)", () => {
    expect(isSamePath("/explore", "/explore/")).toBe(true);
    expect(isSamePath("/explore/", "/explore")).toBe(true);
    expect(isSamePath("/", "/")).toBe(true);
  });

  it("does not treat root as a prefix of every route", () => {
    expect(isSamePath("/explore/", "/")).toBe(false);
    expect(isSamePath("/", "/explore/")).toBe(false);
  });

  it("is a whole-path compare, not a prefix one — a profile subpage is NOT the profile root", () => {
    // The nav's own `match` predicates are prefix matches; re-tap must not reuse them, or clicking
    // Profile from /u/<me>/followers/ would scroll in place instead of going back to the profile.
    expect(isSamePath("/u/5Grw/followers/", "/u/5Grw/")).toBe(false);
    expect(isSamePath("/u/5Grw/", "/u/5Grw/")).toBe(true);
  });

  it("distinguishes sibling routes", () => {
    expect(isSamePath("/notifications/", "/bookmarks/")).toBe(false);
  });
});
