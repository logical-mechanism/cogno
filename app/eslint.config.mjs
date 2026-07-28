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
  {
    // Bucket-key derivation divergence — the class, not the instance.
    //
    // Every device-local store is keyed `<prefix>:<who>`, with `<prefix>:anon` when `who` is null. The
    // store is therefore only as correct as the `who` each caller derives, and thirty-one call sites
    // derived it by hand. Three of them wrote `gate.status === "ready" ? (gate.address ?? null) : null`
    // where the other twenty-eight wrote the bare `viewer.address ?? null`, and the two disagree for
    // the whole window before the CIP-8 bind resolves — so those three read `cg-blocked:anon` while
    // every other surface wrote `cg-blocked:<ss58>`. A block landed, a toast confirmed it, and the row
    // came back.
    //
    // `lib/viewerBucket.ts` fixes the three; THIS is what stops the thirty-second. It is deliberately a
    // syntax ban rather than a type-level one: both expressions typecheck, and both are individually
    // reasonable — `status === "ready"` is the correct guard for a write AFFORDANCE. What is never
    // correct is gating an ADDRESS on it, because that turns "we haven't resolved the bind yet" into
    // "this is a different person's device state".
    name: "cogno/viewer-bucket-derivation",
    ignores: ["src/lib/viewerBucket.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.left.property.name='status'][test.right.value='ready']:has(MemberExpression[property.name='address'])",
          message:
            "Do not gate a viewer address on `status === \"ready\"` — that derives a DIFFERENT device-local bucket key while the CIP-8 bind is still resolving. Use `viewerBucket(viewer)` from @/lib/viewerBucket. (`status === \"ready\"` is still the right guard for a write affordance; just not for an address.)",
        },
      ],
    },
  },
]);
