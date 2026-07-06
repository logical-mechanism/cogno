// Emoji dataset for the picker — built from the bundled emojibase-data compact set. This module is
// imported ONLY by EmojiPickerPanel, which the Composer lazy-loads, so the ~570KB source JSON stays
// out of the main bundle and downloads as its own chunk the first time a user opens the picker.
//
// Emoji are inserted as native UTF-8 text (rendered by the viewer's OS font), matching how the
// composer already handles emoji — no image sprites, no runtime CDN. Search uses emojibase's keyword
// `tags` (e.g. 😂 → "lol", "haha", "funny"), so it behaves like a real emoji keyboard.

import compact from "emojibase-data/en/compact.json";

export interface EmojiItem {
  /** the native UTF-8 emoji to insert. */
  c: string;
  /** display name / accessible label. */
  n: string;
  /** lowercased search haystack (label + emojibase keyword tags). */
  s: string;
}

export interface EmojiCategory {
  id: string;
  name: string;
  /** a representative emoji shown on the category tab. */
  icon: string;
  emojis: EmojiItem[];
}

interface RawEmoji {
  group?: number;
  order?: number;
  label: string;
  unicode: string;
  tags?: string[];
}

// emojibase group index → our display category. Smileys-emotion (0) and people-body (1) merge into a
// single "Smileys & People" (as most pickers do); the component group (2, skin-tone/hair modifiers) and
// the ungrouped regional indicators are dropped. Order mirrors the familiar Twitter / emoji-mart tabs.
const CATEGORY_DEFS: { id: string; name: string; icon: string; groups: number[] }[] = [
  { id: "people", name: "Smileys & People", icon: "😀", groups: [0, 1] },
  { id: "nature", name: "Animals & Nature", icon: "🐻", groups: [3] },
  { id: "food", name: "Food & Drink", icon: "🍔", groups: [4] },
  { id: "activity", name: "Activities", icon: "⚽", groups: [6] },
  { id: "travel", name: "Travel & Places", icon: "✈️", groups: [5] },
  { id: "objects", name: "Objects", icon: "💡", groups: [7] },
  { id: "symbols", name: "Symbols", icon: "❤️", groups: [8] },
  { id: "flags", name: "Flags", icon: "🚩", groups: [9] },
];

const GROUP_TO_CAT = new Map<number, string>();
for (const def of CATEGORY_DEFS) for (const g of def.groups) GROUP_TO_CAT.set(g, def.id);

export const EMOJI_CATEGORIES: EmojiCategory[] = (() => {
  const buckets = new Map<string, { o: number; item: EmojiItem }[]>();
  for (const def of CATEGORY_DEFS) buckets.set(def.id, []);
  for (const raw of compact as RawEmoji[]) {
    if (raw.group === undefined) continue;
    const catId = GROUP_TO_CAT.get(raw.group);
    if (!catId) continue; // component group or anything unmapped
    const s =
      raw.tags && raw.tags.length
        ? `${raw.label} ${raw.tags.join(" ")}`.toLowerCase()
        : raw.label.toLowerCase();
    buckets.get(catId)!.push({
      o: raw.order ?? Number.MAX_SAFE_INTEGER,
      item: { c: raw.unicode, n: raw.label, s },
    });
  }
  return CATEGORY_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    icon: def.icon,
    emojis: buckets
      .get(def.id)!
      .sort((a, b) => a.o - b.o)
      .map((x) => x.item),
  }));
})();

const ALL_EMOJI: EmojiItem[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

/** Emoji whose label/tags contain EVERY whitespace-separated search term (case-insensitive). */
export function searchEmoji(query: string): EmojiItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return ALL_EMOJI.filter((e) => terms.every((t) => e.s.includes(t)));
}
