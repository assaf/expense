import { AuthCard, AuthHeader } from "~/components/auth/AuthCard";
import { ShieldCheck } from "lucide-react";
import { Form, redirect } from "react-router";
import { requireUser } from "~/lib/auth.server";
import { escapeHtml } from "~/lib/escape";
import {
  findOAuthClient,
  hasOAuthConsent,
  saveOAuthConsent,
} from "~/lib/db/oauth";
import { issueAuthorizationCode, PKCE_METHOD } from "~/lib/oauth.server";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/oauth.authorize";

/**
 * OAuth authorization endpoint (GET) + consent page (POST approve/deny).
 *
 * The user is already signed in (session cookie). The flow is: an MCP
 * client opens this URL in the browser, the user sees who wants access and
 * clicks Allow, and we redirect back to the client with a PKCE-bound
 * authorization code. Consent is remembered (a "previously connected" note
 * is shown), but every authorization still requires an explicit Allow click
 * on this page: the GET never issues codes, so a link/image request from an
 * attacker-controlled page can never silently mint a code for an
 * already-approved client (consent-CSRF / silent re-authorization). The
 * page is also framed-out (X-Frame-Options + CSP frame-ancestors) so
 * clickjacking can't fake that click.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const parsed = parseAuthorizeParams(url);
  // Sign in first: requireUser redirects to /login?next=<this URL>, and the
  // login action bounces back here, where consent resumes.
  const user = await requireUser(request);
  if (!parsed.ok) return errorPage(parsed.error);

  const client = await findOAuthClient(parsed.params.clientId);
  if (!client) return errorPage("Unknown client.");
  if (!client.redirectUris.includes(parsed.params.redirectUri)) {
    return errorPage("The redirect URI is not registered for this client.");
  }

  // Codes are ONLY issued from the approve POST below, never from this
  // GET, so an <img>/<a> request can't mint a code without a click.
  return {
    client,
    ...parsed.params,
    userEmail: user.email,
    previouslyConnected: await hasOAuthConsent(user.id, client.id),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const decision = formString(form, "decision");
  const params = {
    clientId: formString(form, "client_id"),
    redirectUri: formString(form, "redirect_uri"),
    codeChallenge: formString(form, "code_challenge"),
    state: formString(form, "state"),
  };
  if (
    !params.clientId ||
    !params.redirectUri ||
    !params.codeChallenge ||
    !params.state
  ) {
    return errorPage(
      "This authorization request is incomplete; start over from the app you're connecting.",
    );
  }
  const client = await findOAuthClient(params.clientId);
  if (!client) return errorPage("Unknown client.");
  if (!client.redirectUris.includes(params.redirectUri)) {
    return errorPage("The redirect URI is not registered for this client.");
  }

  if (decision === "deny") {
    return redirect(
      redirectWith(params.redirectUri, {
        error: "access_denied",
        state: params.state,
      }),
    );
  }
  if (decision !== "approve") {
    return errorPage("Choose Allow or Deny.");
  }

  await saveOAuthConsent(user.id, client.id);
  const code = await issueAuthorizationCode({
    userId: user.id,
    client,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
  });
  return redirect(
    redirectWith(params.redirectUri, { code, state: params.state }),
  );
}

export default function OAuthAuthorizePage({
  loaderData,
}: Route.ComponentProps) {
  const {
    client,
    clientId,
    redirectUri,
    codeChallenge,
    state,
    userEmail,
    previouslyConnected,
  } = loaderData as Route.ComponentProps["loaderData"] & {
    client: NonNullable<Awaited<ReturnType<typeof findOAuthClient>>>;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    userEmail: string;
    previouslyConnected: boolean;
  };

  return (
    <AuthCard>
      <AuthHeader
        icon={
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-50 dark:bg-gray-800">
            <ShieldCheck
              aria-hidden="true"
              className="h-6 w-6 text-blue-600 dark:text-blue-400"
            />
          </div>
        }
        title="Connect to Expense"
        blurb={
          <>
            <span className="font-medium text-gray-800 dark:text-gray-100">
              {client.name}
            </span>{" "}
            wants to access your expenses: capture receipts, log mileage, answer
            spending questions, and build reports.
          </>
        }
        note={
          previouslyConnected
            ? "Previously connected; approving refreshes this connection's access."
            : undefined
        }
      />
      <div className="mb-6 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-2 text-sm text-gray-600 dark:text-gray-300">
        Signed in as{" "}
        <span className="font-medium text-gray-800 dark:text-gray-100">
          {userEmail}
        </span>
      </div>
      <Form method="post" className="flex flex-col gap-2">
        <input type="hidden" name="client_id" value={clientId} />
        <input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        <button
          type="submit"
          name="decision"
          value="approve"
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
        >
          Allow
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:bg-gray-700"
        >
          Deny
        </button>
      </Form>
    </AuthCard>
  );
}

// --- Validation & helpers --------------------------------------------------

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

function parseAuthorizeParams(
  url: URL,
): { ok: true; params: AuthorizeParams } | { ok: false; error: string } {
  if (url.searchParams.get("response_type") !== "code") {
    return {
      ok: false,
      error:
        "This authorization request is not supported (response_type must be code).",
    };
  }
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const method = url.searchParams.get("code_challenge_method") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!clientId) return { ok: false, error: "Missing client_id." };
  if (!redirectUri) return { ok: false, error: "Missing redirect_uri." };
  if (!codeChallenge || method !== PKCE_METHOD) {
    return {
      ok: false,
      error: "PKCE is required (code_challenge_method=S256).",
    };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(codeChallenge)) {
    return { ok: false, error: "Invalid code_challenge." };
  }
  if (!state) return { ok: false, error: "Missing state." };
  return { ok: true, params: { clientId, redirectUri, codeChallenge, state } };
}

/** Append code/state (or an OAuth error) to the client's redirect URI. */
function redirectWith(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

function errorPage(message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb"><div style="max-width:420px;padding:2rem;background:#fff;border:1px solid #e5e7eb;border-radius:12px;color:#374151"><h1 style="font-size:1.25rem;color:#111827">Can't connect</h1><p>${escapeHtml(message)}</p><p style="color:#9ca3af;font-size:0.875rem">Return to the app you were connecting and try again.</p></div></body></html>`,
    {
      status: 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      },
    },
  );
}

/** The consent page must never be frameable (clickjacking can fake the
 * Allow click) and must never issue a code on a plain GET. */
export function headers(): HeadersInit {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
}
