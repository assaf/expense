import { authMarkdown } from "~/lib/content.server";
import { markdownRouteLoader } from "~/lib/markdown-route.server";

/**
 * /auth.md: how an agent authenticates against this service, and how that
 * access ends. Not a mirror of a page: the document exists for agents, is
 * discovered from the robots.txt Agentmap / the AI catalog, and is published
 * in the Auth.md shape (an H1 naming the file).
 *
 * The discovery URLs in the document are written bare, never inside
 * backticks: an Auth.md checker extracts URLs from the text and does not
 * strip the closing delimiter, so a backticked `…/oauth-protected-resource`
 * arrives as `…/oauth-protected-resource` plus a backtick and 404s. Leave
 * them bare, and keep this reason out of the document itself, which is
 * published copy addressed to the agent.
 */
export const loader = markdownRouteLoader(authMarkdown, "text/markdown");
