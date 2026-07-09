"use client";

// MentionSuggestions — the @-autocomplete popover the composer opens while typing `@name`. Purely
// presentational: it renders the ranked people rows and reports picks/hover up; the ranking, search,
// keyboard nav and token insertion live in useMentions. Each row mirrors the shared PersonRow shape
// (identicon + display name + reputation chip + truncated ss58), the same primitives Explore uses.

import { Avatar } from "./Avatar";
import { ReputationBadge } from "./ReputationBadge";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import { Spinner } from "./icons";
import styles from "./MentionSuggestions.module.css";
import type { Suggestion } from "@/lib/types";

export interface MentionSuggestionsProps {
  items: Suggestion[];
  activeIndex: number;
  loading: boolean;
  query: string;
  listId: string;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
}

export function MentionSuggestions({
  items,
  activeIndex,
  loading,
  query,
  listId,
  onPick,
  onHover,
}: MentionSuggestionsProps) {
  const empty = !loading && items.length === 0;

  return (
    <div className={styles.popover} role="presentation">
      <ul className={styles.list} role="listbox" id={listId} aria-label="Mention suggestions">
        {items.map((s, i) => (
          <li
            key={s.author}
            id={`${listId}-opt-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            className={`${styles.row} ${i === activeIndex ? styles.active : ""}`}
            // mousedown (not click) + preventDefault so the pick fires WITHOUT the textarea losing focus
            // (a blur would close the popover before the click lands).
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(s);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <Avatar address={s.author} src={s.avatar} size="sm" name={s.displayName} />
            <span className={styles.text}>
              <span className={styles.nameRow}>
                <DisplayName address={s.author} displayName={s.displayName} truncate />
                <ReputationBadge address={s.author} />
              </span>
              <Handle address={s.author} />
            </span>
          </li>
        ))}
        {loading && items.length === 0 && (
          <li className={styles.status} aria-hidden>
            <Spinner size="sm" /> <span>Searching…</span>
          </li>
        )}
        {empty && query.length >= 1 && (
          <li className={styles.status} role="status">
            No people match “{query}”.
          </li>
        )}
      </ul>
    </div>
  );
}
