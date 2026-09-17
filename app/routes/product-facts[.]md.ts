import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { productFactsMarkdown } from "~/lib/content.server";

/** /product-facts.md is the llmstxt.org convention: markdown mirror of
 * /product-facts. */
export const loader = markdownRouteLoader(
  productFactsMarkdown,
  "text/markdown",
);
