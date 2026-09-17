import { CheckCircle2 } from "lucide-react";
import { JsonLd } from "~/components/JsonLd";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { Card } from "~/components/ui/Card";
import { ABOUT, SITE } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta, SITE_URL } from "~/lib/seo-content";
import type { Route } from "./+types/about";

export function loader() {
  return { ...ABOUT, keyFacts: SITE.keyFacts };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/about");
}

export const headers = () => marketingPageHeaders("/about.md");

export default function AboutPage({ loaderData }: Route.ComponentProps) {
  const aboutSchema = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    name: "About Expense",
    url: `${SITE_URL}/about`,
    description: loaderData.summary,
    author: {
      "@type": "Person",
      name: "Assaf Arkin",
      url: "https://labnotes.org",
    },
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={aboutSchema} />}
    >
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.benefitsHeading}
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {loaderData.benefits.map((b) => (
            <Card key={b.title} className="p-5">
              <h3 className="font-semibold text-ink">{b.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {b.body}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.factsHeading}
        </h2>
        <ul className="mt-6 flex flex-col gap-3">
          {loaderData.keyFacts.map((fact) => (
            <li key={fact} className="flex items-start gap-2">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              />
              <span className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                {fact}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <MarketingCta
        heading={loaderData.cta.heading}
        body={loaderData.cta.body}
        secondaryLabel={loaderData.cta.secondaryLabel}
        secondaryHref="/faq"
      />
    </MarketingPage>
  );
}
