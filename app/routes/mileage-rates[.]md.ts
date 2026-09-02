import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { mileageRatesMarkdown } from "~/lib/seo-content";

/** /mileage-rates.md is the llmstxt.org convention: markdown mirror of /mileage-rates. */
export const loader = markdownRouteLoader(
  mileageRatesMarkdown,
  "text/markdown",
);
