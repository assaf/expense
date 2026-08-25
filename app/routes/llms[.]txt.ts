import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { llmsTxt } from "~/lib/seo-content";

/** /llms.txt is the llmstxt.org convention: a curated LLM-readable overview. */
export const loader = markdownRouteLoader(llmsTxt, "text/plain");
