// Pure-logic test for the read-path selector. There is exactly ONE reader — the PAPI-direct node
// source — so `makeFeedSource` always returns it, for any api handle.

import { describe, it, expect } from "vitest";
import { makeFeedSource } from "./index";
import type { CognoApi } from "@/lib/types";
import type { PolkadotClient } from "polkadot-api";

// The selector never touches the api or the client until a method is called.
const fakeApi = {} as unknown as CognoApi;
const fakeClient = {} as unknown as PolkadotClient;

describe("makeFeedSource — the sole PAPI-direct reader", () => {
  it("returns a reader exposing the whole read surface", () => {
    const src = makeFeedSource(fakeApi, fakeClient);
    for (const method of [
      "liveHeadId", // the NextPostId liveness signal the home feed pages off
      "page",
      "thread",
      "profile",
      "poll",
      "viewerPollChoice",
      // The two poll-position reads. Listed for the same reason as everything above them: the test's
      // claim is the WHOLE read surface, and a list that quietly stops tracking the interface asserts
      // a coverage it does not have.
      "pollChoices",
      "pollVoters",
      // The PAGED roster. Listed for exactly the reason above: the roster surface reads through this
      // now, and an interface method the selector forgot to pass through would fail at runtime only.
      "pollVoterTotals",
      "pollVotersPage",
      "viewerPostState",
      "followEdges",
      "whoToFollow",
      "searchPeople",
    ] as const) {
      expect(typeof src[method]).toBe("function");
    }
  });
});
