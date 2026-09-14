import { AtSign } from "lucide-react";
import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { Field } from "~/components/ui/Field";
import { FieldLabel } from "~/components/ui/FieldLabel";
import { Input } from "~/components/ui/Input";
import { StatusNote } from "~/components/ui/StatusNote";

/**
 * Settings → Your email: the address this account signs in with, and the form
 * that moves it. The change is immediate, so the address shown here is read
 * fresh by the loader (not from the 30-second user cache), and the action
 * navigates on success (see the action) so this card re-renders with the new
 * address and the confirmation.
 *
 * A refusal answers JSON and renders inline, so the page stays put and the
 * typed address survives it. The old address gets a notice email; the new one
 * gets its own receipts-by-email verification link.
 */
export function SignInEmailForm({ userEmail }: { userEmail: string }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";
  const changed = searchParams.get("email") === "changed";

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
  }, [fetcher.data]);

  useEffect(() => {
    if (!changed) return;
    setEmail("");
    setPassword("");
    setError(null);
  }, [changed]);

  return (
    <Card id="sign-in-email" className="mb-4 scroll-mt-6 p-4">
      <FieldLabel as="div" muted>
        Sign-in email
      </FieldLabel>
      <div className="mb-3 truncate font-mono text-sm">{userEmail}</div>
      <fetcher.Form method="post" className="flex max-w-sm flex-col gap-3">
        <input type="hidden" name="intent" value="changeEmail" />
        <Field label="New email">
          <Input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setEmail(event.currentTarget.value);
              setError(null);
            }}
            invalid={Boolean(error)}
          />
        </Field>
        <Field label="Current password">
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setPassword(event.currentTarget.value);
              setError(null);
            }}
            invalid={Boolean(error)}
          />
        </Field>
        <div>
          <Button
            type="submit"
            size="md"
            variant="secondary"
            disabled={busy || !email || !password}
          >
            <AtSign aria-hidden="true" className="h-4 w-4" />{" "}
            {busy ? "Changing…" : "Change email"}
          </Button>
        </div>
      </fetcher.Form>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : changed ? (
        <p
          role="status"
          className="mt-3 text-xs text-green-700 dark:text-green-400"
        >
          Sign-in email changed. We emailed your old address to let you know.
        </p>
      ) : (
        <StatusNote className="mt-3 text-xs">
          We email the new address a link to confirm it before receipts sent
          from there are accepted. Until you remove it on the Email page, the
          old address keeps importing receipts.
        </StatusNote>
      )}
    </Card>
  );
}
