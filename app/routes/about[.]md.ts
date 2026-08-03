import { aboutMarkdown } from "~/lib/seo-content";

/** /about.md — the llmstxt.org convention: markdown mirror of /about. */
export async function loader() {
  return new Response(aboutMarkdown(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
