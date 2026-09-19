import { RouterContextProvider } from "react-router";
import { resolveSessionUser } from "~/lib/auth.server";

/**
 * The context the root middleware builds for a request. A test that calls a
 * route loader or action directly has to supply it, since resolving the
 * session and publishing the user is the middleware's job. Going through
 * resolveSessionUser, rather than hand-setting a user, keeps the test on the
 * path the middleware takes: a request carrying a session cookie resolves to
 * that user, an anonymous one to null, exactly as it does in the app.
 */
export async function contextForRequest(
  request: Request,
): Promise<RouterContextProvider> {
  const context = new RouterContextProvider();
  await resolveSessionUser(context, request);
  return context;
}
