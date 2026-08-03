import { faqMarkdown } from "~/lib/seo-content";

/** /faq.md — the llmstxt.org convention: markdown mirror of /faq. */
export async function loader() {
  return new Response(faqMarkdown(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
