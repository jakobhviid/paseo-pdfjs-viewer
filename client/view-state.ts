import { z } from "zod";

/** PDF.js scale presets, accepted by `PDFViewer.currentScaleValue` as-is. */
export const SCALE_PRESETS = ["auto", "page-width", "page-fit", "page-actual"] as const;
export type ScalePreset = (typeof SCALE_PRESETS)[number];

/** What dragging does: select text, pan the page (hand), or mark an area to copy. */
export const TOOLS = ["select", "hand", "area"] as const;
export type Tool = (typeof TOOLS)[number];

/**
 * Where the reader is, in the document's own coordinates so it survives rebuilds, window resizes,
 * and reopening the tab. Persisted with `useTabState`.
 */
export const savedViewSchema = z.object({
  page: z.number().int().min(1),
  /** A preset, or a numeric scale such as "1.25". */
  scale: z.string().min(1),
  /** The top-left corner of the view in PDF points on `page`; null means the page's top. */
  left: z.number().nullable(),
  top: z.number().nullable(),
  // Defaults keep tabs saved before a preference existed valid, along with their position.
  invert: z.boolean().default(false),
  tool: z.enum(TOOLS).default("select"),
  /** Okular's Continuous setting: all pages in one scroll, or one page at a time. */
  continuous: z.boolean().default(true),
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const defaultSavedView: SavedView = {
  page: 1,
  scale: "auto",
  left: null,
  top: null,
  invert: false,
  tool: "select",
  continuous: true,
};

/** What PDF.js reports in `updateviewarea`: a percentage for numeric scales, else the preset. */
export interface ViewerLocation {
  pageNumber: number;
  scale: number | string;
  left: number;
  top: number;
}

export function isScalePreset(value: string): value is ScalePreset {
  return (SCALE_PRESETS as readonly string[]).includes(value);
}

export function scaleValueFromLocation(scale: number | string): string {
  if (typeof scale === "number") return String(scale / 100);
  if (isScalePreset(scale)) return scale;
  const numeric = Number(scale);
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric / 100) : "auto";
}

/** View preferences that ride along with the position. */
export type ViewPreferences = Pick<SavedView, "invert" | "tool" | "continuous">;

export function savedViewFromLocation(
  location: ViewerLocation,
  { invert, tool, continuous }: ViewPreferences,
): SavedView {
  return {
    page: Math.max(1, Math.round(location.pageNumber)),
    scale: scaleValueFromLocation(location.scale),
    left: Number.isFinite(location.left) ? Math.round(location.left) : null,
    top: Number.isFinite(location.top) ? Math.round(location.top) : null,
    invert,
    tool,
    continuous,
  };
}

export interface RestoreTarget {
  scaleValue: string;
  pageNumber: number;
  /** A PDF "XYZ" destination keeping the current zoom, or null to show the page's top. */
  destArray: [null, { name: "XYZ" }, number, number, null] | null;
}

export function restoreTarget(view: SavedView, pageCount: number): RestoreTarget {
  const pageNumber = Math.min(Math.max(1, view.page), Math.max(1, pageCount));
  const scaleValue = isScalePreset(view.scale) || Number(view.scale) > 0 ? view.scale : "auto";
  // A saved position belongs to its page; if the page no longer exists, show the last page's top.
  const samePage = pageNumber === view.page;
  const destArray =
    samePage && view.left !== null && view.top !== null
      ? ([null, { name: "XYZ" }, view.left, view.top, null] as RestoreTarget["destArray"])
      : null;
  return { scaleValue, pageNumber, destArray };
}

const PRESET_LABELS: Record<ScalePreset, string> = {
  auto: "Automatic",
  "page-width": "Fit width",
  "page-fit": "Fit page",
  "page-actual": "Actual size",
};

/** The zoom shown in the toolbar: the preset's name, or the effective percentage. */
export function scaleLabel(scaleValue: string, effectiveScale: number): string {
  if (isScalePreset(scaleValue) && scaleValue !== "auto") return PRESET_LABELS[scaleValue];
  return `${Math.round(effectiveScale * 100)}%`;
}

/** Fixed zoom levels in the zoom menu, as in Firefox's and Chrome's PDF viewers. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export interface ZoomMenuItem {
  /** A preset, or a numeric scale such as "1.25", for `PDFViewer.currentScaleValue`. */
  value: string;
  label: string;
  selected: boolean;
  /** Draw a divider above this item. */
  separated: boolean;
}

/** The zoom menu: the four presets, then fixed levels, with the current one checked. */
export function zoomMenuItems(currentScaleValue: string): ZoomMenuItem[] {
  const current = Number(currentScaleValue);
  // Firefox's order.
  const order: ScalePreset[] = ["auto", "page-actual", "page-fit", "page-width"];
  const presets = order.map((value) => ({
    value,
    label: PRESET_LABELS[value],
    selected: value === currentScaleValue,
    separated: false,
  }));
  const levels = ZOOM_LEVELS.map((level, index) => ({
    value: String(level),
    label: `${Math.round(level * 100)}%`,
    selected: Math.abs(current - level) < 1e-6,
    separated: index === 0,
  }));
  return [...presets, ...levels];
}
