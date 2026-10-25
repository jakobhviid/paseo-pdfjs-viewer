import type { PluginTheme } from "@getpaseo/plugin";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import { SCOPE_CLASS } from "../css-scope";
import {
  type Box,
  isPinHeld,
  type PageBox,
  type PinnedPage,
  pageNearestCenter,
} from "../current-page";
import { isExternalLink } from "../links";
import { pagingKey, WheelPageFlip } from "../page-flip";
import {
  defaultSavedView,
  restoreTarget,
  type SavedView,
  type ScalePreset,
  savedViewFromLocation,
  type Tool,
  type ViewerLocation,
} from "../view-state";
import type {
  CreateViewerController,
  CreateViewerControllerOptions,
  FindStatus,
  OpenOptions,
  ViewerController,
} from "../viewer-types";
import { AreaSelection } from "./area-selection";
import { binaryDataFactoryFor, loadPdfjsRuntime, type PdfjsRuntime } from "./runtime";

/** One loaded document in its own scroll container. A rebuild loads into a new layer. */
interface Layer {
  container: HTMLDivElement;
  eventBus: EventBus;
  linkService: PDFLinkService;
  findController: PDFFindController;
  pdfViewer: PDFViewer;
  document: PDFDocumentProxy | null;
  location: ViewerLocation | null;
  /** The page the viewer last moved to itself; current until the reader scrolls. */
  pin: PinnedPage | null;
}

/** How long a rebuilt document may take to draw a page before it is shown anyway. */
const SWAP_TIMEOUT_MS = 2000;
const PENDING_CLASS = "paseo-pdfjs-pending";
const INVERT_CLASS = "paseo-pdfjs-invert";
const HAND_CLASS = "paseo-pdfjs-hand";
const AREA_CLASS = "paseo-pdfjs-area";
const GRABBING_CLASS = "paseo-pdfjs-grabbing";
/** Where a hand-tool drag must not start, as in PDF.js's grab-to-pan: links and form controls. */
const HAND_IGNORE = "a[href], a[href] *, input, textarea, button, button *, select, option";

// PDF.js FindState values.
const FIND_STATES: Record<number, FindStatus["state"]> = {
  0: "found",
  1: "not-found",
  2: "wrapped",
  3: "pending",
};

export const createViewerController: CreateViewerController = (options) =>
  new PdfViewerController(options);

class PdfViewerController implements ViewerController {
  private readonly root: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private current: Layer | null = null;
  private openSequence = 0;
  private destroyed = false;
  private invert: boolean;
  private tool: Tool;
  private continuous: boolean;
  /** Set once the PDF.js runtime has loaded. */
  private runtime: PdfjsRuntime | null = null;
  private readonly wheelFlip = new WheelPageFlip();
  private password: string | undefined;
  private passwordTask: {
    task: PDFDocumentLoadingTask;
    update: (password: string) => void;
  } | null = null;
  private findQuery = "";
  private readonly area: AreaSelection;
  /** Set while restoring a saved or rebuilt view, which is not a navigation. */
  private restoring = false;
  private readonly keyboardScope: HTMLElement;

  constructor(private readonly options: CreateViewerControllerOptions) {
    const host = options.host as HTMLElement;
    this.root = document.createElement("div");
    this.root.className = SCOPE_CLASS;
    Object.assign(this.root.style, { position: "absolute", inset: "0", overflow: "hidden" });
    host.appendChild(this.root);
    this.area = new AreaSelection({ notify: options.callbacks.onNotice });
    this.invert = options.invert;
    this.setInvert(options.invert);
    this.tool = options.tool;
    this.setTool(options.tool);
    this.continuous = options.continuous;
    this.setTheme(options.theme);
    this.root.addEventListener("click", this.onClick, true);
    this.root.addEventListener("focusout", this.onFocusOut);
    this.keyboardScope = (options.keyboardScope as HTMLElement | undefined) ?? this.root;
    this.keyboardScope.addEventListener("keydown", this.onKeyDown);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.root);
  }

  async open(bytes: Uint8Array, { view, password }: OpenOptions): Promise<void> {
    const sequence = ++this.openSequence;
    if (password !== undefined) this.password = password;
    // A newer version of the file supersedes a password prompt for an older one.
    void this.passwordTask?.task.destroy();
    this.passwordTask = null;
    const runtime = await loadPdfjsRuntime(this.options.fetchRuntimePart);
    if (this.isStale(sequence)) return;
    this.runtime = runtime;
    // Capture the reader's place before the new document replaces anything.
    const target = view === "current" ? this.currentView() : view;

    let pdfDocument: PDFDocumentProxy;
    try {
      pdfDocument = await this.loadDocument(runtime, bytes);
    } catch (error) {
      if (this.isStale(sequence)) return;
      throw error;
    }
    if (this.isStale(sequence)) {
      void pdfDocument.loadingTask.destroy();
      return;
    }

    const previous = this.current;
    const layer = this.createLayer(runtime, previous !== null);
    layer.document = pdfDocument;
    const pagesInit = once(layer.eventBus, "pagesinit");
    layer.pdfViewer.setDocument(pdfDocument);
    layer.linkService.setDocument(pdfDocument, null);
    await pagesInit;
    if (this.isStale(sequence)) {
      this.destroyLayer(layer);
      return;
    }
    const firstPageDrawn = once(layer.eventBus, "pagerendered");
    this.applyView(layer, target, pdfDocument.numPages);
    const carried = previous && view === "current" ? this.heldPin(previous) : null;
    if (carried) this.pin(layer, carried.page);

    let focus = false;
    if (previous) {
      // Keep showing the old document until the new one has drawn, so a rebuild does not flash.
      await Promise.race([firstPageDrawn, delay(SWAP_TIMEOUT_MS)]);
      if (this.isStale(sequence)) {
        this.destroyLayer(layer);
        return;
      }
      // Keyboard navigation keeps working across rebuilds.
      focus = previous.container.contains(document.activeElement);
      this.destroyLayer(previous);
    } else {
      // Arrow keys work as soon as a document opens, unless the user is typing somewhere.
      focus = !isEditable(document.activeElement);
    }
    layer.container.classList.remove(PENDING_CLASS);
    this.current = layer;
    if (focus) layer.container.focus({ preventScroll: true });
    const callbacks = this.options.callbacks;
    callbacks.onDocument({ pageCount: pdfDocument.numPages });
    callbacks.onPage(this.currentPage(layer));
    callbacks.onScale({
      scaleValue: layer.pdfViewer.currentScaleValue,
      scale: layer.pdfViewer.currentScale,
    });
    // Searching the new version would scroll to its first match and lose the reader's place, so
    // keep the query and let the next search run against the new document.
    if (this.findQuery) {
      callbacks.onFind({ query: this.findQuery, current: 0, total: 0, state: "idle" });
    }
  }

  async submitPassword(password: string): Promise<void> {
    this.password = password;
    this.passwordTask?.update(password);
  }

  setPage(page: number): void {
    const layer = this.current;
    if (!layer || !Number.isFinite(page)) return;
    const target = Math.min(Math.max(1, Math.round(page)), layer.pdfViewer.pagesCount);
    layer.pdfViewer.currentPageNumber = target;
    this.pin(layer, target);
  }

  previousPage(): void {
    if (this.current) this.setPage(this.currentPage(this.current) - 1);
  }

  nextPage(): void {
    if (this.current) this.setPage(this.currentPage(this.current) + 1);
  }

  zoomIn(): void {
    this.current?.pdfViewer.increaseScale();
  }

  zoomOut(): void {
    this.current?.pdfViewer.decreaseScale();
  }

  setScale(scale: ScalePreset | string): void {
    if (this.current) this.current.pdfViewer.currentScaleValue = scale;
  }

  find(query: string, options: { again: boolean; previous: boolean }): void {
    this.findQuery = query;
    const layer = this.current;
    if (!layer) return;
    if (!query) {
      layer.eventBus.dispatch("findbarclose", { source: this });
      this.options.callbacks.onFind({ query, current: 0, total: 0, state: "idle" });
      return;
    }
    this.dispatchFind(layer, query, options);
  }

  setInvert(invert: boolean): void {
    this.invert = invert;
    this.root.classList.toggle(INVERT_CLASS, invert);
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.root.classList.toggle(HAND_CLASS, tool === "hand");
    this.root.classList.toggle(AREA_CLASS, tool === "area");
    this.area.clear();
    // Only the select tool works with a text selection; drop one made in this viewer.
    if (tool !== "select") {
      const selection = window.getSelection();
      if (selection?.anchorNode && this.root.contains(selection.anchorNode)) {
        selection.removeAllRanges();
      }
    }
  }

  /**
   * Switches between all pages in one scroll and one page at a time, keeping the current page.
   * Within that page the view stays where it was when the page's top-left corner is in view.
   */
  setContinuous(continuous: boolean): void {
    this.continuous = continuous;
    const layer = this.current;
    if (!layer || !this.runtime) return;
    const page = this.currentPage(layer);
    const view = this.currentView();
    layer.pdfViewer.scrollMode = scrollModeFor(this.runtime, continuous);
    this.applyView(
      layer,
      view.page === page ? view : { ...view, page, left: null, top: null },
      layer.pdfViewer.pagesCount,
    );
    this.pin(layer, page);
  }

  setTheme(theme: PluginTheme): void {
    const { colors } = theme;
    this.root.style.backgroundColor = colors.surface1;
    // Colors for the area tool's rectangle and Copy bar, which are drawn in the DOM.
    this.root.style.setProperty("--paseo-pdfjs-accent", colors.accent);
    this.root.style.setProperty("--paseo-pdfjs-surface", colors.surface0);
    this.root.style.setProperty("--paseo-pdfjs-hover", colors.surface2);
    this.root.style.setProperty("--paseo-pdfjs-border", colors.border);
    this.root.style.setProperty("--paseo-pdfjs-foreground", colors.foreground);
  }

  focus(): void {
    this.current?.container.focus({ preventScroll: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.openSequence += 1;
    this.resizeObserver.disconnect();
    this.root.removeEventListener("click", this.onClick, true);
    this.root.removeEventListener("focusout", this.onFocusOut);
    this.keyboardScope.removeEventListener("keydown", this.onKeyDown);
    this.area.clear();
    void this.passwordTask?.task.destroy();
    this.passwordTask = null;
    if (this.current) this.destroyLayer(this.current);
    this.current = null;
    this.root.remove();
  }

  private isStale(sequence: number): boolean {
    return this.destroyed || sequence !== this.openSequence;
  }

  private async loadDocument(runtime: PdfjsRuntime, bytes: Uint8Array): Promise<PDFDocumentProxy> {
    const parameters = {
      data: bytes,
      password: this.password,
      // Ask the page, not the worker, for CMaps, fonts, and decoders; see binaryDataFactoryFor.
      useWorkerFetch: false,
      BinaryDataFactory: binaryDataFactoryFor(this.options.fetchBinaryData),
      cMapPacked: true,
      isEvalSupported: false,
      enableXfa: false,
    } as DocumentInitParameters;
    const task = runtime.lib.getDocument(parameters);
    // getDocument already tried a remembered password, so a prompt here means none or a wrong one.
    task.onPassword = (update: (password: string) => void, reason: number) => {
      this.passwordTask = { task, update };
      this.options.callbacks.onPassword(
        reason === runtime.lib.PasswordResponses.INCORRECT_PASSWORD,
      );
    };
    try {
      return await task.promise;
    } finally {
      if (this.passwordTask?.task === task) this.passwordTask = null;
    }
  }

  private createLayer(runtime: PdfjsRuntime, pending: boolean): Layer {
    const container = document.createElement("div");
    container.className = "paseo-pdfjs-container";
    if (pending) container.classList.add(PENDING_CLASS);
    container.tabIndex = 0;
    const viewerElement = document.createElement("div");
    viewerElement.className = "pdfViewer";
    container.appendChild(viewerElement);
    this.root.appendChild(container);

    const { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } = runtime.viewer;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer nofollow",
    });
    const findController = new PDFFindController({ eventBus, linkService });
    const pdfViewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      // Render links and annotations; leave form editing off, since nothing could save it.
      annotationMode: runtime.lib.AnnotationMode.ENABLE,
    });
    // Before the document arrives, so it opens in the right mode.
    pdfViewer.scrollMode = scrollModeFor(runtime, this.continuous);
    linkService.setViewer(pdfViewer);
    const scrollPageIntoView = pdfViewer.scrollPageIntoView.bind(pdfViewer);
    pdfViewer.scrollPageIntoView = (params) => {
      scrollPageIntoView(params);
      if (!this.restoring) this.pin(layer, params.pageNumber);
    };
    const layer: Layer = {
      container,
      eventBus,
      linkService,
      findController,
      pdfViewer,
      document: null,
      location: null,
      pin: null,
    };
    this.listen(layer);
    container.addEventListener("wheel", (event) => this.onWheel(layer, event), { passive: false });
    container.addEventListener("pointerdown", (event) => this.onPointerDown(layer, event));
    return layer;
  }

  private listen(layer: Layer): void {
    const callbacks = this.options.callbacks;
    const isCurrent = () => this.current === layer;
    layer.eventBus.on("updateviewarea", ({ location }: { location: ViewerLocation }) => {
      layer.location = location;
      if (!isCurrent()) return;
      callbacks.onLocation(location);
      callbacks.onPage(this.currentPage(layer));
    });
    layer.eventBus.on(
      "scalechanging",
      ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
        if (!isCurrent()) return;
        // A marked area belongs to the old scale's geometry.
        this.area.clear();
        callbacks.onScale({ scaleValue: presetValue ?? String(scale), scale });
      },
    );
    const reportFind = (
      matchesCount: { current: number; total: number },
      state: FindStatus["state"],
    ) => {
      if (!isCurrent() || !this.findQuery) return;
      callbacks.onFind({
        query: this.findQuery,
        current: matchesCount.current,
        total: matchesCount.total,
        state,
      });
    };
    layer.eventBus.on(
      "updatefindmatchescount",
      ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
        reportFind(matchesCount, matchesCount.total > 0 ? "found" : "pending"),
    );
    layer.eventBus.on(
      "updatefindcontrolstate",
      ({
        state,
        matchesCount,
      }: {
        state: number;
        matchesCount: { current: number; total: number };
      }) => reportFind(matchesCount, FIND_STATES[state] ?? "pending"),
    );
  }

  private dispatchFind(
    layer: Layer,
    query: string,
    options: { again: boolean; previous: boolean },
  ) {
    layer.eventBus.dispatch("find", {
      source: this,
      type: options.again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: options.previous,
      matchDiacritics: false,
    });
  }

  private applyView(layer: Layer, view: SavedView, pageCount: number): void {
    this.restoring = true;
    try {
      this.restoreView(layer, view, pageCount);
    } finally {
      this.restoring = false;
    }
    layer.pin = null;
  }

  private restoreView(layer: Layer, view: SavedView, pageCount: number): void {
    const target = restoreTarget(view, pageCount);
    layer.pdfViewer.currentScaleValue = target.scaleValue;
    if (target.destArray) {
      layer.pdfViewer.scrollPageIntoView({
        pageNumber: target.pageNumber,
        destArray: target.destArray,
        allowNegativeOffset: true,
      });
    } else {
      layer.pdfViewer.currentPageNumber = target.pageNumber;
    }
  }

  /**
   * The current page as Okular decides it: the page the viewer last moved to, until the reader
   * scrolls, and otherwise the visible page whose center is nearest the view's center.
   */
  private currentPage(layer: Layer): number {
    // One page at a time: the page on screen.
    if (!this.continuous) return layer.pdfViewer.currentPageNumber;
    const pin = this.heldPin(layer);
    if (pin) return pin.page;
    layer.pin = null;
    const container = layer.container;
    const frame = container.getBoundingClientRect();
    const view = {
      left: frame.left + container.clientLeft,
      top: frame.top + container.clientTop,
      right: frame.left + container.clientLeft + container.clientWidth,
      bottom: frame.top + container.clientTop + container.clientHeight,
    };
    return (
      pageNearestCenter(visiblePageBoxes(layer.pdfViewer, view), view) ??
      layer.pdfViewer.currentPageNumber
    );
  }

  private heldPin(layer: Layer): PinnedPage | null {
    const { scrollLeft, scrollTop } = layer.container;
    return isPinHeld(layer.pin, { scrollLeft, scrollTop }) ? layer.pin : null;
  }

  /** Records a move the viewer made itself; the scroll position it left behind is the pin. */
  private pin(layer: Layer, page: number): void {
    const { scrollLeft, scrollTop } = layer.container;
    layer.pin = { page, scrollLeft, scrollTop };
    if (layer === this.current) this.options.callbacks.onPage(page);
  }

  private currentView(): SavedView {
    const layer = this.current;
    const preferences = { invert: this.invert, tool: this.tool, continuous: this.continuous };
    if (!layer) return { ...defaultSavedView, ...preferences };
    if (layer.location) return savedViewFromLocation(layer.location, preferences);
    return {
      ...defaultSavedView,
      page: layer.pdfViewer.currentPageNumber,
      scale: layer.pdfViewer.currentScaleValue || "auto",
      ...preferences,
    };
  }

  private destroyLayer(layer: Layer): void {
    if (layer === this.current) this.area.clear();
    layer.pdfViewer.setDocument(null);
    layer.linkService.setDocument(null);
    void layer.document?.loadingTask.destroy();
    layer.document = null;
    layer.container.remove();
  }

  private onResize(): void {
    const viewer = this.current?.pdfViewer;
    if (!viewer?.pdfDocument) return;
    // Presets such as "page-width" depend on the container size; numeric scales do not.
    const scaleValue = viewer.currentScaleValue;
    if (scaleValue && !Number(scaleValue)) viewer.currentScaleValue = scaleValue;
    viewer.update();
  }

  /**
   * Ctrl+wheel zooms around the pointer, as in PDF.js's own viewer. Trackpad pinches arrive as
   * many small pixel deltas and scale smoothly; a mouse wheel notch is one zoom step. One page at
   * a time, the wheel scrolls within the page and turns it at the edge, as in Okular.
   */
  private onWheel(layer: Layer, event: WheelEvent): void {
    if (this.current !== layer || event.deltaY === 0) return;
    if (!(event.ctrlKey || event.metaKey)) {
      if (this.continuous || event.altKey || event.shiftKey) return;
      const edge = pageEdges(layer);
      const flip = this.wheelFlip.push({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ...edge,
      });
      // At the edge nothing is left to scroll; keep the wheel from scrolling anything else.
      if ((event.deltaY > 0 && edge.atBottom) || (event.deltaY < 0 && edge.atTop)) {
        event.preventDefault();
      }
      if (flip) this.turnPage(layer, flip === "next" ? "down" : "up");
      return;
    }
    event.preventDefault();
    const origin = [event.clientX, event.clientY];
    const scaleFactor = Math.exp(-event.deltaY / 100);
    if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(scaleFactor - 1) < 0.05) {
      layer.pdfViewer.updateScale({ drawingDelay: 400, scaleFactor, origin });
    } else if (event.deltaY < 0) {
      layer.pdfViewer.increaseScale({ drawingDelay: 400, steps: 1, origin });
    } else {
      layer.pdfViewer.decreaseScale({ drawingDelay: 400, steps: 1, origin });
    }
  }

  /**
   * Left and Right turn whole pages when the page fits the width, as in Firefox's, Chrome's, and
   * Okular's viewers; zoomed in further, they scroll sideways as usual. The jump is immediate.
   * The keys work anywhere in the panel, so a toolbar button keeping focus after a click does not
   * stop them, except in text fields and open menus, where arrows mean something else.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const layer = this.current;
    if (!layer || event.defaultPrevented) return;
    if (event.key === "Escape" && this.area.active) {
      event.preventDefault();
      this.area.clear();
      return;
    }
    const target = event.target as Element | null;
    const paging = this.continuous ? null : pagingKey(event);
    // Only from the document itself: on a toolbar button, Space presses the button.
    if (paging && target && layer.container.contains(target) && !isEditable(target)) {
      const edge = pageEdges(layer);
      if (paging === "down" ? edge.atBottom : edge.atTop) {
        event.preventDefault();
        this.turnPage(layer, paging);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Text fields use arrows to move the caret; an open menu (the zoom menu) owns the keys.
    if (isEditable(target) || this.keyboardScope.querySelector("[role='menu']")) return;
    if (layer.pdfViewer.isHorizontalScrollbarEnabled) {
      // Sideways scrolling belongs to the document; from the toolbar, nothing scrolls.
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowRight") this.nextPage();
    else this.previousPage();
  };

  /**
   * One page at a time, scrolling past an edge turns the page, as in Okular: down shows the top
   * of the next page, up the bottom of the previous one.
   */
  private turnPage(layer: Layer, direction: "down" | "up"): void {
    const page = layer.pdfViewer.currentPageNumber;
    if (direction === "down") {
      if (page < layer.pdfViewer.pagesCount) this.setPage(page + 1);
      return;
    }
    if (page <= 1) return;
    this.setPage(page - 1);
    layer.container.scrollTop = layer.container.scrollHeight;
  }

  /**
   * When the focused element inside the viewer is removed (the area tool's Copy bar after a copy,
   * or a link in an annotation layer PDF.js discards), focus would fall to the page body and the
   * keys would stop until the next click. Give it back to the document instead.
   */
  private readonly onFocusOut = (event: FocusEvent): void => {
    const lost = event.target as Element | null;
    if (event.relatedTarget) return;
    setTimeout(() => {
      if (this.destroyed || lost?.isConnected) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      this.focus();
    }, 0);
  };

  private onPointerDown(layer: Layer, event: PointerEvent): void {
    if (this.current !== layer) return;
    if (this.tool === "hand") this.startPan(layer, event);
    else if (this.tool === "area") this.area.begin(layer.container, layer.pdfViewer, event);
  }

  /**
   * The hand tool pans by dragging with the mouse. Touch and pen keep the browser's own panning,
   * and links and form controls stay clickable because a drag never starts on them.
   */
  private startPan(layer: Layer, event: PointerEvent): void {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as Element | null)?.closest?.(HAND_IGNORE)) return;
    const container = layer.container;
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: container.scrollLeft,
      top: container.scrollTop,
    };
    // Keeps the browser from starting a text selection, and keeps keyboard scrolling working.
    event.preventDefault();
    container.focus({ preventScroll: true });
    container.setPointerCapture(event.pointerId);
    this.root.classList.add(GRABBING_CLASS);
    const onMove = (move: PointerEvent) => {
      container.scrollLeft = start.left - (move.clientX - start.x);
      container.scrollTop = start.top - (move.clientY - start.y);
    };
    const onEnd = () => {
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onEnd);
      container.removeEventListener("pointercancel", onEnd);
      this.root.classList.remove(GRABBING_CLASS);
    };
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerup", onEnd);
    container.addEventListener("pointercancel", onEnd);
  }

  /** Web links leave through Paseo's opener rather than navigating the app. */
  private readonly onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    // The attribute, not `anchor.href`: the property resolves PDF.js's in-document "#dest" links
    // against the app's own URL, which would make every outline entry look external.
    const href = anchor?.getAttribute("href") ?? "";
    if (!isExternalLink(href)) return;
    event.preventDefault();
    event.stopPropagation();
    this.options.callbacks.openExternal(href);
  };
}

/**
 * The visible pages' drawing areas on screen, in document order. Scans outward from a page PDF.js
 * knows is visible, so the cost follows the number of visible pages, not the document's length.
 */
function visiblePageBoxes(viewer: PDFViewer, view: Box): PageBox[] {
  const boxOf = (page: number): PageBox | null => {
    const div = (viewer.getPageView(page - 1) as { div?: HTMLDivElement } | undefined)?.div;
    if (!div?.isConnected) return null;
    const rect = div.getBoundingClientRect();
    const left = rect.left + div.clientLeft;
    const top = rect.top + div.clientTop;
    return { page, left, top, right: left + div.clientWidth, bottom: top + div.clientHeight };
  };
  const isVisible = (box: PageBox | null): box is PageBox =>
    box !== null &&
    box.bottom > view.top &&
    box.top < view.bottom &&
    box.right > view.left &&
    box.left < view.right;
  const start = Math.min(Math.max(1, viewer.currentPageNumber), viewer.pagesCount);
  const boxes: PageBox[] = [];
  for (let page = start; page >= 1; page -= 1) {
    const box = boxOf(page);
    if (isVisible(box)) boxes.unshift(box);
    else if (page !== start) break;
  }
  for (let page = start + 1; page <= viewer.pagesCount; page += 1) {
    const box = boxOf(page);
    if (!isVisible(box)) break;
    boxes.push(box);
  }
  return boxes;
}

function scrollModeFor(runtime: PdfjsRuntime, continuous: boolean): number {
  const { ScrollMode } = runtime.viewer;
  return continuous ? ScrollMode.VERTICAL : ScrollMode.PAGE;
}

/**
 * Whether the top and bottom of the page on screen are in view. Measured on the drawn page, not
 * the scroll range: PDF.js's page border overflows the view a little even at "Fit page".
 */
function pageEdges(layer: Layer): { atTop: boolean; atBottom: boolean } {
  const viewer = layer.pdfViewer;
  const div = (viewer.getPageView(viewer.currentPageNumber - 1) as { div?: HTMLDivElement })?.div;
  const container = layer.container;
  if (!div) return { atTop: true, atBottom: true };
  const frame = container.getBoundingClientRect();
  const viewTop = frame.top + container.clientTop;
  const pageTop = div.getBoundingClientRect().top + div.clientTop;
  return {
    atTop: pageTop >= viewTop - 1,
    atBottom: pageTop + div.clientHeight <= viewTop + container.clientHeight + 1,
  };
}

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  if ((element as HTMLElement).isContentEditable) return true;
  return element.matches("input, textarea, select");
}

function once(eventBus: EventBus, name: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = () => {
      eventBus.off(name, listener);
      resolve();
    };
    eventBus.on(name, listener);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
