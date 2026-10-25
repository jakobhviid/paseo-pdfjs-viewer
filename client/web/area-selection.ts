import type { PageViewport, PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import {
  actionBarPosition,
  type AreaRect,
  imageScale,
  isUsableArea,
  joinTextPieces,
  rectFromPoints,
  type Size,
  type TextPiece,
} from "../area";

const RECT_CLASS = "paseo-pdfjs-area-rect";
const BAR_CLASS = "paseo-pdfjs-area-actions";

/** The parts of PDF.js's PDFPageView the area tool reads. */
interface PageView {
  div: HTMLDivElement;
  pdfPage: PDFPageProxy | null;
  viewport: PageViewport;
}

interface Area {
  page: PageView;
  rect: AreaRect;
  overlay: HTMLDivElement;
  bar: HTMLDivElement | null;
}

export interface AreaSelectionOptions {
  notify(message: string, tone: "info" | "error"): void;
}

/**
 * The area tool, like Okular's: drag a rectangle on one page, then copy the text inside it or an
 * image of it. The image is rendered from the PDF at a higher resolution than the screen.
 */
export class AreaSelection {
  private area: Area | null = null;

  constructor(private readonly options: AreaSelectionOptions) {}

  get active(): boolean {
    return this.area !== null;
  }

  /** Starts an area on the page under the pointer; a press elsewhere only clears the last one. */
  begin(container: HTMLElement, pdfViewer: PDFViewer, event: PointerEvent): void {
    // Touch keeps the browser's own panning.
    if (event.pointerType === "touch" || event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest?.(`.${BAR_CLASS}`)) return;
    this.clear();
    const pageDiv = target?.closest?.(".page") as HTMLDivElement | null;
    if (!pageDiv) return;
    const page = pdfViewer.getPageView(Number(pageDiv.dataset.pageNumber) - 1) as PageView | undefined;
    if (!page?.pdfPage) return;

    // Keeps the browser from starting a text selection.
    event.preventDefault();
    container.focus({ preventScroll: true });
    container.setPointerCapture(event.pointerId);
    const size: Size = { width: page.viewport.width, height: page.viewport.height };
    const pointOnPage = (pointer: PointerEvent) => {
      const frame = pageFrame(pageDiv);
      return { x: pointer.clientX - frame.left, y: pointer.clientY - frame.top };
    };
    const start = pointOnPage(event);
    const overlay = document.createElement("div");
    overlay.className = RECT_CLASS;
    pageDiv.appendChild(overlay);
    const area: Area = { page, rect: rectFromPoints(start, start, size), overlay, bar: null };
    this.area = area;
    place(overlay, area.rect, pageDiv);

    const onMove = (move: PointerEvent) => {
      area.rect = rectFromPoints(start, pointOnPage(move), size);
      place(overlay, area.rect, pageDiv);
    };
    const onEnd = () => {
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onEnd);
      container.removeEventListener("pointercancel", onEnd);
      if (this.area !== area) return;
      if (isUsableArea(area.rect)) area.bar = this.showActions(area, pageDiv, size);
      else this.clear();
    };
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerup", onEnd);
    container.addEventListener("pointercancel", onEnd);
  }

  clear(): void {
    const area = this.area;
    this.area = null;
    area?.overlay.remove();
    area?.bar?.remove();
  }

  private showActions(area: Area, pageDiv: HTMLDivElement, size: Size): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = BAR_CLASS;
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Selected area");
    bar.append(
      actionButton("Copy text", () => this.copyText(area, pageDiv)),
      actionButton("Copy image", () => this.copyImage(area)),
    );
    pageDiv.appendChild(bar);
    const position = actionBarPosition(area.rect, size, {
      width: bar.offsetWidth,
      height: bar.offsetHeight,
    });
    place(bar, { ...position, width: -1, height: -1 }, pageDiv);
    return bar;
  }

  private copyText(area: Area, pageDiv: HTMLDivElement): void {
    const text = textInArea(pageDiv, area.rect);
    this.clear();
    if (!text) {
      this.options.notify("There is no text in the selected area.", "info");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => this.options.notify("Copied text.", "info"),
      (error: unknown) => this.options.notify(`Couldn't copy the text: ${messageOf(error)}`, "error"),
    );
  }

  private copyImage(area: Area): void {
    // Start the clipboard write inside the click and let the image render into it, so browsers
    // that require a user gesture for clipboard writes accept it.
    const image = renderArea(area);
    this.clear();
    navigator.clipboard.write([new ClipboardItem({ "image/png": image })]).then(
      () => this.options.notify("Copied image.", "info"),
      (error: unknown) => this.options.notify(`Couldn't copy the image: ${messageOf(error)}`, "error"),
    );
  }
}

/** The page's drawing area on screen: inside its border, where PDF.js draws the page. */
function pageFrame(pageDiv: HTMLDivElement): { left: number; top: number; offsetX: number; offsetY: number } {
  const page = pageDiv.getBoundingClientRect();
  const paddingLeft = page.left + pageDiv.clientLeft;
  const paddingTop = page.top + pageDiv.clientTop;
  const drawing = pageDiv.querySelector(".canvasWrapper")?.getBoundingClientRect();
  const left = drawing?.left ?? paddingLeft;
  const top = drawing?.top ?? paddingTop;
  return { left, top, offsetX: left - paddingLeft, offsetY: top - paddingTop };
}

/** Positions an element over the page; a negative width or height leaves that size alone. */
function place(element: HTMLElement, rect: AreaRect, pageDiv: HTMLDivElement): void {
  const frame = pageFrame(pageDiv);
  element.style.left = `${frame.offsetX + rect.x}px`;
  element.style.top = `${frame.offsetY + rect.y}px`;
  if (rect.width >= 0) element.style.width = `${rect.width}px`;
  if (rect.height >= 0) element.style.height = `${rect.height}px`;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** The text-layer characters whose centers fall inside the area, in reading order. */
function textInArea(pageDiv: HTMLDivElement, rect: AreaRect): string {
  const textLayer = pageDiv.querySelector(".textLayer");
  if (!textLayer) return "";
  const frame = pageFrame(pageDiv);
  const box = {
    left: frame.left + rect.x,
    top: frame.top + rect.y,
    right: frame.left + rect.x + rect.width,
    bottom: frame.top + rect.y + rect.height,
  };
  const pieces: TextPiece[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const bounds = node.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.right < box.left || bounds.left > box.right) continue;
    if (bounds.bottom < box.top || bounds.top > box.bottom) continue;
    let piece: TextPiece | null = null;
    for (let index = 0; index < node.length; index += 1) {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const char = range.getBoundingClientRect();
      const x = char.left + char.width / 2;
      const y = char.top + char.height / 2;
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      if (!piece) {
        piece = { text: "", left: char.left, right: char.right, top: char.top, bottom: char.bottom };
        pieces.push(piece);
      }
      piece.text += node.data[index];
      piece.right = Math.max(piece.right, char.right);
      piece.top = Math.min(piece.top, char.top);
      piece.bottom = Math.max(piece.bottom, char.bottom);
    }
  }
  range.detach();
  return joinTextPieces(pieces);
}

/** Renders the area from the PDF itself, so the image is sharp at any zoom. */
async function renderArea(area: Area): Promise<Blob> {
  const pdfPage = area.page.pdfPage;
  if (!pdfPage) throw new Error("The page is not loaded.");
  const { rect } = area;
  const scale = imageScale(rect, window.devicePixelRatio);
  const viewport = area.page.viewport.clone({ scale: area.page.viewport.scale * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  await pdfPage.render({
    canvas,
    viewport,
    transform: [1, 0, 0, 1, -rect.x * scale, -rect.y * scale],
    background: "white",
  }).promise;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The image could not be encoded."));
    }, "image/png");
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
