import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Input } from "~/components/ui/Input";
import { countLabel } from "~/lib/format";
import { categoriesForSynonym, OPERATOR_ALIASES } from "~/lib/expense-search";

/**
 * The insights filter input with a token-aware dropdown: the suggestion
 * set is computed for the word the caret is in, so `cate` completes to
 * `category:` + its names whether it's the first token or the fifth
 * (native datalists match the whole input value and can't do that). A
 * name typed in the clear completes to its filter form, `Amazon Pha` to
 * `merchant:Amazon Pharmacy `, with the trailing space the next filter
 * is typed straight after.
 *
 * Keyboard: ↓/↑ move, Enter or Tab accepts, Escape dismisses. Options
 * accept on mousedown so the input never blurs mid-pick.
 */

export interface FilterNames {
  merchants: [string, number][];
  categories: [string, number][];
  reports: [string, number][];
}

interface Suggestion {
  /** Replacement for the active token, from `start` on (trailing space
   * when the token is complete, none after a bare operator you'll keep
   * typing). */
  completion: string;
  /** Offset inside the active token where `completion` starts replacing
   * it. Zero for everything typed as one word; a bare candidate replaces
   * only the words a name covers, so the words ahead of them ("coffee"
   * in "coffee Amazon Pha") stay free text. */
  start: number;
  label: string;
  hint: string;
}

const OPERATORS = [
  "merchant:",
  "category:",
  "report:",
  "description:",
  "amount:",
] as const;

/** Generous cap: the list scrolls, so long merchant lists stay reachable
 * without rendering unbounded DOM. */
const MAX_OPTIONS = 50;

/** Suggestions for the candidate under the caret: an operator's value
 * ("merchant:off"), or the free-text run parseQuery reads as bare words
 * ("Amazon Pha" — the words a name starts complete to it). */
export function tokenSuggestions(
  token: string,
  names: FilterNames,
): Suggestion[] {
  const t = token.toLowerCase();
  // Nothing typed under the caret: no suggestions (this is also what
  // keeps the dropdown closed when the value is set programmatically).
  if (!t.trim()) return [];
  const byRest = (list: FilterNames["merchants"], key: string, rest: string) =>
    list
      .filter(([name]) =>
        // Mid-word on a multi-word value ("report:2026 t"): the name only
        // needs to contain the typed fragment — selecting the suggestion
        // replaces the whole operator with the parse-exact form.
        rest.includes(" ")
          ? name.toLowerCase().includes(rest)
          : name.toLowerCase().startsWith(rest),
      )
      .slice(0, MAX_OPTIONS)
      .map(([name, count]) => ({
        completion: `${key}:${name} `,
        start: 0,
        label: name,
        hint: countLabel(count),
      }));
  const categorySynonymSuggestions = (rest: string) =>
    categoriesForSynonym(rest).map((name) => ({
      completion: `category:${name} `,
      start: 0,
      label: name,
      hint: "category",
    }));
  // An operator (canonical or aliased) with a value completes names for
  // its canonical key; an alias with its colon still completes the
  // canonical operator ("fro:" -> "merchant:") so queries stay canonical.
  // The value may contain spaces ("report:2026 test" is one token here,
  // matching parseQuery, where an operator's value runs to the next
  // operator).
  const op =
    /^(merchant|category|report|description|amount|from|vendor|store|seller|cat|in|for|desc|note|notes):(.*)$/.exec(
      t,
    );
  if (op) {
    // Aliases carry their canonical key, so "from:dev" completes merchant
    // names; the alias stays in the query and parses identically.
    const canonical = OPERATOR_ALIASES[op[1]!] ?? op[1]!;
    const source =
      canonical === "merchant"
        ? names.merchants
        : canonical === "category"
          ? names.categories
          : canonical === "report"
            ? names.reports
            : [];
    const rest = op[2] ?? "";
    // A synonym typed after the category operator ("category:food")
    // offers the canonical category it means.
    return [
      ...byRest(source, canonical, rest),
      ...(canonical === "category" ? categorySynonymSuggestions(rest) : []),
    ].slice(0, MAX_OPTIONS);
  }
  // A bare candidate is parseQuery's free text (its `words`). The words at
  // its end that a name starts complete to that name's filter form: one
  // word as it is typed ("office" -> merchant:OfficeMax), or a multi-word
  // name typed in the clear by its longest matching run ("Amazon Pha" ->
  // merchant:Amazon Pharmacy), which leaves any words ahead of it as free
  // text. Operators, aliases and category synonyms are single words, so
  // they complete on the word being typed.
  const words = [...t.matchAll(/\S+/g)];
  const last = words[words.length - 1]!;
  const typed = last[0];
  const typedAt = last.index;
  const aliasCompletions = Object.entries(OPERATOR_ALIASES)
    .filter(([alias]) => alias.startsWith(typed))
    .map(([alias, canonical]) => ({
      completion: `${canonical}:`,
      start: typedAt,
      label: `${alias}: (${canonical}:)`,
      hint: "filter",
    }));
  const operators = OPERATORS.filter((o) => o.startsWith(typed)).map((o) => ({
    completion: o,
    start: typedAt,
    label: o,
    hint: "filter",
  }));
  // A bare word that is a built-in synonym of a category ("food", "gas")
  // offers that category's operator form.
  const synonymCategories = categoriesForSynonym(typed).map((name) => ({
    completion: `category:${name} `,
    start: typedAt,
    label: name,
    hint: "category",
  }));
  /** The longest run of typed words the account's names start, or 0 when
   * none does. One run for every list: an older word (the lone "t" in
   * "2026 t") never rides along on a shorter fallback. */
  const allNames = [...names.merchants, ...names.categories, ...names.reports];
  let run = 0;
  for (let length = words.length; length >= 1 && run === 0; length--) {
    const phrase = t.slice(words[words.length - length]!.index);
    if (allNames.some(([name]) => name.toLowerCase().startsWith(phrase)))
      run = length;
  }
  const namesFor = (list: FilterNames["merchants"], key: string) => {
    if (run === 0) return [];
    const from = words[words.length - run]!.index;
    const matching = list.filter(([name]) =>
      name.toLowerCase().startsWith(t.slice(from)),
    );
    return matching.slice(0, MAX_OPTIONS).map(([name, count]) => ({
      completion: `${key}:${name} `,
      start: from,
      label: name,
      hint: countLabel(count),
    }));
  };
  return [
    ...operators,
    ...aliasCompletions,
    ...synonymCategories,
    ...namesFor(names.merchants, "merchant"),
    ...namesFor(names.categories, "category"),
    ...namesFor(names.reports, "report"),
  ].slice(0, MAX_OPTIONS);
}

export function FilterCombobox({
  value,
  onChange,
  names,
  placeholder,
  ariaLabel,
  id = "filter-combobox",
  inputRef,
  leading,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  names: FilterNames;
  placeholder: string;
  ariaLabel: string;
  /** DOM id of the input (the listbox derives its id from it). */
  id?: string;
  /** Ref to the input, for shortcut focus (home's "/" key). */
  inputRef?: Ref<HTMLInputElement>;
  /** Icon rendered inside the input's left edge. */
  leading?: ReactNode;
  className?: string;
}) {
  const localRef = useRef<HTMLInputElement>(null);
  const setInputRef = (el: HTMLInputElement | null) => {
    localRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) inputRef.current = el;
  };
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // The candidate the caret sits in: if an operator prefix ("report:",
  // aliased included) is open at the caret, its value runs to the caret
  // and may contain spaces (parseQuery semantics: an operator's value
  // runs to the next operator). Otherwise it's the free-text run before
  // the caret (parseQuery's `words`), which is what lets a multi-word
  // name typed in the clear complete; a caret after whitespace has a
  // finished word under it and nothing left to complete.
  const { token, tokenStart } = useMemo(() => {
    const upToCaret = value.slice(0, caret).toLowerCase();
    const re =
      /(?:^|\s)(merchant|category|report|description|amount|from|vendor|store|seller|cat|in|for|desc|note|notes):/gi;
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(upToCaret); m; m = re.exec(upToCaret)) last = m;
    if (last) {
      const start = last.index + last[0].length - last[1].length - 1;
      return { token: upToCaret.slice(start), tokenStart: start };
    }
    if (/\s$/.test(upToCaret)) return { token: "", tokenStart: caret };
    return { token: upToCaret, tokenStart: 0 };
  }, [value, caret]);

  const options = useMemo(
    () => (open ? tokenSuggestions(token, names) : []),
    [open, token, names],
  );

  useEffect(() => {
    setActive(0);
  }, [token, open]);

  const apply = (s: Suggestion) => {
    const from = tokenStart + s.start;
    const next = value.slice(0, from) + s.completion + value.slice(caret);
    onChange(next);
    // Put the caret at the end of the inserted completion.
    const pos = from + s.completion.length;
    queueMicrotask(() => {
      localRef.current?.focus();
      localRef.current?.setSelectionRange(pos, pos);
    });
  };
  const listId = `${id}-options`;
  // Keyboard navigation scrolls the active option into view (the list
  // is taller than the viewport cap for long merchant lists).
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, options]);

  return (
    <div className="relative">
      <Input
        ref={setInputRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onSelect={(e) =>
          setCaret(
            e.currentTarget.selectionStart ?? e.currentTarget.value.length,
          )
        }
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!open || options.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            apply(options[active]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className={`w-full ${leading ? "pl-9" : ""} ${className}`}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        // DOM focus stays on the input while the arrow keys move a visible
        // highlight, so the highlight has to be named here or a screen reader
        // never hears which option the keys are on.
        aria-activedescendant={
          open && active >= 0 && active < options.length
            ? `${listId}-opt-${active}`
            : undefined
        }
        aria-label={ariaLabel}
      />
      {leading ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 [&>svg]:h-4 [&>svg]:w-4"
        >
          {leading}
        </div>
      ) : null}
      {open && options.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full z-20 mt-1 max-h-64 w-full overflow-y-auto overscroll-contain rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {options.map((s, i) => (
            <li key={`${s.completion}-${i}`}>
              <button
                type="button"
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                ref={i === active ? activeRef : undefined}
                // mousedown applies before the input's blur can close the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  apply(s);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${
                  i === active
                    ? "bg-gray-100 dark:bg-gray-700"
                    : "bg-white dark:bg-gray-800"
                }`}
              >
                <span className="min-w-0 truncate text-gray-800 dark:text-gray-100">
                  {s.label}
                </span>
                <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">
                  {s.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
