import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useFetcher } from "react-router";
import { cn } from "cn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";

/**
 * The trash button for a row: the hidden intent plus the row-identifying
 * inputs, posted through the row's own fetcher, asking first when the caller
 * passes `confirm`. The question is the app's own dialog rather than
 * `window.confirm`, which a browser can suppress and which looks nothing
 * like the confirms on the expense, email-review, and reconcile pages.
 */
export function RemoveButton({
  fetcher,
  intent,
  fields,
  label,
  confirm,
  disabled,
  title,
  className,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  intent: string;
  /** Hidden inputs carrying the row's identity, e.g. { name } or { id }. */
  fields: Record<string, string>;
  /** Accessible label, e.g. "Remove Groceries". */
  label: string;
  /** When set, asks for confirmation with this message before deleting. */
  confirm?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const submit = () => {
    const form = formRef.current;
    if (form) void fetcher.submit(new FormData(form), { method: "post" });
  };
  return (
    <>
      <form
        ref={formRef}
        method="post"
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm) setAsking(true);
          else submit();
        }}
      >
        <input type="hidden" name="intent" value={intent} />
        {Object.entries(fields).map(([fieldName, value]) => (
          <input key={fieldName} type="hidden" name={fieldName} value={value} />
        ))}
        <button
          type="submit"
          disabled={disabled}
          className={cn(
            "text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400 disabled:opacity-50",
            className,
          )}
          aria-label={label}
          title={title}
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </form>
      {asking ? (
        <ConfirmDialog
          message={confirm ?? ""}
          onConfirm={() => {
            setAsking(false);
            submit();
          }}
          onCancel={() => setAsking(false)}
          deleting={fetcher.state !== "idle"}
        />
      ) : null}
    </>
  );
}
