import { ArrowRight, Inbox } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { PageShell } from "~/components/PageShell";
import { ReviewInbox } from "~/components/email-review";
import { requireUser } from "~/lib/auth.server";
import { requireIntent } from "~/lib/route-helpers.server";
import { readEmailConnection } from "~/lib/db/email-connections";
import {
  ignoreReviewItem,
  listReviewItems,
  processReviewItem,
  reviewSenderRulePattern,
  rulesForReview,
  scanInboxForReview,
  senderHasRule,
} from "~/lib/email-review.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/email-review";

/** Inbox review: scan a connected mailbox for receipt-like emails and
 * decide each one — process (→ expense, email to Trash) or ignore (drops
 * off the list). Both decisions require confirmation in the UI. This is
 * where a first-time sender's receipts surface: processing one with
 * "remember this sender" adds a user rule, so future receipts from them
 * auto-import. See docs/email-connections.md → Inbox review. */

export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const onboarding = url.searchParams.get("onboarding") === "1";
  const connectionId = url.searchParams.get("connection") ?? "";
  const connection = connectionId
    ? await readEmailConnection(user.accountId, connectionId)
    : undefined;
  if (!connection) {
    return { connection: null, items: [], scannedAt: null, onboarding };
  }
  const [items, rules] = await Promise.all([
    listReviewItems(connection.id),
    rulesForReview(user.accountId),
  ]);
  return {
    connection: {
      id: connection.id,
      emailAddress: connection.emailAddress,
      reviewScannedAt: connection.reviewScannedAt,
    },
    items: items.map((item) => ({
      ...item,
      hasRule: senderHasRule(rules, item.fromAddress),
      rulePattern: reviewSenderRulePattern(item.fromAddress),
    })),
    scannedAt: connection.reviewScannedAt,
    onboarding,
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Review inbox — Expense" }];
}

export async function action({ request }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request);
  const connectionId = formString(form, "connectionId");

  // Every action is scoped to a connection the user owns.
  const connection = connectionId
    ? await readEmailConnection(user.accountId, connectionId)
    : undefined;
  if (!connection) {
    return Response.json({ ok: false, error: "Connection not found." });
  }

  switch (intent) {
    case "scan": {
      try {
        const result = await scanInboxForReview(connection);
        console.info("[email-review] scan complete", {
          connectionId: connection.id,
          ...result,
        });
        return Response.json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          {
            ok: false,
            error: `Scan failed: ${message}. Check that the API token is still valid in FastMail, then try again.`,
          },
          { status: 502 },
        );
      }
    }
    case "process": {
      const emailId = formString(form, "emailId");
      const acceptSender = formString(form, "acceptSender") === "1";
      if (!emailId)
        return Response.json({ ok: false, error: "Missing email." });
      const result = await processReviewItem({
        connection,
        emailId,
        acceptSender,
      });
      return Response.json(result);
    }
    case "ignore": {
      const emailId = formString(form, "emailId");
      if (!emailId)
        return Response.json({ ok: false, error: "Missing email." });
      const removed = await ignoreReviewItem(connection.id, emailId);
      return Response.json({ ok: removed });
    }
    default:
      return unknownIntent();
  }
}

export default function EmailReviewPage({ loaderData }: Route.ComponentProps) {
  const { connection, items, scannedAt, onboarding } = loaderData;
  if (!connection) {
    return (
      <PageShell
        backTo="/emails"
        backLabel="Back to email"
        icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
        title="Review inbox"
      >
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No email connection selected.{" "}
          <Link
            to="/emails"
            className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
          >
            Connect an email account first.
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      backTo="/emails"
      backLabel="Back to email"
      icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
      title="Review inbox"
      headerRight={
        onboarding ? (
          <Button asChild size="sm">
            <Link to="/">
              Finish setup <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </Button>
        ) : null
      }
    >
      <p className="-mt-3 mb-6 text-sm text-gray-500 dark:text-gray-400">
        Receipts found in{" "}
        <span className="font-mono">{connection.emailAddress}</span>. Process
        the ones that are expenses; ignore the rest.
      </p>

      <ReviewInbox
        connectionId={connection.id}
        items={items}
        scannedAt={scannedAt}
      />
    </PageShell>
  );
}
