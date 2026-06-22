"use client";

// SearchBar — the global search input (doc 03 §21). Substring search over post bodies is INDEXER-ONLY
// (gated on `searchEnabled` = feedSource.caps.search). Pill, --cg-bg-subtle. Controlled value; Enter
// commits via onSubmit (nav to /explore?q= or run inline); a clear (✕) appears when there's text.
// When search is unavailable (PAPI-direct), the input is disabled with the honest cap placeholder
// ("Search needs the indexer") + a title explaining the dependency — NO fake client-side search.

import { useCallback } from "react";
import styles from "./SearchBar.module.css";
import { IconSearch, IconClose } from "./icons";

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
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  searchEnabled,
  placeholder = "Search cogno-chain",
  autoFocus,
  loading,
}: SearchBarProps) {
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit(value);
      }
    },
    [onSubmit, value],
  );

  const disabledPlaceholder = "Add an indexer to search";

  return (
    <div className={styles.root} role="search">
      <span className={styles.icon} aria-hidden>
        <IconSearch />
      </span>
      <input
        className={styles.input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={searchEnabled ? placeholder : disabledPlaceholder}
        aria-label={placeholder}
        disabled={!searchEnabled}
        aria-disabled={!searchEnabled || undefined}
        title={searchEnabled ? undefined : "Full-text search is optional — add an indexer in Settings."}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
      />
      {searchEnabled && value.length > 0 && !loading && (
        <button
          type="button"
          className={styles.clear}
          aria-label="Clear search"
          onClick={() => onChange("")}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}
