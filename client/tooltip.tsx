import type { PluginTheme } from "@getpaseo/plugin";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Text, View } from "react-native";

// Hover tooltips for the toolbar, modeled on Paseo's own toolbar buttons: they open after 300 ms
// of hovering, sit below the control, take no pointer events, and close when the pointer leaves
// or presses. The plugin UI kit has no tooltip, so the panel draws one.

const OPEN_DELAY_MS = 300;
const GAP = 6;
const EDGE = 4;

interface TooltipContent {
  text: string;
  /** Keys shown as key caps after the text, such as ["←"]. */
  keys?: readonly string[];
}

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TooltipApi {
  show(content: TooltipContent, anchor: View): void;
  hide(): void;
}

const TooltipContext = createContext<TooltipApi | null>(null);

/**
 * Hover handlers and a ref for a control that shows `content` as a tooltip. Spread the handlers on
 * a Pressable (`onHoverIn`, `onHoverOut`, `onPressIn`), or the hover pair on a View's pointer
 * events. Pass `ref` when the control already has one.
 */
export function useTooltip(content: TooltipContent | null, ref?: RefObject<View | null>) {
  const api = useContext(TooltipContext);
  const ownRef = useRef<View>(null);
  const target = ref ?? ownRef;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const onHoverIn = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      const current = contentRef.current;
      if (current && target.current) api?.show(current, target.current);
    }, OPEN_DELAY_MS);
  }, [api, cancel, target]);
  const onHoverOut = useCallback(() => {
    cancel();
    api?.hide();
  }, [api, cancel]);
  useEffect(() => onHoverOut, [onHoverOut]);
  return { ref: target, onHoverIn, onHoverOut, onPressIn: onHoverOut };
}

/** Provides tooltips to the controls inside it and draws the open one over the panel. */
export function TooltipProvider({
  panel,
  theme,
  children,
}: {
  panel: RefObject<View | null>;
  theme: PluginTheme;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<{ content: TooltipContent; anchor: Anchor } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const panelWidth = useRef(0);
  const request = useRef(0);

  const api = useMemo<TooltipApi>(
    () => ({
      show(content, anchorView) {
        const container = panel.current;
        if (!container) return;
        const id = ++request.current;
        anchorView.measureInWindow((x, y, anchorWidth, anchorHeight) => {
          container.measureInWindow((panelX, panelY, measuredWidth) => {
            if (id !== request.current) return;
            panelWidth.current = measuredWidth;
            setWidth(null);
            setOpen({
              content,
              anchor: { x: x - panelX, y: y - panelY, width: anchorWidth, height: anchorHeight },
            });
          });
        });
      },
      hide() {
        request.current += 1;
        setOpen(null);
      },
    }),
    [panel],
  );

  const styles = useMemo(() => tooltipStyles(theme), [theme]);
  let left = -9999;
  if (open && width !== null) {
    const centered = open.anchor.x + open.anchor.width / 2 - width / 2;
    left = Math.min(Math.max(EDGE, centered), Math.max(EDGE, panelWidth.current - width - EDGE));
  }
  return (
    <TooltipContext.Provider value={api}>
      {children}
      {open ? (
        <View
          pointerEvents="none"
          role="tooltip"
          testID="pdfjs-tooltip"
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          style={[
            styles.tooltip,
            {
              left,
              top: open.anchor.y + open.anchor.height + GAP,
              opacity: width === null ? 0 : 1,
            },
          ]}
        >
          <Text style={styles.text}>{open.content.text}</Text>
          {open.content.keys?.map((key) => (
            <View key={key} style={styles.key}>
              <Text style={styles.keyText}>{key}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </TooltipContext.Provider>
  );
}

function tooltipStyles(theme: PluginTheme) {
  return {
    tooltip: {
      position: "absolute" as const,
      zIndex: 30,
      maxWidth: 280,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      shadowColor: "#000",
      shadowOpacity: 0.16,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
    },
    text: { color: theme.colors.foreground, fontSize: 12 },
    key: {
      minWidth: 18,
      paddingHorizontal: 4,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      alignItems: "center" as const,
    },
    keyText: { color: theme.colors.foregroundMuted, fontSize: 12 },
  };
}
