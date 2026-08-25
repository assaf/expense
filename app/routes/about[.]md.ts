import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { aboutMarkdown } from "~/lib/seo-content";

/** /about.md is the llmstxt.org convention: markdown mirror of /about. */
export const loader = markdownRouteLoader(aboutMarkdown, "text/markdown");
