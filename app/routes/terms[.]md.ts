import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { termsMarkdown } from "~/lib/seo-content";

/** /terms.md is the llmstxt.org convention: markdown mirror of /terms. */
export const loader = markdownRouteLoader(termsMarkdown, "text/markdown");
