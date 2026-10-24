import type { PluginServerContext } from "@getpaseo/plugin/server";
import { binaryDataBase64, type PdfjsAssets, runtimePartSource } from "./server/assets";
import { binary, pdfjsVersion, runtime } from "./server/generated/pdfjs-assets.js";
import { binaryData, runtimePart } from "./shared/rpc";

const assets: PdfjsAssets = { version: pdfjsVersion, runtime, binary };

export default function contribute(server: PluginServerContext) {
  server.handle(runtimePart, ({ part }) => runtimePartSource(assets, part));
  server.handle(binaryData, ({ kind, filename }) => binaryDataBase64(assets, kind, filename));
  return () => {};
}
