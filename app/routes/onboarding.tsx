import { KeyRound, Mail, PlugZap, ReceiptText } from "lucide-react";
import { errorMessage } from "~/lib/errors.server";
import { pageMeta } from "~/lib/seo-content";
import { Link, data, redirect, useFetcher } from "react-router";
import { AuthCard, AuthHeader, AuthTile } from "~/components/auth/AuthCard";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { OrDivider } from "~/components/ui/OrDivider";
import { Alert } from "~/components/ui/Alert";
import {
  guardAnonymousAttempt,
  rejectCrossSitePost,
  sessionStorage,
} from "~/lib/auth.server";
import { isAuthenticated } from "~/lib/auth.server";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import {
  FM_PENDING_SESSION_KEY,
  isFastmailOAuthConfigured,
  type FmPendingConnection,
} from "~/lib/fastmail-oauth.server";
import {
  GOOGLE_PENDING_SESSION_KEY,
  isGmailOAuthConfigured,
  type GooglePendingConnection,
} from "~/lib/google-oauth.server";
import {
  completeOnboarding,
  oauthOnboardingState,
  type OAuthOnboardingState,
  verifyOnboardingToken,
} from "~/lib/onboarding.server";
import {
  formEmail,
  formString,
  MAX_PASSWORD_LENGTH,
  unknownIntent,
} from "~/lib/validation";
import { parseIntent } from "~/lib/route-helpers.server";
import type { Route } from "./+types/onboarding";

/**
 * Fastmail onboarding: the first-run flow for users who connect their
 * own mailbox instead of signing up with email + verification link.
 *
 * Step 1: paste a Fastmail API token. The token is verified against the
 * JMAP session endpoint, which also reveals the mailbox address (no
 * typing it).
 * Step 2: set a password (new account, with email verified automatically
 * because the token proves mailbox control) or enter the existing
 * account's password (the mailbox attaches to that account).
 * Success: session cookie + redirect into the inbox review, then the
 * expense list with a one-time welcome panel.
 */

type ActionData =
  | { step: "token"; error?: string }
  | {
      step: "create" | "attach";
      email: string;
      /** Empty on the OAuth path: the credential lives in the fmPending
       * session, not in the form. */
      token?: string;
      error?: string;
    };

interface LoaderData {
  configured: boolean;
  oauthConfigured: boolean;
  googleConfigured: boolean;
  oauthConnected?: OAuthOnboardingState;
}
export async function loader({
  request,
}: Route.LoaderArgs): Promise<LoaderData> {
  if (await isAuthenticated(request)) throw redirect("/emails");
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const googlePending = session.get(GOOGLE_PENDING_SESSION_KEY) as
    | GooglePendingConnection
    | undefined;
  if (googlePending) {
    // The Gmail callback verified the mailbox and parked its encrypted
    // credentials here; skip straight to the create/attach step. The
    // session value stays intact until the flow completes (or is
    // restarted) so form errors can retry without a re-connect.
    return {
      configured: isTokenCryptoConfigured(),
      oauthConfigured: false,
      googleConfigured: false,
      oauthConnected: await oauthOnboardingState(
        googlePending.emailAddress,
        "gmail",
      ),
    };
  }
  const pending = session.get(FM_PENDING_SESSION_KEY) as
    | FmPendingConnection
    | undefined;
  if (pending) {
    // Same fast path for the Fastmail callback's parked credentials.
    return {
      configured: isTokenCryptoConfigured(),
      oauthConfigured: false,
      googleConfigured: false,
      oauthConnected: await oauthOnboardingState(pending.username, "fastmail"),
    };
  }
  return {
    configured: isTokenCryptoConfigured(),
    oauthConfigured: isFastmailOAuthConfigured() && isTokenCryptoConfigured(),
    googleConfigured: isGmailOAuthConfigured() && isTokenCryptoConfigured(),
  };
}
export function meta(): Route.MetaDescriptors {
  return pageMeta(
    "Connect your email — Expense",
    "Connect Gmail or Fastmail instead of email verification: receipts import automatically, and your expenses are arranged for tax season. Free.",
    "/onboarding",
  );
}

export async function action({ request }: Route.ActionArgs) {
  rejectCrossSitePost(request);
  const { form, intent } = await parseIntent(request);

  if (intent === "connect-token") {
    // Anonymous work (a Fastmail session call per request); cap per IP.
    await guardAnonymousAttempt(request);
    if (!isTokenCryptoConfigured()) {
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
      return data({
        step: "token",
        error: "Paste your Fastmail API token first.",
      } satisfies ActionData);
    }
    const result = await verifyOnboardingToken(token);
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
    // Also anonymous work: verifyJmapToken makes an outbound FastmaiFastmail    // (and success hashes a password), so cap it per IP like connect-token.
    await guardAnonymousAttempt(request);
    const token = formString(form, "token").trim();
    const email = formEmail(form);
    const password = formString(form, "password");
    let oauth: FmPendingConnection | GooglePendingConnection | undefined;
    if (!token) {
      const session = await sessionStorage.getSession(
        request.headers.get("Cookie"),
      );
      // Either provider's parked credentials: already encrypted, mailbox
      // already verified live by the callback; the route passes the
      // ciphertext straight through and never touches plaintext.
      oauth =
        (session.get(GOOGLE_PENDING_SESSION_KEY) as
          | GooglePendingConnection
          | undefined) ??
        (session.get(FM_PENDING_SESSION_KEY) as
          | FmPendingConnection
          | undefined);
    }
    if (!token && !oauth) {
      return data({
        step: intent,
        email,
        error: "Your email connection expired. Connect again.",
      } satisfies ActionData);
    }
    try {
      const outcome = await completeOnboarding({
        token: token || undefined,
        oauth,
        email,
        password,
      });
      // The login session cookie replaces the whole cookie session, which
      // also clears fmPending (cookie sessions serialize their full
      // contents on every commit).
      return redirect(
        `/email-review?onboarding=1&connection=${outcome.connectionId}`,
        { headers: { "Set-Cookie": outcome.sessionCookie } },
      );
    } catch (error) {
      const message = errorMessage(error);
      return data({
        step: intent,
        email,
        error: message,
      } satisfies ActionData);
    }
  }

  if (intent === "oauth-restart") {
    // Abandon the parked OAuth credentials (e.g. the wrong mailbox got
    // connected) and drop back to step 1.
    const session = await sessionStorage.getSession(
      request.headers.get("Cookie"),
    );
    session.unset(GOOGLE_PENDING_SESSION_KEY);
    session.unset(FM_PENDING_SESSION_KEY);
    throw redirect("/onboarding", {
      headers: { "Set-Cookie": await sessionStorage.commitSession(session) },
    });
  }

  return unknownIntent();
}

export default function OnboardingPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const restartFetcher = useFetcher();
  const state: ActionData = actionData ?? { step: "token" };
  const oauth = loaderData.oauthConnected;
  const step: "create" | "attach" | "token" = oauth
    ? oauth.existing === "verified"
      ? "attach"
      : "create"
    : state.step;
  const stepTwo = step !== "token";
  const error = state.error ?? null;
  const email = "email" in state ? state.email : (oauth?.email ?? "");
  // On the OAuth path the credential stays in the fmPending session.
  const token = "token" in state && !oauth ? state.token : "";

  return (
    <AuthCard>
      <AuthHeader
        icon={
          <AuthTile>
            <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
          </AuthTile>
        }
        title={stepTwo ? "Set your password" : "Connect your email account"}
        blurb={
          stepTwo
            ? oauth
              ? step === "attach"
                ? `Connected as ${email} via ${oauth.provider === "gmail" ? "Gmail" : "Fastmail"}. This mailbox already has an Expense account; sign in to connect it to whichever account you use.`
                : `Connected as ${email} via ${oauth.provider === "gmail" ? "Gmail" : "Fastmail"}. Set a password to create your account.`
              : email
                ? step === "attach"
                  ? `The mailbox ${email} already has an Expense account, but you can connect it to whichever account you sign in with.`
                  : `We found your address from the token: ${email}. Set a password to create your account.`
                : ""
            : "We automatically import and process your expenses from your inbox, no manual forwarding. Your token proves you own the mailbox, so there's no verification email."
        }
      />

      {!stepTwo ? (
        <>
          {!loaderData.configured ? (
            <Alert>
              Email connections are not configured on this deployment.
            </Alert>
          ) : (
            <>
              {loaderData.googleConfigured ? (
                <>
                  <Button asChild size="lg" className="w-full">
                    <a href="/connect-gmail?next=onboarding">
                      <Mail aria-hidden="true" className="h-5 w-5" />
                      Connect with Gmail
                    </a>
                  </Button>
                  <div className="my-5">
                    <OrDivider />
                  </div>
                </>
              ) : null}
              <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                Connect your Fastmail
              </h2>
              {loaderData.oauthConfigured ? (
                <div className="mb-4 flex flex-col items-center gap-1.5">
                  <Button asChild size="lg" className="w-full">
                    <a href="/connect-fastmail?next=onboarding">
                      <PlugZap aria-hidden="true" className="h-5 w-5" />
                      Connect with Fastmail
                    </a>
                  </Button>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    or paste an API token
                  </p>
                </div>
              ) : null}
              <ol className="mb-4 list-decimal space-y-0.5 pl-5 text-xs text-gray-500 dark:text-gray-400">
                <li>
                  Open{" "}
                  <a
                    href="https://app.fastmail.com/settings/security/tokens/new"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Fastmail → Settings → Privacy &amp; Security → API tokens
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
                <Field label="Fastmail API token">
                  <Input
                    type="password"
                    name="token"
                    placeholder="fmu1-…"
                    autoComplete="off"
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
                  Verify Fastmail token
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
          <input type="hidden" name="intent" value={step} />
          {!oauth ? <input type="hidden" name="token" value={token} /> : null}
          <Field label="Account email">
            <Input
              type="email"
              name="email"
              autoComplete="email"
              defaultValue={email}
              required
              invalid={!!error}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
            {oauth
              ? `Prefilled from your ${oauth.provider === "gmail" ? "Gmail" : "Fastmail"} connection; change it to the email you sign in with.`
              : step === "attach"
                ? "Prefilled from your token; change it to the email you sign in with."
                : "Your account email is the address from your token; the token proves you own it."}
          </p>
          <Field label="Password">
            <Input
              type="password"
              name="password"
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete={
                step === "attach" ? "current-password" : "new-password"
              }
              required
              invalid={!!error}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {step === "create"
              ? "At least 8 characters. This is your sign-in password; your email connection stays stored encrypted and is only used to read your inbox."
              : "Your password is checked against the account you sign in with; the mailbox connects to it."}
          </p>
          {step === "attach" ? (
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
            {step === "attach"
              ? "Sign in & connect mailbox"
              : "Create my account"}
          </Button>
          <div className="flex items-center justify-center gap-1 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
            <KeyRound
              aria-hidden="true"
              className="h-3.5 w-3.5 text-gray-400"
            />
            {oauth ? (
              <restartFetcher.Form method="post">
                <input type="hidden" name="intent" value="oauth-restart" />
                <button
                  type="submit"
                  className="text-gray-500 dark:text-gray-400 hover:underline"
                >
                  Not {email}? Start over
                </button>
              </restartFetcher.Form>
            ) : (
              <Link
                to="/onboarding"
                className="text-gray-500 dark:text-gray-400 hover:underline"
              >
                Not {email}? Start over
              </Link>
            )}
          </div>
        </form>
      )}
    </AuthCard>
  );
}
