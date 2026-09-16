import { useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";

/**
 * Whether this request has a session. The root loader resolves the user for
 * the public marketing pages too (that is how a signed-in visitor gets
 * identified on them), so the public chrome can offer "Dashboard" instead of
 * "Sign in" without a single page loader reading the session again.
 *
 * The value is the same on the server render and on hydration: it comes from
 * the root loader payload, never from browser-only state. Like every
 * `useRouteLoaderData` call it requires a data router, which the app always
 * renders in (the root route is the only place the session is read).
 */
export function useSignedIn(): boolean {
  return useRouteLoaderData<typeof rootLoader>("root")?.user != null;
}
