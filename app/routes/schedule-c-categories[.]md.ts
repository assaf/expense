import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { scheduleCCategoriesMarkdown } from "~/lib/content.server";

/** /schedule-c-categories.md is the llmstxt.org convention: markdown mirror
 * of /schedule-c-categories. */
export const loader = markdownRouteLoader(
  scheduleCCategoriesMarkdown,
  "text/markdown",
);
