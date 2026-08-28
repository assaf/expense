import { KeyRound, MailCheck, ReceiptText } from "lucide-react";
import { Link, data } from "react-router";
import { AuthCard, AuthHeader, AuthTile } from "~/components/auth/AuthCard";
import { Button } from "~/components/ui/Button";
import { Alert } from "~/components/ui/Alert";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import {
  guardAnonymousAction,
  recordAnonymousAttempt,
  rejectCrossSitePost,
  requestPasswordReset,
  resetPasswordWithToken,
} from "~/lib/auth.server";
import {
  formString,
  isEmail,
  MAX_PASSWORD_LENGTH,
  unknownIntent,
} from "~/lib/validation";
import type { Route } from "./+types/reset-password";

/**
 * Password recovery: request an emailed single-use link, then set a new
 * password with it. Public (the token IS the credential; the root loader
 * treats it like /verify-email). Entry points: the "Forgot password?"
 * links on /login and the attach step of /onboarding.
 */

type ActionData =
  | { view: "request"; error?: string }
  | { view: "requested" }
  | { view: "reset"; token: string; email: string; error?: string }
  | { view: "done"; email: string };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return {
    // ?token= prefills the reset form (emailed link); ?email= prefills the
    // request form (onboarding's attach step links here with it).
    token: url.searchParams.get("token") ?? "",
    email: url.searchParams.get("email") ?? "",
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Reset password — Expense" }];
}

export async function action({ request }: Route.ActionArgs) {
  rejectCrossSitePost(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "request") {
    // Anonymous work (an email send per request); cap per IP like signup.
    await guardAnonymousAction(request);
    const email = formString(form, "email").trim().toLowerCase();
    if (!isEmail(email)) {
      await recordAnonymousAttempt(request);
      return data({
        view: "request",
        error: "Enter a valid email address",
      } satisfies ActionData);
    }
    // Always the same outcome, whether or not the account exists.
    await requestPasswordReset(email, new URL(request.url).origin);
    await recordAnonymousAttempt(request);
    return data({ view: "requested" } satisfies ActionData);
  }

  if (intent === "reset") {
    // The confirm step derives a full scrypt hash when the token is live,
    // so cap it per IP like the request email above: every attempt counts,
    // not just failures.
    await guardAnonymousAction(request);
    const token = formString(form, "token");
    const email = formString(form, "email").trim().toLowerCase();
    const password = formString(form, "password");
    try {
      const result = await resetPasswordWithToken(token, password);
      await recordAnonymousAttempt(request);
      return data({ view: "done", email: result.email } satisfies ActionData);
    } catch (error) {
      await recordAnonymousAttempt(request);
      const message =
        error instanceof Error ? error.message : "Something went wrong";
      return data({
        view: "reset",
        token,
        email,
        error: message,
      } satisfies ActionData);
    }
  }

  return unknownIntent();
}

export default function ResetPasswordPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const state: ActionData =
    actionData ??
    (loaderData.token
      ? { view: "reset", token: loaderData.token, email: loaderData.email }
      : { view: "request" });
  const error = "error" in state ? state.error : null;

  return (
    <AuthCard>
      <AuthHeader
        icon={
          <AuthTile>
            <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
          </AuthTile>
        }
        title={
          state.view === "done"
            ? "Password set"
            : state.view === "reset"
              ? "Set a new password"
              : state.view === "requested"
                ? "Check your inbox"
                : "Reset your password"
        }
        blurb={
          state.view === "request"
            ? "We'll email a single-use link to set a new one."
            : state.view === "requested"
              ? "If an account exists for that email, a reset link is on its way. It expires in 7 days."
              : state.view === "reset"
                ? "Choose a new password for this account."
                : `Password updated for ${state.email}.`
        }
      />

      {state.view === "request" ? (
        <form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="request" />
          <Field label="Email">
            <Input
              type="email"
              name="email"
              autoComplete="email"
              placeholder="you@example.com"
              defaultValue={loaderData.email}
              required
              invalid={!!error}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          {error ? (
            <Alert icon className="font-medium">
              {error}
            </Alert>
          ) : null}
          <Button type="submit" size="lg" className="mt-2 w-full">
            Email a reset link
          </Button>
          <div className="flex items-center justify-center gap-1 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
            <Link
              to="/login"
              className="text-gray-500 dark:text-gray-400 hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        </form>
      ) : null}

      {state.view === "requested" ? (
        <div className="flex flex-col items-center gap-2 text-sm">
          <MailCheck
            aria-hidden="true"
            className="h-8 w-8 text-green-600 dark:text-green-400"
          />
          <Link
            to="/login"
            className="mt-2 font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      ) : null}

      {state.view === "reset" ? (
        <form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="reset" />
          <input type="hidden" name="token" value={state.token} />
          <input type="hidden" name="email" value={state.email} />
          <Field label="New password">
            <Input
              type="password"
              name="password"
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete="new-password"
              required
              invalid={!!error}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            At least 8 characters. The link is single-use and expires in 7 days.
          </p>
          {error ? (
            <Alert icon className="font-medium">
              {error}
            </Alert>
          ) : null}
          <Button type="submit" size="lg" className="mt-2 w-full">
            <KeyRound aria-hidden="true" className="h-4 w-4" /> Set password
          </Button>
          <div className="flex items-center justify-center gap-1 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
            <Link
              to="/reset-password"
              className="text-gray-500 dark:text-gray-400 hover:underline"
            >
              Link not working? Request a new one
            </Link>
          </div>
        </form>
      ) : null}

      {state.view === "done" ? (
        <div className="flex flex-col items-center gap-2 text-sm">
          <Link
            to="/login"
            className="mt-2 font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Sign in with your new password
          </Link>
        </div>
      ) : null}
    </AuthCard>
  );
}
