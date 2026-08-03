import { alternativesMarkdown } from "~/lib/seo-content";

/** /alternatives.md — the llmstxt.org convention: markdown mirror of /alternatives. */
export async function loader() {
  return new Response(alternativesMarkdown(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
