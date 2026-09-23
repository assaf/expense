import { markdownRouteLoader } from "~/lib/markdown-route.server";
import { changelogMarkdown } from "~/lib/content.server";

/** /changelog.md is the llmstxt.org convention: markdown mirror of /changelog. */
export const loader = markdownRouteLoader(changelogMarkdown, "text/markdown");
