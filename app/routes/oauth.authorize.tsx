import { ShieldCheck } from "lucide-react";
import { Form, redirect } from "react-router";
import { requireUser } from "~/lib/auth.server";
import { escapeHtml } from "~/lib/escape";
import {
  findOAuthClient,
  hasOAuthConsent,
  saveOAuthConsent,
} from "~/lib/store.server";
import { issueAuthorizationCode, PKCE_METHOD } from "~/lib/oauth.server";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/oauth.authorize";

/**
 * OAuth authorization endpoint (GET) + consent page (POST approve/deny).
 *
 * The user is already signed in (session cookie) — the flow is: an MCP
 * client opens this URL in the browser, the user sees who wants access and
 * clicks Allow, and we redirect back to the client with a PKCE-bound
 * authorization code. Consent is remembered, so subsequent connections
 * skip the page and get a code immediately.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const parsed = parseAuthorizeParams(url);
  // Sign in first — requireUser redirects to /login?next=<this URL>, and the
  // login action bounces back here, where consent resumes.
  const user = await requireUser(request);
  if (!parsed.ok) return errorPage(parsed.error);

  const client = await findOAuthClient(parsed.params.clientId);
  if (!client) return errorPage("Unknown client.");
  if (!client.redirectUris.includes(parsed.params.redirectUri)) {
    return errorPage("The redirect URI is not registered for this client.");
  }

  if (await hasOAuthConsent(user.id, client.id)) {
    const code = await issueAuthorizationCode({
      userId: user.id,
      client,
      redirectUri: parsed.params.redirectUri,
      codeChallenge: parsed.params.codeChallenge,
    });
    return redirect(
      redirectWith(parsed.params.redirectUri, {
        code,
        state: parsed.params.state,
      }),
    );
  }

  return { client, ...parsed.params, userEmail: user.email };
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
      "This authorization request is incomplete — start over from the app you're connecting.",
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
  const { client, clientId, redirectUri, codeChallenge, state, userEmail } =
    loaderData as Route.ComponentProps["loaderData"] & {
      client: NonNullable<Awaited<ReturnType<typeof findOAuthClient>>>;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state: string;
      userEmail: string;
    };

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4"
    >
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-50">
            <ShieldCheck className="h-6 w-6 text-blue-600" />
          </div>
          <h1 className="text-xl font-bold">Connect to Expense</h1>
          <p className="text-sm text-gray-500">
            <span className="font-medium text-gray-800">{client.name}</span>{" "}
            wants to access your expenses — capture receipts, log mileage,
            answer spending questions, and build reports.
          </p>
        </div>
        <div className="mb-6 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
          Signed in as{" "}
          <span className="font-medium text-gray-800">{userEmail}</span>
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
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
          >
            Allow
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            Deny
          </button>
        </Form>
      </div>
    </main>
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
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
