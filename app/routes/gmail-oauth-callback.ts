import { redirect } from "react-router";
import type { Route } from "./+types/gmail-oauth-callback";
import {
  guardAnonymousAttempt,
  SESSION_USER_KEY,
  sessionStorage,
} from "~/lib/auth.server";
import { findUserById } from "~/lib/db/accounts";
import { createEmailConnection } from "~/lib/db/email-connections";
import { initStore } from "~/lib/db/seed";
import { encryptSecret } from "~/lib/token-crypto.server";
import { gmailProfileEmail } from "~/lib/gmail.server";
import {
  decodeGoogleIdToken,
  exchangeGmailAuthorizationCode,
  GOOGLE_OAUTH_SESSION_KEY,
  GOOGLE_PENDING_SESSION_KEY,
  isGmailFlowStale,
  type GmailTokenSet,
  type GoogleOAuthFlow,
  type GooglePendingConnection,
} from "~/lib/google-oauth.server";

/**
 * The OAuth redirect target registered with Google (GET
 * /gmail-oauth-callback). Validates CSRF state + staleness, exchanges the
 * authorization code (PKCE), and verifies the resulting access token by
 * reading the Gmail profile — the live check that also resolves the
 * mailbox address. The id_token's `sub` (fetched over TLS from Google's
 * token endpoint, no signature check needed) becomes remoteAccountId.
 * Then:
 *
 * - signed-in: create the connection on the user's account (mirroring the
 *   FastMail callback) and land on /emails;
 * - anonymous: park the ENCRYPTED credentials on the session (googlePending)
 *   for the onboarding flow to consume, and land on /onboarding.
 *
 * Every branch clears the in-flight flow state and commits the session
 * before redirecting; failures land on the resume page with
 * ?gmailOauthError=<reason> for the UI to render.
 */

function pendingFrom(
  tokens: GmailTokenSet,
  emailAddress: string,
): GooglePendingConnection {
  const payload = tokens.idToken ? decodeGoogleIdToken(tokens.idToken) : {};
  return {
    emailAddress,
    remoteAccountId: payload.sub ?? "",
    tokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : null,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  await initStore();
  const url = new URL(request.url);
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const flow = session.get(GOOGLE_OAUTH_SESSION_KEY) as
    | GoogleOAuthFlow
    | undefined;
  const next = flow?.next === "emails" ? "emails" : "onboarding";

  const finish = async (path: string): Promise<Response> => {
    session.unset(GOOGLE_OAUTH_SESSION_KEY);
    return redirect(path, {
      headers: {
        "Set-Cookie": await sessionStorage.commitSession(session),
      },
    });
  };

  const stateParam = url.searchParams.get("state");
  if (
    !flow ||
    isGmailFlowStale(flow) ||
    !stateParam ||
    stateParam !== flow.state
  ) {
    return finish(`/${next}?gmailOauthError=state`);
  }
  if (url.searchParams.get("error")) {
    // The user denied consent on Google's page (RFC 6749 §4.1.2.1).
    return finish(`/${next}?gmailOauthError=denied`);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return finish(`/${next}?gmailOauthError=state`);
  }
  // Each code exchange is two outbound Google calls; cap per IP like
  // every other anonymous network path (empty-IP requests skip, so tests
  // are unaffected).
  await guardAnonymousAttempt(request, "gmail-oauth-exchange");

  let tokens: GmailTokenSet;
  try {
    tokens = await exchangeGmailAuthorizationCode({
      code,
      verifier: flow.verifier,
      redirectUri: `${url.origin}/gmail-oauth-callback`,
    });
  } catch (err) {
    console.error("[gmail-oauth] code exchange failed:", { err });
    return finish(`/${next}?gmailOauthError=exchange`);
  }

  let emailAddress: string;
  try {
    emailAddress = (await gmailProfileEmail(tokens.accessToken)).toLowerCase();
  } catch (err) {
    console.error("[gmail-oauth] profile verification failed:", { err });
    return finish(`/${next}?gmailOauthError=verify`);
  }

  const userId = session.get(SESSION_USER_KEY);
  const user =
    typeof userId === "string" ? await findUserById(userId) : undefined;
  if (user) {
    const result = await createEmailConnection({
      accountId: user.accountId,
      provider: "gmail",
      emailAddress,
      remoteAccountId: pendingFrom(tokens, emailAddress).remoteAccountId,
      tokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken
        ? encryptSecret(tokens.refreshToken)
        : undefined,
      tokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
    });
    if (!result.ok) {
      // Global mailbox exclusivity: the address is connected elsewhere.
      return finish(
        `/emails?connected=0&reason=${encodeURIComponent(result.error)}`,
      );
    }
    console.info("[gmail-oauth] connected", {
      accountId: user.accountId,
      address: result.connection.emailAddress,
    });
    return finish(
      `/emails?connected=1&address=${encodeURIComponent(result.connection.emailAddress)}`,
    );
  }

  session.set(GOOGLE_PENDING_SESSION_KEY, pendingFrom(tokens, emailAddress));
  return finish("/onboarding?connected=1");
}
