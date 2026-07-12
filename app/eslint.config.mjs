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
    // On, so a stale `eslint-disable` (there are 13 inline exhaustive-deps suppressions) becomes visible
    // the moment the code under it changes — otherwise a suppression outlives the problem it was hiding
    // and silently keeps suppressing the NEXT one.
    linterOptions: { reportUnusedDisableDirectives: "warn" },
  },
  {
    // The three react-hooks-7 advisories (React-Compiler-readiness: cascading-render / ref-during-render
    // / manual-memoization). They were "off" while the dependency bump landed; they are now WARNINGS
    // under a ratchet — `npm run lint` passes `--max-warnings <N>`, and N comes down with each refactor
    // that removes a real hit. They stay at "warn" rather than "error" on purpose: a minority of the hits
    // are legitimate (the StrictMode re-arm in the batch-cache providers, useTheme's hydration reconcile),
    // so the ratchet floor will not reach zero and a blanket "fix them all" sweep is the wrong move.
    //
    // The `preserve-manual-memoization` hits are NOT cosmetic — they are the compiler telling us a
    // useMemo is decorative because its dep is rebuilt every render (see useVote's returned arrows).
    name: "cogno/react-hooks-7-ratchet",
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);
