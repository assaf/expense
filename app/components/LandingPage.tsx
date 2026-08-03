import {
  ArrowUpRight,
  FolderOpen,
  MapPinned,
  ReceiptText,
  Sparkles,
  Tags,
} from "lucide-react";
import { cn } from "~/lib/cn";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";

const GITHUB = "https://github.com/assaf/expense";
const BLOG = "https://labnotes.org";
const MASTODON = "https://mas.to/@assaf";
const SITE_URL = "https://expense.labnotes.org";

/** Structured data for rich search results (Google reads JSON-LD). */
const SOFTWARE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Expense",
  url: SITE_URL,
  image: `${SITE_URL}/screenshot-og.png`,
  description:
    "Expense collects your receipts — snapped, pasted, or forwarded from email — reads the amount and merchant with OCR, and files each expense into IRS-style categories and reports for tax season.",
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
    url: BLOG,
  },
};

const FEATURES = [
  {
    icon: ReceiptText,
    title: "Receipts in, no typing",
    body: "Snap or paste a receipt image, or forward a receipt email straight to the app. OCR pulls out the amount and merchant, and AI suggests the category.",
  },
  {
    icon: FolderOpen,
    title: "Reports for every bucket",
    body: "Group expenses into reports — Home, Work, Travel, whatever you call them — and keep each project's totals separate.",
  },
  {
    icon: Tags,
    title: "Categories that match the IRS",
    body: "Split expenses by category out of the box. The default list is built from the IRS categories, so year-end totals line up with your return.",
  },
  {
    icon: MapPinned,
    title: "Mileage, mapped",
    body: "Log business drives on a map and deduct them at the per-year IRS mileage rate.",
  },
];

const STEPS = [
  {
    title: "Add a receipt",
    body: "Upload or paste a receipt image, or forward the email to your personal address — the expense is created automatically.",
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

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json">
        {JSON.stringify(SOFTWARE_SCHEMA)}
      </script>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg font-semibold"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink">
            <ReceiptText className="h-4 w-4 text-white" />
          </span>
          Expense
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <FooterLink href={GITHUB} className="hidden sm:inline-flex">
            GitHub
          </FooterLink>
          <FooterLink href={BLOG} className="hidden sm:inline-flex">
            Blog
          </FooterLink>
          <FooterLink href={MASTODON} className="hidden sm:inline-flex">
            Mastodon
          </FooterLink>
          <Button asChild variant="ghost" size="sm" className="ml-2">
            <Link to="/login">Sign in</Link>
          </Button>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-6 sm:pt-16">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600">
            Personal expense tracking
          </p>
          <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Every receipt, ready for tax season.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-gray-600">
            Expense collects your receipts — snapped, pasted, or forwarded from
            your inbox — reads the amount and merchant with OCR, and files each
            expense into IRS-style categories and reports. When tax season
            comes, the totals are already there.
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
              <a href={GITHUB} target="_blank" rel="noreferrer">
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
                The receipt editor — OCR and AI filled in merchant, amount, and
                category.
              </figcaption>
            </figure>
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

      <footer className="border-t border-gray-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink">
              <ReceiptText className="h-3 w-3 text-white" />
            </span>
            Expense · © {new Date().getFullYear()} · Built by Assaf Arkin
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <FooterLink href={GITHUB}>GitHub</FooterLink>
            <FooterLink href={BLOG}>Blog</FooterLink>
            <FooterLink href={MASTODON}>Mastodon</FooterLink>
            <Link
              to="/about"
              className="inline-flex items-center gap-1 rounded-md text-gray-500 transition-colors hover:text-ink"
            >
              About
            </Link>
            <Link
              to="/faq"
              className="inline-flex items-center gap-1 rounded-md text-gray-500 transition-colors hover:text-ink"
            >
              FAQ
            </Link>
            <Link
              to="/alternatives"
              className="inline-flex items-center gap-1 rounded-md text-gray-500 transition-colors hover:text-ink"
            >
              Compare
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function FooterLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded-md text-gray-500 transition-colors hover:text-ink",
        className,
      )}
    >
      {children}
      <ArrowUpRight className="h-3.5 w-3.5" />
    </a>
  );
}
