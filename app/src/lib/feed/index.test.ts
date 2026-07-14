// Pure-logic test for the read-path selector. There is exactly ONE reader — the PAPI-direct node
// source — so `makeFeedSource` always returns it, for any api handle.

import { describe, it, expect } from "vitest";
import { makeFeedSource } from "./index";
import type { CognoApi } from "@/lib/types";

// The selector never touches the api until a method is called.
const fakeApi = {} as unknown as CognoApi;

describe("makeFeedSource — the sole PAPI-direct reader", () => {
  it("returns a reader exposing the whole read surface", () => {
    const src = makeFeedSource(fakeApi);
    for (const method of [
      "liveHeadId", // the NextPostId liveness signal the home feed pages off
      "page",
      "thread",
      "profile",
      "poll",
      "viewerPollChoice",
      "viewerPostState",
      "followEdges",
      "whoToFollow",
      "searchPeople",
    ] as const) {
      expect(typeof src[method]).toBe("function");
    }
  });
});
