import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ZoomMenuItem } from "./view-state";

export const ZOOM_MENU_WIDTH = 168;

/** The zoom levels below the zoom button; a press outside closes it. */
export function ZoomMenu({
  theme,
  items,
  position,
  onSelect,
  onClose,
}: {
  theme: PluginTheme;
  items: readonly ZoomMenuItem[];
  position: { left: number; top: number };
  onSelect(value: string): void;
  onClose(): void;
}) {
  const styles = useMemo(() => menuStyles(theme), [theme]);
  return (
    <>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close zoom menu"
        testID="pdfjs-zoom-menu-backdrop"
      />
      <View
        style={[styles.menu, position]}
        accessibilityRole="menu"
        accessibilityLabel="Zoom"
        testID="pdfjs-zoom-menu"
      >
        {items.map((item) => (
          <View key={item.value}>
            {item.separated ? <View style={styles.separator} /> : null}
            <Pressable
              accessibilityRole="menuitem"
              // React Native Web maps accessibilityState.checked only for checkbox-like roles.
              aria-checked={item.selected}
              onPress={() => onSelect(item.value)}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                styles.item,
                (pressed || hovered) && styles.itemActive,
              ]}
            >
              <View style={styles.check}>
                {item.selected ? (
                  <Icon name="Check" size={14} color={theme.colors.foreground} />
                ) : null}
              </View>
              <Text style={styles.label}>{item.label}</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </>
  );
}

function menuStyles(theme: PluginTheme) {
  return StyleSheet.create({
    menu: {
      position: "absolute",
      zIndex: 20,
      width: ZOOM_MENU_WIDTH,
      paddingVertical: 4,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 8,
      marginHorizontal: 4,
      borderRadius: 5,
    },
    itemActive: { backgroundColor: theme.colors.surface2 },
    check: { width: 16, alignItems: "center" },
    label: { color: theme.colors.foreground, fontSize: 13 },
    separator: {
      height: 1,
      marginVertical: 4,
      backgroundColor: theme.colors.border,
    },
  });
}
