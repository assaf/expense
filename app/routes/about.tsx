import { CheckCircle2 } from "lucide-react";
import { Link } from "react-router";
import { SitePage } from "~/components/SitePage";
import { Button } from "~/components/ui/Button";
import {
  APP_NAME,
  APP_SUMMARY,
  AUTHOR_NAME,
  BENEFITS,
  BLOG_URL,
  KEY_FACTS,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/about";

const ABOUT_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  name: `About ${APP_NAME}`,
  url: `${SITE_URL}/about`,
  description: APP_SUMMARY,
  author: {
    "@type": "Person",
    name: AUTHOR_NAME,
    url: BLOG_URL,
  },
};

export function meta(): Route.MetaDescriptors {
  return [
    {
      title: `About ${APP_NAME} — a free expense tracker built for tax season`,
    },
    {
      name: "description",
      content:
        "Expense is a free expense tracker built for tax season: OCR reads receipts, AI suggests categories, mileage logs at the IRS rate, and PDF or ZIP export is ready when you are.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/about` },
  ];
}

export default function AboutPage() {
  return (
    <SitePage>
      <script type="application/ld+json">{JSON.stringify(ABOUT_SCHEMA)}</script>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-12 sm:px-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600">
          About
        </p>
        <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl">
          A free expense tracker built for tax season.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-gray-600">
          {APP_SUMMARY}
        </p>

        <section className="mt-14">
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            What you get
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {BENEFITS.map((b) => (
              <div
                key={b.title}
                className="rounded-xl border border-gray-200 bg-white p-5"
              >
                <h3 className="font-semibold text-ink">{b.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
                  {b.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            Key facts
          </h2>
          <ul className="mt-6 flex flex-col gap-3">
            {KEY_FACTS.map((fact) => (
              <li key={fact} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                <span className="text-sm leading-relaxed text-gray-700">
                  {fact}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-14 rounded-2xl bg-ink px-6 py-12 text-center sm:px-12">
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Start collecting this year's expenses.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-gray-300">
            Accounts are free and start empty. Add your first receipt in under a
            minute.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="ghost"
              className="w-full text-white hover:bg-white/10 hover:text-white sm:w-auto"
            >
              <Link to="/faq">Read the FAQ</Link>
            </Button>
          </div>
        </section>
      </main>
    </SitePage>
  );
}
