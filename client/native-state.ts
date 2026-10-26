import { byDistance, KEEP } from "./native-layout";
import type { ReloadState } from "./reload-scheduler";

// The iOS panel's decisions about page images, kept free of React Native so they can be tested.

export interface PageImage {
  /** Unique per render, so a page can tell its images apart without comparing data URIs. */
  id: number;
  uri: string;
  revision: string;
  /** Rendered width in pixels. */
  width: number;
  invert: boolean;
}

export interface Viewport {
  first: number;
  last: number;
  current: number;
  /** Width in pixels to render at for the current zoom. */
  width: number;
}

export interface PageRender {
  key: string;
  page: number;
  revision: string;
  width: number;
  invert: boolean;
}

/** Whether `image` can stand for this version at this zoom and color. */
export function isCurrent(
  image: PageImage | undefined,
  revision: string,
  invert: boolean,
  width: number,
): boolean {
  return (
    image !== undefined &&
    image.revision === revision &&
    image.invert === invert &&
    image.width >= width
  );
}

/**
 * Renders the view needs, nearest the current page first. Pages whose render failed wait for a new
 * version of the file or a retry, rather than being asked for again on every move.
 */
export function wantedRenders(
  viewport: Viewport,
  revision: string,
  invert: boolean,
  images: Readonly<Record<number, PageImage>>,
  failed: Readonly<Record<number, unknown>> = {},
): PageRender[] {
  return byDistance(viewport.first, viewport.last, viewport.current)
    .filter((page) => !(page in failed))
    .filter((page) => !isCurrent(images[page], revision, invert, viewport.width))
    .map((page) => ({
      key: `${revision}:${page}:${viewport.width}:${invert}`,
      page,
      revision,
      width: viewport.width,
      invert,
    }));
}

/**
 * Adds a finished render. A sharper image of the same version and color stays; anything else is
 * replaced, so a rebuild or a color change always shows.
 */
export function withImage(
  images: Readonly<Record<number, PageImage>>,
  page: number,
  image: PageImage,
): Readonly<Record<number, PageImage>> {
  const existing = images[page];
  const sharper =
    existing !== undefined &&
    existing.revision === image.revision &&
    existing.invert === image.invert &&
    existing.width > image.width;
  return sharper ? images : { ...images, [page]: image };
}

/** Pages whose images are kept around the view: the visible ones and KEEP on each side. */
export function keptRange(viewport: Viewport, pageCount: number): { low: number; high: number } {
  return {
    low: Math.max(0, viewport.first - KEEP),
    high: Math.min(pageCount - 1, viewport.last + KEEP),
  };
}

/** Drops images outside the kept range; returns `images` itself when nothing is dropped. */
export function prunedImages(
  images: Readonly<Record<number, PageImage>>,
  range: { low: number; high: number },
): Readonly<Record<number, PageImage>> {
  const pages = Object.keys(images).map(Number);
  if (pages.every((page) => page >= range.low && page <= range.high)) return images;
  const kept: Record<number, PageImage> = {};
  for (const page of pages) if (page >= range.low && page <= range.high) kept[page] = images[page];
  return kept;
}

export function statusMessage({
  loaded,
  reload,
  deleted,
}: {
  loaded: boolean;
  reload: { state: ReloadState; error: string | null };
  deleted: boolean;
}): { text: string; danger: boolean; retry: boolean } | null {
  if (deleted) {
    return { text: "The file was deleted. Showing the last version.", danger: false, retry: false };
  }
  if (!loaded) return null;
  if (reload.state === "failed") {
    return { text: "Couldn't load the latest version.", danger: true, retry: true };
  }
  if (reload.state === "waiting" && reload.error) {
    return { text: "Couldn't load the latest version yet. Retrying…", danger: false, retry: false };
  }
  return null;
}

/** The innermost components of a React component stack, innermost first. */
export function summarizeStack(stack: string, count = 6): string {
  return stack
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^in\s+/, "")
        .replace(/^at\s+/, ""),
    )
    .map((line) => line.split(/\s+\(/)[0])
    .filter((line) => line.length > 0)
    .slice(0, count)
    .join(" ‹ ");
}
