import { KeyRound, PlugZap, ReceiptText } from "lucide-react";
import { Link, data, redirect } from "react-router";
import { AuthCard, AuthTile } from "~/components/auth/AuthCard";
import { Button } from "~/components/ui/Button";
import { Alert } from "~/components/ui/Alert";
import { Input } from "~/components/ui/Input";
import {
  guardAnonymousAction,
  recordAnonymousAttempt,
  rejectCrossSitePost,
} from "~/lib/auth.server";
import { isAuthenticated } from "~/lib/auth.server";
import {
  completeOnboarding,
  verifyOnboardingToken,
} from "~/lib/onboarding.server";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import {
  formString,
  MAX_PASSWORD_LENGTH,
  unknownIntent,
} from "~/lib/validation";
import { parseIntent } from "~/lib/route-helpers.server";
import type { Route } from "./+types/onboarding";

/**
 * FastMail onboarding — the first-run flow for users who connect their
 * own mailbox instead of signing up with email + verification link.
 *
 * Step 1: paste a FastMail API token. The token is verified against the
 * JMAP session endpoint, which also reveals the mailbox address — no
 * typing it.
 * Step 2: set a password (new account — email verified automatically,
 * because the token proves mailbox control) or enter the existing
 * account's password (the mailbox attaches to that account).
 * Success: session cookie + redirect into the inbox review, then the
 * expense list with a one-time welcome panel.
 */

type ActionData =
  | { step: "token"; error?: string }
  | { step: "create" | "attach"; email: string; token: string; error?: string };

export async function loader({ request }: Route.LoaderArgs) {
  if (await isAuthenticated(request)) throw redirect("/emails");
  return { configured: isTokenCryptoConfigured() };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Connect FastMail — Expense" }];
}

export async function action({ request }: Route.ActionArgs) {
  rejectCrossSitePost(request);
  const { form, intent } = await parseIntent(request);

  if (intent === "connect-token") {
    // Anonymous work (a FastMail session call per request) — cap per IP.
    await guardAnonymousAction(request);
    if (!isTokenCryptoConfigured()) {
      await recordAnonymousAttempt(request);
      return data(
        {
          step: "token",
          error: "Email connections are not configured on this deployment.",
        } satisfies ActionData,
        { status: 503 },
      );
    }
    const token = formString(form, "token").trim();
    if (!token) {
      await recordAnonymousAttempt(request);
      return data({
        step: "token",
        error: "Paste your FastMail API token first.",
      } satisfies ActionData);
    }
    const result = await verifyOnboardingToken(token);
    await recordAnonymousAttempt(request);
    if (!result.ok) {
      return data({ step: "token", error: result.error } satisfies ActionData);
    }
    return data({
      step: result.existing === "verified" ? "attach" : "create",
      email: result.email,
      token,
    } satisfies ActionData);
  }

  if (intent === "create" || intent === "attach") {
    const token = formString(form, "token");
    const email = formString(form, "email").trim().toLowerCase();
    const password = formString(form, "password");
    try {
      const outcome = await completeOnboarding({ token, email, password });
      return redirect(
        `/email-review?onboarding=1&connection=${outcome.connectionId}`,
        { headers: { "Set-Cookie": outcome.sessionCookie } },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Something went wrong";
      return data({
        step: intent,
        email,
        token,
        error: message,
      } satisfies ActionData);
    }
  }

  return unknownIntent();
}

export default function OnboardingPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const state: ActionData = actionData ?? { step: "token" };
  const stepTwo = state.step === "create" || state.step === "attach";
  const error = state.error ?? null;
  const email = stepTwo ? state.email : "";
  const token = stepTwo ? state.token : "";

  return (
    <AuthCard>
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <AuthTile>
          <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
        </AuthTile>
        <h1 className="text-xl font-bold">
          {stepTwo ? "Set your password" : "Connect your FastMail account"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {stepTwo
            ? email
              ? state.step === "attach"
                ? `The mailbox ${email} already has an Expense account — but you can connect it to whichever account you sign in with.`
                : `We found your address from the token: ${email}. Set a password to create your account.`
              : ""
            : "We automatically import and process your expenses from your inbox — no manual forwarding. Your token proves you own the mailbox, so there's no verification email."}
        </p>
        <p className="text-xs font-medium text-gray-400 dark:text-gray-500">
          Step {stepTwo ? 2 : 1} of 2
        </p>
      </div>

      {!stepTwo ? (
        <>
          {!loaderData.configured ? (
            <Alert>
              Email connections are not configured on this deployment.
            </Alert>
          ) : (
            <>
              <ol className="mb-4 list-decimal space-y-0.5 pl-5 text-xs text-gray-500 dark:text-gray-400">
                <li>
                  Open{" "}
                  <a
                    href="https://app.fastmail.com/settings/security/tokens/new"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    FastMail → Settings → Privacy &amp; Security → API tokens
                    <PlugZap
                      aria-hidden="true"
                      className="ml-0.5 inline h-3 w-3 align-text-bottom"
                    />
                  </a>{" "}
                  (log in first).
                </li>
                <li>
                  Create a token named “Expense” with <b>Read mail</b> and{" "}
                  <b>Compose</b> scopes.
                </li>
                <li>Copy the token and paste it below.</li>
              </ol>
              <form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="intent" value="connect-token" />
                <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
                  FastMail API token
                  <Input
                    type="password"
                    name="token"
                    placeholder="fmu1-…"
                    autoComplete="off"
                    required
                    invalid={!!error}
                    aria-invalid={error ? true : undefined}
                  />
                </label>
                {error ? (
                  <Alert icon className="font-medium">
                    {error}
                  </Alert>
                ) : null}
                <Button type="submit" size="lg" className="mt-2 w-full">
                  Verify token
                </Button>
              </form>
              <div className="mt-6 flex flex-col items-center gap-1 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
                <Link
                  to="/login"
                  className="text-gray-500 dark:text-gray-400 hover:underline"
                >
                  Use email + password instead
                </Link>
              </div>
            </>
          )}
        </>
      ) : (
        <form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value={state.step} />
          <input type="hidden" name="token" value={token} />
          <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            Account email
            <Input
              type="email"
              name="email"
              autoComplete="email"
              defaultValue={email}
              required
              invalid={!!error}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
            {state.step === "attach"
              ? "Prefilled from your token — change it to the email you sign in with."
              : "Your account email is the address from your token — the token proves you own it."}
          </p>
          <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            Password
            <Input
              type="password"
              name="password"
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete={
                state.step === "attach" ? "current-password" : "new-password"
              }
              required
              invalid={!!error}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {state.step === "create"
              ? "At least 8 characters. This is your sign-in password — the token stays stored encrypted and is only used to read your inbox."
              : "Your password is checked against the account you sign in with; the mailbox connects to it."}
          </p>
          {state.step === "attach" ? (
            <Link
              to={`/reset-password?email=${encodeURIComponent(email)}`}
              className="self-end text-xs text-gray-500 dark:text-gray-400 hover:underline"
            >
              Forgot the account password?
            </Link>
          ) : null}
          {error ? (
            <Alert icon className="font-medium">
              {error}
            </Alert>
          ) : null}
          <Button type="submit" size="lg" className="mt-2 w-full">
            {state.step === "attach"
              ? "Sign in & connect mailbox"
              : "Create my account"}
          </Button>
          <div className="flex items-center justify-center gap-1 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
            <KeyRound
              aria-hidden="true"
              className="h-3.5 w-3.5 text-gray-400"
            />
            <Link
              to="/onboarding"
              className="text-gray-500 dark:text-gray-400 hover:underline"
            >
              Not {email}? Start over
            </Link>
          </div>
        </form>
      )}
    </AuthCard>
  );
}
