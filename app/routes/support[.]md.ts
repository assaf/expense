import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { supportMarkdown } from "~/lib/content.server";

/** /support.md is the llmstxt.org convention: markdown mirror of /support. */
export const loader = markdownRouteLoader(supportMarkdown, "text/markdown");
