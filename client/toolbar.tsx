import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { findStatusLabel } from "./find-label";
import type { Tool } from "./view-state";
import type { FindStatus } from "./viewer-types";

export interface ToolbarProps {
  theme: PluginTheme;
  compact: boolean;
  disabled: boolean;
  page: number;
  pageCount: number;
  onPage(page: number): void;
  onPreviousPage(): void;
  onNextPage(): void;
  scaleLabel: string;
  onZoomIn(): void;
  onZoomOut(): void;
  onFitWidth(): void;
  onFitPage(): void;
  findQuery: string;
  find: FindStatus;
  onFindQuery(query: string): void;
  onFind(previous: boolean): void;
  invert: boolean;
  onInvert(): void;
  tool: Tool;
  onTool(tool: Tool): void;
}

export function Toolbar(props: ToolbarProps) {
  const { theme, disabled } = props;
  const styles = useMemo(() => toolbarStyles(theme), [theme]);
  const [pageText, setPageText] = useState(String(props.page));
  useEffect(() => setPageText(String(props.page)), [props.page]);
  const submitPage = () => {
    const page = Number.parseInt(pageText, 10);
    if (Number.isFinite(page)) props.onPage(page);
    else setPageText(String(props.page));
  };

  return (
    <View style={styles.bar} testID="pdfjs-toolbar">
      <View style={styles.group}>
        <IconButton theme={theme} icon="ChevronLeft" label="Previous page" disabled={disabled || props.page <= 1} onPress={props.onPreviousPage} />
        <TextInput
          style={[styles.input, styles.pageInput]}
          value={pageText}
          onChangeText={setPageText}
          onSubmitEditing={submitPage}
          onBlur={submitPage}
          editable={!disabled}
          inputMode="numeric"
          selectTextOnFocus
          accessibilityLabel="Page number"
          testID="pdfjs-page-input"
        />
        <Text style={styles.muted} testID="pdfjs-page-count">
          / {props.pageCount || "–"}
        </Text>
        <IconButton theme={theme} icon="ChevronRight" label="Next page" disabled={disabled || props.page >= props.pageCount} onPress={props.onNextPage} />
      </View>
      <View style={styles.group}>
        <IconButton theme={theme} icon="ZoomOut" label="Zoom out" disabled={disabled} onPress={props.onZoomOut} />
        <Text style={[styles.label, styles.scale]} testID="pdfjs-scale">
          {props.scaleLabel}
        </Text>
        <IconButton theme={theme} icon="ZoomIn" label="Zoom in" disabled={disabled} onPress={props.onZoomIn} />
        {props.compact ? null : (
          <>
            <IconButton theme={theme} icon="MoveHorizontal" label="Fit width" disabled={disabled} onPress={props.onFitWidth} />
            <IconButton theme={theme} icon="Maximize" label="Fit page" disabled={disabled} onPress={props.onFitPage} />
          </>
        )}
      </View>
      {props.compact ? null : (
        // Touch screens pan natively, so the switch is for mouse and trackpad users.
        <View style={styles.group}>
          <IconButton theme={theme} icon="TextCursor" label="Select text" selected={props.tool === "select"} disabled={disabled} onPress={() => props.onTool("select")} />
          <IconButton theme={theme} icon="Hand" label="Hand tool" selected={props.tool === "hand"} disabled={disabled} onPress={() => props.onTool("hand")} />
          <IconButton theme={theme} icon="SquareDashedMousePointer" label="Select area" selected={props.tool === "area"} disabled={disabled} onPress={() => props.onTool("area")} />
        </View>
      )}
      <View style={[styles.group, styles.findGroup]}>
        <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          style={[styles.input, styles.findInput]}
          value={props.findQuery}
          onChangeText={props.onFindQuery}
          onSubmitEditing={() => props.onFind(false)}
          editable={!disabled}
          placeholder="Find"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Find in document"
          testID="pdfjs-find-input"
          // Keep focus after Enter so repeated Enter steps through matches.
          blurOnSubmit={false}
        />
        <Text style={styles.muted} testID="pdfjs-find-status">
          {findStatusLabel(props.find, props.findQuery)}
        </Text>
        <IconButton theme={theme} icon="ChevronUp" label="Previous match" disabled={disabled || !props.findQuery} onPress={() => props.onFind(true)} />
        <IconButton theme={theme} icon="ChevronDown" label="Next match" disabled={disabled || !props.findQuery} onPress={() => props.onFind(false)} />
      </View>
      <IconButton theme={theme} icon="Contrast" label={props.invert ? "Show original colors" : "Invert colors"} selected={props.invert} disabled={disabled} onPress={props.onInvert} />
    </View>
  );
}

interface IconButtonProps {
  theme: PluginTheme;
  icon: string;
  label: string;
  disabled?: boolean;
  selected?: boolean;
  onPress(): void;
}

export function IconButton({ theme, icon, label, disabled, selected, onPress }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        padding: 6,
        borderRadius: 6,
        opacity: disabled ? 0.4 : 1,
        backgroundColor:
          selected || pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
    </Pressable>
  );
}

function toolbarStyles(theme: PluginTheme) {
  return {
    bar: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      columnGap: 12,
      rowGap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: theme.colors.surface0,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    group: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2 },
    findGroup: { flexGrow: 1, justifyContent: "flex-end" as const, gap: 4 },
    input: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 3,
      fontSize: 13,
    },
    pageInput: { width: 48, textAlign: "center" as const },
    findInput: { width: 160 },
    label: { color: theme.colors.foreground, fontSize: 13 },
    scale: { minWidth: 72, textAlign: "center" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
  };
}
