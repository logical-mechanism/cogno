// cogno-chain — LOCAL FONT REGISTRATION
// ======================================
// Side-effect imports of the local @fontsource packages so the static export
// ships its own fonts. There is NO Google-Fonts <link> or fetch anywhere in the
// app — telemetry-free / neutral by design. Importing this module (once, from
// the root layout) registers the @font-face rules.
//
// IMPORTANT: the @font-face family names these packages register MUST stay in
// sync with the --cg-font-ui / --cg-font-mono values in src/styles/tokens.css:
//   "Inter Tight Variable"  -> --cg-font-ui    (everything: body, chrome, names)
//   "IBM Plex Mono"         -> --cg-font-mono  (truncated ss58 handles, addresses)
//
// X uses one UI sans for body and chrome alike; we do too. (The old Reading-Room build used Source Serif
// for post bodies; the X-clone dropped it, and the package has now been dropped too.)

// UI sans (variable weight axis) — drives every visible glyph.
import "@fontsource-variable/inter-tight";

// Mono — IBM Plex Mono for ss58 handles / addresses. Only the weights the UI
// uses (400 body, 500 emphasis).
//
// LATIN SUBSET ONLY, deliberately. The unsuffixed `400.css` declares five @font-face blocks (cyrillic,
// cyrillic-ext, greek, latin-ext, latin); `latin-400.css` declares one. Every glyph this face ever
// renders is ASCII — truncated ss58 handles, Cardano tx hashes, RPC endpoints in Diagnostics, an error
// code — so the other four subsets are pure render-blocking CSS weight that can never match anything.
//
// The UI face below is NOT subsetted the same way, and must not be: it renders user-generated post
// bodies and display names, which are routinely Cyrillic / Greek / Vietnamese. `unicode-range` already
// means those subsets are only DOWNLOADED when a page actually contains such text, so keeping them
// costs a little CSS and nothing else. Dropping them would silently render real users' posts in a
// fallback face.
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";

/**
 * Truthy marker so the root layout can `import { FONTS_LOADED } from ".../fonts"`
 * as a value, guaranteeing this side-effect module is included in the bundle and
 * not tree-shaken away.
 */
export const FONTS_LOADED = true;
