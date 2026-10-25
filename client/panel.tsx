import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { NativePdfPanel } from "./native-panel";

/**
 * PDF.js needs a browser page, so it runs on web only. iOS has no web view with scripts for
 * plugins, so there the daemon renders pages with PDFium and the panel shows them as images.
 * Android shows a message and never loads either viewer.
 */
export function PdfPanel(props: PluginFilePanelProps) {
  if (props.layout.platform === "ios") return <NativePdfPanel {...props} />;
  if (props.layout.platform !== "web") return <UnsupportedPlatform theme={props.theme} />;
  const { WebPdfPanel } = require("./web-panel") as typeof import("./web-panel");
  return <WebPdfPanel {...props} />;
}

function UnsupportedPlatform({ theme }: { theme: PluginFilePanelProps["theme"] }) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 24,
        backgroundColor: theme.colors.surface0,
      },
      text: { color: theme.colors.foregroundMuted, textAlign: "center" as const },
    }),
    [theme],
  );
  return (
    <View style={styles.screen} testID="pdfjs-unsupported">
      <Text style={styles.text}>
        The PDF viewer works in Paseo on desktop, the web, and iOS. It isn't available in the
        Android app yet.
      </Text>
    </View>
  );
}
