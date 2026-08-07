import type { ReactNode } from "react";
import { VerificationResultPage } from "~/components/VerificationResultPage";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { verifyInboundSenderAddress } from "~/lib/store.server";
import type { Route } from "./+types/receipts-email-verify";

/**
 * Public landing page for receipts-by-email verification links (emailed to
 * the sender address). No session — anyone with the token can verify, which
 * is the point: only the mailbox owner has the link. The loader consumes the
 * single-use token and claims the address for its account; the page reports
 * the outcome. Refreshing after a successful click shows the "already used"
 * state, which is honest (the address is verified).
 */

export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const outcome = await verifyInboundSenderAddress(token);
  // The forward-to address, so the page states the same sentence the email
  // does ("Receipts forwarded from X to Y will be added to …") — the user can
  // read it in the email and copy the same details from the page.
  return { ...outcome, forwardTo: INBOUND_EMAIL_ADDRESS };
}

/** Per-outcome copy; the shared page shell renders the icons and card. */
function copyFor(outcome: Awaited<ReturnType<typeof loader>>): {
  title: string;
  body: ReactNode;
} {
  switch (outcome.status) {
    case "verified":
      return {
        title: "Email verified",
        body: (
          <>
            <p>
              Receipts forwarded from{" "}
              <b className="font-mono">{outcome.address}</b> to{" "}
              <b className="font-mono">{outcome.forwardTo}</b> will be added to
              the <b>{outcome.accountName}</b> account on Expense.
            </p>
            <p>
              No other account can use this address anymore. Forward a receipt
              to the expense email to try it out.
            </p>
          </>
        ),
      };
    case "already-verified":
      return {
        title: "Already verified",
        body: (
          <>
            <p>
              Receipts forwarded from{" "}
              <b className="font-mono">{outcome.address}</b> to{" "}
              <b className="font-mono">{outcome.forwardTo}</b> will be added to
              the <b>{outcome.accountName}</b> account on Expense.
            </p>
            <p>This link has already been used. No further action is needed.</p>
          </>
        ),
      };
    case "expired":
      return {
        title: "This verification link has expired",
        body: (
          <>
            <p>
              Verification links last 7 days, and this one was sent more than
              that ago.
            </p>
            <p>
              Sign in to Expense, go to <b>Settings → Receipts by email</b>, and
              click <b>Resend email</b> next to{" "}
              <b className="font-mono">{outcome.address}</b>.
            </p>
          </>
        ),
      };
    default:
      return {
        title: "This verification link is not valid",
        body: (
          <>
            <p>
              The link may have been used already, copied incorrectly, or not
              sent at all.
            </p>
            <p>
              Sign in to Expense, go to <b>Settings → Receipts by email</b>, and
              click <b>Resend email</b> to get a fresh link.
            </p>
          </>
        ),
      };
  }
}

export default function VerifySenderPage({ loaderData }: Route.ComponentProps) {
  const { title, body } = copyFor(loaderData);
  return (
    <VerificationResultPage
      status={loaderData.status}
      title={title}
      body={body}
    />
  );
}
