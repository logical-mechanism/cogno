// ESLint flat config (ESLint 9 / Next 16). Next 16 removed the `next lint` command and defaults to
// flat config, so `npm run lint` calls the ESLint CLI directly (`eslint . --max-warnings 0`).
// `eslint-config-next/core-web-vitals` is the flat-config array equivalent of the old
// `extends: "next/core-web-vitals"` (Next + react/react-hooks/import/jsx-a11y/@typescript-eslint).
// The globalIgnores cover the generated PAPI descriptors, the headless verification scripts (not app
// source), the static-export output, the Next build dir, and next-env.d.ts.

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([".papi/**", "scripts/**", "out/**", ".next/**", "next-env.d.ts"]),
  {
    // On, so a stale `eslint-disable` (there are 12 inline exhaustive-deps suppressions) becomes visible
    // the moment the code under it changes — otherwise a suppression outlives the problem it was hiding
    // and silently keeps suppressing the NEXT one.
    linterOptions: { reportUnusedDisableDirectives: "warn" },
  },
  {
    // The two React-Compiler-readiness advisories eslint-config-next 16 enables by default. They are
    // not correctness rules — they flag code the compiler declines to auto-memoize — and here they fire
    // 73 times on two patterns that are deliberate:
    //
    //   set-state-in-effect (47 hits): every chain-reading hook clears its state synchronously when its
    //     input goes null (`if (!api) { setX(null); return; }`) before re-subscribing. The suggested fix
    //     — derive during render — renders one frame of the PREVIOUS account's data.
    //   refs (26 hits): the latest-value ref (`sourceRef.current = source` in the render body), which is
    //     what lets a best-block-driven refetch read fresh props WITHOUT resubscribing every block. The
    //     suggested fix — sync it in an effect — reads a stale value for exactly one commit, which is
    //     the bug the pattern exists to avoid.
    //
    // Off, not a warning budget: a numeric ceiling silently grants headroom for new violations anywhere
    // in the app, and neither rule reaches zero without adopting the React Compiler. Turn them back on
    // as errors if that happens. Nothing else in app/ is suppressed.
    name: "cogno/react-compiler-advisories",
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },
]);
