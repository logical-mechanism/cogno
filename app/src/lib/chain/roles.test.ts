// F10 — unknown state rendered as a confirmed negative.
//
// `useRoles` publishes `observed` as `ObservedRoleView[] | null`, where `null` means the live
// `ObservedRoles` watch has not answered. RolesSection wrote `(roles.observed ?? [])` and branched on
// the first entry, so a VERIFIED SPO or dRep was shown the full "Enter your SPO verification key"
// wizard on the ordinary loading path of every Settings open — and permanently whenever the watch
// errored, because its error callback wrote `[]` where `Providers.tsx` writes `null` for the same read.
//
// The three-state return is the guard: a caller cannot index this, so there is no `?? []` to write.

import { describe, it, expect } from "vitest";
import { roleStatusOf, type ObservedRoleView } from "./roles";

// `weight` is irrelevant to roleStatusOf (it answers "do you hold this role", never "how much"), so a
// plain 0n is fine here — and pinning it proves the two stay independent: a zero-weight role is still a
// VERIFIED role. That is the whole point of counting participation apart from stake.
const spo: ObservedRoleView = { kind: "Spo", id: "0x" + "ab".repeat(28), weight: 15_000_000n };
const drep: ObservedRoleView = { kind: "DRep", id: "0x" + "cd".repeat(28), weight: 0n };

describe("roleStatusOf", () => {
  it("reports LOADING for an unresolved read, never 'none'", () => {
    expect(roleStatusOf(null, "Spo")).toBe("loading");
    expect(roleStatusOf(null, "DRep")).toBe("loading");
  });

  it("reports NONE only for a resolved empty set", () => {
    expect(roleStatusOf([], "Spo")).toBe("none");
  });

  it("reports VERIFIED when the set holds that kind", () => {
    expect(roleStatusOf([spo], "Spo")).toBe("verified");
  });

  it("does not let one kind vouch for another", () => {
    expect(roleStatusOf([spo], "DRep")).toBe("none");
    expect(roleStatusOf([drep], "Spo")).toBe("none");
  });

  it("handles an mSPO holding several SPO entries", () => {
    const second: ObservedRoleView = { kind: "Spo", id: "0x" + "ef".repeat(28), weight: 0n };
    expect(roleStatusOf([spo, second], "Spo")).toBe("verified");
  });
});
