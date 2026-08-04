import { Link } from "react-router";
import { SitePage } from "~/components/SitePage";
import { Button } from "~/components/ui/Button";
import { APP_NAME, APP_SUMMARY, FAQS, SITE_URL } from "~/lib/seo-content";
import type { Route } from "./+types/faq";

/** FAQPage structured data — the primary signal for FAQ-style AI answers. */
const FAQ_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((f) => ({
    "@type": "Question",
    name: f.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.answer,
    },
  })),
};

export function meta(): Route.MetaDescriptors {
  return [
    {
      title: `${APP_NAME} FAQ — expense tracking for tax season: receipt OCR, AI categories, mileage`,
    },
    {
      name: "description",
      content:
        "Plain answers to common questions about Expense: what it's for, how receipt OCR and AI categories work, whether it tracks mileage, and how it helps at tax time.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/faq` },
  ];
}

export default function FaqPage() {
  return (
    <SitePage>
      <script type="application/ld+json">{JSON.stringify(FAQ_SCHEMA)}</script>
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-12 sm:px-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600">
          FAQ
        </p>
        <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl">
          Frequently asked questions
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-gray-600">
          {APP_SUMMARY}
        </p>

        <div className="mt-10 flex flex-col gap-4">
          {FAQS.map((f) => (
            <article
              key={f.question}
              className="rounded-xl border border-gray-200 bg-white p-5"
            >
              <h2 className="font-semibold text-ink">{f.question}</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {f.answer}
              </p>
            </article>
          ))}
        </div>

        <section className="mt-12 rounded-2xl bg-ink px-6 py-10 text-center sm:px-12">
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Still have questions? Just try it.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-gray-300">
            Accounts are free and start empty — add your first receipt in under
            a minute.
          </p>
          <div className="mt-6">
            <Button
              asChild
              size="lg"
              className="w-full bg-white text-ink hover:bg-gray-100 sm:w-auto"
            >
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
          </div>
        </section>
      </main>
    </SitePage>
  );
}
