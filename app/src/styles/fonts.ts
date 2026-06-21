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
// X uses one UI sans for body and chrome alike; we do too. The old Reading-Room
// build used Source Serif for post bodies — the X-clone drops it (the post body
// is now the UI sans), so @fontsource-variable/source-serif-4 is no longer
// imported here (it stays in package.json, unused, harmless).

// UI sans (variable weight axis) — drives every visible glyph.
import "@fontsource-variable/inter-tight";

// Mono — IBM Plex Mono for ss58 handles / addresses. Only the weights the UI
// uses (400 body, 500 emphasis).
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

/**
 * Truthy marker so the root layout can `import { FONTS_LOADED } from ".../fonts"`
 * as a value, guaranteeing this side-effect module is included in the bundle and
 * not tree-shaken away.
 */
export const FONTS_LOADED = true;
