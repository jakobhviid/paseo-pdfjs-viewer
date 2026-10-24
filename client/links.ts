/**
 * Links that leave the document: web and mail. PDF.js renders in-document links as "#dest", so
 * test the raw href attribute; `anchor.href` would resolve those against the app's URL.
 */
export function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
