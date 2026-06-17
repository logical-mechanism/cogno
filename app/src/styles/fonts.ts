// cogno-chain — LOCAL FONT REGISTRATION
// ======================================
// Side-effect imports of the three local @fontsource packages so the static
// export ships its own fonts. There is NO Google-Fonts <link> or fetch anywhere
// in the app — telemetry-free / neutral by design. Importing this module (once,
// from the root layout) registers the @font-face rules for the three families.
//
// IMPORTANT: the @font-face family names these packages register MUST stay in
// sync with the --font-serif / --font-ui / --font-mono values in
// src/styles/tokens.css:
//   "Source Serif 4 Variable"  -> --font-serif  (post body)
//   "Inter Tight Variable"     -> --font-ui     (chrome)
//   "IBM Plex Mono"            -> --font-mono    (chain-truth)

// Post body — variable serif (weight axis).
import "@fontsource-variable/source-serif-4";

// Chrome — variable UI sans (weight axis).
import "@fontsource-variable/inter-tight";

// Chain-truth — IBM Plex Mono. Only the weights the UI uses (400 body, 500 emphasis).
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

/**
 * Truthy marker so the root layout can `import { FONTS_LOADED } from ".../fonts"`
 * as a value, guaranteeing this side-effect module is included in the bundle and
 * not tree-shaken away.
 */
export const FONTS_LOADED = true;
