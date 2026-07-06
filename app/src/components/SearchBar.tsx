"use client";

// SearchBar — the global search input (doc 03 §21). Substring search over post bodies is node-served
// (spec-200 MicroblogApi.search_posts), gated on `searchEnabled` = feedSource.caps.search — which is
// true once the node reader is ready, so the input is disabled only before connect (no `source` yet).
// Pill, --cg-bg-subtle. Controlled value; Enter commits via onSubmit (nav to /explore?q= or run inline);
// a clear (✕) appears when there's text. NO fake client-side search.

import { useCallback, useState } from "react";
import styles from "./SearchBar.module.css";
import { IconSearch, IconClose, Spinner } from "./icons";

export interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  /** = feedSource.caps.search. false → disabled + honest cap placeholder. */
  searchEnabled: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** spinner in the field while a query is in flight. */
  loading?: boolean;
  /** Recent-search terms shown in a dropdown when the box is focused and empty. Omit → no dropdown. */
  recent?: readonly string[];
  /** Run a recent term. */
  onSelectRecent?: (term: string) => void;
  /** Drop one recent term. */
  onRemoveRecent?: (term: string) => void;
  /** Drop all recent terms. */
  onClearRecent?: () => void;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  searchEnabled,
  placeholder = "Search cogno-chain",
  autoFocus,
  loading,
  recent,
  onSelectRecent,
  onRemoveRecent,
  onClearRecent,
}: SearchBarProps) {
  const [focused, setFocused] = useState(false);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit(value);
      }
    },
    [onSubmit, value],
  );

  const disabledPlaceholder = "Connecting…";
  // Recent-searches dropdown: only while focused with an empty box and some history to show.
  const showRecent =
    searchEnabled && focused && value.length === 0 && !!recent && recent.length > 0;

  return (
    <div className={styles.wrap} role="search">
      <div className={styles.root}>
        <span className={styles.icon} aria-hidden>
          <IconSearch />
        </span>
        <input
          className={styles.input}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={searchEnabled ? placeholder : disabledPlaceholder}
          aria-label={placeholder}
          disabled={!searchEnabled}
          aria-disabled={!searchEnabled || undefined}
          title={searchEnabled ? undefined : "Search is available once connected to a node."}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
        />
        {searchEnabled && loading ? (
          // A query is in flight — show the promised in-field spinner (plain wrapper, not the filled
          // clear pill). The ✕ returns as soon as results land.
          <span className={styles.icon} aria-hidden>
            <Spinner size="sm" />
          </span>
        ) : searchEnabled && value.length > 0 ? (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            onClick={() => onChange("")}
          >
            <IconClose />
          </button>
        ) : null}
      </div>

      {showRecent && (
        // preventDefault on mousedown keeps the input focused (blur would close the panel before the
        // row's click fires).
        <div
          className={styles.recent}
          role="listbox"
          aria-label="Recent searches"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className={styles.recentHead}>
            <span className={styles.recentTitle}>Recent</span>
            {onClearRecent && (
              <button type="button" className={styles.recentClear} onClick={onClearRecent}>
                Clear all
              </button>
            )}
          </div>
          {recent!.map((term) => (
            <div key={term} className={styles.recentRow}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className={styles.recentTerm}
                onClick={() => onSelectRecent?.(term)}
              >
                <span className={styles.recentIcon} aria-hidden>
                  <IconSearch />
                </span>
                <span className={styles.recentLabel}>{term}</span>
              </button>
              {onRemoveRecent && (
                <button
                  type="button"
                  className={styles.recentRemove}
                  aria-label={`Remove "${term}" from recent searches`}
                  onClick={() => onRemoveRecent(term)}
                >
                  <IconClose />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
