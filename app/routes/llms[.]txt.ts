import { llmsTxt } from "~/lib/seo-content";

/** /llms.txt — the llmstxt.org convention: a curated LLM-readable overview. */
export async function loader() {
  return new Response(llmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
