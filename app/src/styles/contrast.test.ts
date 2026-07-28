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

/**
 * Every value an rgba() token takes across the theme blocks, in the same block order as `valuesOf`.
 * The wash/hover/active tokens are translucent, so what the user's eye (and an accessibility audit)
 * actually sees is the COMPOSITE over whatever solid sits behind them.
 */
function rgbaValuesOf(name: string): Array<[number, number, number, number]> {
  const re = new RegExp(`--${name}:\\s*rgba\\(([^)]+)\\)\\s*;`, "g");
  const out: Array<[number, number, number, number]> = [];
  for (const m of TOKENS.matchAll(re)) {
    const [r, g, b, a] = m[1].split(",").map((p) => Number(p.trim()));
    out.push([r, g, b, a]);
  }
  if (out.length === 0) throw new Error(`token --${name} not found (or not an rgba literal) in tokens.css`);
  return out;
}

/** `rgba(fg)` painted over an opaque `bg`, as a hex string. */
function composite([r, g, b, a]: [number, number, number, number], bg: string): string {
  let h = bg.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const base = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (
    "#" +
    [r, g, b]
      .map((c, i) => Math.round(a * c + (1 - a) * base[i]))
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * The TEXT RAMP.
 *
 * This is the guard the danger/accent tests above did NOT provide: they cover text on a COLOURED FILL,
 * which is a handful of buttons. The ramp is every other word on the site, and it was the thing actually
 * failing — PageSpeed flagged --cg-text-secondary at 3.87:1 on the guest sign-in card and --cg-text-muted
 * at 3.01:1 on the /legal footer.
 *
 * The trap the old values fell into is that a token can pass on ONE background and fail on the rest.
 * --cg-text-secondary #71767b cleared 4.58:1 against pure black and was under the floor on every other
 * surface in the app. So the assertion is a cross-product: every text tier against every background it
 * can land on, INCLUDING the translucent ones after compositing. For light-on-dark the lightest
 * background is the worst case; for dark-on-light the darkest is. Cross-producting covers both without
 * having to encode which theme is which.
 *
 * Pairing is BY POSITION, for the same reason spelled out in the accent test: :root and
 * [data-theme="dark"] declare identical values, so any index-of lookup silently collapses them.
 */
describe("token contrast: the text ramp on every background it can land on", () => {
  const TEXT_TIERS = ["cg-text", "cg-text-secondary", "cg-text-muted"];
  const SOLID_BGS = ["cg-bg", "cg-bg-elevated", "cg-bg-subtle"];
  /** Translucent surfaces, each painted over --cg-bg of the same theme block. */
  const WASH_BGS = ["cg-accent-wash", "cg-bg-active", "cg-bg-hover"];

  it("every text tier clears AA on every SOLID background, in EVERY theme", () => {
    const blocks = valuesOf("cg-bg").length;
    for (const tier of TEXT_TIERS) {
      const fg = valuesOf(tier);
      expect(fg.length).toBe(blocks); // the tier must be declared in every block that declares a bg
      for (const bgName of SOLID_BGS) {
        const bgs = valuesOf(bgName);
        expect(bgs.length).toBe(blocks);
        fg.forEach((color, i) => {
          const ratio = contrast(color, bgs[i]);
          expect(
            ratio,
            `--${tier} ${color} on --${bgName} ${bgs[i]} (theme block ${i}) = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
  });

  it("every text tier clears AA on every TRANSLUCENT background once composited, in EVERY theme", () => {
    const pageBgs = valuesOf("cg-bg");
    for (const tier of TEXT_TIERS) {
      const fg = valuesOf(tier);
      for (const washName of WASH_BGS) {
        const washes = rgbaValuesOf(washName);
        expect(washes.length).toBe(pageBgs.length);
        fg.forEach((color, i) => {
          const solid = composite(washes[i], pageBgs[i]);
          const ratio = contrast(color, solid);
          expect(
            ratio,
            `--${tier} ${color} on --${washName} over --cg-bg => ${solid} (theme block ${i}) = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
  });

  /**
   * Clearing AA is necessary but not sufficient. The naive repair (lift each token to just past 4.5:1)
   * lands secondary on #858a8f and muted on #868a8e — a 1.01:1 separation, i.e. the same colour. That
   * would trade a contrast bug for a hierarchy bug, so the distinctness is pinned too. 1.25:1 is the
   * floor; the shipped ramp sits at ~1.38:1 dark and ~1.37:1 light, against ~1.52:1 before the fix.
   */
  it("secondary and muted stay visually DISTINCT, in EVERY theme", () => {
    const secondary = valuesOf("cg-text-secondary");
    const muted = valuesOf("cg-text-muted");
    expect(muted.length).toBe(secondary.length);
    secondary.forEach((s, i) => {
      const ratio = contrast(s, muted[i]);
      expect(
        ratio,
        `--cg-text-secondary ${s} vs --cg-text-muted ${muted[i]} (theme block ${i}) = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(1.25);
    });
  });
});
