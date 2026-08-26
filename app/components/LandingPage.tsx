import {
  Bot,
  CreditCard,
  FolderOpen,
  MapPinned,
  Plug,
  ReceiptText,
  Sparkles,
  Tags,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { MarketingCta } from "~/components/MarketingPage";
import { Button } from "~/components/ui/Button";
import { SitePage } from "~/components/SitePage";
import { BENEFITS, BLOG_URL, SITE_URL } from "~/lib/seo-content";

/** Structured data for rich search results (Google reads JSON-LD). */
const SOFTWARE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Expense",
  url: SITE_URL,
  image: `${SITE_URL}/screenshot-og.png`,
  description:
    "Expense reads your receipts, snapped, pasted, or forwarded from email, and files each expense into IRS Schedule C categories and reports, ready to export for tax season.",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Person",
    name: "Assaf Arkin",
    url: BLOG_URL,
  },
};

/** The icons for the four landing-page features, keyed by the BENEFITS
 * title so the copy itself stays in seo-content.ts (the single source of
 * the site's public copy). Order here is the card order. */
const FEATURE_ICONS: Record<string, LucideIcon> = {
  "Stop losing receipts in your gallery": ReceiptText,
  "PDF reports to show your accountant": FolderOpen,
  "Get ready with your deductions on time": Tags,
  "Log drives without Excel": MapPinned,
  "Reconcile against your monthly statement": CreditCard,
  "Connect your FastMail account": Plug,
};

const FEATURES: { icon: LucideIcon; title: string; body: string }[] =
  Object.keys(FEATURE_ICONS).map((title) => {
    const benefit = BENEFITS.find((b) => b.title === title);
    // A missing title breaks at module load instead of silently dropping a
    // card; the two lists can't drift apart without a loud error.
    if (!benefit) {
      throw new Error(
        `LandingPage feature "${title}" is missing from BENEFITS in seo-content.ts`,
      );
    }
    return {
      icon: FEATURE_ICONS[title]!,
      title: benefit.title,
      body: benefit.body,
    };
  });

const STEPS = [
  {
    title: "Attach a receipt",
    body: "Simply upload the image, copy and paste the image, or even forward your receipt email to yourself. Receipt is automatically created.",
  },
  {
    title: "Save and confirm",
    body: "Merchant name, amount, and category are all automatically entered. Receipts just require a single click to save.",
  },
  {
    title: "Export when it's tax time",
    body: "Receive your report in PDF format with receipt attached, or ZIP of all receipts.",
  },
];

/** The four "bring your own assistant" examples on the landing page. */
const AGENT_EXAMPLES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ReceiptText,
    title: "Extract a receipt from chat",
    body: "Drop a receipt photo or PDF into the conversation, and it's OCR'd, categorized from your own history, and filed. No app to open.",
  },
  {
    icon: Tags,
    title: "Inquire about your expenditures",
    body: `“How much have I spent on plane tickets this quarter?”—the precise amount, straight from the source.`,
  },
  {
    icon: FolderOpen,
    title: "Generate reports on demand",
    body: `“Insert all unreconciled June expenses into the Q2 report and save it as a PDF file.” One line of text, and it's done.`,
  },
  {
    icon: MapPinned,
    title: "Register a journey in natural language",
    body: `“Log the drive from the office back home on Tuesday.” Geocoded, routed, and costed at the IRS rates for the year.
`,
  },
];

export default function LandingPage() {
  return (
    <SitePage>
      <script type="application/ld+json">
        {JSON.stringify(SOFTWARE_SCHEMA)}
      </script>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-6 sm:pt-16">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-400">
            Expense tracking for tax season
          </p>
          <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Every receipt, ready for tax season.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
            Your receipts, all collected to prepare for tax season. Expense does
            that for you: take a picture of it, drop a screenshot or a receipt
            email. OCR recognizes the merchant and amount and puts the spend
            into the correct category of a Schedule C form and a report of your
            choice. And when tax season comes, all is ready.
          </p>
          <p className="mx-auto mt-3 max-w-2xl text-base text-gray-500 dark:text-gray-400">
            Have a FastMail account? Connect it and receipts from your inbox are
            processed automatically, no forwarding and no Gmail required.
          </p>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            By a freelancer. Open-source, no funding.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
          </div>
          <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">
            No credit card required. Your data stays in your account. Export and
            leave anytime.
          </p>
        </section>

        {/* App screenshot */}
        <section className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          <figure className="overflow-hidden rounded-xl bg-white shadow-2xl shadow-gray-900/10 ring-1 ring-gray-900/5 dark:bg-gray-800 dark:shadow-black/30 dark:ring-white/5">
            <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-amber-400" />
              <span className="h-3 w-3 rounded-full bg-green-400" />
            </div>
            <img
              src="/screenshot-hero.png"
              alt="The Expense home page: report totals, receipts with thumbnails, and a mileage entry"
              className="w-full"
            />
          </figure>
        </section>

        {/* Features */}
        <section
          id="features"
          className="border-t border-gray-100 bg-gray-50 py-20 dark:border-gray-800 dark:bg-gray-800/50"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-center text-3xl font-bold tracking-tight text-ink">
              What you get
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-gray-600 dark:text-gray-300">
              Tailored for one purpose: to get your expense data as quickly as
              possible, so year-end is not a grueling process but just a
              download.
            </p>
            <div className="mx-auto mt-12 flex max-w-2xl flex-col gap-3">
              {FEATURES.map((f) => (
                <div
                  key={f.title}
                  className="flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700">
                    <f.icon aria-hidden="true" className="h-5 w-5 text-ink" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-ink">{f.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                      {f.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section
          id="how-it-works"
          className="mx-auto max-w-6xl px-4 py-20 sm:px-6"
        >
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-ink">
                From receipt to export
              </h2>
              <p className="mt-3 max-w-md text-gray-600 dark:text-gray-300">
                Just three fast moves, no data input required.
              </p>
              <ol className="mt-8 flex flex-col gap-6">
                {STEPS.map((step, i) => (
                  <li key={step.title} className="flex gap-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-bold text-blue-600 dark:bg-blue-900/60 dark:text-blue-400">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="font-semibold text-ink">{step.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                        {step.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <figure className="overflow-hidden rounded-xl bg-white shadow-xl shadow-gray-900/10 ring-1 ring-gray-900/5 dark:bg-gray-800 dark:shadow-black/30 dark:ring-white/5">
              <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
                <span className="h-3 w-3 rounded-full bg-red-400" />
                <span className="h-3 w-3 rounded-full bg-amber-400" />
                <span className="h-3 w-3 rounded-full bg-green-400" />
              </div>
              <img
                src="/screenshot-expense.png"
                alt="The receipt editor: OCR and AI filled in merchant, amount, and category"
                className="w-full"
              />
              <figcaption className="flex items-center gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
                <Sparkles
                  aria-hidden="true"
                  className="h-4 w-4 text-blue-600 dark:text-blue-400"
                />
                The receipt editor: OCR and AI filled in merchant, amount, and
                category.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* AI assistants */}
        <section
          id="ai-assistants"
          className="mx-auto max-w-6xl px-4 pb-20 sm:px-6"
        >
          <div className="rounded-2xl border border-gray-200 bg-white p-8 sm:p-12 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              <Bot aria-hidden="true" className="h-4 w-4" /> AI-native
            </div>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-ink">
              Your Own Personal AI Assistant
            </h2>
            <p className="mt-3 max-w-2xl text-gray-600 dark:text-gray-300">
              Expense uses the Model Context Protocol (MCP). Simply point
              Claude, OpenAI, or any other MCP client to your account, log in
              for authentication (no tokens to deal with), and let the assistant
              do the mundane work:
            </p>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {AGENT_EXAMPLES.map((example) => (
                <li
                  key={example.title}
                  className="flex gap-3 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50"
                >
                  <example.icon
                    aria-hidden="true"
                    className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
                  />
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      {example.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                      {example.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
              Connection is authorization: the assistant opens the browser, you
              allow access, and it is connected. Disconnect any time with one
              click in the Settings menu.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          {/* The landing page's closing panel is the page's final moment:
           * larger heading, taller padding, transparent Sign in. */}
          <MarketingCta
            heading="Start collecting this year's expenses."
            body="No credit card, no subscription. Free until we reach 100 users, then still free up to 25 invoices a month."
            secondaryLabel="Sign in"
            secondaryHref="/login"
            className="py-14"
            headingClassName="text-3xl"
            secondaryClassName="bg-transparent"
          />
        </section>
      </main>
    </SitePage>
  );
}
