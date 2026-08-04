/**
 * Loader factory for the llmstxt.org markdown/plain-text mirror routes
 * (/about.md, /faq.md, /alternatives.md, /llms.txt). The body comes from
 * seo-content.ts — the single source of the site's public copy — and every
 * mirror shares the same caching header, so the plumbing lives here instead
 * of in four near-identical route files.
 */
export function markdownRouteLoader(
  content: () => string,
  contentType: string,
): () => Promise<Response> {
  return async function loader() {
    return new Response(content(), {
      headers: {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  };
}
