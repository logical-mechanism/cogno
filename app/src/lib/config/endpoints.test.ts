// Pure-logic tests for the Sponsored-Bind Relay endpoint config (D1 bind-funding). The vitest env is
// 'node' (no window), so these exercise the SSG-safe default path + the setter's url validation.

import { describe, it, expect } from "vitest";
import { DEFAULT_BIND_RELAY_URL, getBindRelayUrl, setBindRelayUrl } from "./endpoints";

describe("bind-relay endpoint config", () => {
  it("defaults to the localhost relay (:8091, distinct from the :8090 follower)", () => {
    expect(DEFAULT_BIND_RELAY_URL).toBe("http://127.0.0.1:8091");
    expect(getBindRelayUrl()).toBe(DEFAULT_BIND_RELAY_URL);
  });

  it("setBindRelayUrl rejects a non-http(s) url", () => {
    expect(() => setBindRelayUrl("ws://nope")).toThrow();
    expect(() => setBindRelayUrl("relay.example")).toThrow();
  });

  it("setBindRelayUrl accepts an http(s) url (a no-op without window, but must not throw)", () => {
    expect(() => setBindRelayUrl("https://relay.example")).not.toThrow();
    expect(() => setBindRelayUrl("http://127.0.0.1:8091")).not.toThrow();
  });
});
