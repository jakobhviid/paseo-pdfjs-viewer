import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PdfPanel } from "./client/panel";
import { releaseRuntime } from "./client/runtime-release";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addFilePanel({
    id: "pdfjs",
    title: "PDF.js",
    icon: "FileText",
    files: { extensions: ["pdf"] },
    Component: PdfPanel,
  });
  return () => {
    removePanel();
    releaseRuntime();
  };
}
