import { redirect } from "react-router";
import type { Route } from "./+types/fastmail-oauth-callback";
import {
  guardAnonymousAttempt,
  SESSION_USER_KEY,
  sessionStorage,
} from "~/lib/auth.server";
import { findUserById } from "~/lib/db/accounts";
import { createEmailConnection } from "~/lib/db/email-connections";
import { initStore } from "~/lib/db/seed";
import { verifyJmapToken } from "~/lib/jmap.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import {
  exchangeAuthorizationCode,
  FM_OAUTH_SESSION_KEY,
  FM_PENDING_SESSION_KEY,
  isFlowStale,
  type FmOAuthFlow,
  type FmPendingConnection,
} from "~/lib/fastmail-oauth.server";
/**
 * The OAuth redirect target registered with FastMail (GET
 * /fastmail-oauth-callback). Validates CSRF state + staleness, exchanges
 * the authorization code (PKCE), and verifies the resulting access token
 * against the JMAP session endpoint — the same live check the paste flow
 * applies, which also enforces "has a mail account". Then:
 *
 * - signed-in: create the connection on the user's account (mirroring the
 *   connectEmail intent in emails.tsx) and land on /emails;
 * - anonymous: park the ENCRYPTED credentials on the session (fmPending)
 *   for the onboarding flow to consume, and land on /onboarding.
 *
 * Every branch clears the in-flight flow state and commits the session
 * before redirecting; failures land on the resume page with
 * ?oauthError=<reason> for the UI to render.
 */

export async function loader({ request }: Route.LoaderArgs) {
  await initStore();
  const url = new URL(request.url);
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const flow = session.get(FM_OAUTH_SESSION_KEY) as FmOAuthFlow | undefined;
  const next = flow?.next === "emails" ? "emails" : "onboarding";

  const finish = async (path: string): Promise<Response> => {
    session.unset(FM_OAUTH_SESSION_KEY);
    return redirect(path, {
      headers: {
        "Set-Cookie": await sessionStorage.commitSession(session),
      },
    });
  };

  const stateParam = url.searchParams.get("state");
  if (!flow || isFlowStale(flow) || !stateParam || stateParam !== flow.state) {
    return finish(`/${next}?oauthError=state`);
  }
  if (url.searchParams.get("error")) {
    // The user denied consent on FastMail's page (RFC 6749 §4.1.2.1).
    return finish(`/${next}?oauthError=denied`);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return finish(`/${next}?oauthError=state`);
  }
  // Each code exchange is two outbound FastMail calls; cap per IP like
  // every other anonymous network path (empty-IP requests skip, so tests
  // are unaffected).
  await guardAnonymousAttempt(request, "fastmail-oauth-exchange");

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      verifier: flow.verifier,
      redirectUri: `${url.origin}/fastmail-oauth-callback`,
    });
  } catch (err) {
    console.error("[fastmail-oauth] code exchange failed:", { err });
    return finish(`/${next}?oauthError=exchange`);
  }

  const verification = await verifyJmapToken(tokens.accessToken);
  if (!verification.ok) {
    return finish(`/${next}?oauthError=verify`);
  }

  const userId = session.get(SESSION_USER_KEY);
  const user =
    typeof userId === "string" ? await findUserById(userId) : undefined;
  if (user) {
    const result = await createEmailConnection({
      accountId: user.accountId,
      provider: "fastmail",
      emailAddress: verification.info.username,
      jmapAccountId: verification.info.mailAccountId,
      tokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: encryptSecret(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
    });
    if (!result.ok) {
      // Global mailbox exclusivity: the address is connected elsewhere.
      return finish(
        `/emails?connected=0&reason=${encodeURIComponent(result.error)}`,
      );
    }
    console.info("[fastmail-oauth] connected", {
      accountId: user.accountId,
      address: result.connection.emailAddress,
    });
    return finish(
      `/emails?connected=1&address=${encodeURIComponent(result.connection.emailAddress)}`,
    );
  }

  const pending: FmPendingConnection = {
    username: verification.info.username,
    mailAccountId: verification.info.mailAccountId,
    tokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc: encryptSecret(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
  };
  session.set(FM_PENDING_SESSION_KEY, pending);
  return finish("/onboarding?connected=1");
}
