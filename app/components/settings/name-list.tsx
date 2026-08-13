import { forwardRef, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { countLabel } from "~/lib/format";

/**
 * One category row in Settings: name + the number of expenses in reports
 * that are not closed, and a delete button. Deleting a category used by
 * more than one such expense asks for confirmation first.
 */
export type CategoryItem = { name: string; count: number };

export function NameList<T extends { name: string }>({
  title,
  id,
  items,
  addIntent,
  addPlaceholder,
  renderItem,
}: {
  title: string;
  /** Anchor target for in-page links (e.g. /settings#reports). */
  id?: string;
  items: readonly T[];
  addIntent: string;
  addPlaceholder: string;
  /** Full row content for every item in the list. */
  renderItem: (item: T) => ReactNode;
}) {
  const fetcher = useFetcher<{ ok: boolean; name?: string; error?: string }>();
  const [flashName, setFlashName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const flashRef = useRef<HTMLLIElement | null>(null);

  // A new entry landed (fetcher, no page navigation): flash it and clear
  // the add input. A rejected add (duplicate) shows its error inline. The
  // loader revalidation has already added the row by the time this runs,
  // so the flash ref is available on the next render.
  useEffect(() => {
    const { data } = fetcher;
    if (!data) return;
    if (data.ok && data.name) {
      setFlashName(data.name);
      setError(null);
      setDraft("");
    } else if (data.error) {
      setError(data.error);
    }
  }, [fetcher.data]);

  // Time-box the flash and bring the new row into view.
  useEffect(() => {
    if (!flashName) return;
    flashRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    const timer = setTimeout(() => setFlashName(null), 3000);
    return () => clearTimeout(timer);
  }, [flashName]);

  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    if (flashName) setAnnouncement(`Added ${flashName}`);
    else setAnnouncement(null);
  }, [flashName]);

  return (
    <section id={id} className="mb-8 scroll-mt-6">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <ul className="mb-3 flex flex-col gap-1">
        {items.length === 0 ? (
          <li className="text-sm text-gray-500 dark:text-gray-400">
            None yet.
          </li>
        ) : (
          items.map((item) => (
            <li
              key={item.name}
              ref={item.name === flashName ? flashRef : undefined}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 transition-colors duration-500 ${
                item.name === flashName
                  ? "bg-amber-200 dark:bg-amber-800"
                  : "bg-gray-50 dark:bg-gray-900"
              }`}
            >
              {renderItem(item)}
            </li>
          ))
        )}
      </ul>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={addIntent} />
        <Input
          type="text"
          name="name"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder={addPlaceholder}
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="flex-1"
        />
        <Button
          type="submit"
          size="md"
          variant="secondary"
          disabled={!draft.trim()}
        >
          <Plus aria-hidden="true" className="h-4 w-4" /> Add
        </Button>
      </fetcher.Form>
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </section>
  );
}

/**
 * Inline rename editor: an input pre-filled with the current name, Save,
 * and Cancel. Submits through a fetcher (no page navigation — the page
 * stays put, and the action's error, e.g. a duplicate name, is shown
 * inline). The row that hosts it is keyed by name, so a successful rename
 * remounts the row and closes the editor.
 */
type RenameResult = { ok: boolean; error?: string };

function RenameForm({
  intent,
  name,
  onCancel,
}: {
  intent: string;
  /** Current name — also the hidden `name` field the action matches on. */
  name: string;
  onCancel: () => void;
}) {
  const fetcher = useFetcher<RenameResult>();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
    else if (fetcher.data?.ok) setError(null);
  }, [fetcher.data]);

  return (
    <div className="flex w-full flex-col gap-1">
      <fetcher.Form method="post" className="flex w-full items-center gap-2">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="name" value={name} />
        <Input
          type="text"
          name="newName"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="min-w-0 flex-1 px-2 py-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!draft.trim() || draft === name}
        >
          Save
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-sm text-gray-500 dark:text-gray-400 hover:text-ink"
        >
          Cancel
        </button>
      </fetcher.Form>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}

const RenameButton = forwardRef<
  HTMLButtonElement,
  { onClick: () => void; name: string }
>(function RenameButton({ onClick, name }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="text-gray-500 dark:text-gray-400 hover:text-ink"
      aria-label={`Rename ${name}`}
    >
      <Pencil aria-hidden="true" className="h-4 w-4" />
    </button>
  );
});

/**
 * The trash button for a named row (category/report): hidden intent/name
 * inputs inside the row's own fetcher form, with an optional confirm
 * prompt before submitting.
 */
function RemoveButton({
  fetcher,
  intent,
  name,
  confirm,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  intent: string;
  name: string;
  /** When set, asks for confirmation with this message before deleting. */
  confirm?: string;
}) {
  return (
    <fetcher.Form
      method="post"
      className="contents"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="name" value={name} />
      <button
        type="submit"
        className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400"
        aria-label={`Remove ${name}`}
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" />
      </button>
    </fetcher.Form>
  );
}

export function CategoryRow({ category }: { category: CategoryItem }) {
  const [editing, setEditing] = useState(false);
  const renameRef = useRef<HTMLButtonElement>(null);
  const removeFetcher = useFetcher();
  const confirmRemove =
    category.count > 1
      ? `This category contains ${category.count} expenses in open reports. Delete it anyway?`
      : undefined;
  useEffect(() => {
    if (!editing) renameRef.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <RenameForm
        intent="renameCategory"
        name={category.name}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <>
      <span className="truncate">{category.name}</span>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="text-xs text-gray-500 dark:text-gray-400"
          title="Expenses in reports that are not closed"
        >
          {category.count === 0 ? "No expenses" : countLabel(category.count)}
        </span>
        <RenameButton
          ref={renameRef}
          onClick={() => setEditing(true)}
          name={category.name}
        />
        <RemoveButton
          fetcher={removeFetcher}
          intent="removeCategory"
          name={category.name}
          confirm={confirmRemove}
        />
      </div>
    </>
  );
}
