import type { ReactNode } from "react";
import { VerificationResultPage } from "~/components/VerificationResultPage";
import {
  verifyUserEmailAddress,
  type VerifyEmailOutcome,
} from "~/lib/database";
import type { Route } from "./+types/verify-email";

/**
 * Public landing page for account-verification links (emailed after
 * signup/join). No session — anyone with the token can verify, which is
 * the point: only the mailbox owner has the link. The loader consumes the
 * single-use token and marks the user's email verified, after which they
 * can sign in. Refreshing a used link reports "already verified" (the
 * token hash is kept after success); a token from a replaced account
 * (re-signup while unverified) is invalid — the old link is discarded.
 */

export async function loader({
  request,
}: Route.LoaderArgs): Promise<VerifyEmailOutcome> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return verifyUserEmailAddress(token);
}

/** Per-outcome copy; the shared page shell renders the icons and card. */
function copyFor(outcome: VerifyEmailOutcome): {
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
              <b className="font-mono">{outcome.email}</b> is verified. You can
              now sign in to Expense.
            </p>
            <p>
              Receipts by email for this address were also set up at signup.
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
              <b className="font-mono">{outcome.email}</b> was already verified.
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
              Sign in with your email and password and use the{" "}
              <b>Resend verification email</b> button to get a fresh link.
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
              The link may have been used already, copied incorrectly, or the
              account was re-created since it was sent (which discards the old
              link).
            </p>
            <p>
              Sign in with your email and password and use the{" "}
              <b>Resend verification email</b> button to get a fresh link.
            </p>
          </>
        ),
      };
  }
}

export default function VerifyEmailPage({ loaderData }: Route.ComponentProps) {
  const { title, body } = copyFor(loaderData);
  return (
    <VerificationResultPage
      status={loaderData.status}
      title={title}
      body={body}
    />
  );
}
