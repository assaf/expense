import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { faqMarkdown } from "~/lib/seo-content";

/** /faq.md is the llmstxt.org convention: markdown mirror of /faq. */
export const loader = markdownRouteLoader(faqMarkdown, "text/markdown");
