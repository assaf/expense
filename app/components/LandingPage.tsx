import {
  ArrowUpRight,
  Bot,
  FolderOpen,
  MapPinned,
  ReceiptText,
  Sparkles,
  Tags,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { SiteFooter, SiteHeader } from "~/components/SiteChrome";
import { BENEFITS, BLOG_URL, GITHUB_URL, SITE_URL } from "~/lib/seo-content";

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
  "Receipts in, no typing": ReceiptText,
  "Reports for every bucket": FolderOpen,
  "Categories that match the IRS": Tags,
  "Mileage, mapped": MapPinned,
};

const FEATURES: { icon: LucideIcon; title: string; body: string }[] =
  Object.keys(FEATURE_ICONS).map((title) => {
    const benefit = BENEFITS.find((b) => b.title === title);
    // A missing title breaks at module load instead of silently dropping a
    // card — the two lists can't drift apart without a loud error.
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
    title: "Add a receipt",
    body: "Upload or paste a receipt image, or forward the email to your personal address. The expense is created automatically.",
  },
  {
    title: "Check the details",
    body: "OCR reads the merchant and amount; AI suggests the category. You review, tweak if needed, and save.",
  },
  {
    title: "Export at tax time",
    body: "Get a PDF per report with the receipts attached, or a ZIP of everything, and hand it to your accountant.",
  },
];

/** The four "bring your own assistant" examples on the landing page. */
const AGENT_EXAMPLES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ReceiptText,
    title: "Capture a receipt from the chat",
    body: "Drop a receipt photo or PDF into the conversation, and it's OCR'd, categorized from your own history, and filed. No app to open.",
  },
  {
    icon: Tags,
    title: "Ask about your spending",
    body: "\u201CHow much did I spend on flights last quarter?\u201D — the exact total, straight from your data.",
  },
  {
    icon: FolderOpen,
    title: "Build reports on command",
    body: "\u201CMove all unreported June expenses into the Q2 report and export the PDF.\u201D One sentence, done.",
  },
  {
    icon: MapPinned,
    title: "Log a drive in plain English",
    body: "\u201CLog the drive home from the office on Tuesday.\u201D Geocoded, routed, and priced at the year's IRS rate.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json">
        {JSON.stringify(SOFTWARE_SCHEMA)}
      </script>
      <SiteHeader />

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-6 sm:pt-16">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600">
            Expense tracking for tax season
          </p>
          <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Every receipt, ready for tax season.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-gray-600">
            Expense collects your receipts: snap a photo, paste a screenshot, or
            forward the email. OCR reads the amount and merchant, and each
            expense lands in a Schedule C category and a report you name. When
            tax season comes, the totals are already there.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="secondary"
              className="w-full sm:w-auto"
            >
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                See the code <ArrowUpRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
          <p className="mt-5 text-sm text-gray-500">
            Your data stays in your account. Export a PDF or ZIP anytime.
          </p>
        </section>

        {/* App screenshot */}
        <section className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          <figure className="overflow-hidden rounded-xl bg-white shadow-2xl shadow-gray-900/10 ring-1 ring-gray-900/5">
            <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3">
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
          className="border-t border-gray-100 bg-gray-50 py-20"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-center text-3xl font-bold tracking-tight text-ink">
              What you get
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-gray-600">
              Built for one job: getting your expenses collected quickly, so
              year-end is a download, not a marathon.
            </p>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <div
                  key={f.title}
                  className="rounded-xl border border-gray-200 bg-white p-5"
                >
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">
                    <f.icon className="h-5 w-5 text-ink" />
                  </div>
                  <h3 className="font-semibold text-ink">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
                    {f.body}
                  </p>
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
              <p className="mt-3 max-w-md text-gray-600">
                Three steps, none of them data entry.
              </p>
              <ol className="mt-8 flex flex-col gap-6">
                {STEPS.map((step, i) => (
                  <li key={step.title} className="flex gap-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-bold text-blue-600">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="font-semibold text-ink">{step.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-gray-600">
                        {step.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <figure className="overflow-hidden rounded-xl bg-white shadow-xl shadow-gray-900/10 ring-1 ring-gray-900/5">
              <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3">
                <span className="h-3 w-3 rounded-full bg-red-400" />
                <span className="h-3 w-3 rounded-full bg-amber-400" />
                <span className="h-3 w-3 rounded-full bg-green-400" />
              </div>
              <img
                src="/screenshot-expense.png"
                alt="The receipt editor: OCR and AI filled in merchant, amount, and category"
                className="w-full"
              />
              <figcaption className="flex items-center gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                <Sparkles className="h-4 w-4 text-blue-600" />
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
          <div className="rounded-2xl border border-gray-200 bg-white p-8 sm:p-12">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-blue-600">
              <Bot className="h-4 w-4" /> AI-native
            </div>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-ink">
              Bring your own AI assistant.
            </h2>
            <p className="mt-3 max-w-2xl text-gray-600">
              Expense speaks the Model Context Protocol (MCP). Point Claude,
              Cursor, or any MCP client at your account, approve the connection
              by signing in (no tokens to manage), and let the assistant do the
              boring parts:
            </p>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {AGENT_EXAMPLES.map((example) => (
                <li
                  key={example.title}
                  className="flex gap-3 rounded-xl border border-gray-100 bg-gray-50 p-4"
                >
                  <example.icon className="h-5 w-5 shrink-0 text-blue-600" />
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      {example.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600">
                      {example.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-gray-500">
              Connecting is signing in: the assistant opens your browser, you
              click Allow, and it's connected. Revoke it anytime with one click
              in Settings.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="rounded-2xl bg-ink px-6 py-14 text-center sm:px-12">
            <h2 className="text-3xl font-bold tracking-tight text-white">
              Start collecting this year's expenses.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-gray-300">
              Accounts are free and start empty. Add your first receipt in under
              a minute.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                asChild
                size="lg"
                className="w-full bg-white text-ink hover:bg-gray-100 sm:w-auto"
              >
                <Link to="/login?mode=create">Create your account</Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="w-full text-white hover:bg-white/10 hover:text-white sm:w-auto"
              >
                <Link to="/login">Sign in</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
