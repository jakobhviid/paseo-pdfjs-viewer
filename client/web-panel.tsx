import {
  openExternalUrl,
  type PluginFilePanelProps,
  useRpc,
  useTabState,
} from "@getpaseo/plugin/client";
import { Loading, useToast } from "@getpaseo/plugin/client/ui";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { binaryData, runtimePart } from "../shared/rpc";
import { createReloadScheduler, type ReloadScheduler, type ReloadState } from "./reload-scheduler";
import { throttle } from "./throttle";
import { Toolbar } from "./toolbar";
import {
  defaultSavedView,
  savedViewFromLocation,
  savedViewSchema,
  scaleLabel,
  type Tool,
  type ViewerLocation,
  zoomMenuItems,
} from "./view-state";
import { ZOOM_MENU_WIDTH, ZoomMenu } from "./zoom-menu";
import type { CreateViewerController, FindStatus, ViewerController } from "./viewer-types";

/**
 * Above this size, ask before reading: the whole file is read into the app, over the relay when
 * the host is remote, and again on every change.
 */
export const LARGE_FILE_BYTES = 64 * 1024 * 1024;
const SAVE_VIEW_MS = 500;

const IDLE_FIND: FindStatus = { query: "", current: 0, total: 0, state: "idle" };

export function WebPdfPanel({ file, tab, theme, layout }: PluginFilePanelProps) {
  const fetchRuntimePart = useRpc(runtimePart);
  const fetchBinaryData = useRpc(binaryData);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [saved, setSaved] = useTabState(tab, savedViewSchema, defaultSavedView);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const panel = useRef<View>(null);
  const panelWidth = useRef(0);
  const host = useRef<View>(null);
  const viewer = useRef<ViewerController | null>(null);
  const reloads = useRef<ReloadScheduler | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState<{ state: ReloadState; error: string | null }>({
    state: "loading",
    error: null,
  });
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(saved.page);
  const [scale, setScale] = useState({ scaleValue: saved.scale, scale: 1 });
  const [find, setFind] = useState<FindStatus>(IDLE_FIND);
  const [findQuery, setFindQuery] = useState("");
  const [password, setPassword] = useState<{ incorrect: boolean } | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [allowLarge, setAllowLarge] = useState(false);
  const [zoomMenu, setZoomMenu] = useState<{ left: number; top: number } | null>(null);
  const tooLarge = file.size > LARGE_FILE_BYTES && !allowLarge;

  useLayoutEffect(() => {
    if (tooLarge) return;
    // Web only: the panel picks this component when layout.platform is "web".
    const { createViewerController } = require("./web/controller") as {
      createViewerController: CreateViewerController;
    };
    // Built when it fires, so the view preferences are the current ones.
    const saveLocation = throttle((location: ViewerLocation) => {
      setSaved(savedViewFromLocation(location, savedRef.current));
    }, SAVE_VIEW_MS);
    const controller = createViewerController({
      host: host.current,
      theme: themeRef.current,
      invert: savedRef.current.invert,
      tool: savedRef.current.tool,
      fetchRuntimePart,
      fetchBinaryData,
      callbacks: {
        onDocument: ({ pageCount: count }) => {
          setPageCount(count);
          setLoaded(true);
          setPassword(null);
        },
        onPage: setPage,
        onScale: setScale,
        onLocation: saveLocation,
        onFind: setFind,
        onPassword: (incorrect) => setPassword({ incorrect }),
        onNotice: (message, tone) => {
          if (tone === "error") toastRef.current.error(message);
          else toastRef.current.show(message);
        },
        openExternal: (url) => {
          void openExternalUrl(url).catch((error: unknown) => {
            console.warn(`Could not open ${url}: ${messageOf(error)}`);
          });
        },
      },
    });
    viewer.current = controller;

    let restored = false;
    const scheduler = createReloadScheduler({
      run: async () => {
        const bytes = await file.readBytes();
        // The first document opens where the tab was left; later versions keep the reader's place.
        await controller.open(bytes, { view: restored ? "current" : savedRef.current });
        restored = true;
      },
      onState: (state, error) =>
        setReload({ state, error: error === undefined ? null : messageOf(error) }),
    });
    reloads.current = scheduler;
    const unwatch = file.watch((event) => {
      if (event.type === "deleted") {
        setDeleted(true);
        return;
      }
      setDeleted(false);
      scheduler.request();
    });
    scheduler.request(true);

    return () => {
      unwatch();
      scheduler.dispose();
      saveLocation.flush();
      controller.destroy();
      viewer.current = null;
      reloads.current = null;
    };
  }, [file, tooLarge, fetchRuntimePart, fetchBinaryData, setSaved]);

  useEffect(() => {
    viewer.current?.setTheme(theme);
  }, [theme]);

  const onFindQuery = useCallback((query: string) => {
    setFindQuery(query);
    if (!query) viewer.current?.find("", { again: false, previous: false });
  }, []);
  const onFind = useCallback(
    (previous: boolean) => {
      if (!findQuery) return;
      // Repeat the search to step through matches; a new query starts at the first one.
      const again = find.query === findQuery && find.state !== "idle";
      viewer.current?.find(findQuery, { again, previous });
    },
    [find, findQuery],
  );
  const onInvert = useCallback(() => {
    const invert = !savedRef.current.invert;
    setSaved({ ...savedRef.current, invert });
    viewer.current?.setInvert(invert);
  }, [setSaved]);
  const onTool = useCallback(
    (tool: Tool) => {
      setSaved({ ...savedRef.current, tool });
      viewer.current?.setTool(tool);
    },
    [setSaved],
  );
  const retry = useCallback(() => reloads.current?.request(true), []);
  const openZoomMenu = useCallback((anchor: View | null) => {
    const container = panel.current;
    if (!anchor || !container) return;
    anchor.measureInWindow((x, y, _width, height) => {
      container.measureInWindow((panelX, panelY) => {
        const maxLeft = Math.max(0, panelWidth.current - ZOOM_MENU_WIDTH - 4);
        setZoomMenu({ left: Math.min(Math.max(0, x - panelX), maxLeft), top: y - panelY + height + 4 });
      });
    });
  }, []);
  const closeZoomMenu = useCallback(() => setZoomMenu(null), []);
  const chooseZoom = useCallback((value: string) => {
    setZoomMenu(null);
    viewer.current?.setScale(value);
    viewer.current?.focus();
  }, []);
  useEscape(zoomMenu !== null, closeZoomMenu);

  const styles = useMemo(() => panelStyles(theme), [theme]);
  const status = statusMessage({ loaded, reload, deleted });

  return (
    <View
      ref={panel}
      style={styles.panel}
      onLayout={(event) => {
        panelWidth.current = event.nativeEvent.layout.width;
      }}
    >
      <Toolbar
        theme={theme}
        compact={layout.compact}
        disabled={!loaded}
        page={page}
        pageCount={pageCount}
        onPage={(next) => viewer.current?.setPage(next)}
        onPreviousPage={() => viewer.current?.previousPage()}
        onNextPage={() => viewer.current?.nextPage()}
        scaleLabel={loaded ? scaleLabel(scale.scaleValue, scale.scale) : "–"}
        zoomMenuOpen={zoomMenu !== null}
        onOpenZoomMenu={openZoomMenu}
        onZoomIn={() => viewer.current?.zoomIn()}
        onZoomOut={() => viewer.current?.zoomOut()}
        onFitWidth={() => viewer.current?.setScale("page-width")}
        onFitPage={() => viewer.current?.setScale("page-fit")}
        findQuery={findQuery}
        find={find}
        onFindQuery={onFindQuery}
        onFind={onFind}
        invert={saved.invert}
        onInvert={onInvert}
        tool={saved.tool}
        onTool={onTool}
      />
      {status ? (
        <View style={styles.banner} testID="pdfjs-status">
          <Text style={status.danger ? styles.bannerDanger : styles.bannerText}>{status.text}</Text>
          {status.retry ? <TextButton theme={theme} label="Retry" onPress={retry} /> : null}
        </View>
      ) : null}
      <View style={styles.body}>
        <View ref={host} style={StyleSheet.absoluteFill} testID="pdfjs-viewer" />
        {tooLarge ? (
          <CenteredMessage theme={theme} testID="pdfjs-too-large">
            <Text style={styles.message}>
              This PDF is {formatBytes(file.size)}. The whole file is read into the app, and again
              each time it changes.
            </Text>
            <TextButton theme={theme} label="Open anyway" onPress={() => setAllowLarge(true)} />
          </CenteredMessage>
        ) : null}
        {!tooLarge && !loaded && reload.state === "failed" ? (
          <CenteredMessage theme={theme} testID="pdfjs-error">
            <Text style={styles.errorText}>Couldn't open this PDF.</Text>
            {reload.error ? <Text style={styles.messageMuted}>{reload.error}</Text> : null}
            <TextButton theme={theme} label="Retry" onPress={retry} />
          </CenteredMessage>
        ) : null}
        {!tooLarge && !loaded && reload.state !== "failed" && !password ? <Loading /> : null}
        {password ? (
          <PasswordPrompt
            theme={theme}
            incorrect={password.incorrect}
            onSubmit={(value) => void viewer.current?.submitPassword(value)}
          />
        ) : null}
      </View>
      {zoomMenu ? (
        <ZoomMenu
          theme={theme}
          items={zoomMenuItems(scale.scaleValue)}
          position={zoomMenu}
          onSelect={chooseZoom}
          onClose={closeZoomMenu}
        />
      ) : null}
    </View>
  );
}

/** Calls `onEscape` when Escape is pressed while `active`. The panel only renders on web. */
function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const target = globalThis as unknown as KeyEventTarget;
    const onKeyDown = (event: { key: string }) => {
      if (event.key === "Escape") onEscape();
    };
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [active, onEscape]);
}

interface KeyEventTarget {
  addEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
  removeEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
}

function statusMessage({
  loaded,
  reload,
  deleted,
}: {
  loaded: boolean;
  reload: { state: ReloadState; error: string | null };
  deleted: boolean;
}): { text: string; danger: boolean; retry: boolean } | null {
  if (deleted) return { text: "The file was deleted. Showing the last version.", danger: false, retry: false };
  if (!loaded) return null;
  if (reload.state === "failed") {
    return { text: "Couldn't load the latest version.", danger: true, retry: true };
  }
  if (reload.state === "waiting" && reload.error) {
    return { text: "Couldn't load the latest version yet. Retrying…", danger: false, retry: false };
  }
  return null;
}

function PasswordPrompt({
  theme,
  incorrect,
  onSubmit,
}: {
  theme: PluginFilePanelProps["theme"];
  incorrect: boolean;
  onSubmit(password: string): void;
}) {
  const styles = useMemo(() => panelStyles(theme), [theme]);
  const [value, setValue] = useState("");
  const submit = () => {
    if (value) onSubmit(value);
  };
  return (
    <CenteredMessage theme={theme} testID="pdfjs-password">
      <Text style={styles.message}>This PDF is password-protected.</Text>
      {incorrect ? <Text style={styles.errorText}>That password is incorrect.</Text> : null}
      <TextInput
        style={styles.passwordInput}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        secureTextEntry
        autoFocus
        placeholder="Password"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="PDF password"
      />
      <TextButton theme={theme} label="Open" onPress={submit} />
    </CenteredMessage>
  );
}

function CenteredMessage({
  theme,
  testID,
  children,
}: {
  theme: PluginFilePanelProps["theme"];
  testID?: string;
  children: ReactNode;
}) {
  const styles = useMemo(() => panelStyles(theme), [theme]);
  return (
    <View style={styles.overlay} testID={testID}>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function TextButton({
  theme,
  label,
  onPress,
}: {
  theme: PluginFilePanelProps["theme"];
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function panelStyles(theme: PluginFilePanelProps["theme"]) {
  return {
    panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface1 },
    body: { flex: 1, minHeight: 0, position: "relative" as const },
    banner: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: theme.colors.surface0,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    bannerText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 13 },
    bannerDanger: { flex: 1, color: theme.colors.statusDanger, fontSize: 13 },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: 24,
      backgroundColor: theme.colors.surface1,
    },
    card: { maxWidth: 420, gap: 8, alignItems: "center" as const },
    message: { color: theme.colors.foreground, textAlign: "center" as const },
    messageMuted: { color: theme.colors.foregroundMuted, textAlign: "center" as const, fontSize: 13 },
    errorText: { color: theme.colors.statusDanger, textAlign: "center" as const },
    passwordInput: {
      width: 240,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
