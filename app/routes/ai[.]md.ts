import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { aiMarkdown } from "~/lib/seo-content";

/** /ai.md — the llmstxt.org convention: markdown mirror of /ai. */
export const loader = markdownRouteLoader(aiMarkdown, "text/markdown");
