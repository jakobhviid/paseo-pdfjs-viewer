import type { BinaryKind, RuntimePart } from "../shared/rpc";

export interface PdfjsAssets {
  version: string;
  runtime: Readonly<Record<RuntimePart, string>>;
  binary: Readonly<Record<BinaryKind, Readonly<Record<string, string>>>>;
}

export function runtimePartSource(assets: PdfjsAssets, part: RuntimePart) {
  return { version: assets.version, source: assets.runtime[part] };
}

/** Looks the file up by exact name; anything else, including inherited keys, is missing. */
export function binaryDataBase64(assets: PdfjsAssets, kind: BinaryKind, filename: string) {
  const files = assets.binary[kind];
  return { base64: Object.hasOwn(files, filename) ? files[filename] : null };
}
