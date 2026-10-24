/** The class on the element that holds the viewer; PDF.js's stylesheet applies only inside it. */
export const SCOPE_CLASS = "paseo-pdfjs-root";

/**
 * PDF.js's viewer stylesheet includes global rules (`:root` variables, button and dialog styles)
 * that would restyle the app. Wrap it in `@scope` so it applies only inside the viewer, moving its
 * `:root` variables onto the scope root. Its only top-level at-rules are `@media`, which `@scope`
 * allows.
 */
export function scopeCss(css: string, scopeClass: string = SCOPE_CLASS): string {
  return `@scope (.${scopeClass}) {\n${css.replace(/:root\b/g, ":scope")}\n}\n`;
}
