/**
 * Escape a string for safe inclusion as text content in HTML or XML:
 * reply email bodies, SVG receipt text, and the text-email renderer.
 * Escapes the five HTML-significant characters (& < > " ').
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
