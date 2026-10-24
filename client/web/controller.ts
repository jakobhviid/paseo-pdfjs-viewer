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
import { isExternalLink } from "../links";
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
}

/** How long a rebuilt document may take to draw a page before it is shown anyway. */
const SWAP_TIMEOUT_MS = 2000;
const PENDING_CLASS = "paseo-pdfjs-pending";
const INVERT_CLASS = "paseo-pdfjs-invert";
const HAND_CLASS = "paseo-pdfjs-hand";
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
  private password: string | undefined;
  private passwordTask: { task: PDFDocumentLoadingTask; update: (password: string) => void } | null =
    null;
  private findQuery = "";

  constructor(private readonly options: CreateViewerControllerOptions) {
    const host = options.host as HTMLElement;
    this.root = document.createElement("div");
    this.root.className = SCOPE_CLASS;
    Object.assign(this.root.style, { position: "absolute", inset: "0", overflow: "hidden" });
    host.appendChild(this.root);
    this.invert = options.invert;
    this.setInvert(options.invert);
    this.tool = options.tool;
    this.setTool(options.tool);
    this.setTheme(options.theme);
    this.root.addEventListener("click", this.onClick, true);
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
    // Capture the reader's place before the new document replaces anything.
    const target = view === "current" ? this.currentView() : view;

    let document: PDFDocumentProxy;
    try {
      document = await this.loadDocument(runtime, bytes);
    } catch (error) {
      if (this.isStale(sequence)) return;
      throw error;
    }
    if (this.isStale(sequence)) {
      void document.loadingTask.destroy();
      return;
    }

    const previous = this.current;
    const layer = this.createLayer(runtime, previous !== null);
    layer.document = document;
    const pagesInit = once(layer.eventBus, "pagesinit");
    layer.pdfViewer.setDocument(document);
    layer.linkService.setDocument(document, null);
    await pagesInit;
    if (this.isStale(sequence)) {
      this.destroyLayer(layer);
      return;
    }
    const firstPageDrawn = once(layer.eventBus, "pagerendered");
    this.applyView(layer, target, document.numPages);

    if (previous) {
      // Keep showing the old document until the new one has drawn, so a rebuild does not flash.
      await Promise.race([firstPageDrawn, delay(SWAP_TIMEOUT_MS)]);
      if (this.isStale(sequence)) {
        this.destroyLayer(layer);
        return;
      }
      this.destroyLayer(previous);
    }
    layer.container.classList.remove(PENDING_CLASS);
    this.current = layer;
    const callbacks = this.options.callbacks;
    callbacks.onDocument({ pageCount: document.numPages });
    callbacks.onPage(layer.pdfViewer.currentPageNumber);
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
    const viewer = this.current?.pdfViewer;
    if (!viewer || !Number.isFinite(page)) return;
    viewer.currentPageNumber = Math.min(Math.max(1, Math.round(page)), viewer.pagesCount);
  }

  previousPage(): void {
    this.current?.pdfViewer.previousPage();
  }

  nextPage(): void {
    this.current?.pdfViewer.nextPage();
  }

  zoomIn(): void {
    this.current?.pdfViewer.increaseScale();
  }

  zoomOut(): void {
    this.current?.pdfViewer.decreaseScale();
  }

  setScale(scale: ScalePreset): void {
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
  }

  setTheme(theme: PluginTheme): void {
    this.root.style.backgroundColor = theme.colors.surface1;
  }

  destroy(): void {
    this.destroyed = true;
    this.openSequence += 1;
    this.resizeObserver.disconnect();
    this.root.removeEventListener("click", this.onClick, true);
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
    linkService.setViewer(pdfViewer);
    const layer: Layer = {
      container,
      eventBus,
      linkService,
      findController,
      pdfViewer,
      document: null,
      location: null,
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
      if (isCurrent()) callbacks.onLocation(location);
    });
    layer.eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      if (isCurrent()) callbacks.onPage(pageNumber);
    });
    layer.eventBus.on(
      "scalechanging",
      ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
        if (isCurrent()) callbacks.onScale({ scaleValue: presetValue ?? String(scale), scale });
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
      ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) =>
        reportFind(matchesCount, FIND_STATES[state] ?? "pending"),
    );
  }

  private dispatchFind(layer: Layer, query: string, options: { again: boolean; previous: boolean }) {
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

  private currentView(): SavedView {
    const layer = this.current;
    const preferences = { invert: this.invert, tool: this.tool };
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
   * many small pixel deltas and scale smoothly; a mouse wheel notch is one zoom step.
   */
  private onWheel(layer: Layer, event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey) || this.current !== layer || event.deltaY === 0) return;
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
   * The hand tool pans by dragging with the mouse. Touch and pen keep the browser's own panning,
   * and links and form controls stay clickable because a drag never starts on them.
   */
  private onPointerDown(layer: Layer, event: PointerEvent): void {
    if (this.tool !== "hand" || this.current !== layer) return;
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
