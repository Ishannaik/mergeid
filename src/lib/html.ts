/**
 * Escape untrusted strings before interpolating them into HTML.
 *
 * OAuth callback pages are served as text/html on the bot's own origin.
 * Values like `error_description` arrive from the query string with no
 * prior validation (docs/security-model.md threat 14); leaving them raw
 * is reflected XSS. Escape at the injection site so intentional markup
 * in surrounding templates stays intact.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}
