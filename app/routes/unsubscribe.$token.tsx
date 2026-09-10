import { MailCheck, MailX, ReceiptText } from "lucide-react";
import { data, Form, Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { AuthCard, AuthHeader, AuthTile } from "~/components/auth/AuthCard";
import { marketingUnsubscribeUserId } from "~/lib/unsubscribe.server";
import { findUserById, unsubscribeMarketingEmail } from "~/lib/db/accounts";
import { rejectCrossSitePost } from "~/lib/auth.server";
import { marketingPageHeaders, pageMeta } from "~/lib/seo-content";
import type { Route } from "./+types/unsubscribe.$token";

/**
 * Marketing-email unsubscribe: the permanent link in every marketing
 * email's footer (and in its List-Unsubscribe header). Public by design —
 * the signed token IS the credential (app/lib/unsubscribe.server.ts), no
 * login, no stored token. GET renders a confirmation (mail scanners and
 * link prefetchers follow links, so the write never happens on GET); POST
 * records the opt-out. The same POST serves RFC 8058 one-click: Gmail and
 * Apple Mail POST straight to the URL from their servers, with no session
 * and no Origin header — rejectCrossSitePost lets those through.
 * Unsubscribing is idempotent and permanent until resubscribed in Settings.
 */

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    "Unsubscribe — Expense",
    "Stop receiving Expense marketing emails.",
    "/unsubscribe",
  );
}

/** Personalized public page: the confirm view shows the user's email,
 * so never let it be cached anywhere. */
export function headers() {
  return marketingPageHeaders();
}

export async function loader({ params }: Route.LoaderArgs) {
  const userId = marketingUnsubscribeUserId(params.token ?? "");
  const user = userId ? await findUserById(userId) : undefined;
  if (!user) {
    return data({ view: "invalid" } as const);
  }
  return { view: "confirm" as const, email: user.email };
}

export async function action({ request, params }: Route.ActionArgs) {
  rejectCrossSitePost(request);
  const userId = marketingUnsubscribeUserId(params.token ?? "");
  if (!userId) {
    return data({ view: "invalid" } as const);
  }
  const result = await unsubscribeMarketingEmail(userId);
  if (!result) {
    return data({ view: "invalid" } as const);
  }
  return {
    view: "done" as const,
    email: result.email,
    already: result.already,
  };
}

export default function UnsubscribePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const state = actionData ?? loaderData;

  return (
    <AuthCard>
      <AuthHeader
        icon={
          <AuthTile>
            {state.view === "done" ? (
              <MailCheck aria-hidden="true" className="h-6 w-6 text-white" />
            ) : (
              <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
            )}
          </AuthTile>
        }
        title={
          state.view === "done"
            ? "You're unsubscribed"
            : state.view === "invalid"
              ? "Link not valid"
              : "Unsubscribe from marketing emails?"
        }
        blurb={
          state.view === "done"
            ? `Marketing emails won't be sent to ${state.email} anymore. Receipts-by-email notices and security emails are unaffected. You can turn marketing emails back on in Settings.`
            : state.view === "invalid"
              ? "This unsubscribe link doesn't match a current account. If the link came from a forwarded email, use the link in an email addressed to you."
              : `Confirm to stop marketing emails (product news and tips) to ${state.email}. Receipts-by-email notices and security emails keep coming.`
        }
      />

      {state.view === "confirm" ? (
        <Form method="post" className="flex flex-col">
          <Button
            type="submit"
            size="lg"
            variant="secondary"
            className="w-full"
          >
            <MailX aria-hidden="true" className="h-4 w-4" /> Unsubscribe
          </Button>
        </Form>
      ) : null}

      {state.view === "invalid" ? (
        <div className="flex justify-center">
          <Link
            to="/"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Go to the home page
          </Link>
        </div>
      ) : null}
    </AuthCard>
  );
}
