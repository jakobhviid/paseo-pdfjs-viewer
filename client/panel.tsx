import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

/**
 * PDF.js needs a browser page. On iOS and Android a plugin has neither a web view with scripts nor
 * a native PDF view, so native shows a message and never loads the web viewer's code.
 */
export function PdfPanel(props: PluginFilePanelProps) {
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
        The PDF.js viewer works in Paseo on desktop and the web. It isn't available in the iOS and
        Android apps yet.
      </Text>
    </View>
  );
}
