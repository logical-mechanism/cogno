"use client";

// useMentions — the composer's @-autocomplete engine + display-token/stored-value bookkeeping.
//
// The editor text holds friendly `@displayName` DISPLAY tokens; a parallel list records which
// AccountId each picked token means. On submit (and for the byte meter) the display text is serialized
// to `@<ss58>` body text via serializeMentions. This hook owns: detecting the active `@query` at the
// caret, searching people (source.searchPeople) + client-side re-ranking, inserting a picked token,
// keyboard nav, and the serialize function. The popover UI is the presentational <MentionSuggestions>.
//
// It reads the session (source/api/signer/viewer) + the viewer's following set itself, so the base
// Composer stays presentational (mirrors how ReputationBadge / ProfileHoverCard read from the session
// as leaves). Gated on caps.search && caps.profiles — a node that can't people-search shows no popover.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/components/Providers";
import { useFollow } from "@/hooks/useFollow";
import { MentionSuggestions } from "@/components/MentionSuggestions";
import {
  serializeMentions,
  reconcileMentions,
  mentionToken,
  type MentionRef,
  type SubmittedDraft,
} from "@/lib/mentions";
import { fallbackDisplayName, truncateSs58 } from "@/lib/ss58";
import type { Suggestion } from "@/lib/types";

const MENTION_LIMIT = 6;
const SEARCH_DEBOUNCE_MS = 180;
const MIN_QUERY = 1;
const MAX_QUERY = 40; // beyond this it's not a name — likely a pasted address; don't autocomplete

/** The `@query` token being typed at the caret, or null. Triggered only when `@` follows start/space
 *  and only non-whitespace runs up to the caret (so `email@host` never triggers). */
function activeQueryAt(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(value[i]) && value[i] !== "@") i--;
  if (i < 0 || value[i] !== "@") return null;
  // The char before '@' must be the start or whitespace.
  if (i > 0 && !/\s/.test(value[i - 1])) return null;
  const query = value.slice(i + 1, caret);
  if (query.length < MIN_QUERY || query.length > MAX_QUERY) return null;
  return { start: i, query };
}

/** The display text shown for a picked person: their name, else the stable cogno-… fallback. */
function displayFor(s: Suggestion): string {
  return s.displayName?.trim() || fallbackDisplayName(s.author);
}

export interface UseMentions {
  /** Expand the display tokens in `text` to `@<ss58>` body text (submit + byte-meter path). Also the
   *  composer's clamp test: `serialize(t) === t` means `t` carries no mention token, so its DISPLAY
   *  length is its posted length and an as-you-type clamp cannot slice a token. */
  serialize: (text: string) => string;
  /** Snapshot the draft being submitted (its DISPLAY text + current refs) so the bindings come back if
   *  the surface restores it after a failed tx. Call with the display text, BEFORE the surface clears. */
  markSubmitted: (displayText: string) => void;
  /** The popover node — render it inside the (relatively-positioned) textarea wrapper. */
  suggestions: ReactNode;
  /** True while the popover is open (composer suppresses its own Enter handling then). */
  open: boolean;
  /** Call after the textarea value changes to (re)detect the active `@query` at `caret`. */
  onTextInput: (value: string, caret: number) => void;
  /** Handle a keydown while open; returns true when it consumed the key (nav/select/close). */
  onKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Close the popover without touching the recorded mentions (call on textarea blur / submit). */
  dismiss: () => void;
}

export function useMentions(opts: {
  text: string;
  setText: (next: string) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  listId: string;
}): UseMentions {
  const { text, setText, taRef, listId } = opts;
  const { api, signer, source, viewer } = useSession();
  const me = viewer.address ?? null;
  const { following } = useFollow(api, signer, source, me);
  // Hold the following set in a REF (not a memo in the search-effect deps): useFollow returns a fresh
  // `[]` on every render while its edges are null (in-flight / failed), which would otherwise make the
  // debounced search effect re-run in a ~180ms loop. The ranking reads the latest set from the ref.
  const followingSetRef = useRef<Set<string>>(new Set());
  followingSetRef.current = useMemo(() => new Set(following), [following]);

  const [mentions, setMentions] = useState<MentionRef[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState(0); // index of the active '@'
  const [results, setResults] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const canSearch = !!source;

  // The draft last handed to onSubmit — see `reconcileMentions`, which decides what it is allowed to do.
  const submitted = useRef<SubmittedDraft | null>(null);
  const markSubmitted = useCallback(
    (displayText: string) => {
      submitted.current = { text: displayText, refs: mentions };
    },
    [mentions],
  );

  // Prune against the text, or restore the submitted draft's bindings if the surface handed it back.
  // The rule itself is `reconcileMentions` in lib/mentions — pure, and unit-tested there, because both
  // ways it can go wrong corrupt a post permanently.
  useEffect(() => {
    setMentions((ms) => reconcileMentions(ms, text, submitted.current));
  }, [text]);

  const close = useCallback(() => {
    setOpen(false);
    setResults([]);
    setLoading(false);
    setActiveIndex(0);
  }, []);

  const onTextInput = useCallback(
    (value: string, caret: number) => {
      if (!canSearch) return;
      const active = activeQueryAt(value, caret);
      if (!active) {
        if (open) close();
        return;
      }
      setAnchor(active.start);
      setQuery(active.query);
      setActiveIndex(0);
      setOpen(true);
    },
    [canSearch, open, close],
  );

  // Debounced people search for the active query.
  useEffect(() => {
    if (!open || !source || !canSearch) return;
    const term = query.trim();
    if (term.length === 0) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      source
        .searchPeople(term, MENTION_LIMIT)
        .then((people) => {
          if (cancelled) return;
          // Client-side re-rank: (a) accounts the viewer follows first, (b) reputation net score desc,
          // (c) follower count desc — the strongest-signal-first ordering the task specifies.
          const followingSet = followingSetRef.current;
          const ranked = [...people].sort((a, b) => {
            const fa = followingSet.has(a.author) ? 0 : 1;
            const fb = followingSet.has(b.author) ? 0 : 1;
            if (fa !== fb) return fa - fb;
            const sa = a.accountScore ?? 0n;
            const sb = b.accountScore ?? 0n;
            if (sa !== sb) return sa > sb ? -1 : 1;
            return b.followerCount - a.followerCount;
          });
          setResults(ranked);
          setActiveIndex(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, source, canSearch]);

  const pick = useCallback(
    (s: Suggestion) => {
      // Keep display tokens UNIQUE within a draft: if this display already maps to a DIFFERENT account,
      // disambiguate with the truncated ss58 so serialization stays unambiguous.
      let display = displayFor(s);
      const clash = mentions.some((m) => m.display === display && m.ss58 !== s.author);
      if (clash) display = `${display} (${truncateSs58(s.author)})`;

      const token = `${mentionToken(display)} `;
      const before = text.slice(0, anchor);
      const after = text.slice(anchor + 1 + query.length); // drop the `@` + typed query
      const next = before + token + after;
      const caret = before.length + token.length;

      setText(next);
      setMentions((ms) => [...ms.filter((m) => m.display !== display), { ss58: s.author, display }]);
      close();

      // Restore the caret just past the inserted token on the next frame.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          /* selection unsupported in some envs */
        }
      });
    },
    [text, anchor, query, mentions, setText, taRef, close],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false;
      // Every consumed key ALSO stops propagation: the composer sits inside ComposerModal, whose card
      // handles Escape (close) + Tab (focus trap). Without this, Escape-to-dismiss-the-popover would
      // bubble up and close the whole modal (popping the discard-confirm). The EmojiPicker guards the
      // same way. preventDefault alone does NOT stop the synthetic-event bubble.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return true;
      }
      if (results.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => (i + 1) % results.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => (i - 1 + results.length) % results.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        pick(results[activeIndex]);
        return true;
      }
      return false;
    },
    [open, results, activeIndex, pick, close],
  );

  const serialize = useCallback((t: string) => serializeMentions(t, mentions), [mentions]);

  const suggestions =
    open && canSearch ? (
      <MentionSuggestions
        items={results}
        activeIndex={activeIndex}
        loading={loading}
        query={query}
        listId={listId}
        onPick={pick}
        onHover={setActiveIndex}
      />
    ) : null;

  return {
    serialize,
    markSubmitted,
    suggestions,
    open: open && canSearch,
    onTextInput,
    onKeyDown,
    dismiss: close,
  };
}
