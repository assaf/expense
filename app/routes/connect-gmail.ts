import { randomBytes } from "node:crypto";
import { redirect } from "react-router";
import type { Route } from "./+types/connect-gmail";
import { guardAnonymousAttempt, sessionStorage } from "~/lib/auth.server";
import {
  buildGmailAuthorizeUrl,
  GOOGLE_OAUTH_MAX_AGE_S,
  GOOGLE_OAUTH_SESSION_KEY,
  isGmailOAuthConfigured,
  type GoogleOAuthFlow,
} from "~/lib/google-oauth.server";
import { generatePkcePair } from "~/lib/fastmail-oauth.server";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import { oauthResumePath } from "~/lib/route-helpers.server";

/**
 * "Connect with Gmail" entry point (GET /connect-gmail): bounces the
 * browser to Google's OAuth consent page. Works signed-in (the Settings
 * path) and anonymous (the onboarding path) — no requireUser here; the
 * callback branches on the session. Env-gated: without the GOOGLE_* vars
 * (or token encryption) the flow degrades to a redirect back to the
 * resume page with ?gmailOauthError=unconfigured, never a bare error page.
 *
 * The resume target is an allowlist token, not a path: `?next=emails` or
 * `?next=onboarding`, anything else defaulting to onboarding, so this
 * route can never become an open redirect.
 */

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const rawNext = url.searchParams.get("next");
  if (!isGmailOAuthConfigured() || !isTokenCryptoConfigured()) {
    throw redirect(`${oauthResumePath(rawNext)}?gmailOauthError=unconfigured`);
  }
  // Minting flow state costs a signed cookie write and enables two
  // outbound Google calls downstream; cap it per IP like every other
  // anonymous path (skips empty-IP requests, e.g. tests).
  await guardAnonymousAttempt(request, "gmail-oauth");
  const state = randomBytes(32).toString("base64url");
  const { verifier } = generatePkcePair();
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const flow: GoogleOAuthFlow = {
    state,
    verifier,
    next: rawNext === "emails" ? "emails" : "onboarding",
    ts: Date.now(),
  };
  session.set(GOOGLE_OAUTH_SESSION_KEY, flow);
  throw redirect(
    buildGmailAuthorizeUrl({
      state,
      verifier,
      redirectUri: `${url.origin}/gmail-oauth-callback`,
    }),
    {
      headers: {
        "Set-Cookie": await sessionStorage.commitSession(session, {
          maxAge: GOOGLE_OAUTH_MAX_AGE_S,
        }),
      },
    },
  );
}
