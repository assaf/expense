import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { alternativesMarkdown } from "~/lib/seo-content";

/** /alternatives.md is the llmstxt.org convention: markdown mirror of
 * /alternatives. */
export const loader = markdownRouteLoader(
  alternativesMarkdown,
  "text/markdown",
);
