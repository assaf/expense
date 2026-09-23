import { JsonLd } from "~/components/JsonLd";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { Badge } from "~/components/ui/Badge";
import type { ChangeType } from "~/data/content-types";
import { CHANGELOG, changelogReleases } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta, SITE_URL } from "~/lib/seo-content";
import type { Route } from "./+types/changelog";

/** Color per change type: green for something new, blue for a change to what
 * was there, amber for a fix. The badge's own classes carry the dark: twins,
 * so this map only picks the tone. */
const TONE_BY_CHANGE: Record<ChangeType, "green" | "blue" | "amber"> = {
  feature: "green",
  improvement: "blue",
  fix: "amber",
};

export function loader() {
  return { ...CHANGELOG, releases: changelogReleases() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/changelog");
}

export const headers = () => marketingPageHeaders("/changelog.md");

export default function ChangelogPage({ loaderData }: Route.ComponentProps) {
  const changelogSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: loaderData.mirror.title,
    url: `${SITE_URL}/changelog`,
    description: loaderData.summary,
    about: {
      "@type": "SoftwareApplication",
      name: "Expense",
      url: SITE_URL,
      applicationCategory: "FinanceApplication",
    },
    dateModified: loaderData.releases[0]?.date,
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={changelogSchema} />}
    >
      <section className="mt-10">
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {loaderData.intro}
        </p>
        <ol className="mt-10 flex flex-col gap-10">
          {loaderData.releases.map((release) => (
            <li key={release.date}>
              <h2
                id={release.date}
                className="font-mono text-sm font-semibold tracking-tight text-gray-500 dark:text-gray-400"
              >
                <time dateTime={release.date}>{release.date}</time>
              </h2>
              <ul className="mt-3 flex flex-col gap-2.5 border-l border-gray-200 pl-4 dark:border-gray-700">
                {release.changes.map((change) => (
                  <li key={change.text} className="flex items-start gap-2.5">
                    <Badge
                      tone={TONE_BY_CHANGE[change.type]}
                      className="mt-0.5 shrink-0"
                    >
                      {loaderData.typeLabels[change.type]}
                    </Badge>
                    <span className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                      {change.text}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      <MarketingCta
        heading={loaderData.cta.heading}
        body={loaderData.cta.body}
        className="mt-14 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
