import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { connectMarkdown } from "~/lib/seo-content";

/** /connect.md is the llmstxt.org convention: markdown mirror of /connect. */
export const loader = markdownRouteLoader(connectMarkdown, "text/markdown");
