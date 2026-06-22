// lib/identicon — a tiny, PURE, DETERMINISTIC blockies-style identicon generator.
//
// D6: every account has a stable visual even with no Profile.avatar. The seed is the ss58 address.
// This is OFFLINE + pure: same seed → same image, forever, no network, no crypto API. It produces a
// vertically-mirrored 5×5 grid of cells (the classic Ethereum "blockies" silhouette) with a derived
// foreground + background colour, returned as plain data the Avatar component renders as inline SVG
// <rect>s (so it inherits no external resource + can't break layout).
//
// The PRNG is the xorshift128 used by the original `blockies` library — chosen because it is trivial,
// dependency-free, and deterministic across engines. We seed it from the address string.

const SIZE = 5; // 5×5 grid, X-mirrored → classic blockie
const SCALE = 1; // unit cells; the SVG viewBox is SIZE×SIZE and the consumer scales it.

interface Rng {
  rand: () => number; // [0,1)
}

// xorshift128 seeded from the address chars (verbatim blockies seeding).
function makeRng(seed: string): Rng {
  const randseed = new Int32Array(4);
  for (let i = 0; i < seed.length; i++) {
    randseed[i % 4] = (randseed[i % 4] << 5) - randseed[i % 4] + seed.charCodeAt(i);
  }
  const rand = (): number => {
    const t = randseed[0] ^ (randseed[0] << 11);
    randseed[0] = randseed[1];
    randseed[1] = randseed[2];
    randseed[2] = randseed[3];
    randseed[3] = randseed[3] ^ (randseed[3] >> 19) ^ t ^ (t >> 8);
    return (randseed[3] >>> 0) / 0x100000000;
  };
  return { rand };
}

function createColor(rng: Rng): string {
  // hue 0..360, near-full sat, mid-high lightness → a vivid but readable cell colour.
  const h = Math.floor(rng.rand() * 360);
  const s = rng.rand() * 60 + 40; // 40..100%
  const l = (rng.rand() + rng.rand() + rng.rand() + rng.rand()) * 25; // 0..100, bell-ish
  return `hsl(${h} ${Math.round(s)}% ${Math.round(l)}%)`;
}

export interface Identicon {
  /** SIZE — the grid is SIZE×SIZE; viewBox is `0 0 SIZE SIZE`. */
  size: number;
  /** background colour (CSS) for the empty cells. */
  bg: string;
  /** the filled cells as unit `{x,y,fill}`; consumer renders <rect width=1 height=1>. */
  cells: Array<{ x: number; y: number; fill: string }>;
}

/**
 * Deterministically derive an identicon for an ss58 address. Pure + offline. The same address always
 * yields the same Identicon. Cell colour is either the foreground or an occasional "spot" colour, per
 * the blockies algorithm (3-way: 0=bg, 1=fg, 2=spot).
 */
export function identiconFor(address: string): Identicon {
  const seed = (address || "cogno").toLowerCase();
  const rng = makeRng(seed);

  const color = createColor(rng);
  const bgColor = createColor(rng);
  const spotColor = createColor(rng);

  const dataWidth = Math.ceil(SIZE / 2);
  const mirrorWidth = SIZE - dataWidth;

  const cells: Array<{ x: number; y: number; fill: string }> = [];

  for (let y = 0; y < SIZE; y++) {
    const row: number[] = [];
    for (let x = 0; x < dataWidth; x++) {
      // 0..2.3 → biased toward bg(0)/fg(1), occasional spot(2)
      row[x] = Math.floor(rng.rand() * 2.3);
    }
    // mirror the left half onto the right
    const mirrored = row.slice(0, mirrorWidth).reverse();
    const full = row.concat(mirrored);

    for (let x = 0; x < full.length; x++) {
      const v = full[x];
      if (v === 0) continue; // background → no rect
      cells.push({ x, y, fill: v === 1 ? color : spotColor });
    }
  }

  return { size: SIZE, bg: bgColor, cells };
}

export const IDENTICON_SCALE = SCALE;
