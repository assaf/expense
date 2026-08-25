import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { aiMarkdown } from "~/lib/seo-content";

/** /ai.md is the llmstxt.org convention: markdown mirror of /ai. */
export const loader = markdownRouteLoader(aiMarkdown, "text/markdown");
