import { drainEmailConnection } from "~/lib/email-connection-process.server";
import { readEmailConnectionById } from "~/lib/db/email-connections";
import { assertCronSecret } from "~/lib/route-helpers.server";
import type { Route } from "./+types/api.dev-email-drain";

/**
 * DEV ONLY: drain one connected mailbox with the REAL renderer (headless
 * Chromium, not the tsx stub) so the saved receipt image is a true render of
 * the email. The tsx `pnpm drain:email` script stubs the renderer (tsx can't
 * load Vite's ?inline font assets), which produces a 1×1 placeholder image;
 * this route runs in the bundled dev server where Playwright works.
 *
 * Gated: rejects in production, and requires `Authorization: Bearer
 * <CRON_SECRET>` (same as the cron routes). Drains the Inbox, 60-day
 * lookback, batch 50. Idempotent (already-evaluated emails are skipped).
 *
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:4565/api/dev-email-drain?connection=<id>"
 */
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "dev only" }, { status: 404 });
  }
  const denied = assertCronSecret(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connection");
  if (!connectionId) {
    return Response.json(
      { error: "?connection=<id> required" },
      { status: 400 },
    );
  }
  const connection = await readEmailConnectionById(connectionId);
  if (!connection) {
    return Response.json({ error: "connection not found" }, { status: 404 });
  }
  const result = await drainEmailConnection(connection, {
    lookbackMs: 60 * 24 * 60 * 60 * 1000,
    batchSize: 50,
    timeBudgetMs: 120_000,
  });
  return Response.json({ ok: true, result });
}
