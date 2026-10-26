import { type PluginFilePanelProps, useRpc, useTabState } from "@getpaseo/plugin/client";
import { Icon, Loading } from "@getpaseo/plugin/client/ui";
import {
  Component,
  type ErrorInfo,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Image,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { nativeOpen, nativePage } from "../shared/rpc";
import {
  type Anchor,
  anchorAt,
  currentPage,
  layoutPages,
  MAX_ZOOM,
  offsetOf,
  type PageLayout,
  type PageSize,
  renderWidth,
  visibleRange,
} from "./native-layout";
import {
  keptRange,
  type PageImage,
  type PageRender,
  prunedImages,
  statusMessage,
  summarizeStack,
  type Viewport,
  wantedRenders,
  withImage,
} from "./native-state";
import { createReloadScheduler, type ReloadScheduler, type ReloadState } from "./reload-scheduler";
import { createRenderQueue } from "./render-queue";
import { throttle } from "./throttle";
import { defaultSavedView, savedViewSchema } from "./view-state";

const SAVE_VIEW_MS = 500;
/** Page renders in flight at once; the daemon renders one at a time and encodes the other. */
const RENDER_CONCURRENCY = 2;
/** Automatic recoveries from a render error before the panel waits for the user instead. */
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 10_000;

interface OpenedDocument {
  revision: string;
  pages: PageSize[];
}

/**
 * iOS: the daemon renders pages with PDFium and this panel shows them as images in a zoomable
 * scroll view. Only pages near the view are rendered. A rebuild re-renders them in place and keeps
 * the reader's page and position on it; each page shows its previous image until the new one loads.
 */
export function NativePdfPanel(props: PluginFilePanelProps) {
  const { theme } = props;
  const [mount, setMount] = useState(0);
  const [failure, setFailure] = useState<{
    message: string;
    stack: string;
    recovered: boolean;
  } | null>(null);
  const recoveries = useRef<number[]>([]);

  // A render error remounts the reader, which reopens on the saved page, a few times in a row at
  // most. The banner keeps what failed and where, so a screenshot identifies the component.
  const onError = useCallback((message: string, stack: string) => {
    const now = Date.now();
    recoveries.current = recoveries.current.filter((time) => now - time < RECOVERY_WINDOW_MS);
    const recovered = recoveries.current.length < MAX_RECOVERIES;
    if (recovered) recoveries.current.push(now);
    setFailure({ message, stack: summarizeStack(stack), recovered });
    if (recovered) setMount((value) => value + 1);
  }, []);
  const reopen = useCallback(() => {
    recoveries.current = [];
    setFailure(null);
    setMount((value) => value + 1);
  }, []);
  const styles = useMemo(() => panelStyles(theme, true), [theme]);

  return (
    <View style={styles.panel}>
      {failure ? (
        <View style={styles.banner} testID="pdfjs-native-failure">
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={failure.recovered ? styles.bannerText : styles.bannerDanger}>
              {failure.recovered ? "The viewer hit an error and reopened: " : "The viewer failed: "}
              {failure.message}
            </Text>
            {failure.stack ? <Text style={styles.stackText}>{failure.stack}</Text> : null}
          </View>
          <TextButton
            theme={theme}
            label={failure.recovered ? "Dismiss" : "Reopen"}
            onPress={failure.recovered ? () => setFailure(null) : reopen}
          />
        </View>
      ) : null}
      <ReaderBoundary resetKey={mount} onError={onError}>
        <NativeReader key={mount} {...props} />
      </ReaderBoundary>
    </View>
  );
}

class ReaderBoundary extends Component<
  { resetKey: number; onError(message: string, stack: string): void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn("[pdfjs-viewer] Native reader failed", error, info.componentStack);
    this.props.onError(messageOf(error), info.componentStack ?? "");
  }

  componentDidUpdate(previous: { resetKey: number }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function NativeReader({ file, tab, theme, layout }: PluginFilePanelProps) {
  const open = useRpc(nativeOpen);
  const render = useRpc(nativePage);
  const [saved, setSaved] = useTabState(tab, savedViewSchema, defaultSavedView);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const [pdf, setPdf] = useState<OpenedDocument | null>(null);
  const pdfRef = useRef(pdf);
  pdfRef.current = pdf;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [images, setImages] = useState<Readonly<Record<number, PageImage>>>({});
  const [pageErrors, setPageErrors] = useState<Record<number, string>>({});
  const [reload, setReload] = useState<{ state: ReloadState; error: string | null }>({
    state: "loading",
    error: null,
  });
  const [password, setPassword] = useState<{ incorrect: boolean } | null>(null);
  const passwordRef = useRef<string | undefined>(undefined);
  const [deleted, setDeleted] = useState(false);

  const scroll = useRef<ScrollView>(null);
  const position = useRef({ x: 0, y: 0, zoom: 1 });
  /** The scroll content's height as last laid out, unzoomed. */
  const contentHeight = useRef(0);
  // Where to put the view once the layout it refers to is on screen: the saved page at first,
  // then the reader's place whenever a rebuild or a resize moves the pages.
  const pendingAnchor = useRef<Anchor | null>({
    page: Math.max(0, saved.page - 1),
    fraction: 0,
  });
  const reloads = useRef<ReloadScheduler | null>(null);
  const imageIds = useRef(0);
  const renderRef = useRef(render);
  renderRef.current = render;

  const pageLayout = useMemo(
    () => (pdf && size.width > 0 ? layoutPages(pdf.pages, size.width) : null),
    [pdf, size.width],
  );
  const layoutRef = useRef<PageLayout | null>(pageLayout);
  layoutRef.current = pageLayout;
  const invert = saved.invert;
  const invertRef = useRef(invert);
  invertRef.current = invert;

  const saveView = useMemo(
    () =>
      throttle((page: number) => {
        // Native keeps the page only. The web viewer's point position belongs to its page, so it
        // is cleared only when the page changes.
        if (savedRef.current.page === page + 1) return;
        setSaved({ ...savedRef.current, page: page + 1, left: null, top: null });
      }, SAVE_VIEW_MS),
    [setSaved],
  );

  const updateViewport = useCallback(() => {
    const current = layoutRef.current;
    if (!current || size.height === 0) return;
    const { y, zoom } = position.current;
    const top = y / zoom;
    const bottom = top + size.height / zoom;
    const range = visibleRange(current.boxes, top, bottom);
    if (!range) return;
    const next: Viewport = {
      ...range,
      current: currentPage(current.boxes, top, size.height / zoom),
      width: renderWidth(size.width, PixelRatio.get(), zoom),
    };
    setViewport((previous) =>
      previous &&
      previous.first === next.first &&
      previous.last === next.last &&
      previous.current === next.current &&
      previous.width === next.width
        ? previous
        : next,
    );
  }, [size.height, size.width]);

  const applyAnchor = useCallback(() => {
    const anchor = pendingAnchor.current;
    const current = layoutRef.current;
    if (!anchor || !current) return;
    pendingAnchor.current = null;
    const { x, zoom } = position.current;
    const y = offsetOf(current, anchor) * zoom;
    position.current = { ...position.current, y };
    scroll.current?.scrollTo({ x, y, animated: false });
    updateViewport();
  }, [updateViewport]);

  // Open the file, and again whenever it changes on disk.
  useEffect(() => {
    const scheduler = createReloadScheduler({
      run: async () => {
        const result = await open({ path: file.path, password: passwordRef.current });
        if (result.status === "password") {
          setPassword({ incorrect: result.incorrect });
          return;
        }
        setPassword(null);
        if (result.revision === pdfRef.current?.revision) return;
        const current = layoutRef.current;
        if (current && !pendingAnchor.current) {
          pendingAnchor.current = anchorAt(
            current.boxes,
            position.current.y / position.current.zoom,
          );
        }
        setPageErrors({});
        setPdf({ revision: result.revision, pages: result.pages });
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
      reloads.current = null;
    };
  }, [file, open]);

  useEffect(() => () => saveView.flush(), [saveView]);

  // A new layout (a rebuild, or a new width) moves the pages; put the reader back on theirs. A
  // scroll before the content has its new height would be clamped, so a layout that changes the
  // height waits for onContentSizeChange.
  useEffect(() => {
    if (pageLayout && Math.abs(contentHeight.current - pageLayout.height) < 1) applyAnchor();
    updateViewport();
  }, [pageLayout, applyAnchor, updateViewport]);

  // React Native reports the content container's layout, which zooming does not change.
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeight.current = height;
      applyAnchor();
    },
    [applyAnchor],
  );

  const shownPage = viewport?.current;
  useEffect(() => {
    if (shownPage !== undefined) saveView(shownPage);
  }, [shownPage, saveView]);

  // Renders run through one queue: the pages the view wants, nearest first, two at a time.
  const queue = useMemo(
    () =>
      createRenderQueue<PageRender>({
        concurrency: RENDER_CONCURRENCY,
        run: async (job) => {
          try {
            const result = await renderRef.current({
              path: file.path,
              password: passwordRef.current,
              revision: job.revision,
              page: job.page,
              width: job.width,
              invert: job.invert,
            });
            if (result.status === "stale") {
              reloads.current?.request(true);
              return;
            }
            if (pdfRef.current?.revision !== job.revision || invertRef.current !== job.invert)
              return;
            imageIds.current += 1;
            const image: PageImage = {
              id: imageIds.current,
              uri: `data:image/png;base64,${result.base64}`,
              revision: job.revision,
              width: result.width,
              invert: job.invert,
            };
            setImages((previous) => withImage(previous, job.page, image));
            setPageErrors((previous) => {
              if (!(job.page in previous)) return previous;
              const { [job.page]: _, ...rest } = previous;
              return rest;
            });
          } catch (error) {
            setPageErrors((previous) => ({ ...previous, [job.page]: messageOf(error) }));
          }
        },
      }),
    [file],
  );
  useEffect(() => () => queue.dispose(), [queue]);

  // Each move of the view, and each image that arrives, restates what the view still needs.
  useEffect(() => {
    queue.want(
      pdf && viewport ? wantedRenders(viewport, pdf.revision, invert, images, pageErrors) : [],
    );
  }, [queue, pdf, viewport, invert, images, pageErrors]);

  // Drop images far from the view; they render again when the reader comes back.
  useEffect(() => {
    if (!viewport || !pdf) return;
    const range = keptRange(viewport, pdf.pages.length);
    setImages((previous) => prunedImages(previous, range));
  }, [viewport, pdf]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => {
      if (previous.width === width && previous.height === height) return previous;
      const current = layoutRef.current;
      if (current && previous.width !== width && !pendingAnchor.current) {
        pendingAnchor.current = anchorAt(current.boxes, position.current.y / position.current.zoom);
      }
      return { width, height };
    });
  }, []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, zoomScale } = event.nativeEvent;
      position.current = { x: contentOffset.x, y: contentOffset.y, zoom: zoomScale || 1 };
      updateViewport();
    },
    [updateViewport],
  );

  const goToPage = useCallback((page: number) => {
    const current = layoutRef.current;
    if (!current) return;
    const index = Math.min(Math.max(0, page), current.boxes.length - 1);
    const { x, zoom } = position.current;
    scroll.current?.scrollTo({ x, y: current.boxes[index].top * zoom, animated: true });
  }, []);

  const onInvert = useCallback(() => {
    setSaved({ ...savedRef.current, invert: !savedRef.current.invert });
  }, [setSaved]);
  const retry = useCallback(() => reloads.current?.request(true), []);
  const retryPage = useCallback((page: number) => {
    setPageErrors((previous) => {
      const { [page]: _, ...rest } = previous;
      return rest;
    });
  }, []);
  const submitPassword = useCallback((value: string) => {
    passwordRef.current = value;
    reloads.current?.request(true);
  }, []);

  const styles = useMemo(() => panelStyles(theme, layout.compact), [theme, layout.compact]);
  const loaded = pdf !== null;
  const pageCount = pdf?.pages.length ?? 0;
  const page = viewport?.current ?? 0;
  const status = statusMessage({ loaded, reload, deleted });

  const pages: ReactNode[] = [];
  if (pageLayout && viewport) {
    const { low, high } = keptRange(viewport, pageLayout.boxes.length);
    for (let index = low; index <= high; index += 1) {
      const box = pageLayout.boxes[index];
      pages.push(
        <PageView
          key={index}
          top={box.top}
          width={size.width}
          height={box.height}
          image={images[index] ?? null}
          page={index}
          error={pageErrors[index] ?? null}
          onRetry={retryPage}
          placeholder={theme.colors.surface2}
          errorColor={theme.colors.statusDanger}
        />,
      );
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.bar} testID="pdfjs-native-toolbar">
        <ToolbarButton
          theme={theme}
          icon="ChevronLeft"
          label="Previous page"
          disabled={!loaded || page <= 0}
          onPress={() => goToPage(page - 1)}
        />
        <Text style={styles.pageLabel}>{loaded ? `${page + 1} / ${pageCount}` : "–"}</Text>
        <ToolbarButton
          theme={theme}
          icon="ChevronRight"
          label="Next page"
          disabled={!loaded || page >= pageCount - 1}
          onPress={() => goToPage(page + 1)}
        />
        <View style={styles.spacer} />
        {loaded && reload.state === "loading" ? <Text style={styles.muted}>Updating…</Text> : null}
        <ToolbarButton
          theme={theme}
          icon={invert ? "Sun" : "Moon"}
          label={invert ? "Show original colors" : "Invert page colors"}
          selected={invert}
          onPress={onInvert}
        />
      </View>
      {status ? (
        <View style={styles.banner} testID="pdfjs-status">
          <Text style={status.danger ? styles.bannerDanger : styles.bannerText}>{status.text}</Text>
          {status.retry ? <TextButton theme={theme} label="Retry" onPress={retry} /> : null}
        </View>
      ) : null}
      <View style={styles.body} onLayout={onLayout}>
        {size.width > 0 ? (
          <ScrollView
            ref={scroll}
            style={StyleSheet.absoluteFill}
            contentContainerStyle={{ width: size.width, height: pageLayout?.height ?? 0 }}
            minimumZoomScale={1}
            maximumZoomScale={MAX_ZOOM}
            bouncesZoom
            scrollEventThrottle={32}
            onScroll={onScroll}
            onContentSizeChange={onContentSizeChange}
            testID="pdfjs-native-pages"
          >
            {pages}
          </ScrollView>
        ) : null}
        {!loaded && reload.state === "failed" ? (
          <CenteredMessage theme={theme} testID="pdfjs-error">
            <Text style={styles.errorText}>Couldn't open this PDF.</Text>
            {reload.error ? <Text style={styles.messageMuted}>{reload.error}</Text> : null}
            <TextButton theme={theme} label="Retry" onPress={retry} />
          </CenteredMessage>
        ) : null}
        {!loaded && reload.state !== "failed" && !password ? <Loading /> : null}
        {password ? (
          <PasswordPrompt theme={theme} incorrect={password.incorrect} onSubmit={submitPassword} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * One page. A new image is laid over the shown one and replaces it once it has loaded, so a
 * rebuild or a sharper render never flashes the placeholder.
 */
const PageView = memo(function PageView({
  top,
  width,
  height,
  page,
  image,
  error,
  onRetry,
  placeholder,
  errorColor,
}: {
  top: number;
  width: number;
  height: number;
  page: number;
  image: PageImage | null;
  error: string | null;
  onRetry(page: number): void;
  placeholder: string;
  errorColor: string;
}) {
  const [shown, setShown] = useState<PageImage | null>(null);
  const fill = { position: "absolute" as const, left: 0, top: 0, width, height };
  // Keyed by image, so the incoming layer becomes the shown one without remounting or reloading.
  const layers = [shown, image].filter(
    (layer, index, all): layer is PageImage =>
      layer !== null && all.findIndex((other) => other?.id === layer.id) === index,
  );
  return (
    <View
      style={{ position: "absolute", left: 0, top, width, height, backgroundColor: placeholder }}
    >
      {layers.map((layer) => (
        <PageLayer
          key={layer.id}
          uri={layer.uri}
          style={fill}
          onLoad={layer === shown ? undefined : () => setShown(layer)}
        />
      ))}
      {error ? (
        // Over an older image, a strip at the page's top; on an empty page, centered.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Page ${page + 1} could not be shown. Retry`}
          onPress={() => onRetry(page)}
          style={
            shown
              ? {
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width,
                  padding: 8,
                  backgroundColor: placeholder,
                }
              : [fill, { alignItems: "center", justifyContent: "center", padding: 16 }]
          }
        >
          <Text style={{ color: errorColor, textAlign: "center" }}>
            {shown ? "Couldn't show the latest version of this page." : error} Tap to retry.
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function PageLayer({
  uri,
  style,
  onLoad,
}: {
  uri: string;
  style: { position: "absolute"; left: number; top: number; width: number; height: number };
  onLoad?: () => void;
}) {
  const source = useMemo(() => ({ uri }), [uri]);
  return <Image source={source} style={style} resizeMode="stretch" onLoad={onLoad} />;
}

function ToolbarButton({
  theme,
  icon,
  label,
  disabled,
  selected,
  onPress,
}: {
  theme: PluginFilePanelProps["theme"];
  icon: string;
  label: string;
  disabled?: boolean;
  selected?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        padding: 8,
        borderRadius: 8,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: selected || pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={20} color={theme.colors.foreground} />
    </Pressable>
  );
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
  const styles = useMemo(() => panelStyles(theme, true), [theme]);
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
  const styles = useMemo(() => panelStyles(theme, true), [theme]);
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
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={{ paddingVertical: 6 }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

function panelStyles(theme: PluginFilePanelProps["theme"], compact: boolean) {
  return {
    panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface1 },
    bar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      paddingHorizontal: compact ? 6 : 10,
      paddingVertical: 2,
      backgroundColor: theme.colors.surface0,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    pageLabel: {
      minWidth: 64,
      textAlign: "center" as const,
      color: theme.colors.foreground,
      fontSize: 15,
      fontVariant: ["tabular-nums" as const],
    },
    spacer: { flex: 1 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
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
    stackText: { color: theme.colors.foregroundMuted, fontSize: 11 },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: 24,
      backgroundColor: theme.colors.surface1,
    },
    card: { maxWidth: 420, gap: 10, alignItems: "center" as const },
    message: { color: theme.colors.foreground, textAlign: "center" as const },
    messageMuted: {
      color: theme.colors.foregroundMuted,
      textAlign: "center" as const,
      fontSize: 13,
    },
    errorText: { color: theme.colors.statusDanger, textAlign: "center" as const },
    passwordInput: {
      width: 240,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 16,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
