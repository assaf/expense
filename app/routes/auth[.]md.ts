import { authMarkdown } from "~/lib/content.server";
import { markdownRouteLoader } from "~/lib/markdown-route.server";

/**
 * /auth.md: how an agent authenticates against this service, and how that
 * access ends. Not a mirror of a page: the document exists for agents, is
 * discovered from the robots.txt Agentmap / the AI catalog, and is published
 * in the Auth.md shape (an H1 naming the file).
 */
export const loader = markdownRouteLoader(authMarkdown, "text/markdown");
