/**
 * The page a link asks for, 1-based, or null. Paseo opens `file.pdf#L5`, `file.pdf:5`, and
 * `file.pdf (5)` with `lineStart: 5`; a PDF has no lines, so the number is the page.
 */
export function linkedPage(params: { lineStart?: number }): number | null {
  const page = params.lineStart;
  return typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : null;
}
