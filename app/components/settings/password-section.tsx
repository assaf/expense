import { KeyRound } from "lucide-react";
import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { Section } from "~/components/ui/Section";
import { StatusNote } from "~/components/ui/StatusNote";
import { MAX_PASSWORD_LENGTH } from "~/lib/validation";

/**
 * Settings → Password: change the password you sign in with. This is also
 * where /.well-known/change-password sends password managers and OS password
 * tools, which is why the markup is picky: the section id and the
 * current-password/new-password hints are what make this a change-password
 * form to them, and the submission navigates on success (see the action) so
 * they can tell the change went through and save the new password.
 *
 * A refusal answers JSON and renders inline, so the page stays put and the
 * user keeps what they typed.
 */
export function PasswordSection({ userEmail }: { userEmail: string }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [searchParams] = useSearchParams();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";
  // The action redirects here on success rather than answering the fetcher,
  // so the confirmation rides on the URL (same as the login notices).
  const changed = searchParams.get("password") === "changed";

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
  }, [fetcher.data]);

  useEffect(() => {
    if (!changed) return;
    // The fields no longer describe anything the last submit did, and the
    // new password has no business sitting in the DOM.
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  }, [changed]);

  /** Any edit retires the previous outcome: what the fields say now is not
   * what the last submit answered. */
  function edited(set: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      set(event.currentTarget.value);
      setError(null);
    };
  }

  return (
    <Section
      id="change-password"
      title="Password"
      className="border-t border-gray-100 dark:border-gray-800 pt-6 scroll-mt-6"
    >
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Change the password you sign in with. Every other device is signed out
        and connected assistants have to be reconnected; your expenses, reports
        and mailboxes stay as they are.
      </p>
      <Card className="p-4">
        <fetcher.Form method="post" className="flex max-w-sm flex-col gap-3">
          <input type="hidden" name="intent" value="changePassword" />
          {/* Password managers save the new password against this account
              only if the form names it; the value is the signed-in email. */}
          <input
            type="hidden"
            name="username"
            autoComplete="username"
            value={userEmail}
            readOnly
          />
          <Field label="Current password">
            <Input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              required
              value={current}
              onChange={edited(setCurrent)}
              invalid={Boolean(error)}
            />
          </Field>
          <Field label="New password">
            <Input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={MAX_PASSWORD_LENGTH}
              value={next}
              onChange={edited(setNext)}
              invalid={Boolean(error)}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={edited(setConfirm)}
              invalid={Boolean(error)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              size="md"
              variant="secondary"
              disabled={busy || !current || !next || !confirm}
            >
              <KeyRound aria-hidden="true" className="h-4 w-4" />{" "}
              {busy ? "Changing…" : "Change password"}
            </Button>
          </div>
        </fetcher.Form>
        {error ? (
          <p
            role="alert"
            className="mt-3 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        ) : changed ? (
          <p
            role="status"
            className="mt-3 text-xs text-green-700 dark:text-green-400"
          >
            Password changed. Other devices and connected apps will need to sign
            in again.
          </p>
        ) : (
          <StatusNote className="mt-3 text-xs">
            At least 8 characters. Forgot your current one? Sign out, then use
            "Forgot password?" on the login page.
          </StatusNote>
        )}
      </Card>
    </Section>
  );
}
