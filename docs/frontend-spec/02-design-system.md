# 02 — Design System & Tokens

This is the foundation doc for the cogno-chain frontend redesign. It defines the **complete visual language** the rest of the spec is built on: every color, type, space, radius, shadow, motion, icon, and focus token, with **concrete values** for both themes. The target is a faithful clone of X/Twitter's actual visual system — dense single-column timeline, hairline dividers, 9999px pill buttons, 15px base type, sticky blurred header, hover-tinted action icons — re-skinned with the **cogno teal/verdigris accent** in place of Twitter's blue (`#1d9bf0`). The app is **dark-first** (X's near-black default) with a working **light** theme, both fully specified here under the `--cg-*` token namespace. There is **no Tailwind**: the implementation is CSS Modules consuming these CSS custom properties. This doc ships a drop-in `tokens.css` skeleton at the end. Sibling docs reference these tokens by name and must never hardcode raw color, size, or motion values.

> **Migration note.** The existing `app/src/styles/tokens.css` is the old "Reading Room / Civic Ledger" paper-ink design (`--surface-*` / `--ink-*` / `--verdigris*` names, serif post body, `prefers-color-scheme`). That file and its prefixes are **replaced wholesale** by the `--cg-*` system here. The three local `@fontsource` packages already installed — `@fontsource-variable/inter-tight`, `@fontsource/ibm-plex-mono`, `@fontsource-variable/source-serif-4` — are **kept** (`app/src/styles/fonts.ts` still registers them); we reuse **Inter Tight** as the UI font and **IBM Plex Mono** for handles/ss58, and drop Source Serif from the active UI. Theme selection moves from `prefers-color-scheme` to an explicit `[data-theme]` attribute on `<html>` so the `ThemeToggle` works (see "Theme switching" below). See `01-information-architecture.md` for where the theme attribute is set on first paint, and `01-information-architecture.md` (app shell) + `03-component-library.md` §22.7 for `ThemeToggle` placement.

---

## 1. Design principles (how to match X)

These are non-negotiable fidelity rules. Every other doc assumes them.

1. **Near-black dark default.** Dark theme page background is pure `#000000` (X "Lights out" is `#000`; X "Dim" is `#15202b`; we ship the `#000` look as default and offer Light). Surfaces that sit *above* the page (cards on hover, modals, elevated menus, the compose box) use `#16181c`-family greys, never lighter-than-needed.
2. **Hairline structure, no heavy borders.** Rows in the timeline are separated by a single 1px divider in `--cg-border`. Cards are not boxed; the timeline is one continuous column of `PostCard`s divided by hairlines. Border width is **always 1px** unless explicitly stated.
3. **Pill geometry for actions.** Buttons (primary CTA, Follow, tabs-as-buttons) are fully rounded: `--cg-radius-pill` = `9999px`. Avatars are circular. Inputs and cards use a smaller radius.
4. **15px base, tight leading.** Body/UI text is `15px / 20px`. Type does not scale fluidly (no `clamp()` in the X clone) — it uses a fixed step scale.
5. **Dense, generous tap targets.** The timeline is dense vertically, but every interactive control has a ≥ 44×44px (mobile) / ≥ 34px (desktop icon) hit area via padding, even when the visible glyph is `1.25rem`.
6. **One accent, used decisively.** The cogno accent replaces Twitter blue on every load-bearing surface: primary buttons, links, active nav text + indicator, focus ring, the "Post" CTA, selected tab underline, the reply icon hover-tint, spinners. **Like** is a separate rose/pink (X uses pink `#f91880` for the heart — we keep a rose `--cg-like`). **Repost** is green (`--cg-repost`). **Danger** is red.
7. **Hover row highlight.** Hovering a `PostCard` row tints its background to `--cg-bg-hover`. Action icons additionally tint to their semantic color on hover (reply→accent, repost→green, like→rose, quote→accent, share→accent).
8. **Sticky blurred header.** The top app bar and the `TimelineTabs` bar are sticky with `backdrop-filter: blur(12px)` over a translucent page background.

---

## 2. Color system

### 2.1 How the ramp is organized

X's palette is, functionally: one page background, a couple of elevated greys, a hairline border, three text tiers (primary / secondary / muted), one brand accent (we swap to cogno teal), plus three semantic action colors (like-pink, repost-green, danger-red) and an overlay scrim. We map exactly that onto the canonical `--cg-*` names.

| Role | Token | Used for |
|---|---|---|
| Page background | `--cg-bg` | The app canvas behind everything |
| Elevated surface | `--cg-bg-elevated` | Modals, dropdown menus, toasts, the compose box, RightRail cards, hover-popovers |
| Row hover | `--cg-bg-hover` | `PostCard` row hover, list-item hover, menu-item hover |
| Hairline | `--cg-border` | Dividers between posts, input borders, card outlines, tab bar bottom rule |
| Text primary | `--cg-text` | Display names, post body, headings, primary labels |
| Text secondary | `--cg-text-secondary` | Handles, timestamps, secondary nav labels, metadata, action counts |
| Text muted | `--cg-text-muted` | Placeholders, disabled text, the faintest hints, divider dots |
| Accent | `--cg-accent` | Primary buttons, links, active nav, focus ring, spinners, selected-tab indicator |
| Accent hover | `--cg-accent-hover` | Hover/active state of accent buttons & links |
| Accent contrast | `--cg-accent-contrast` | Text/icon color **on top of** an accent fill (the "Post" button label) |
| Like | `--cg-like` | The heart (filled when liked), like-count when liked, like hover-tint |
| Repost | `--cg-repost` | Repost icon when reposted, repost-count when reposted, repost hover-tint |
| Danger | `--cg-danger` | Destructive actions (clear vote/profile, revoke), error toasts, over-limit warning text, the down-vote (secondary) active state |
| Overlay scrim | `--cg-overlay` | The dimmed backdrop behind modals/sheets |

### 2.2 Deriving the cogno accent (AA contrast)

The brand base is verdigris `#2e7d6b`. On a near-black dark surface, `#2e7d6b` is too dark/low-contrast for text and small UI, so the **dark-theme accent is lifted** to a brighter teal; on white it is **deepened**. Both chosen values clear WCAG AA (≥ 4.5:1 for normal text, ≥ 3:1 for large text/UI) against their theme's primary background, and the accent-contrast pairs clear AA against the accent fill.

- **Dark accent** `--cg-accent: #2ec4a6` — a lifted, slightly cyan-leaning verdigris. Contrast vs `#000` ≈ 9.0:1 (text-safe); vs `#16181c` ≈ 8.2:1. Reads as "teal", clearly not Twitter blue.
- **Dark accent fill contrast** `--cg-accent-contrast: #06140f` — near-black on the teal fill ≈ 8.5:1, so the "Post" button label is crisp. (We use a dark label on the bright-teal pill, matching how a saturated teal button wants dark text; X uses white-on-blue, but white-on-`#2ec4a6` is only ~2.0:1 and fails — so dark label is the correct AA choice. If a future, deeper accent fill is used, switch to `#ffffff` contrast.)
- **Dark accent hover** `--cg-accent-hover: #46d3b7` — one step brighter for hover/press.
- **Light accent** `--cg-accent: #1f6f5e` — a deepened verdigris. Contrast vs `#ffffff` ≈ 4.6:1 (text-safe AA) and stronger vs `#f7f9f9`.
- **Light accent fill contrast** `--cg-accent-contrast: #ffffff` — white on `#1f6f5e` ≈ 5.7:1.
- **Light accent hover** `--cg-accent-hover: #18584b`.

> Rationale: keeping `2e7d6b` as a literal only where it passes (it does **not** pass for dark-mode small text) would force per-context overrides. Instead each theme gets one AA-safe accent value, and components just use `--cg-accent`.

### 2.3 Concrete values — DARK (default)

```
--cg-bg:               #000000
--cg-bg-elevated:      #16181c
--cg-bg-hover:         #16181c   /* applied at low opacity in practice; see note */
--cg-bg-hover-solid:   #080808   /* a near-imperceptible row tint, used as fallback */
--cg-border:           #2f3336
--cg-text:             #e7e9ea
--cg-text-secondary:   #71767b
--cg-text-muted:       #565a5e
--cg-accent:           #2ec4a6
--cg-accent-hover:     #46d3b7
--cg-accent-contrast:  #06140f
--cg-like:             #f91880
--cg-repost:           #00ba7c
--cg-danger:           #f4212e
--cg-warning:          #f5a623   /* amber — the soft rate-limit kind */
--cg-overlay:          rgba(91, 112, 131, 0.40)
```

**Hover-tint companions** (10–15% alpha washes used as the *background* behind an action icon on hover, X-style):

```
--cg-accent-wash:      rgba(46, 196, 166, 0.12)   /* reply/quote/share icon hover bg */
--cg-like-wash:        rgba(249, 24, 128, 0.12)
--cg-repost-wash:      rgba(0, 186, 124, 0.12)
--cg-danger-wash:      rgba(244, 33, 46, 0.12)
```

> **Row hover note.** X tints the whole post row very slightly on hover. On pure-black, the cleanest approach is a translucent white wash so it composes over any nested surface: set `--cg-bg-hover: rgba(231, 233, 234, 0.03)` and apply it as a `background-color` overlay on the row. We expose **both** a translucent `--cg-bg-hover` (preferred) and a solid `--cg-bg-hover-solid` fallback; components should use `--cg-bg-hover`.

Final dark `--cg-bg-hover` value: `rgba(231, 233, 234, 0.03)`.

### 2.4 Concrete values — LIGHT

```
--cg-bg:               #ffffff
--cg-bg-elevated:      #ffffff   /* light modals are white with a shadow + border, not a grey */
--cg-bg-hover:         rgba(15, 20, 25, 0.03)
--cg-bg-hover-solid:   #f7f9f9
--cg-border:           #eff3f4
--cg-text:             #0f1419
--cg-text-secondary:   #536471
--cg-text-muted:       #8b98a5
--cg-accent:           #1f6f5e
--cg-accent-hover:     #18584b
--cg-accent-contrast:  #ffffff
--cg-like:             #f91880
--cg-repost:           #00ba7c
--cg-danger:           #f4212e
--cg-warning:          #b26a00   /* amber — the soft rate-limit kind */
--cg-overlay:          rgba(0, 0, 0, 0.40)
--cg-accent-wash:      rgba(31, 111, 94, 0.10)
--cg-like-wash:        rgba(249, 24, 128, 0.10)
--cg-repost-wash:      rgba(0, 186, 124, 0.10)
--cg-danger-wash:      rgba(244, 33, 46, 0.10)
```

> Light theme: the page is `#fff`, the secondary surface (`RightRail` cards, the explore search box, empty-state panels) is `#f7f9f9` — that's where `--cg-bg-elevated` differs from page in light mode. Because a white modal on a white page needs separation, light modals lean on `--cg-shadow-modal` + `--cg-border` rather than a fill change. For the secondary "filled" surface (search box bg, who-to-follow card bg) use an explicit alias:

```
--cg-bg-subtle:        #f7f9f9   /* LIGHT: filled secondary surface (search box, cards) */
                       #202327   /* DARK:  the equivalent filled secondary surface       */
```

Add `--cg-bg-subtle` to both themes (dark `#202327`, light `#f7f9f9`). Use it for the `SearchBar` field background, `RightRail` card backgrounds, and segmented controls — surfaces X fills with a faint grey.

### 2.5 Contrast budget (must hold)

| Pair | Theme | Ratio (approx) | Requirement | Pass |
|---|---|---|---|---|
| `--cg-text` on `--cg-bg` | dark | 16.1:1 | 4.5:1 | ✅ |
| `--cg-text-secondary` on `--cg-bg` | dark | 4.7:1 | 4.5:1 | ✅ |
| `--cg-text` on `--cg-bg` | light | 17.4:1 | 4.5:1 | ✅ |
| `--cg-text-secondary` on `--cg-bg` | light | 4.9:1 | 4.5:1 | ✅ |
| `--cg-accent` on `--cg-bg` | dark | 9.0:1 | 4.5:1 | ✅ |
| `--cg-accent` on `--cg-bg` | light | 4.6:1 | 4.5:1 | ✅ |
| `--cg-accent-contrast` on `--cg-accent` | dark | 8.5:1 | 4.5:1 | ✅ |
| `--cg-accent-contrast` on `--cg-accent` | light | 5.7:1 | 4.5:1 | ✅ |
| `--cg-border` on `--cg-bg` | both | ≥ 1.3:1 (non-text) | ~1.3:1 OK | ✅ |

`--cg-text-muted` is **intentionally below AA** (placeholders/disabled only) and must never carry information required to operate the app.

---

## 3. Typography

### 3.1 Font stack

X ships its proprietary **Chirp**. We approximate with the locally-vendored **Inter Tight** (already in `package.json`) plus a system fallback chain so first paint is never blank, and **IBM Plex Mono** for ss58 addresses/handles (the `@handle` mono voice). Source Serif is left registered but **unused** by the X-clone UI.

```
--cg-font-ui:   "Inter Tight Variable", -apple-system, BlinkMacSystemFont,
                "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
--cg-font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

- `--cg-font-ui` drives **everything** visible: display names, post body, nav, buttons, counts. (X uses one UI font for body and chrome alike; we do too.)
- `--cg-font-mono` is **only** for the truncated ss58 `Handle` (e.g. `@5CBEKoFC…f3K`), raw address displays in Settings, and any post id shown as a chain fact. Mono uses `font-variant-numeric: tabular-nums` so addresses/counts align.

> No Google Fonts `<link>` or network fetch — fonts are bundled. Keep importing `app/src/styles/fonts.ts` once from the root layout (it registers the `@font-face` rules). The CSS family name **must** stay `"Inter Tight Variable"` / `"IBM Plex Mono"` to match those packages.

### 3.2 Type scale (X's 13/15/17/20/23/31)

Fixed steps, no fluid scaling. Each step is `font-size / line-height` with a default weight. Names follow `--cg-fs-*` (size) and `--cg-lh-*` (line-height). Base UI = **15px**.

| Token | Size | px | Line-height token | LH | Default weight | Used for |
|---|---|---|---|---|---|---|
| `--cg-fs-xs` | 0.8125rem | 13px | `--cg-lh-xs` 16px (1.23) | `--cg-fw-regular` | Tiny meta: tab counts, byte counter, fine print, "Show this thread" |
| `--cg-fs-sm` | 0.9375rem | 15px | `--cg-lh-sm` 20px (1.33) | `--cg-fw-regular` | **Base.** Post body, handles, timestamps, nav labels, button text, counts |
| `--cg-fs-md` | 1.0625rem | 17px | `--cg-lh-md` 24px (1.41) | `--cg-fw-regular` | Focused single-post detail body (the post you opened in `/post/[id]`), composer textarea |
| `--cg-fs-lg` | 1.25rem | 20px | `--cg-lh-lg` 24px (1.2) | `--cg-fw-bold` | Section headings: header title ("Home", "Explore"), `ProfileHeader` display name |
| `--cg-fs-xl` | 1.4375rem | 23px | `--cg-lh-xl` 28px (1.22) | `--cg-fw-extrabold` | Large headings: onboarding `/welcome` headline, empty-state titles |
| `--cg-fs-2xl` | 1.9375rem | 31px | `--cg-lh-2xl` 36px (1.16) | `--cg-fw-extrabold` | Hero numbers / the biggest display copy (rare; profile stat hero, welcome wordmark line) |

**Letter-spacing:** UI text uses `0`. Large/bold headings (`--cg-fs-lg`+) tighten to `-0.01em` (`--cg-tracking-tight`). Mono handles use `0` (don't track monospace).

### 3.3 Weights (Inter Tight variable axis)

```
--cg-fw-regular:   400   /* body, handles, timestamps */
--cg-fw-medium:    500   /* nav labels, button text, active states, mono emphasis */
--cg-fw-semibold:  600   /* display names in PostCardHeader, count emphasis */
--cg-fw-bold:      700   /* headings (--cg-fs-lg), active LeftNav item, ProfileHeader name */
--cg-fw-extrabold: 800   /* the big headlines (--cg-fs-xl / 2xl), the "Post" CTA label */
```

> X renders display names at ~700 and the "Post" button label at ~700–800; body at 400; secondary metadata at 400. Match that: `PostCardHeader` display name = `--cg-fw-bold` (700) on desktop is too heavy at 15px — use `--cg-fw-semibold` (600) for the inline name in a `PostCard`, reserve 700 for headings and the `ProfileHeader` name.

### 3.4 Post-body size

The **timeline** post body uses base `--cg-fs-sm` (15px / 20px). The **focused post** at the top of `/post/[id]` (`ThreadView` root) renders larger at `--cg-fs-md` (17px / 24px), exactly as X enlarges the opened tweet. The **composer** textarea also uses `--cg-fs-md` (17px) so typing feels roomy, matching X's compose box. Post body always: `--cg-font-ui`, `white-space: pre-wrap`, `overflow-wrap: break-word`, color `--cg-text`. URLs auto-linked in `PostBody` render in `--cg-accent` with no underline until hover (see `03-component-library.md` §1 / §3).

### 3.5 Numerics

Counts (likes, reposts, replies) and the `ByteCounter` use **tabular figures** so they don't jitter as values change: `font-variant-numeric: tabular-nums`. The `ByteCounter` shows `used/512` in `--cg-fs-xs`; turns `--cg-danger` at/over the byte cap (see `09-surface-compose.md` + `03-component-library.md` §7–§11). ss58 in `--cg-font-mono` + `tabular-nums`.

---

## 4. Geometry, spacing, density

### 4.1 Radius

```
--cg-radius-pill:  9999px   /* buttons, Follow, tabs-as-pills, avatars(circle), badges */
--cg-radius-card:  16px     /* RightRail cards, modal containers, embedded QuotedPostEmbed, media-frame placeholders */
--cg-radius-input: 4px      /* text inputs that are NOT pill (rare) — most inputs are pill or the search field which is pill */
--cg-radius-sm:    8px      /* small wells: poll option bars, code-ish chips, menu container */
```

- **Avatars** are circles: `border-radius: var(--cg-radius-pill)` on a square box. Sizes in §4.4.
- **`QuotedPostEmbed`** uses `--cg-radius-card` (16px) with a `--cg-border` outline — X's quoted-tweet card.
- **`SearchBar`** field is a pill (`--cg-radius-pill`) filled with `--cg-bg-subtle`.
- **`PollCard` option bars** use `--cg-radius-sm` (8px) for the progress fill.
- **Modals/sheets** use `--cg-radius-card` (16px) on desktop; the mobile bottom-sheet variant rounds only the top corners (`16px 16px 0 0`).

### 4.2 Spacing scale (4px base)

```
--cg-space-1:  4px
--cg-space-2:  8px
--cg-space-3:  12px
--cg-space-4:  16px
--cg-space-5:  20px
--cg-space-6:  24px
--cg-space-7:  32px
--cg-space-8:  48px
```

Conventions (match X density):
- **`PostCard` padding:** `--cg-space-4` (16px) left/right, `--cg-space-3` (12px) top/bottom. Avatar column is `40px` (avatar) + `--cg-space-3` (12px) gutter to the content column.
- **Row divider:** the 1px `--cg-border` rule sits at the bottom of each `PostCard` (no vertical margin; padding does the breathing).
- **Action row** (`PostCardActions`) sits `--cg-space-2` (8px) below the post body; icons are spread `space-between` across the content column width (X caps the spread; we let them distribute with a `max-width: 425px`).
- **Header / tab bar height:** `53px` content + 1px border (X's header is ~53px). Tokenize as `--cg-header-h: 53px`.
- **Compose CTA button height:** desktop `52px` (the big left-rail "Post" pill), inline action buttons `36px`, Follow buttons `34px`.

### 4.3 Layout widths (referenced by `01-information-architecture.md` (app shell) + `03-component-library.md` §22.7)

Tokenize the three-column shell so the shell doc and feed doc agree:

```
--cg-col-feed:   600px   /* center timeline column max-width (X is 600) */
--cg-col-left:   275px   /* desktop LeftNav rail width (expanded) */
--cg-col-left-icononly: 88px  /* tablet collapsed icon rail */
--cg-col-right:  350px   /* RightRail width */
--cg-content-max: 1265px /* the whole 3-col cluster max-width before centering */
--cg-col-onboarding: 480px /* single-column onboarding/auth width (used by 11) */
```

### 4.4 Avatar sizes

```
--cg-avatar-sm:  24px   /* inline in dense lists, RightRail who-to-follow rows can use 40 */
--cg-avatar-md:  40px   /* DEFAULT — PostCard, comments */
--cg-avatar-lg:  48px   /* focused post in /post/[id] */
--cg-avatar-xl:  133px  /* ProfileHeader (X profile avatar ~133px, overlaps banner) */
```

All avatars are circular. The identicon fallback (deterministic from the ss58 address) fills the same circle — see `03-component-library.md` §1 / §3 for the `Avatar` component contract; this doc only fixes the sizes + circle geometry.

### 4.5 Z-index layers

```
--cg-z-base:      0
--cg-z-sticky:    100    /* sticky header + TimelineTabs + sticky compose footer */
--cg-z-fab:       200    /* mobile compose FAB, BottomTabBar */
--cg-z-dropdown:  300    /* PostCardActions "..." menu, profile menu */
--cg-z-overlay:   400    /* modal/sheet scrim */
--cg-z-modal:     410    /* ComposerModal, EditProfileModal, dialogs (above scrim) */
--cg-z-toast:     500    /* Toaster — above everything */
```

---

## 5. Iconography

### 5.1 Approach

**Inline SVG**, no icon-font, no runtime icon library dependency. Ship a small set of hand-picked SVGs as React components in `app/src/components/icons/` (one file per icon, `currentColor` fill/stroke so they inherit text color). This keeps the static export light and lets each icon tint via `color`. Match X's icon silhouettes (rounded, ~1.5px optical stroke at 24px viewBox, mostly **filled** glyphs for solid actions and **outline** for inactive states — X uses outline-when-inactive, filled-when-active for like/repost/bookmark).

### 5.2 Icon sizing

```
--cg-icon-sm:  1.125rem   /* 18px — inline, tab bar secondary */
--cg-icon-md:  1.25rem    /* 20px — DEFAULT: PostCardActions, nav glyphs */
--cg-icon-lg:  1.625rem   /* 26px — LeftNav primary glyphs, BottomTabBar */
```

Default action-row icon size is `--cg-icon-md` (20px). The icon's **hit area** is larger than the glyph: wrap each action icon in a `34px` (desktop) / `40px` (mobile) circular button whose background is transparent until hover.

### 5.3 Required icon set (canonical names → component file)

Implement at minimum (X-equivalent silhouettes):

| Icon | File | Where | Active variant |
|---|---|---|---|
| Reply (speech bubble outline) | `IconReply` | `PostCardActions` | — (no active fill) |
| Repost (two arrows in a loop) | `IconRepost` | `PostCardActions` | filled + `--cg-repost` when reposted |
| Like (heart outline) | `IconLike` | `PostCardActions` | **filled heart** + `--cg-like` when liked |
| Quote (quote-pen / overlapping bubbles) | `IconQuote` | `PostCardActions` overflow + `QuoteComposer` trigger | — |
| Share (up-arrow-out-of-tray) | `IconShare` | `PostCardActions` (copy-link) | — |
| Down-vote (chevron/arrow-down, secondary) | `IconDownvote` | `PostCardActions` overflow | active → `--cg-danger` |
| More (horizontal ellipsis) | `IconMore` | `PostCardHeader` / actions overflow | — |
| Home | `IconHome` | `LeftNav`, `BottomTabBar` | filled when route active |
| Search / Explore (magnifier) | `IconSearch` | `LeftNav`, `BottomTabBar`, `SearchBar` | filled when active |
| Profile (person outline) | `IconProfile` | `LeftNav`, `BottomTabBar` | filled when active |
| Settings (gear) | `IconSettings` | `LeftNav`, Settings entry | filled when active |
| Compose / Post (feather-pen or plus) | `IconCompose` | mobile FAB, `LeftNav` Post button | — |
| Poll (bar-chart) | `IconPoll` | `Composer` toolbar | — |
| Close (X) | `IconClose` | modals/sheets | — |
| Back (arrow-left) | `IconBack` | detail header, modal header | — |
| Check / Verify | `IconCheck` | toasts, success, poll "voted" | — |
| Spinner (see Motion) | `Spinner` | loading | — |
| Theme sun / moon | `IconSun` `IconMoon` | `ThemeToggle` | — |
| Link (chain) | `IconLink` | `PostBody` external link affordance (optional) | — |

> Down-vote is genuinely supported on-chain (weighted up/down). It is a **secondary** action: it lives in the `PostCardActions` "..." overflow on the timeline, and is shown as an explicit control only on `/post/[id]` post-detail where the weighted score (`upWeight − downWeight`) is surfaced. See `03-component-library.md` §1 / §3. Rationale: keep the primary row identical to X (Reply · Repost · Like · Share) so muscle memory holds; expose down-vote where the weighted-score context already exists.

### 5.4 Hover-tint behavior (the X interaction)

On hover/focus of an action button, **two** things change together over `--cg-motion-fast`:
1. The **icon color** shifts to its semantic color: reply → `--cg-accent`, repost → `--cg-repost`, like → `--cg-like`, quote → `--cg-accent`, share → `--cg-accent`, down-vote → `--cg-danger`.
2. The **circular hit-area background** fills with the matching `*-wash` token (e.g. like → `--cg-like-wash`).

The adjacent **count label** tints to the same semantic color on hover, and stays tinted in the **active** state (liked → like color persists; reposted → repost color persists). Inactive resting state: icon + count are `--cg-text-secondary`.

### 5.5 Active-state fills

- **Like, when liked:** the heart swaps outline→**filled** and color→`--cg-like`, with the like-pop animation (§7.3).
- **Repost, when reposted:** the loop icon → filled + `--cg-repost`. Because reposts are **permanent** (no un-repost on chain), the reposted state is **sticky and non-toggling** — once active it never returns to inactive in the same session; the menu hides "Undo repost". Show a subtle persistent green. (Divergence from X, where retweet toggles. Rationale: chain has no un-repost — `repost` errors `AlreadyReposted`.) See `03-component-library.md` §1 / §3.
- **Nav active:** the active `LeftNav` / `BottomTabBar` item uses the **filled** glyph variant + `--cg-text` (bold) label; inactive uses outline glyph + `--cg-text` regular. (X bolds the active nav label and fills the glyph; it does not tint nav to brand color — keep nav glyph neutral, not accent, except the focus ring.)

---

## 6. Elevation, blur, borders

### 6.1 Shadows

X is mostly flat; elevation appears only on floating surfaces (dropdown menus, modals, toasts, the hover-card). Two shadow tokens, theme-aware:

```
/* DARK */
--cg-shadow-menu:  0 0 8px rgba(255,255,255,0.06), 0 1px 3px rgba(0,0,0,0.6);
--cg-shadow-modal: 0 0 24px rgba(255,255,255,0.05), 0 8px 28px rgba(0,0,0,0.7);

/* LIGHT */
--cg-shadow-menu:  0 0 8px rgba(101,119,134,0.20), 0 1px 3px rgba(101,119,134,0.15);
--cg-shadow-modal: 0 0 16px rgba(101,119,134,0.12), 0 8px 28px rgba(101,119,134,0.25);
```

> Dark elevation is communicated by a faint light *glow* (X's trick on black) plus a dark drop shadow; light elevation uses the classic grey-blue soft shadow. Cards in the timeline have **no** shadow (hairline only).

### 6.2 Sticky-header backdrop blur

The top app bar and the `TimelineTabs` bar are `position: sticky` with a translucent background + blur so content scrolls under them:

```
--cg-header-bg:   /* DARK  */ rgba(0, 0, 0, 0.65)
                  /* LIGHT */ rgba(255, 255, 255, 0.85)
--cg-header-blur: 12px
```

Apply as: `background: var(--cg-header-bg); backdrop-filter: blur(var(--cg-header-blur)); -webkit-backdrop-filter: blur(var(--cg-header-blur));`. The header still carries a 1px bottom `--cg-border`. Provide an opaque fallback (`@supports not (backdrop-filter: blur(1px)) { background: var(--cg-bg); }`).

### 6.3 Overlay scrim

Modals/sheets dim the page with `--cg-overlay` (dark: `rgba(91,112,131,0.40)` — X's signature blue-grey scrim on black; light: `rgba(0,0,0,0.40)`). The scrim sits at `--cg-z-overlay`; clicking it dismisses non-blocking modals.

---

## 7. Motion

### 7.1 Durations & easings

```
--cg-motion-fast:  120ms   /* hover/focus tints, icon color, button bg, row highlight */
--cg-motion-base:  200ms   /* modal/sheet open-close, dropdown, tab indicator slide */
--cg-motion-slow:  320ms   /* skeleton shimmer cycle segment, larger entrances */
--cg-ease-standard: cubic-bezier(0.4, 0.0, 0.2, 1)   /* default */
--cg-ease-out:      cubic-bezier(0.0, 0.0, 0.2, 1)   /* entrances */
--cg-ease-in:       cubic-bezier(0.4, 0.0, 1, 1)     /* exits */
--cg-ease-pop:      cubic-bezier(0.2, 0.9, 0.3, 1.3) /* like-pop overshoot */
```

- **Hovers/focus:** `transition: color, background-color var(--cg-motion-fast) var(--cg-ease-standard);`
- **Modal/sheet:** scale+fade in over `--cg-motion-base` with `--cg-ease-out`; the mobile bottom sheet slides up `translateY(100%)→0`. Scrim fades over the same duration.
- **Tab indicator:** the active `TimelineTabs` / `ProfileTabs` underline slides over `--cg-motion-base`.
- **Dropdown menu:** fade+scale from 0.96 over `--cg-motion-base`.

### 7.2 Optimistic-UI motion (load-bearing)

Per locked decision #1, the app uses **optimistic UI**. The design-system contribution is the *visual grammar* for it:
- **Pending optimistic item** (a just-posted `PostCard`, a like not yet confirmed): render at `opacity: 0.6` with no spinner; on confirmation, transition `opacity 0.6→1` over `--cg-motion-base`. On failure, fade out + remove, then raise a `--cg-danger` toast. (Per-surface behavior lives in `03-component-library.md` §1 / §3 and `09-surface-compose.md` + `03-component-library.md` §7–§11; the tokens/timings are here.)
- **Optimistic count bump:** like/repost count increments instantly with the active color; tabular-nums prevents layout shift.

### 7.3 Like-pop animation

When a user taps Like, the heart plays a single pop using `--cg-ease-pop`:
```
@keyframes cg-like-pop {
  0%   { transform: scale(1); }
  35%  { transform: scale(1.35); }
  70%  { transform: scale(0.9); }
  100% { transform: scale(1); }
}
/* applied: animation: cg-like-pop var(--cg-motion-base) var(--cg-ease-pop); */
```
(X bursts a particle ring; we ship the scale-pop only — particles are out of scope/decorative.)

### 7.4 Spinner

A 1px-stroke circular spinner in `--cg-accent`, `--cg-icon-md` (20px), rotating `0.75s linear infinite`:
```
@keyframes cg-spin { to { transform: rotate(360deg); } }
```

### 7.5 Skeleton shimmer

Loading skeletons (timeline placeholders, profile header) use a left-to-right shimmer. The gradient pair is pinned: **base `--cg-bg-subtle` → highlight `--cg-bg-hover-solid`** (the highlight is the swept-through stop):
```
@keyframes cg-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
/* background: linear-gradient(90deg, var(--cg-bg-subtle) 25%, var(--cg-bg-hover-solid) 37%, var(--cg-bg-subtle) 63%);
   background-size: 200% 100%; animation: cg-shimmer 1.4s ease-in-out infinite; */
```

### 7.6 Reduced motion

Honor `prefers-reduced-motion: reduce` globally: zero out animations/transitions, disable the like-pop scale (instant color swap instead), disable shimmer (static `--cg-bg-subtle`), keep the spinner (replace rotation with an opacity pulse if motion-sensitive — optional). The global reset (already present in `globals.css`) handles transition/animation duration; the like-pop and shimmer keyframes must additionally be guarded so they don't run.

---

## 8. Focus & accessibility tokens

### 8.1 Focus-visible ring

Keyboard focus uses an accent ring, never removed:
```
--cg-focus-ring:        var(--cg-accent)
--cg-focus-ring-width:  2px
--cg-focus-ring-offset: 2px
```
Global rule: `:focus-visible { outline: var(--cg-focus-ring-width) solid var(--cg-focus-ring); outline-offset: var(--cg-focus-ring-offset); border-radius: inherit; }` and `:focus:not(:focus-visible) { outline: none; }`. Pill controls get a ring that follows their pill radius (use `outline` so it tracks the shape). On dark, the teal ring is highly visible; on light it's the deepened teal.

### 8.2 Selection

```
::selection { background: var(--cg-accent-wash); color: var(--cg-text); }
```

### 8.3 Hit targets & contrast

- Minimum interactive hit target: **44×44px** on touch (`BottomTabBar`, FAB, action buttons get padding to reach it), **34×34px** for desktop action icons.
- Information must never rely on `--cg-text-muted` alone (sub-AA).
- The keyboard model (`j`/`k` feed nav, `n` = new post, `g h` etc.) is specified per-surface in `06-surface-home.md`; this doc only guarantees a visible focus ring exists on every focusable element and that the active feed item gets the same `--cg-bg-hover` highlight + focus ring when navigated via keyboard.

---

## 9. Theme switching

Themes are selected by a `data-theme` attribute on the **root `<html>`** element, not by `prefers-color-scheme`. Default (no attribute, or `data-theme="dark"`) = dark. `data-theme="light"` = light.

- `:root` / `[data-theme="dark"]` carry the dark token values (dark is the default so we put dark on bare `:root` too).
- `[data-theme="light"]` overrides the **color** tokens only (geometry/type/motion are theme-agnostic and live once on `:root`).
- `ThemeToggle` (see `01-information-architecture.md` (app shell) + `03-component-library.md` §22.7, lives in `/settings` and optionally the `LeftNav` footer) flips the attribute and persists the choice to `localStorage` (key `cg-theme`).
- **No-flash:** an inline `<head>` script must set `document.documentElement.dataset.theme` from `localStorage` (falling back to `'dark'`) **before first paint** — required because the app is a static export with no SSR. The IA doc (`01-information-architecture.md`) owns where that inline boot script lives; this doc just mandates the attribute contract and the default = dark.
- Optionally also respect `prefers-color-scheme` **only** as the initial default when no stored choice exists; the explicit toggle always wins.
- A `<meta name="color-scheme" content="dark light">` + `color-scheme: dark light` on `:root` keeps form controls / scrollbars themed.

> The "Dim" (`#15202b`) third theme is **not required**. If ever added, it's a third `[data-theme="dim"]` block overriding only `--cg-bg` family — but ship dark + light only.

---

## 10. Component → token quick map (for sibling docs)

A cheat-sheet so each component doc binds to the right tokens without re-deriving:

| Component | Key tokens |
|---|---|
| `AppShell` | `--cg-bg`, `--cg-content-max`, column width tokens |
| `LeftNav` | `--cg-col-left`, `--cg-fs-lg`, `--cg-fw-bold` (active), `--cg-icon-lg`, primary "Post" pill = `--cg-accent` fill + `--cg-accent-contrast` + `--cg-radius-pill` |
| `BottomTabBar` | `--cg-z-fab`, `--cg-icon-lg`, `--cg-header-bg` + blur, 44px hit targets |
| `RightRail` | `--cg-col-right`, cards on `--cg-bg-subtle` + `--cg-radius-card` |
| `Timeline` / `PostCard` | `--cg-col-feed`, `--cg-space-4`/`3` padding, `--cg-border` divider, `--cg-bg-hover` row, `--cg-fs-sm` body |
| `PostCardActions` | `--cg-icon-md`, hover-tint tokens (`--cg-accent`/`--cg-like`/`--cg-repost` + `*-wash`), `--cg-fs-xs` counts tabular |
| `Composer` / `ComposerModal` | `--cg-fs-md` textarea, `--cg-radius-card` modal, `--cg-shadow-modal`, `ByteCounter` `--cg-fs-xs` → `--cg-danger` at cap |
| `RateLimitNotice` | `--cg-bg-subtle` panel, `--cg-text-secondary` copy, no battery, no red unless hard-blocked (then `--cg-danger`) |
| `PollCard` | option bar fill `--cg-accent`, track `--cg-bg-subtle`, `--cg-radius-sm`, `--cg-fw-medium` on leading option |
| `FollowButton` | pill, accent fill when "Follow", `--cg-bg`/border when "Following"→hover `--cg-danger` "Unfollow" (X pattern) |
| `Handle` | `--cg-font-mono`, `--cg-fs-sm`, `--cg-text-secondary`, `tabular-nums` |
| `Avatar` | circle, size tokens §4.4, identicon fallback |
| `Toaster` / `Toast` | `--cg-z-toast`, `--cg-bg-elevated`, `--cg-shadow-modal`, success=`--cg-accent`, error=`--cg-danger` |
| `ThemeToggle` | `IconSun`/`IconMoon`, flips `data-theme` |
| `Spinner`/`Skeleton` | `cg-spin` / `cg-shimmer` keyframes, `--cg-accent` / `--cg-bg-subtle` |
| `EmptyState` | `--cg-fs-xl` title, `--cg-text-secondary` body, centered |

---

## 11. `tokens.css` skeleton (drop-in)

Replace `app/src/styles/tokens.css` with this. `globals.css` keeps `@import "./tokens.css";` and is updated to use `--cg-*` (the reset stays; the paper-ink utilities are removed/rewritten by `globals.css`'s owner — see `globals.css` updates below). All values are concrete.

```css
/*
 * cogno-chain — DESIGN TOKENS (X-clone, cogno accent)
 * ===================================================
 * Single source of color/type/space/radius/shadow/motion. Components consume
 * var(--cg-*) ONLY — never raw hex/px. Dark is the default (on :root and
 * [data-theme="dark"]); [data-theme="light"] overrides COLOR tokens only.
 * Geometry / type / motion are theme-agnostic and defined once on :root.
 * Theme is chosen by the data-theme attribute on <html>, set pre-paint by an
 * inline boot script (see 01-information-architecture.md). Fonts are local @fontsource
 * (see app/src/styles/fonts.ts); family names must match.
 */

:root {
  color-scheme: dark light;

  /* ===== THEME-AGNOSTIC: TYPE ===== */
  --cg-font-ui: "Inter Tight Variable", -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --cg-font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas,
    monospace;

  --cg-fs-xs: 0.8125rem;   /* 13px */
  --cg-fs-sm: 0.9375rem;   /* 15px — BASE */
  --cg-fs-md: 1.0625rem;   /* 17px */
  --cg-fs-lg: 1.25rem;     /* 20px */
  --cg-fs-xl: 1.4375rem;   /* 23px */
  --cg-fs-2xl: 1.9375rem;  /* 31px */

  --cg-lh-xs: 1rem;        /* 16px */
  --cg-lh-sm: 1.25rem;     /* 20px */
  --cg-lh-md: 1.5rem;      /* 24px */
  --cg-lh-lg: 1.5rem;      /* 24px */
  --cg-lh-xl: 1.75rem;     /* 28px */
  --cg-lh-2xl: 2.25rem;    /* 36px */

  --cg-fw-regular: 400;
  --cg-fw-medium: 500;
  --cg-fw-semibold: 600;
  --cg-fw-bold: 700;
  --cg-fw-extrabold: 800;

  --cg-tracking-tight: -0.01em;

  /* ===== THEME-AGNOSTIC: SPACE ===== */
  --cg-space-1: 4px;
  --cg-space-2: 8px;
  --cg-space-3: 12px;
  --cg-space-4: 16px;
  --cg-space-5: 20px;
  --cg-space-6: 24px;
  --cg-space-7: 32px;
  --cg-space-8: 48px;

  /* ===== THEME-AGNOSTIC: RADIUS ===== */
  --cg-radius-pill: 9999px;
  --cg-radius-card: 16px;
  --cg-radius-sm: 8px;
  --cg-radius-input: 4px;

  /* ===== THEME-AGNOSTIC: LAYOUT ===== */
  --cg-col-feed: 600px;
  --cg-col-left: 275px;
  --cg-col-left-icononly: 88px;
  --cg-col-right: 350px;
  --cg-content-max: 1265px;
  --cg-col-onboarding: 480px;
  --cg-header-h: 53px;

  --cg-avatar-sm: 24px;
  --cg-avatar-md: 40px;
  --cg-avatar-lg: 48px;
  --cg-avatar-xl: 133px;

  /* ===== THEME-AGNOSTIC: ICONS ===== */
  --cg-icon-sm: 1.125rem;
  --cg-icon-md: 1.25rem;
  --cg-icon-lg: 1.625rem;

  /* ===== THEME-AGNOSTIC: Z-LAYERS ===== */
  --cg-z-base: 0;
  --cg-z-sticky: 100;
  --cg-z-fab: 200;
  --cg-z-dropdown: 300;
  --cg-z-overlay: 400;
  --cg-z-modal: 410;
  --cg-z-toast: 500;

  /* ===== THEME-AGNOSTIC: MOTION ===== */
  --cg-motion-fast: 120ms;
  --cg-motion-base: 200ms;
  --cg-motion-slow: 320ms;
  --cg-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --cg-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --cg-ease-in: cubic-bezier(0.4, 0, 1, 1);
  --cg-ease-pop: cubic-bezier(0.2, 0.9, 0.3, 1.3);

  /* ===== THEME-AGNOSTIC: FOCUS ===== */
  --cg-focus-ring-width: 2px;
  --cg-focus-ring-offset: 2px;
  --cg-header-blur: 12px;

  /* ===== DARK COLORS (DEFAULT) ===== */
  --cg-bg: #000000;
  --cg-bg-elevated: #16181c;
  --cg-bg-subtle: #202327;
  --cg-bg-hover: rgba(231, 233, 234, 0.03);
  --cg-bg-hover-solid: #080808;
  --cg-border: #2f3336;

  --cg-text: #e7e9ea;
  --cg-text-secondary: #71767b;
  --cg-text-muted: #565a5e;

  --cg-accent: #2ec4a6;
  --cg-accent-hover: #46d3b7;
  --cg-accent-contrast: #06140f;
  --cg-accent-wash: rgba(46, 196, 166, 0.12);

  --cg-like: #f91880;
  --cg-like-wash: rgba(249, 24, 128, 0.12);
  --cg-repost: #00ba7c;
  --cg-repost-wash: rgba(0, 186, 124, 0.12);
  --cg-danger: #f4212e;
  --cg-danger-wash: rgba(244, 33, 46, 0.12);
  --cg-warning: #f5a623;

  --cg-overlay: rgba(91, 112, 131, 0.4);
  --cg-header-bg: rgba(0, 0, 0, 0.65);

  --cg-focus-ring: var(--cg-accent);

  --cg-shadow-menu: 0 0 8px rgba(255, 255, 255, 0.06),
    0 1px 3px rgba(0, 0, 0, 0.6);
  --cg-shadow-modal: 0 0 24px rgba(255, 255, 255, 0.05),
    0 8px 28px rgba(0, 0, 0, 0.7);
}

/* explicit dark (same as :root default) for symmetry */
[data-theme="dark"] {
  color-scheme: dark;
  --cg-bg: #000000;
  --cg-bg-elevated: #16181c;
  --cg-bg-subtle: #202327;
  --cg-bg-hover: rgba(231, 233, 234, 0.03);
  --cg-bg-hover-solid: #080808;
  --cg-border: #2f3336;
  --cg-text: #e7e9ea;
  --cg-text-secondary: #71767b;
  --cg-text-muted: #565a5e;
  --cg-accent: #2ec4a6;
  --cg-accent-hover: #46d3b7;
  --cg-accent-contrast: #06140f;
  --cg-accent-wash: rgba(46, 196, 166, 0.12);
  --cg-like: #f91880;
  --cg-like-wash: rgba(249, 24, 128, 0.12);
  --cg-repost: #00ba7c;
  --cg-repost-wash: rgba(0, 186, 124, 0.12);
  --cg-danger: #f4212e;
  --cg-danger-wash: rgba(244, 33, 46, 0.12);
  --cg-warning: #f5a623;
  --cg-overlay: rgba(91, 112, 131, 0.4);
  --cg-header-bg: rgba(0, 0, 0, 0.65);
  --cg-focus-ring: var(--cg-accent);
  --cg-shadow-menu: 0 0 8px rgba(255, 255, 255, 0.06),
    0 1px 3px rgba(0, 0, 0, 0.6);
  --cg-shadow-modal: 0 0 24px rgba(255, 255, 255, 0.05),
    0 8px 28px rgba(0, 0, 0, 0.7);
}

/* ===== LIGHT COLORS ===== */
[data-theme="light"] {
  color-scheme: light;
  --cg-bg: #ffffff;
  --cg-bg-elevated: #ffffff;
  --cg-bg-subtle: #f7f9f9;
  --cg-bg-hover: rgba(15, 20, 25, 0.03);
  --cg-bg-hover-solid: #f7f9f9;
  --cg-border: #eff3f4;
  --cg-text: #0f1419;
  --cg-text-secondary: #536471;
  --cg-text-muted: #8b98a5;
  --cg-accent: #1f6f5e;
  --cg-accent-hover: #18584b;
  --cg-accent-contrast: #ffffff;
  --cg-accent-wash: rgba(31, 111, 94, 0.1);
  --cg-like: #f91880;
  --cg-like-wash: rgba(249, 24, 128, 0.1);
  --cg-repost: #00ba7c;
  --cg-repost-wash: rgba(0, 186, 124, 0.1);
  --cg-danger: #f4212e;
  --cg-danger-wash: rgba(244, 33, 46, 0.1);
  --cg-warning: #b26a00;
  --cg-overlay: rgba(0, 0, 0, 0.4);
  --cg-header-bg: rgba(255, 255, 255, 0.85);
  --cg-focus-ring: var(--cg-accent);
  --cg-shadow-menu: 0 0 8px rgba(101, 119, 134, 0.2),
    0 1px 3px rgba(101, 119, 134, 0.15);
  --cg-shadow-modal: 0 0 16px rgba(101, 119, 134, 0.12),
    0 8px 28px rgba(101, 119, 134, 0.25);
}

/* ===== KEYFRAMES (global, reduced-motion guarded) ===== */
@keyframes cg-spin { to { transform: rotate(360deg); } }
@keyframes cg-like-pop {
  0% { transform: scale(1); }
  35% { transform: scale(1.35); }
  70% { transform: scale(0.9); }
  100% { transform: scale(1); }
}
@keyframes cg-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### `globals.css` companion updates (for the `globals.css` owner)

The existing reset stays. The owner of `globals.css` must:
- Swap `body` to `background: var(--cg-bg); color: var(--cg-text); font-family: var(--cg-font-ui); font-size: var(--cg-fs-sm); line-height: var(--cg-lh-sm);`.
- Replace the paper-ink `.post-body` / `.feed-heading` / `.mono` utilities with `--cg-*` equivalents (post body = `--cg-font-ui` 15px, **not** serif anymore).
- Set the focus-visible rule to `outline: var(--cg-focus-ring-width) solid var(--cg-focus-ring); outline-offset: var(--cg-focus-ring-offset);`.
- Set `::selection { background: var(--cg-accent-wash); color: var(--cg-text); }`.
- Keep the `prefers-reduced-motion` reset (now also in tokens.css — dedupe to one).

---

## 12. Divergences from X honored here

| X behavior | cogno chain choice | Rationale |
|---|---|---|
| Twitter blue `#1d9bf0` accent | cogno teal (`#2ec4a6` dark / `#1f6f5e` light) | Brand; AA-derived from `#2e7d6b` |
| White-on-blue primary button | Dark-on-teal (`--cg-accent-contrast: #06140f`) on dark | White on bright teal fails AA |
| Like = pink heart | Kept (`--cg-like: #f91880`) | Match X exactly |
| Repost toggles (un-retweet) | Repost is **sticky/permanent** (no inactive return) | Chain has no un-repost (`AlreadyReposted`) |
| In-post media | None — text-only, no media tab, no upload affordances | 512-byte text-only posts; no media on chain |
| Char counter (280 chars) | `ByteCounter` counts **UTF-8 bytes / 512** | `MaxLength=512` bytes, not chars |
| Unique @usernames | `Handle` = truncated **ss58** in mono | No usernames on chain |
| Rate-limit = generic | Twitter-style "over the rate limit" copy, no battery | Capacity exhaustion surfaces as a soft rate limit |
| Down-vote: none | Secondary down-vote in overflow / on detail | Chain supports weighted up/down |
| `prefers-color-scheme` auto | Explicit `data-theme` toggle, dark default | Static export needs a working toggle |

---

## Implementation checklist

- [ ] Replace `app/src/styles/tokens.css` with the §11 skeleton (verbatim concrete values; both themes).
- [ ] Update `app/src/styles/globals.css` per the §11 companion notes (body → `--cg-*`, rewrite `.post-body` to sans 15px, focus-visible ring, selection, dedupe reduced-motion).
- [ ] Confirm `app/src/styles/fonts.ts` still imports `@fontsource-variable/inter-tight` and `@fontsource/ibm-plex-mono`; the CSS family names match `--cg-font-ui` / `--cg-font-mono`. Source Serif import may stay (unused) or be removed.
- [ ] Add the pre-paint theme boot script that sets `document.documentElement.dataset.theme` from `localStorage['cg-theme']` (default `'dark'`) — owned by `01-information-architecture.md`; verify it runs before first paint in the static export.
- [ ] Add `<meta name="color-scheme" content="dark light">` to the document head.
- [ ] Create `app/src/components/icons/` with the §5.3 inline-SVG icon set (`currentColor`, 24px viewBox, X-style silhouettes, outline+filled variants for like/repost/nav).
- [ ] Implement the `Spinner` (uses `cg-spin`) and skeleton shimmer helper (`cg-shimmer`) as shared components/classes.
- [ ] Implement the global `:focus-visible` ring and verify it tracks pill geometry on buttons.
- [ ] Verify AA contrast for `--cg-text`, `--cg-text-secondary`, `--cg-accent`, and `--cg-accent-contrast` in BOTH themes with a contrast checker (table §2.5).
- [ ] Verify `--cg-text-muted` is used only for non-essential/placeholder text (never sole carrier of meaning).
- [ ] Wire the like-pop animation (`cg-like-pop`) to the Like action and guard it under `prefers-reduced-motion`.
- [ ] Apply `--cg-header-bg` + `backdrop-filter: blur(var(--cg-header-blur))` to the sticky header and `TimelineTabs`, with the `@supports not` opaque fallback.
- [ ] Confirm no component file contains raw hex/rgb/px literals for color, type, radius, motion — all via `var(--cg-*)`.
- [ ] Confirm `ThemeToggle` flips `data-theme` and persists to `localStorage['cg-theme']`; both themes render correctly across all surfaces.
- [ ] Static-export sanity: `npm run build` produces `app/out/` with fonts bundled (no Google Fonts fetch); theme attribute survives a hard refresh with no flash.
