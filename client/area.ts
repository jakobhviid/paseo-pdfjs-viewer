// Geometry and text assembly for the area tool, kept free of the DOM so they can be tested.

/** A rectangle on a page, in CSS pixels from the page's top-left corner. */
export interface AreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Below this, a drag was a click, not an area. */
export const MIN_AREA_SIZE = 4;

/** The rectangle between two drag points, clamped to the page. */
export function rectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  page: Size,
): AreaRect {
  const clampX = (x: number) => Math.min(Math.max(0, x), page.width);
  const clampY = (y: number) => Math.min(Math.max(0, y), page.height);
  const x1 = clampX(start.x);
  const x2 = clampX(end.x);
  const y1 = clampY(start.y);
  const y2 = clampY(end.y);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function isUsableArea(rect: AreaRect): boolean {
  return rect.width >= MIN_AREA_SIZE && rect.height >= MIN_AREA_SIZE;
}

/** Canvas pixels for a copied image: sharper than the screen, without huge canvases. */
const MAX_IMAGE_PIXELS = 16_000_000;

/**
 * How many image pixels per CSS pixel to render a copied area at: twice the screen's density, at
 * least 2, reduced so the image stays under the pixel budget.
 */
export function imageScale(rect: AreaRect, devicePixelRatio: number): number {
  const wanted = Math.max(2, 2 * (devicePixelRatio || 1));
  const area = Math.max(1, rect.width * rect.height);
  return Math.max(0.5, Math.min(wanted, Math.sqrt(MAX_IMAGE_PIXELS / area)));
}

/** Where the Copy bar goes: below the area, else above it, else inside its top edge. */
export function actionBarPosition(rect: AreaRect, page: Size, bar: Size): { x: number; y: number } {
  const gap = 6;
  const x = Math.min(Math.max(0, rect.x + rect.width - bar.width), Math.max(0, page.width - bar.width));
  if (rect.y + rect.height + gap + bar.height <= page.height) {
    return { x, y: rect.y + rect.height + gap };
  }
  if (rect.y - gap - bar.height >= 0) return { x, y: rect.y - gap - bar.height };
  return { x, y: rect.y + gap };
}

/** A run of selected characters from one text-layer node, with its box in screen pixels. */
export interface TextPiece {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Joins selected pieces, in the text layer's reading order, into lines: a piece that does not
 * share most of its height with the previous one starts a new line, and a visible gap between
 * pieces on one line becomes a space.
 */
export function joinTextPieces(pieces: readonly TextPiece[]): string {
  const lines: string[] = [];
  let line = "";
  let previous: TextPiece | null = null;
  for (const piece of pieces) {
    if (!piece.text) continue;
    if (previous) {
      const height = Math.min(piece.bottom - piece.top, previous.bottom - previous.top);
      const overlap = Math.min(piece.bottom, previous.bottom) - Math.max(piece.top, previous.top);
      if (overlap < height / 2) {
        lines.push(line);
        line = "";
      } else if (
        piece.left - previous.right > height * 0.2 &&
        !/\s$/.test(line) &&
        !/^\s/.test(piece.text)
      ) {
        line += " ";
      }
    }
    line += piece.text;
    previous = piece;
  }
  if (previous) lines.push(line);
  return lines.map((text) => text.replace(/\s+$/, "")).join("\n");
}
