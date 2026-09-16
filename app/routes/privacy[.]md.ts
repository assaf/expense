import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { privacyMarkdown } from "~/lib/content.server";

/** /privacy.md is the llmstxt.org convention: markdown mirror of /privacy. */
export const loader = markdownRouteLoader(privacyMarkdown, "text/markdown");
