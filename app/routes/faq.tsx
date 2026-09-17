import { JsonLd } from "~/components/JsonLd";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { Card } from "~/components/ui/Card";
import { FAQ } from "~/lib/content.server";
import { plainText } from "~/lib/markdown";
import { marketingPageHeaders, pageMeta } from "~/lib/seo-content";
import type { Route } from "./+types/faq";

export function loader() {
  return FAQ;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/faq");
}

export const headers = () => marketingPageHeaders("/faq.md");

export default function FaqPage({ loaderData }: Route.ComponentProps) {
  /** FAQPage structured data: the primary signal for FAQ-style AI answers. */
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: loaderData.questions.map((question) => ({
      "@type": "Question",
      name: question.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: plainText(question.answer),
      },
    })),
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      className="max-w-3xl"
      schema={<JsonLd data={faqSchema} />}
    >
      <div className="mt-10 flex flex-col gap-4">
        {loaderData.questions.map((question) => (
          <Card key={question.question} className="p-5">
            <h2 className="font-semibold text-ink">{question.question}</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              {question.answer}
            </p>
          </Card>
        ))}
      </div>

      <MarketingCta
        heading={loaderData.cta.heading}
        body={loaderData.cta.body}
        className="mt-12 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
