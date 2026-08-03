import { AlertCircle, ReceiptText } from "lucide-react";
import { redirect, useFetcher, useSearchParams } from "react-router";
import { useState } from "react";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import {
  createAccountWithUser,
  isAuthenticated,
  joinAccountWithInviteCode,
  login,
} from "~/lib/auth.server";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/login";

type Mode = "signin" | "create" | "join";

/** Only allow same-origin relative paths for the post-login destination. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Never bounce back to the login page or to internal `.data` URLs.
  if (raw.startsWith("/login") || raw.includes(".data")) return "/";
  return raw;
}

const SITE_URL = "https://expense.labnotes.org";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Sign in to Expense" },
    {
      name: "description",
      content:
        "Sign in to Expense — personal expense tracking with receipts and mileage.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/login` },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await isAuthenticated(request)) {
    const url = new URL(request.url);
    throw redirect(safeNext(url.searchParams.get("next")));
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const mode = formString(form, "mode") as Mode;
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const username = formString(form, "username").trim().toLowerCase();
  const password = formString(form, "password");

  try {
    let cookie: string;
    if (mode === "create") {
      cookie = await createAccountWithUser({
        accountName: formString(form, "accountName"),
        username,
        password,
      });
    } else if (mode === "join") {
      cookie = await joinAccountWithInviteCode({
        inviteCode: formString(form, "inviteCode"),
        username,
        password,
      });
    } else {
      cookie = await login(username, password);
    }
    return redirect(next, { headers: { "Set-Cookie": cookie } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Something went wrong";
    console.warn("Auth failed (%s): %s", mode, message);
    return Response.json({ error: message }, { status: 401 });
  }
}

export default function LoginPage() {
  const fetcher = useFetcher<{ error?: string }>();
  // The landing page links straight to the signup form: /login?mode=create.
  const [searchParams] = useSearchParams();
  const urlMode = searchParams.get("mode");
  const [mode, setMode] = useState<Mode>(
    urlMode === "create" ? "create" : urlMode === "join" ? "join" : "signin",
  );
  const error = fetcher.data?.error;
  const busy = fetcher.state !== "idle";

  const titles: Record<Mode, { title: string; blurb: string }> = {
    signin: {
      title: "Sign in to Expense",
      blurb: "Personal expense tracking — receipts and mileage.",
    },
    create: {
      title: "Create your account",
      blurb: "New accounts start empty. Share it later with an invite code.",
    },
    join: {
      title: "Join an account",
      blurb: "Enter the invite code from the account's Settings page.",
    },
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-ink">
            <ReceiptText className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-bold">{titles[mode].title}</h1>
          <p className="text-sm text-gray-500">{titles[mode].blurb}</p>
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
            label="Username"
            name="username"
            autoComplete="username"
            placeholder="jane"
          />
          <AuthField
            label="Password"
            name="password"
            type="password"
            autoComplete={
              mode === "signin" ? "current-password" : "new-password"
            }
          />

          {error && (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            className="mt-2 w-full"
            disabled={busy}
          >
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

        <div className="mt-6 flex flex-col items-center gap-1 border-t border-gray-100 pt-4 text-sm">
          {mode === "signin" ? (
            <>
              <button
                type="button"
                className="font-medium text-blue-600 hover:underline"
                onClick={() => setMode("create")}
              >
                Create a new account
              </button>
              <button
                type="button"
                className="text-gray-500 hover:underline"
                onClick={() => setMode("join")}
              >
                Join an existing account with an invite code
              </button>
            </>
          ) : (
            <button
              type="button"
              className="font-medium text-blue-600 hover:underline"
              onClick={() => setMode("signin")}
            >
              Already have an account? Sign in
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function AuthField({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <Input
        type={type}
        name={name}
        required
        minLength={name === "password" ? 8 : undefined}
        autoComplete={autoComplete}
        placeholder={placeholder}
      />
    </Field>
  );
}
