import { CheckCircle2, Clock3, ReceiptText, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { AuthCard, AuthTile } from "~/components/auth/AuthCard";

/**
 * Shared shell for the two public verification-link landing pages
 * (/verify-email for account verification, /receipts-email-verify for
 * receipts-by-email sender verification). Both consume a single-use token
 * in the loader and render the same card (logo, status icon + title,
 * body copy, and a "Sign in" footer), differing only in the copy each
 * route supplies. The icon follows the status (green check, amber clock,
 * or red X) so the two pages can't drift apart visually.
 */

export type VerificationStatus =
  | "verified"
  | "already-verified"
  | "expired"
  | "invalid";

/** The per-status copy a verification route supplies to the shared shell. */
export type VerificationCopy = {
  title: string;
  body: ReactNode;
};

export function VerificationResultPage({
  status,
  title,
  body,
}: VerificationCopy & { status: VerificationStatus }) {
  const icon =
    status === "expired" ? (
      <Clock3 aria-hidden="true" className="h-6 w-6 text-amber-600" />
    ) : status === "invalid" ? (
      <XCircle
        aria-hidden="true"
        className="h-6 w-6 text-red-600 dark:text-red-400"
      />
    ) : (
      <CheckCircle2 aria-hidden="true" className="h-6 w-6 text-green-600" />
    );
  return (
    <AuthCard center>
      <div className="mb-4 flex items-center justify-center">
        <AuthTile>
          <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
        </AuthTile>
      </div>
      <div className="mb-3 flex items-center justify-center gap-2">
        {icon}
        <h1 className="text-lg font-bold">{title}</h1>
      </div>
      <div className="flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-300">
        {body}
      </div>
      <div className="mt-6 border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
        <a
          href="/login"
          className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
          Sign in to Expense
        </a>
      </div>
    </AuthCard>
  );
}
