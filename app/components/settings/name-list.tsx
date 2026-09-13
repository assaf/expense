import { forwardRef, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { useFetcher } from "react-router";
import { AddNameForm } from "~/components/AddNameForm";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { ListRow, useFlashRow } from "~/components/ui/ListRow";
import { LiveStatus } from "~/components/ui/LiveStatus";
import { RemoveButton } from "~/components/ui/RemoveButton";
import { Section } from "~/components/ui/Section";
import { StatusNote } from "~/components/ui/StatusNote";
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
  // A new entry landed (the add fetcher, no page navigation): flash it.
  // The loader revalidation has already added the row by the time this
  // runs, so the flash ref is available on the next render.
  const { flashKey, rowRef, flash } = useFlashRow<string>();

  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    if (flashKey) setAnnouncement(`Added ${flashKey}`);
    else setAnnouncement(null);
  }, [flashKey]);

  return (
    <Section id={id} title={title}>
      <LiveStatus>{announcement}</LiveStatus>
      <ul className="mb-3 flex flex-col gap-1">
        {items.length === 0 ? (
          <StatusNote as="li">None yet.</StatusNote>
        ) : (
          items.map((item) => (
            <ListRow
              key={item.name}
              flash={item.name === flashKey}
              rowRef={rowRef}
            >
              {renderItem(item)}
            </ListRow>
          ))
        )}
      </ul>
      <AddNameForm
        intent={addIntent}
        placeholder={addPlaceholder}
        onAdded={(name) => flash(name)}
      />
    </Section>
  );
}

/**
 * Inline rename editor: an input pre-filled with the current name, Save,
 * and Cancel. Submits through a fetcher (no page navigation; the page
 * stays put, and the action's error, e.g. a duplicate name, is shown
 * inline). The row that hosts it is keyed by name, so a successful rename
 * remounts the row and closes the editor.
 */
type RenameResult = { ok: boolean; error?: string };

export function RenameForm({
  intent,
  name,
  onCancel,
}: {
  intent: string;
  /** Current name; also the hidden `name` field the action matches on. */
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

export const RenameButton = forwardRef<
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
          fields={{ name: category.name }}
          label={`Remove ${category.name}`}
          confirm={confirmRemove}
        />
      </div>
    </>
  );
}
