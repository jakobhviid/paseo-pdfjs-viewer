import type { PluginRpcContract, PluginTheme } from "@getpaseo/plugin";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
import type { binaryData, runtimePart } from "../shared/rpc";
import type { SavedView, ScalePreset, Tool, ViewerLocation } from "./view-state";

// The contract between the cross-platform panel and the web-only viewer in client/web/. Keep it
// free of DOM types: the panel is type-checked without the DOM library.

/** The function `useRpc(contract)` returns. */
type RpcCall<Contract> =
  Contract extends PluginRpcContract<infer Input extends ZodType, infer Output extends ZodType>
    ? (input: ZodInput<Input>) => Promise<ZodOutput<Output>>
    : never;

export type FetchRuntimePart = RpcCall<typeof runtimePart>;
export type FetchBinaryData = RpcCall<typeof binaryData>;

export interface FindStatus {
  query: string;
  /** 1-based index of the selected match, 0 when there is none. */
  current: number;
  total: number;
  state: "idle" | "pending" | "found" | "not-found" | "wrapped";
}

export interface ViewerCallbacks {
  onDocument(info: { pageCount: number }): void;
  onPage(page: number): void;
  onScale(info: { scaleValue: string; scale: number }): void;
  onLocation(location: ViewerLocation): void;
  onFind(status: FindStatus): void;
  /** The document needs a password; `incorrect` is true after a wrong one. */
  onPassword(incorrect: boolean): void;
  /** A short message for the user, such as "Copied image." */
  onNotice(message: string, tone: "info" | "error"): void;
  openExternal(url: string): void;
}

export interface OpenOptions {
  /** Where to show the document: a saved view, or "current" to keep the reader's place. */
  view: SavedView | "current";
  password?: string;
}

export interface ViewerController {
  /** Parses the bytes and swaps the new document in once its first page is drawn. */
  open(bytes: Uint8Array, options: OpenOptions): Promise<void>;
  /** Retries the open that asked for a password. */
  submitPassword(password: string): Promise<void>;
  setPage(page: number): void;
  previousPage(): void;
  nextPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** A preset or a numeric scale such as "1.25". */
  setScale(scale: ScalePreset | string): void;
  find(query: string, options: { again: boolean; previous: boolean }): void;
  setInvert(invert: boolean): void;
  setTool(tool: Tool): void;
  /** All pages in one scroll, or one page at a time. */
  setContinuous(continuous: boolean): void;
  setTheme(theme: PluginTheme): void;
  /** Moves keyboard focus to the document, so arrow keys reach it. */
  focus(): void;
  destroy(): void;
}

export interface CreateViewerControllerOptions {
  /** The element to mount into: on web, a React Native `View` ref is its DOM element. */
  host: unknown;
  /**
   * Where page keys work: the whole panel, toolbar included, as in Firefox's and Okular's viewers.
   * On web, a React Native `View` ref is its DOM element. Defaults to the document itself.
   */
  keyboardScope?: unknown;
  theme: PluginTheme;
  invert: boolean;
  tool: Tool;
  continuous: boolean;
  fetchRuntimePart: FetchRuntimePart;
  fetchBinaryData: FetchBinaryData;
  callbacks: ViewerCallbacks;
}

export type CreateViewerController = (options: CreateViewerControllerOptions) => ViewerController;

export class PasswordRequiredError extends Error {
  constructor() {
    super("The PDF is password-protected.");
    this.name = "PasswordRequiredError";
  }
}
