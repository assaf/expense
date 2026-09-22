import { data } from "react-router";
import { userContext } from "~/lib/auth.server";
import { readReports } from "~/lib/db/reports";
import type { Route } from "./+types/api.session";

/**
 * What a public page learns after hydration: whether this browser has a
 * session, and the report names the command palette's export submenu needs.
 *
 * The marketing documents cannot carry either, because they are shared-cached
 * and a session-dependent byte would pin one account's page for every visitor
 * (the root loader omits the session on public paths for exactly that reason).
 * So the chrome and the palette ask here instead, once per page load, after
 * the cached document has already painted.
 *
 * Self-gating: an anonymous caller gets `user: null` instead of a redirect, so
 * this is an ordinary fetch from any page (see SELF_GATED_PATHS in root.tsx).
 * The answer is the caller's own session and nothing else.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const reportNames = user
    ? (await readReports(user.accountId)).map((r) => r.name)
    : [];
  return data(
    { user: user ? { id: user.id } : null, reportNames },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
