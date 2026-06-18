// Vitest config — PURE-LOGIC unit tests only (no jsdom, no React/DOM rendering).
// We test the deterministic seam: wallet derivation, capacity replay, CIP-8 bind payload
// defense, post-event extraction/error mapping, and the feed-source selector. Anything that
// needs the browser (MeshJS, PAPI sockets) is mocked, so this runs in the plain 'node' env.

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig's "@/*" -> "./src/*" so test imports match app imports.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // No global setup: every mock is declared per-file so a test reads as a closed unit.
    globals: false,
  },
});
