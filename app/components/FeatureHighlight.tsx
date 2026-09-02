import {
  Bot,
  Command,
  CreditCard,
  FileText,
  Fuel,
  Globe,
  Keyboard,
  Mail,
  MapPinned,
  Plug,
  ReceiptText,
  Search,
  Tags,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";

/**
 * One rotating "did you know?" card at the bottom of the home page. The
 * loader picks a highlight id at random from the ones that can render with
 * the current data (e.g. "email" needs the inbound address configured), so
 * every return visit surfaces a different feature without the card ever
 * getting in the way of adding expenses.
 */
export type HighlightId =
  | "capture"
  | "categories"
  | "command-palette"
  | "connect-email"
  | "email"
  | "mcp"
  | "mileage-location"
  | "mileage-rate"
  | "reports"
  | "invite"
  | "reconcile"
  | "search-operators"
  | "shortcut-hints"
  | "webmcp";

/** The data a highlight may interpolate. Fields the app doesn't have are
 * empty strings; the matching highlights are excluded from the pool.
 * `mileageRate` is filled client-side from the browser's local today (the
 * server runs UTC); `hasRates` (server-computable, timezone-independent)
 * decides whether the mileage-rate highlight is eligible at all.
 * `hasEmailConnection` (no connected mailbox for the account) gates the
 * connect-email highlight. */
export interface HighlightData {
  inboundAddress: string;
  mcpUrl: string;
  inviteCode: string;
  mileageRate: string;
  hasRates: boolean;
  hasEmailConnection: boolean;
}

interface HighlightDef {
  icon: LucideIcon;
  title: string;
  body: (data: HighlightData) => ReactNode;
  /** Keyboard-driven features have no page to link to; the instruction
   * (press ⌘K) is the action. Omit when a link would be noise. */
  cta?: { label: string; to: string };
}

const HIGHLIGHTS: Record<HighlightId, HighlightDef> = {
  capture: {
    icon: ReceiptText,
    title: "Add a receipt without typing",
    body: () => (
      <>
        Upload or paste (⌘V) a receipt image or PDF, or drag one anywhere on
        this page. Merchant, amount, and category fill in automatically.
      </>
    ),
    cta: { label: "Add a receipt", to: "/expense/new" },
  },
  categories: {
    icon: Tags,
    title: "Add your own categories",
    body: () => (
      <>
        Expense starts with the{" "}
        <Link
          to="/schedule-c-categories"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          IRS Schedule C categories
        </Link>
        , but you can add your own anytime in Settings, for clients, projects,
        or whatever makes your taxes clearer. New categories are offered
        automatically when receipts are parsed.
      </>
    ),
    cta: { label: "Manage categories", to: "/settings#categories" },
  },
  "command-palette": {
    icon: Command,
    title: "Get anywhere from the keyboard",
    body: () => (
      <>
        Press ⌘K and type what you want: jump to a page, add a receipt or
        mileage, search expenses, export a report. Power keys work too: g then r
        opens Reports, a starts a new receipt.
      </>
    ),
  },
  "shortcut-hints": {
    icon: Keyboard,
    title: "The shortcuts, on screen",
    body: () => (
      <>
        Press Shift+? and Expense pins the keys next to the buttons they drive:
        pages, new receipt, search. Press it again and the pins go away.
      </>
    ),
  },
  "search-operators": {
    icon: Search,
    title: "Search narrows by report, category, or merchant",
    body: () => (
      <>
        Prefix your search and pick from suggestions: report: Q3, category:
        meals, merchant: Amazon, description: webinar. Combine prefixes to stack
        filters, and the status line totals every match exactly.
      </>
    ),
  },
  "connect-email": {
    icon: Plug,
    title: "Your inbox, processed automatically",
    body: () => (
      <>
        Connect your FastMail account and receipts landing in your inbox are
        processed for you: merchant, amount, and category filled in, no
        forwarding needed.
      </>
    ),
    cta: { label: "Connect your email account", to: "/emails" },
  },
  email: {
    icon: Mail,
    title: "Email your receipts",
    body: (data) => (
      <>
        Forward a receipt email to{" "}
        <span className="break-all font-mono font-semibold text-gray-700 dark:text-gray-200">
          {data.inboundAddress}
        </span>{" "}
        and it is added automatically (PDF and image attachments supported).
        Only emails from verified sender addresses are imported; add yours on
        the Email page.
      </>
    ),
    cta: { label: "Manage email addresses", to: "/emails" },
  },
  mcp: {
    icon: Bot,
    title: "Let your AI assistant lend a hand",
    body: (data) => (
      <>
        Point any MCP client (Claude, OpenAI, or another assistant) at{" "}
        <span className="break-all font-mono font-semibold text-gray-700 dark:text-gray-200">
          {data.mcpUrl}
        </span>
        . It can capture receipts, log mileage, answer spending questions, and
        export reports. Revoke access to any app in Settings.
      </>
    ),
    cta: { label: "Set up a client", to: "/connect" },
  },
  webmcp: {
    icon: Globe,
    title: "Browser agents can read along",
    body: () => (
      <>
        In Chrome, Expense registers read-only tools for the browser's own agent
        (WebMCP): same data, your signed-in session, nothing to set up. Ask the
        page a question about your spending.
      </>
    ),
    cta: { label: "How agent access works", to: "/ai" },
  },
  "mileage-location": {
    icon: MapPinned,
    title: "Mileage measured from where you start",
    body: () => (
      <>
        Set a start/end location (home, office, or wherever you choose) and
        every drive is measured as a round trip from there. Change it anytime in
        Settings.
      </>
    ),
    cta: { label: "Set your location", to: "/settings#start-location" },
  },
  "mileage-rate": {
    icon: Fuel,
    title: "Mileage rates come from the IRS",
    body: (data) => (
      <>
        Rates update automatically from the IRS:{" "}
        {data.mileageRate ? (
          <span className="font-semibold text-gray-700 dark:text-gray-200">
            ${data.mileageRate}/mi
          </span>
        ) : (
          "the rate for today"
        )}{" "}
        for business right now. Classify each drive as business, charity, or
        medical and the right rate is applied. Every rate since 2011 is on the{" "}
        <Link
          to="/mileage-rates"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          mileage rates page
        </Link>
        .
      </>
    ),
    cta: { label: "Log a drive", to: "/expense/new?type=mileage" },
  },
  reports: {
    icon: FileText,
    title: "Reports for every filing",
    body: () => (
      <>
        Create as many reports as you need and export any of them as a PDF.
        Close the ones you have filed, or delete ones you no longer use, all on
        the Reports page.
      </>
    ),
    cta: { label: "Manage reports", to: "/export" },
  },
  invite: {
    icon: Users,
    title: "Bring your accountant or family in",
    body: (data) => (
      <>
        Share your invite code{" "}
        <span className="break-all font-mono font-semibold text-gray-700 dark:text-gray-200">
          {data.inviteCode}
        </span>{" "}
        and they can join your account; everyone sees the same expenses,
        reports, and settings.
      </>
    ),
    cta: { label: "Get your invite code", to: "/settings#invite-code" },
  },
  reconcile: {
    icon: CreditCard,
    title: "Reconcile against your statement",
    body: () => (
      <>
        Upload a credit card statement (PDF, QuickBooks, CSV, or Excel) and
        Expense matches it against your logged expenses. Catch deductions you
        missed and find discrepancies.
      </>
    ),
    cta: { label: "Reconcile now", to: "/reconcile" },
  },
};

/** The highlight ids that can render with the given data: "email" needs the
 * inbound address configured, "mileage-rate" a published IRS rate, "invite"
 * the account's invite code. "capture" is always available, so the pool is
 * never empty. */
export function availableHighlights(data: HighlightData): HighlightId[] {
  const pool: HighlightId[] = [
    "capture",
    "categories",
    "command-palette",
    "shortcut-hints",
    "webmcp",
    "mileage-location",
    "reconcile",
    "reports",
    "search-operators",
  ];
  // Only suggest connecting a mailbox when the account hasn't connected one.
  if (!data.hasEmailConnection) pool.push("connect-email");
  if (data.inboundAddress) pool.push("email");
  if (data.mcpUrl) pool.push("mcp");
  if (data.hasRates) pool.push("mileage-rate");
  if (data.inviteCode) pool.push("invite");
  return pool;
}

/** Pick one highlight at random from the ones the current data can render.
 * `boost` triples the odds for that id (it gets two extra pool entries),
 * used to nudge unconnected accounts toward the connect-email highlight
 * while still keeping the rotation. Ignored when the boosted id isn't in
 * the pool. `random` is injectable so tests can be deterministic. */
export function pickHighlight(
  data: HighlightData,
  boost?: HighlightId,
  random: () => number = Math.random,
): HighlightId {
  const pool = availableHighlights(data);
  const weighted =
    boost && pool.includes(boost) ? [...pool, boost, boost] : pool;
  return weighted[Math.floor(random() * weighted.length)]!;
}

export function FeatureHighlight({
  id,
  data,
}: {
  id: HighlightId;
  data: HighlightData;
}) {
  const { icon: Icon, title, body, cta } = HIGHLIGHTS[id];
  return (
    <Card className="mt-6 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-gray-800 text-blue-600 dark:text-blue-400">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Did you know?
          </p>
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {title}
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {body(data)}
          </p>
        </div>
      </div>
      {cta && (
        <div className="mt-3 pl-12">
          <Button asChild variant="secondary" size="sm">
            <Link to={cta.to}>{cta.label}</Link>
          </Button>
        </div>
      )}
    </Card>
  );
}
