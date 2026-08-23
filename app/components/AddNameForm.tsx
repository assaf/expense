import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

/** Server payload shared by every "add a name" intent (reports,
 * categories): success echoes the created name, rejection explains why. */
type NameAddResult = { ok: boolean; name?: string; error?: string };

interface UseNameAddOptions {
  /** The hidden `intent` submitted with the add request. */
  intent: string;
  /** Called with the created name after a successful add. */
  onAdded?: (name: string) => void;
}

/** The add-a-name flow shared by the settings lists, the export page and
 * the editors' inline report creator: a fetcher plus the draft/error
 * state, with a rejected add (empty or duplicate) keeping its error and a
 * successful one clearing the input. */
export function useNameAdd({ intent, onAdded }: UseNameAddOptions) {
  const fetcher = useFetcher<NameAddResult>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Kept in a ref so an inline callback doesn't retrigger the effect.
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  useEffect(() => {
    const { data } = fetcher;
    if (!data) return;
    if (data.ok && data.name) {
      setDraft("");
      setError(null);
      onAddedRef.current?.(data.name);
    } else if (data.error) {
      setError(data.error);
    }
  }, [fetcher.data]);

  const updateDraft = (value: string) => {
    setDraft(value);
    setError(null);
  };
  const submit = () => {
    const name = draft.trim();
    if (!name) return;
    void fetcher.submit({ intent, name }, { method: "post" });
  };
  const reset = () => {
    setDraft("");
    setError(null);
  };

  return { fetcher, draft, updateDraft, error, submit, reset };
}

interface AddNameFormProps {
  intent: string;
  placeholder: string;
  onAdded?: (name: string) => void;
}

/** The "<input> + Add" row for naming things: hidden intent, an
 * invalid-wired input that clears its error as you type, an Add button
 * disabled until the draft has content, and the rejection error line
 * underneath. */
export function AddNameForm({
  intent,
  placeholder,
  onAdded,
}: AddNameFormProps) {
  const { fetcher, draft, updateDraft, error } = useNameAdd({
    intent,
    onAdded,
  });
  return (
    <>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={intent} />
        <Input
          type="text"
          name="name"
          value={draft}
          onChange={(e) => updateDraft(e.target.value)}
          placeholder={placeholder}
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
    </>
  );
}
