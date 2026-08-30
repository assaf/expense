import { randomBytes } from "node:crypto";
import { redirect } from "react-router";
import type { Route } from "./+types/connect-fastmail";
import { FASTMAIL_OAUTH_CLIENT_ID } from "~/lib/env";
import { sessionStorage } from "~/lib/auth.server";
import {
  buildAuthorizeUrl,
  FM_OAUTH_MAX_AGE_S,
  FM_OAUTH_SESSION_KEY,
  generatePkcePair,
  isFastMailOAuthConfigured,
  type FmOAuthFlow,
} from "~/lib/fastmail-oauth.server";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";

/**
 * "Connect with FastMail" entry point (GET /connect-fastmail): bounces the
 * browser to FastMail's OAuth consent page. Works signed-in (the Settings
 * path) and anonymous (the onboarding path) — no requireUser here; the
 * callback branches on the session. Env-gated: without
 * FASTMAIL_OAUTH_CLIENT_ID (or token encryption) the flow degrades to a
 * redirect back to the resume page with ?oauthError=unconfigured, never a
 * bare error page.
 *
 * The resume target is an allowlist token, not a path: `?next=emails` or
 * `?next=onboarding`, anything else defaulting to onboarding, so this
 * route can never become an open redirect.
 */

/** Map a raw ?next= value to its resume path (allowlist, defaulting to
 * onboarding); shared by the error redirects and the flow state. */
function resumePath(raw: string | null): string {
  return raw === "emails" ? "/emails" : "/onboarding";
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const rawNext = url.searchParams.get("next");
  if (!isFastMailOAuthConfigured() || !isTokenCryptoConfigured()) {
    throw redirect(`${resumePath(rawNext)}?oauthError=unconfigured`);
  }
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = generatePkcePair();
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const flow: FmOAuthFlow = {
    state,
    verifier,
    next: rawNext === "emails" ? "emails" : "onboarding",
    ts: Date.now(),
  };
  session.set(FM_OAUTH_SESSION_KEY, flow);
  throw redirect(
    buildAuthorizeUrl({
      clientId: FASTMAIL_OAUTH_CLIENT_ID,
      redirectUri: `${url.origin}/fastmail-oauth-callback`,
      state,
      challenge,
    }),
    {
      headers: {
        "Set-Cookie": await sessionStorage.commitSession(session, {
          maxAge: FM_OAUTH_MAX_AGE_S,
        }),
      },
    },
  );
}
