// Contrast guard for the tokens that carry TEXT ON A FILL.
//
// This exists because the review got the danger button exactly backwards. It reported "the danger label
// is black-on-red in Settings and white-on-red in ConfirmDialog" as though black-on-red were the defect.
// It is the other way round: black-on-red is ~4.50:1 and white-on-red is ~4.11:1, so the WHITE one was
// the failure — and standardising on white (the obvious reading of the finding) would have taken two
// AA-borderline buttons and pushed them clearly under the floor.
//
// Nothing else in this repo can catch that. There are no component or DOM tests; check-tokens.mjs
// verifies a token RESOLVES, not that its value is legible. So the ratio is asserted here, in arithmetic,
// against the real values parsed out of tokens.css.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");

/** Every value a token takes across the theme blocks (:root, [data-theme=dark], [data-theme=light]). */
function valuesOf(name: string): string[] {
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, "g");
  const out: string[] = [];
  for (const m of TOKENS.matchAll(re)) out.push(m[1]);
  if (out.length === 0) throw new Error(`token --${name} not found (or not a hex literal) in tokens.css`);
  return out;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG AA for NORMAL text. `--cg-fs-sm` is 15px and the danger buttons use it; AA "large" needs
 * 18.66px bold / 24px, so there is no large-text escape hatch here — 4.5:1 is the floor that applies.
 */
const AA_NORMAL = 4.5;

describe("token contrast: text on a coloured fill", () => {
  it("danger labels clear AA against the danger fill, in EVERY theme", () => {
    const fills = valuesOf("cg-danger");
    const labels = valuesOf("cg-danger-contrast");
    expect(fills.length).toBeGreaterThan(0);
    expect(labels.length).toBe(fills.length); // the token must exist in every block that defines the fill

    for (const fill of fills) {
      for (const label of labels) {
        expect(contrast(label, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it("accent labels clear AA against the accent fill, in EVERY theme", () => {
    // The pill that is re-declared ~18 times. Guarded for the same reason.
    const fills = valuesOf("cg-accent");
    const labels = valuesOf("cg-accent-contrast");
    expect(labels.length).toBe(fills.length); // the label must exist in every block that defines the fill
    // --cg-accent and --cg-accent-contrast flip together per theme, so pair them by POSITION rather than
    // cross-producting (a dark fill with a light theme's label is not a combination that renders).
    //
    // By position, not by `labels[fills.indexOf(fill)]`: two theme blocks currently declare the SAME
    // accent (:root and [data-theme=dark] are both #eff3f4), and indexOf collapses the second onto the
    // first — so that block's label was never actually tested. It passed only because the duplicate
    // blocks also share a label. Change one theme's contrast without changing its fill and the guard
    // would have gone quiet on exactly the theme that broke.
    fills.forEach((fill, i) => {
      expect(contrast(labels[i], fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  it("PINS the regression: white-on-danger is BELOW the floor (this is what the review told us to ship)", () => {
    const danger = valuesOf("cg-danger")[0];
    expect(contrast("#ffffff", danger)).toBeLessThan(AA_NORMAL);
  });
});
