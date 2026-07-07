"use client";

// EmojiPickerPanel — the searchable, categorized emoji board (surface 09 §4.1). The Composer's
// EmojiPicker lazy-loads this component, so the emoji dataset (emoji-data) downloads only when a user
// first opens the picker. It emits the chosen native emoji via onPick; the Composer inserts it at the
// caret (byte-counted, D1). Presentational — no chain calls, no draft state.

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./EmojiPickerPanel.module.css";
import { EMOJI_CATEGORIES, searchEmoji, type EmojiItem } from "./emoji-data";
import { loadRecentEmoji, pushRecentEmoji } from "./recentEmoji";

export interface EmojiPickerPanelProps {
  onPick: (emoji: string) => void;
}

export default function EmojiPickerPanel({ onPick }: EmojiPickerPanelProps) {
  const [query, setQuery] = useState("");
  // null ⇒ not searching (show the categorized board); an array ⇒ search results.
  const results = useMemo(() => (query.trim() ? searchEmoji(query) : null), [query]);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Recently-used row (device-local). Record every pick, then hand the char up to the Composer.
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmoji());
  const handlePick = (emoji: string) => {
    setRecent(pushRecentEmoji(emoji));
    onPick(emoji);
  };

  // Focus the search on open so a user can type-to-filter immediately.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const jumpTo = (id: string) => {
    boardRef.current
      ?.querySelector<HTMLElement>(`[data-cat="${id}"]`)
      ?.scrollIntoView({ block: "start" });
  };

  return (
    <div className={styles.panel}>
      <div className={styles.searchRow}>
        <input
          ref={searchRef}
          type="text"
          className={styles.search}
          placeholder="Search emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search emoji"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className={styles.board} ref={boardRef}>
        {results ? (
          results.length ? (
            <Grid emojis={results} onPick={handlePick} />
          ) : (
            <p className={styles.empty}>No emoji found.</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <section className={styles.section} data-cat="recent">
                <h3 className={styles.heading}>Recently used</h3>
                <div className={styles.grid}>
                  {recent.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={styles.emoji}
                      title={c}
                      aria-label={`Emoji ${c}`}
                      onClick={() => handlePick(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {EMOJI_CATEGORIES.map((cat) => (
              <section key={cat.id} className={styles.section} data-cat={cat.id}>
                <h3 className={styles.heading}>{cat.name}</h3>
                <Grid emojis={cat.emojis} onPick={handlePick} />
              </section>
            ))}
          </>
        )}
      </div>

      {!results && (
        <div className={styles.tabs} aria-label="Emoji categories">
          {EMOJI_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={styles.tab}
              title={cat.name}
              aria-label={cat.name}
              onClick={() => jumpTo(cat.id)}
            >
              <span aria-hidden>{cat.icon}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Grid({ emojis, onPick }: { emojis: EmojiItem[]; onPick: (e: string) => void }) {
  return (
    <div className={styles.grid}>
      {emojis.map((e) => (
        <button
          key={e.c}
          type="button"
          className={styles.emoji}
          title={e.n}
          aria-label={e.n}
          onClick={() => onPick(e.c)}
        >
          {e.c}
        </button>
      ))}
    </div>
  );
}
