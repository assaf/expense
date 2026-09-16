import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { aiMarkdown } from "~/lib/content.server";

/** /ai.md is the llmstxt.org convention: markdown mirror of /ai. */
export const loader = markdownRouteLoader(aiMarkdown, "text/markdown");
