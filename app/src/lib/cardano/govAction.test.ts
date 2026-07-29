// Golden-vector tests for the CIP-129 decode and the status derivation. Both are pure, and both are
// the kind of code that is wrong in a way nothing downstream notices: a decode that silently drops a
// byte resolves the WRONG action, and a status that defaults to "open" tells a reader an expired
// action is still being voted on.

import { describe, it, expect } from "vitest";
import { parseGovActionId, govActionStatus } from "./govAction";

// A REAL preprod governance action (ParameterChange, "Reduce minPoolCost to 75 ada…"), checked against
// this deployment's own db-sync: tx e641ec80…f69c index 0.
const REAL_ID = "gov_action1ueq7eqptkyy7z58fyrrvqwr7shewl5cfgjjx6zxssgftme2q76wqqvxkqlu";
const REAL_TX = "e641ec802bb109e150e920c6c0387e85f2efd30944a46d08d08212bde540f69c";

describe("parseGovActionId", () => {
  it("decodes a real preprod governance action id", () => {
    expect(parseGovActionId(REAL_ID)).toEqual({ txHash: REAL_TX, index: 0 });
  });

  it("accepts surrounding whitespace and mixed case, which a paste carries", () => {
    expect(parseGovActionId(`  ${REAL_ID.toUpperCase()}  `)).toEqual({
      txHash: REAL_TX,
      index: 0,
    });
  });

  // Every rejection below is a REFUSAL, not a best guess. Resolving the wrong action would attach a
  // poll to a proposal nobody chose, and there is no delete_post to undo it.
  it("rejects another bech32 identifier with a valid checksum", () => {
    // A dRep id: correct bech32, wrong prefix entirely.
    expect(
      parseGovActionId("drep1yf6rudz7w9kz4etshj0njg7fjtd0c4frgsds6f8e6ep47ygl6sw74"),
    ).toBeNull();
  });

  it("rejects a one-character corruption, because the checksum is the whole point", () => {
    const flipped = REAL_ID.slice(0, -1) + (REAL_ID.endsWith("u") ? "w" : "u");
    expect(parseGovActionId(flipped)).toBeNull();
  });

  it("rejects a character outside the bech32 alphabet", () => {
    // "b", "i", "o" and "1" are excluded from the charset precisely to survive transcription.
    expect(parseGovActionId(REAL_ID.replace(/q/, "b"))).toBeNull();
  });

  it("rejects an empty or obviously wrong input rather than throwing", () => {
    for (const bad of ["", "   ", "gov_action1", "not an id", "gov_action1qqqq"]) {
      expect(parseGovActionId(bad)).toBeNull();
    }
  });

  // CIP-129's payload is a 32-byte tx hash plus a ONE-byte index. The Conway CDDL allows a two-byte
  // index and no authoritative source says how CIP-129 would encode one, so a payload of any other
  // length is refused as unparseable rather than read as if the extra byte were not there.
  //
  // Both vectors below carry a VALID checksum over the gov_action hrp, generated for this test. That
  // matters: an invented string would fail at the checksum step and this test would pass while the
  // length check went unexercised.
  it("rejects a valid-checksum payload that is not exactly 33 bytes", () => {
    // 32 bytes: the tx hash with no index byte.
    expect(
      parseGovActionId("gov_action1ueq7eqptkyy7z58fyrrvqwr7shewl5cfgjjx6zxssgftme2q76wqgjjjvq"),
    ).toBeNull();
    // 34 bytes: a two-byte index, which CIP-129 does not specify.
    expect(
      parseGovActionId("gov_action1ueq7eqptkyy7z58fyrrvqwr7shewl5cfgjjx6zxssgftme2q76wqqqqu72ynh"),
    ).toBeNull();
  });

  // The index is a full byte, and the top of its range must survive the 5-bit regrouping.
  it("decodes the largest one-byte index", () => {
    expect(
      parseGovActionId("gov_action1ueq7eqptkyy7z58fyrrvqwr7shewl5cfgjjx6zxssgftme2q76w07ur726w"),
    ).toEqual({ txHash: REAL_TX, index: 255 });
  });
});

describe("govActionStatus", () => {
  // The terminal fields win, and they are checked in ledger order. An action that was ENACTED also has
  // an expiration in the past, so reading `expiration` first would report a landed action as expired —
  // the single most misleading thing this function could say.
  it("reports an enacted action as enacted, not expired, despite a past expiration", () => {
    expect(govActionStatus({ enacted_epoch: 300, expiration: 295 }, 400)).toEqual({
      kind: "enacted",
      epoch: 300,
    });
  });

  it("prefers enacted over ratified when both are set", () => {
    expect(govActionStatus({ ratified_epoch: 298, enacted_epoch: 300 }, 400)).toEqual({
      kind: "enacted",
      epoch: 300,
    });
  });

  it("reports ratified, dropped and expired from their own fields", () => {
    expect(govActionStatus({ ratified_epoch: 298 }, 400)).toEqual({ kind: "ratified", epoch: 298 });
    expect(govActionStatus({ dropped_epoch: 299 }, 400)).toEqual({ kind: "dropped", epoch: 299 });
    expect(govActionStatus({ expired_epoch: 310 }, 400)).toEqual({ kind: "expired", epoch: 310 });
  });

  // The live case at the time this shipped: preprod epoch 303, action expires at 310.
  it("reports an action still inside its expiration as open", () => {
    expect(govActionStatus({ expiration: 310 }, 303)).toEqual({ kind: "open", expiresEpoch: 310 });
  });

  it("reports a passed expiration as expired even with no terminal epoch set", () => {
    expect(govActionStatus({ expiration: 310 }, 311)).toEqual({ kind: "expired", epoch: 310 });
  });

  // "Still open for voting" is a claim about right now. On a failed epoch read it must not be made.
  it("is unknown when the current epoch could not be read, never open", () => {
    expect(govActionStatus({ expiration: 310 }, null)).toEqual({ kind: "unknown" });
  });

  it("is unknown when the ledger gave no expiration at all", () => {
    expect(govActionStatus({}, 303)).toEqual({ kind: "unknown" });
  });

  // Epoch 0 is a real epoch and must not be read as absent, which is the trap a falsy test would hit.
  it("treats epoch 0 as a value, not as missing", () => {
    expect(govActionStatus({ enacted_epoch: 0 }, 400)).toEqual({ kind: "enacted", epoch: 0 });
  });
});
