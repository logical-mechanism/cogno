"use client";

// SearchBar — a single-line substring search over post bodies, shown ONLY when the active
// feed source can serve it (the indexer). Calm and unchromed: it reads as a ledger lookup,
// not a product search box. Submitting (or clearing) hands the query up; the page swaps the
// live feed for the paginated search result.

import { useEffect, useState } from "react";
import styles from "./SearchBar.module.css";

export interface SearchBarProps {
  /** The committed query (so the input reflects external clears). */
  value: string;
  /** Commit a query (empty string clears the search, restoring the live feed). */
  onSearch: (q: string) => void;
  /** Total matches for the current committed query, when known. */
  resultCount?: number;
}

export function SearchBar({ value, onSearch, resultCount }: SearchBarProps) {
  const [text, setText] = useState(value);

  // Reflect external changes to the committed value (e.g. a programmatic clear).
  useEffect(() => {
    setText(value);
  }, [value]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(text.trim());
  };

  const onClear = () => {
    setText("");
    onSearch("");
  };

  return (
    <form className={styles.bar} onSubmit={onSubmit} role="search">
      <label className={styles.label} htmlFor="cogno-search">
        search the ledger
      </label>
      <div className={styles.row}>
        <input
          id="cogno-search"
          className={styles.input}
          type="search"
          value={text}
          spellCheck={false}
          placeholder="substring, case-insensitive"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className={styles.go}>
          find
        </button>
        {value.length > 0 && (
          <button type="button" className={styles.clear} onClick={onClear}>
            clear
          </button>
        )}
      </div>
      {value.length > 0 && resultCount != null && (
        <p className={styles.count} aria-live="polite">
          {resultCount} {resultCount === 1 ? "post" : "posts"} matching
          <span className={styles.q}> “{value}”</span>
        </p>
      )}
    </form>
  );
}

export default SearchBar;
