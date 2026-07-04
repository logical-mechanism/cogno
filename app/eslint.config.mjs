// ESLint flat config (ESLint 9 / Next 16). Replaces the legacy .eslintrc.json — Next 16 removed the
// `next lint` command and defaults to flat config, so `npm run lint` now calls the ESLint CLI directly
// (`eslint .`). `eslint-config-next/core-web-vitals` is the flat-config array equivalent of the old
// `extends: "next/core-web-vitals"` (same Next + react/react-hooks/import/jsx-a11y/@typescript-eslint
// rule set). The globalIgnores mirror the old `ignorePatterns`: generated PAPI descriptors, the headless
// verification scripts (not app source), the static-export output, the Next build dir, and next-env.d.ts.

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([".papi/**", "scripts/**", "out/**", ".next/**", "next-env.d.ts"]),
  {
    // ESLint 9 flat config defaults `reportUnusedDisableDirectives` to "warn"; ESLint 8 (the prior
    // toolchain) defaulted it OFF. Keep it OFF so this dependency bump preserves the exact prior lint
    // contract instead of newly flagging pre-existing `eslint-disable` comments (a separate cleanup).
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    // eslint-config-next 16 upgraded eslint-plugin-react-hooks to v7, which adds a batch of
    // React-Compiler-readiness rules that did NOT exist in the v14 config's plugin. They are advisory
    // (cascading-render / ref-during-render / manual-memoization patterns), not correctness findings —
    // this is a live, shipped SPA whose 170 units pass — and satisfying them means refactoring ~60
    // working effects/refs. That is out of scope for a dependency-currency bump, so they are DEFERRED
    // to a dedicated react-hooks-7 follow-up rather than silently churned here. Every other react-hooks
    // rule (incl. the load-bearing `exhaustive-deps`) stays at its config-next default severity.
    name: "cogno/defer-react-hooks-7-advisories",
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);
