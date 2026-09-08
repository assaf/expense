import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "~/components/ui/Input";
import { countLabel } from "~/lib/format";
import { categoriesForSynonym, OPERATOR_ALIASES } from "~/lib/expense-search";

/**
 * The insights filter input with a token-aware dropdown: the suggestion
 * set is computed for the word the caret is in, so `cate` completes to
 * `category:` + its names whether it's the first token or the fifth
 * (native datalists match the whole input value and can't do that).
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
  /** Full replacement for the active token (trailing space when the
   * token is complete, none after a bare operator you'll keep typing). */
  completion: string;
  label: string;
  hint: string;
}

const OPERATORS = [
  "merchant:",
  "category:",
  "report:",
  "description:",
] as const;

/** Generous cap: the list scrolls, so long merchant lists stay reachable
 * without rendering unbounded DOM. */
const MAX_OPTIONS = 50;

/** Suggestions for the token under the caret. */
export function tokenSuggestions(
  token: string,
  names: FilterNames,
): Suggestion[] {
  const t = token.toLowerCase();
  const byRest = (
    list: FilterNames["merchants"],
    key: string,
    rest: string,
  ) => {
    const prefix = list
      .filter(([name]) => name.toLowerCase().startsWith(rest))
      .slice(0, MAX_OPTIONS)
      .map(([name, count]) => ({
        completion: `${key}:${name} `,
        label: name,
        hint: countLabel(count),
      }));
    // A synonym typed after the operator ("category:food") offers the
    // canonical category it means.
    const synonyms = (key === "category" ? categoriesForSynonym(rest) : []).map(
      (name) => ({
        completion: `${key}:${name} `,
        label: name,
        hint: "category",
      }),
    );
    return [...prefix, ...synonyms].slice(0, MAX_OPTIONS);
  };
  // An operator (canonical or aliased) with a value completes names for
  // its canonical key; an alias with its colon still completes the
  // canonical operator ("fro:" -> "merchant:") so queries stay canonical.
  const op =
    /^(merchant|category|report|description|from|vendor|store|seller|cat|in|for|desc|note|notes):(.*)$/.exec(
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
    return byRest(source, canonical, op[2] ?? "");
  }
  const aliasCompletions = Object.entries(OPERATOR_ALIASES)
    .filter(([alias]) => alias.startsWith(t))
    .map(([alias, canonical]) => ({
      completion: `${canonical}:`,
      label: `${alias}: (${canonical}:)`,
      hint: "filter",
    }));
  const operators = OPERATORS.filter((o) => o.startsWith(t)).map((o) => ({
    completion: o,
    label: o,
    hint: "filter",
  }));
  const namesFor = (list: FilterNames["merchants"], key: string) =>
    byRest(list, key, t);
  // A bare word that is a built-in synonym of a category ("food", "gas")
  // offers that category's operator form.
  const synonymCategories = categoriesForSynonym(t).map((name) => ({
    completion: `category:${name} `,
    label: name,
    hint: "category",
  }));
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
}: {
  value: string;
  onChange: (value: string) => void;
  names: FilterNames;
  placeholder: string;
  ariaLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // The word the caret sits in (the candidate being typed).
  const { token, tokenStart } = useMemo(() => {
    const upToCaret = value.slice(0, caret);
    const m = /(\S*)$/.exec(upToCaret);
    return { token: m![1]!, tokenStart: caret - m![1]!.length };
  }, [value, caret]);

  const options = useMemo(
    () => (open ? tokenSuggestions(token, names) : []),
    [open, token, names],
  );

  useEffect(() => {
    setActive(0);
  }, [token, open]);

  const apply = (s: Suggestion) => {
    const next = value.slice(0, tokenStart) + s.completion + value.slice(caret);
    onChange(next);
    // Put the caret at the end of the inserted completion.
    const pos = tokenStart + s.completion.length;
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  };
  const listId = "insights-filter-options";
  // Keyboard navigation scrolls the active option into view (the list
  // is taller than the viewport cap for long merchant lists).
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, options]);

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id="insights-query"
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
        autoComplete="off"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        className="w-full pr-9"
      />
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
