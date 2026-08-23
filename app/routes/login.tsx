import { MailCheck, ReceiptText } from "lucide-react";
import { Link, redirect, useFetcher, useSearchParams } from "react-router";
import { useState } from "react";
import { AuthCard, AuthTile } from "~/components/auth/AuthCard";
import { Button } from "~/components/ui/Button";
import { Alert } from "~/components/ui/Alert";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import {
  createAccountWithUser,
  EmailNotVerifiedError,
  guardAnonymousAction,
  isAuthenticated,
  joinAccountWithInviteCode,
  login,
  recordAnonymousAttempt,
  rejectCrossSitePost,
  resendAccountVerification,
} from "~/lib/auth.server";
import { pageMeta } from "~/lib/seo-content";
import { formString, MAX_PASSWORD_LENGTH } from "~/lib/validation";
import type { Route } from "./+types/login";

type Mode = "signin" | "create" | "join" | "resend-verification";

/** Success payloads are `{ ok: true, email }` (no session yet — the account
 * is pending until the emailed link is clicked); failures are `{ error }`
 * with `unverifiedEmail` set when the only problem is a missing
 * verification, so the UI can offer a resend button. */
type ActionData =
  | { ok: true; email: string }
  | { error: string; unverifiedEmail?: string };

/** Only allow same-origin relative paths for the post-login destination. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Never bounce back to the login page or to internal `.data` URLs.
  if (raw.startsWith("/login") || raw.includes(".data")) return "/";
  return raw;
}

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    "Sign in to Expense",
    "Sign in to Expense — free expense tracking for tax season, with receipt OCR, mileage, and PDF/ZIP export.",
    "/login",
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await isAuthenticated(request)) {
    const url = new URL(request.url);
    throw redirect(safeNext(url.searchParams.get("next")));
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  rejectCrossSitePost(request);
  const form = await request.formData();
  const mode = formString(form, "mode") as Mode;
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const email = formString(form, "email").trim().toLowerCase();
  const password = formString(form, "password");
  // Absolute origin for the verification link in the emailed message.
  const origin = new URL(request.url).origin;

  // cap them per IP, independent of outcome. Sign-in keeps its per-email
  // lockout AND gets its own per-IP throttle (scope "signin"): without it
  // one IP could force unlimited scrypt derivations, and the per-email
  // lockout would be remotely triggerable by any 5 requests.
  if (mode === "create" || mode === "join" || mode === "resend-verification") {
    await guardAnonymousAction(request);
  } else {
    await guardAnonymousAction(request, "signin");
  }
  // cap them per IP, independent of outcome (sign-in keeps its per-email
  // lockout). Five attempts inside 15 minutes lock the IP.
  if (mode === "create" || mode === "join" || mode === "resend-verification") {
    await guardAnonymousAction(request);
  }

  try {
    if (mode === "create") {
      const result = await createAccountWithUser(
        {
          accountName: formString(form, "accountName"),
          email,
          password,
        },
        origin,
      );
      // No session yet — the account stays pending until the email is
      // verified, so the response is a "check your email" state, not a
      // redirect into the app.
      return Response.json({
        ok: true,
        email: result.email,
      } satisfies ActionData);
    }
    if (mode === "join") {
      const result = await joinAccountWithInviteCode(
        {
          inviteCode: formString(form, "inviteCode"),
          email,
          password,
        },
        origin,
      );
      return Response.json({
        ok: true,
        email: result.email,
      } satisfies ActionData);
    }
    if (mode === "resend-verification") {
      const result = await resendAccountVerification(email, origin);
      return Response.json({
        ok: true,
        email: result.email,
      } satisfies ActionData);
    }
    const cookie = await login(email, password, origin);
    return redirect(next, { headers: { "Set-Cookie": cookie } });
  } catch (error) {
    // Count under the same scope the guard used — signin failures must not
    // consume the signup/join/resend budget for this IP (and vice versa).
    await recordAnonymousAttempt(request, mode === "signin" ? "signin" : "");
    const message =
      error instanceof Error ? error.message : "Something went wrong";
    console.warn("Auth failed (%s): %s", mode, message);
    const unverifiedEmail =
      error instanceof EmailNotVerifiedError ? error.email : undefined;
    return Response.json(
      {
        error: message,
        ...(unverifiedEmail ? { unverifiedEmail } : {}),
      } satisfies ActionData,
      { status: 401 },
    );
  }
}

export default function LoginPage() {
  const fetcher = useFetcher<ActionData>();
  // The landing page links straight to the signup form: /login?mode=create.
  const [searchParams] = useSearchParams();
  const urlMode = searchParams.get("mode");
  const [mode, setMode] = useState<Mode>(
    urlMode === "create" ? "create" : urlMode === "join" ? "join" : "signin",
  );
  // Tracks the email field so the resend button can re-send to it.
  const [emailValue, setEmailValue] = useState("");
  // After a successful create/join/resend the user is NOT signed in — show
  // the "check your email" screen until they pick a different email.
  const [dismissed, setDismissed] = useState(false);

  const data = fetcher.data;
  const error = data && "error" in data ? data.error : null;
  const unverifiedEmail =
    data && "unverifiedEmail" in data ? data.unverifiedEmail : null;
  const pendingEmail = data && "ok" in data ? data.email : null;
  const busy = fetcher.state !== "idle";

  const resend = () => {
    const formData = new FormData();
    formData.set("mode", "resend-verification");
    formData.set("email", emailValue || pendingEmail || "");
    void fetcher.submit(formData, { method: "post" });
  };

  // After signup/join/resend, the account exists but can't sign in until
  // the emailed link is clicked — replace the form with that instruction.
  if (pendingEmail && !dismissed) {
    return (
      <AuthCard center>
        <div className="mb-4 flex items-center justify-center">
          <AuthTile>
            <MailCheck aria-hidden="true" className="h-6 w-6 text-white" />
          </AuthTile>
        </div>
        <h1 className="text-xl font-bold">Check your email</h1>
        <div className="mt-3 flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-300">
          <p>
            We sent a verification link to{" "}
            <b className="font-mono">{pendingEmail}</b>. Click it to activate
            your account, then sign in.
          </p>
          <p>
            Once you're in, connect your FastMail account and receipts from your
            inbox are imported automatically — no forwarding.
          </p>
          <p>Can't find it? Check spam, or resend below.</p>
        </div>
        <Button
          type="button"
          size="lg"
          className="mt-4 w-full"
          onClick={resend}
          disabled={busy}
        >
          {busy ? "Sending…" : "Resend verification email"}
        </Button>
        <button
          type="button"
          className="mt-3 text-sm text-gray-500 dark:text-gray-400 hover:underline"
          onClick={() => setDismissed(true)}
        >
          Use a different email
        </button>
      </AuthCard>
    );
  }

  const titles: Record<Mode, { title: string; blurb: string }> = {
    signin: {
      title: "Sign in to Expense",
      blurb: "Expense tracking for tax season — receipts, mileage, exports.",
    },
    create: {
      title: "Create your account",
      blurb: "We'll email you a verification link to activate it.",
    },
    join: {
      title: "Join an account",
      blurb: "Enter the invite code from the account's Settings page.",
    },
    "resend-verification": {
      title: "Resend verification",
      blurb: "We'll email you a fresh verification link.",
    },
  };

  return (
    <AuthCard>
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <AuthTile>
          <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
        </AuthTile>
        <h1 className="text-xl font-bold">{titles[mode].title}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {titles[mode].blurb}
        </p>
      </div>

      <fetcher.Form method="post" className="flex flex-col gap-4">
        <input type="hidden" name="mode" value={mode} />

        {mode === "create" && (
          <AuthField
            label="Account name"
            name="accountName"
            autoComplete="off"
            placeholder="e.g. Smith Family"
          />
        )}
        {mode === "join" && (
          <AuthField
            label="Invite code"
            name="inviteCode"
            autoComplete="off"
            placeholder="e.g. K7M2QXD4"
          />
        )}
        <AuthField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          onChange={setEmailValue}
        />
        <AuthField
          label="Password"
          name="password"
          type="password"
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
        />
        {mode === "signin" ? (
          <Link
            to="/reset-password"
            className="-mt-2 self-end text-xs text-gray-500 dark:text-gray-400 hover:underline"
          >
            Forgot password?
          </Link>
        ) : null}

        {error && (
          <Alert icon className="font-medium">
            {error}
          </Alert>
        )}
        {unverifiedEmail && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resend}
            disabled={busy}
          >
            Resend verification email
          </Button>
        )}

        <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
          {busy
            ? mode === "signin"
              ? "Signing in…"
              : "One moment…"
            : mode === "signin"
              ? "Sign in"
              : mode === "create"
                ? "Create account"
                : "Join account"}
        </Button>
      </fetcher.Form>

      {mode === "create" ? (
        <div className="mt-4">
          <div
            aria-hidden="true"
            className="flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500"
          >
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            or
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          </div>
          <Button
            asChild
            size="lg"
            className="mt-3 w-full border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700 dark:border-blue-600 dark:bg-blue-600 dark:text-white dark:hover:border-blue-700 dark:hover:bg-blue-700"
          >
            <Link to="/onboarding">Connect your FastMail account</Link>
          </Button>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col items-center gap-1 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
        {mode === "signin" ? (
          <>
            <button
              type="button"
              className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => setMode("create")}
            >
              Create a new account
            </button>
            <button
              type="button"
              className="text-gray-500 dark:text-gray-400 hover:underline"
              onClick={() => setMode("join")}
            >
              Join an existing account with an invite code
            </button>
          </>
        ) : (
          <button
            type="button"
            className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
            onClick={() => setMode("signin")}
          >
            Already have an account? Sign in
          </button>
        )}
      </div>
    </AuthCard>
  );
}

function AuthField({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  onChange?: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type={type}
        name={name}
        required
        minLength={name === "password" ? 8 : undefined}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        inputMode={type === "email" ? "email" : undefined}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      />
    </Field>
  );
}
