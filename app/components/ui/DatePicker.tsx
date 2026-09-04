import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "cn";
import { todayDate } from "~/lib/format";
import { inputVariants } from "~/components/ui/Input";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Parse "YYYY-MM-DD" into a local Date (null when malformed). */
function parseISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local Date → "YYYY-MM-DD". */
function toISO(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** "Friday, August 15, 2026" for the day-button accessible names. */
function formatLong(iso: string): string {
  const d = parseISO(iso);
  if (!d) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const TABBABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The element the user would Tab to next (or Shift+Tab to, backwards). */
function siblingFocusable(el: HTMLElement, shift: boolean): HTMLElement | null {
  const els = Array.from(
    document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  );
  const idx = els.indexOf(el);
  if (idx === -1) return null;
  const next = shift ? idx - 1 : idx + 1;
  return els[next] ?? null;
}

/** Date input + colored calendar popover. The input stays editable so a date
 * can be typed directly ("YYYY-MM-DD"); the calendar colors days so a future
 * date can't be picked by accident: black for ordinary dates, blue for
 * today, orange for future dates, and a filled blue circle for the selected
 * date. The popover traps the editor's document-level Enter-save /
 * Escape-cancel shortcuts while open and restores focus on close. */
export function DatePicker({
  value,
  onChange,
  disabled,
  invalid,
  className,
}: {
  /** YYYY-MM-DD ("" when unset). */
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const today = todayDate();
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => {
    const d = parseISO(value);
    return d?.getFullYear() ?? new Date().getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = parseISO(value);
    return d?.getMonth() ?? new Date().getMonth();
  });
  const [focused, setFocused] = useState(value || today);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const openPicker = () => {
    if (disabled) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const initial = value || today;
    const d = parseISO(initial) ?? new Date();
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setFocused(initial);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    restoreRef.current?.focus();
  };

  // Keep the roving-focus day cell focused as it (or the view month) moves.
  useEffect(() => {
    if (!open) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-iso="${focused}"]`)
      ?.focus();
  }, [open, focused, viewYear, viewMonth]);

  // Close when a mousedown lands outside the control (the popover is
  // non-modal; the editor's own shortcuts are guarded in onPopoverKeyDown).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  /** Move the focused day by a number of days, following month boundaries. */
  const moveDay = (delta: number) => {
    const d = parseISO(focused) ?? new Date();
    d.setDate(d.getDate() + delta);
    setFocused(toISO(d));
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  /** Move to the same day of month in an adjacent month (clamped). */
  const shiftMonth = (delta: number) => {
    const d = parseISO(focused) ?? new Date(viewYear, viewMonth, 1);
    const day = d.getDate();
    const first = new Date(d.getFullYear(), d.getMonth() + delta, 1);
    const lastDay = new Date(
      first.getFullYear(),
      first.getMonth() + 1,
      0,
    ).getDate();
    first.setDate(Math.min(day, lastDay));
    setFocused(toISO(first));
    setViewYear(first.getFullYear());
    setViewMonth(first.getMonth());
  };

  const selectFocused = () => {
    onChange(focused);
    close();
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveDay(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveDay(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveDay(-7);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveDay(7);
        break;
      case "Home":
        e.preventDefault();
        setFocused(toISO(new Date(viewYear, viewMonth, 1)));
        break;
      case "End":
        e.preventDefault();
        setFocused(toISO(new Date(viewYear, viewMonth, daysInMonth)));
        break;
      case "PageUp":
        e.preventDefault();
        shiftMonth(e.shiftKey ? 12 : 1);
        break;
      case "PageDown":
        e.preventDefault();
        shiftMonth(e.shiftKey ? -12 : -1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        selectFocused();
        break;
    }
  };

  // The editor binds Enter→Save and Escape→Cancel on document; the popover
  // must not trigger either. Tab moves focus out and closes the picker.
  const onPopoverKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const next = siblingFocusable(inputRef.current!, e.shiftKey);
      setOpen(false);
      (next ?? inputRef.current)?.focus();
    }
  };

  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      toISO(new Date(viewYear, viewMonth, i + 1)),
    ),
  ];

  // The field itself echoes the calendar colors so a selected future date
  // is visible at a glance even with the popover closed.
  const valueTone =
    value && value === today
      ? "text-blue-600 dark:text-blue-400"
      : value && value > today
        ? "text-orange-600 dark:text-orange-400"
        : "text-gray-900 dark:text-gray-100";

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="YYYY-MM-DD"
        className={cn(inputVariants({ invalid }), "w-full pr-10", valueTone)}
        value={value}
        disabled={disabled}
        onClick={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label="Open calendar"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={openPicker}
        className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-md border border-gray-300 bg-gray-100 p-1.5 text-gray-600 shadow-sm hover:border-gray-400 hover:bg-gray-200 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-600 dark:hover:text-gray-100"
      >
        <CalendarDays aria-hidden="true" className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose a date"
          className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-800"
          onKeyDown={onPopoverKeyDown}
        >
          <div className="mb-2 flex items-center justify-between gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => shiftMonth(-1)}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1">
              <select
                aria-label="Month"
                value={viewMonth}
                onChange={(e) => {
                  const d =
                    parseISO(focused) ?? new Date(viewYear, viewMonth, 1);
                  const month = Number(e.target.value);
                  const lastDay = new Date(viewYear, month + 1, 0).getDate();
                  d.setDate(Math.min(d.getDate(), lastDay));
                  d.setMonth(month);
                  setFocused(toISO(d));
                  setViewMonth(month);
                }}
                className={cn(
                  inputVariants(),
                  "rounded-md px-1.5 py-1 text-sm",
                )}
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                aria-label="Year"
                type="number"
                min={1900}
                max={2999}
                value={viewYear}
                onChange={(e) => {
                  const year = Number(e.target.value);
                  if (!e.target.value || Number.isNaN(year)) return;
                  const d =
                    parseISO(focused) ?? new Date(viewYear, viewMonth, 1);
                  const lastDay = new Date(year, viewMonth + 1, 0).getDate();
                  d.setDate(Math.min(d.getDate(), lastDay));
                  d.setFullYear(year);
                  setFocused(toISO(d));
                  setViewYear(year);
                }}
                className={cn(
                  inputVariants(),
                  "w-20 rounded-md px-1.5 py-1 text-sm",
                )}
              />
            </div>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => shiftMonth(1)}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="text-center text-xs font-medium text-gray-500 dark:text-gray-400"
              >
                {d}
              </div>
            ))}
          </div>
          <div
            ref={gridRef}
            role="grid"
            aria-label="Calendar"
            className="grid grid-cols-7 gap-1"
            onKeyDown={onGridKeyDown}
          >
            {cells.map((iso, i) => {
              if (!iso) return <div key={i} />;
              const isSelected = iso === value;
              const isToday = iso === today;
              const isFuture = iso > today;
              return (
                <button
                  key={iso}
                  type="button"
                  tabIndex={iso === focused ? 0 : -1}
                  data-iso={iso}
                  aria-label={formatLong(iso)}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => {
                    onChange(iso);
                    close();
                  }}
                  className={cn(
                    "h-8 w-8 rounded-full text-sm tabular-nums transition-colors",
                    "hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700",
                    isSelected
                      ? "bg-blue-600 font-medium text-white dark:bg-blue-500"
                      : isToday
                        ? "font-medium text-blue-600 dark:text-blue-400"
                        : isFuture
                          ? "text-orange-600 dark:text-orange-400"
                          : "text-gray-800 dark:text-gray-100",
                  )}
                >
                  {Number(iso.slice(8, 10))}
                </button>
              );
            })}
          </div>
          <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
            <button
              type="button"
              onClick={() => {
                onChange(today);
                close();
              }}
              className="w-full rounded-md py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400 dark:hover:bg-gray-700"
            >
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
