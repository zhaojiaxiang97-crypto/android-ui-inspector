import { useCanvasView, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, ZOOM_PRESETS } from "../features/layers/useCanvasView";
import { useCanvasQuickSelect } from "../features/layers/useCanvasQuickSelect";
import { useCanvasTools } from "../features/layers/useCanvasTools";
import { useCanvasInteraction } from "../features/layers/useCanvasInteraction";
import { useCanvasKeyboard } from "../features/layers/useCanvasKeyboard";
import { useCanvasHover } from "../features/layers/useCanvasHover";
import { AppIcon } from "./AppIcon";
import { workbenchCommands } from "../../shared/workbench-commands";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { CaptureGeometry, LayerFocus, LayerMenuAction, PixelSize, QmlGroupImage, SnapshotGroupImage, TreeDoubleClickAction, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, validSize, validBounds, clipBounds } from "../../shared/screen-coordinates";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import { constrainOrbitCamera } from "../../shared/orbit-camera";
import { Layer3DPreview } from "../features/layers/Layer3DPreview";
import { type LayerSceneHandle } from "../features/layers/types";
import { usePreviewViewport } from "../features/layers/usePreviewViewport";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY, parseLayerAppearance, type LayerAppearance, type LayerDisplayMode } from "../features/layers/appearance";
import { measurementRecords, useLayerMeasurement } from "../features/layers/useLayerMeasurement";
import type { MeasurementSnapshotIdentity } from "../../shared/measurement-card";
import { useNodeHover } from "../features/inspection/NodeHoverContext";
import { FlatNodeHoverOverlay } from "../features/layers/CanvasHoverOverlay";
import { QuickSelectPanel } from "../features/layers/QuickSelectPanel";
import { MeasurementCard } from "../features/layers/MeasurementCard";
import type { ContextHintsController } from "../features/inspection/useContextHints";
import { ContextHint } from "./ContextHint";
import { ContinuousZoom } from "./ContinuousZoom";
import { CanvasToolPopover } from "../features/layers/CanvasToolPopover";
import { OrbitParameterInput } from "../features/layers/OrbitParameterInput";
import { LayerViewControls } from "../features/layers/LayerViewControls";
import "../styles/layer-motion.css";
import "../styles/canvas-tools.css";

type ViewMode = "flat" | "layers3d";

type Props = {
  sessionKey?: string | number;
  measurementSnapshot?: MeasurementSnapshotIdentity;
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  geometry?: CaptureGeometry;
  layersAvailable?: boolean;
  toolbarHost?: HTMLElement | null;
  onSelect: (node: UiNode) => void;
  onNavigateNode?: (node: UiNode, sourceRoot: UiNode) => boolean;
  navigationDisabled?: boolean;
  toolsSuspended?: boolean;
  contextHints?: ContextHintsController;
  layerFocus: LayerFocus | null;
  hiddenNodeIds: ReadonlySet<string>;
  doubleClickAction: TreeDoubleClickAction;
  onDoubleClick: (node: UiNode) => void;
  onLayerAction: (action: LayerMenuAction, node?: UiNode | null) => void;
  onOpenLayerMenu: (node: UiNode | null, mode?: ViewMode) => void;
  onCaptureGroup?: (node: UiNode) => Promise<QmlGroupImage | null>;
  savedGroupImages?: readonly SnapshotGroupImage[];
  cachedGroupImages?: readonly SnapshotGroupImage[];
};

export function ScreenshotPreview(props: Props) {
  const [appearance, setAppearance] = useState<LayerAppearance>(() => {
    try {
      const saved = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY);
      return saved && saved.length < 1024 ? parseLayerAppearance(JSON.parse(saved)) : DEFAULT_LAYER_APPEARANCE;
    } catch { return DEFAULT_LAYER_APPEARANCE; }
  });
  // A temporary structure view never overwrites the saved display preferences.
  const [structureOverride, setStructureOverride] = useState(false);
  const changeAppearance = (patch: Partial<LayerAppearance>) => {
    if (patch.showEmpty !== undefined || patch.structureMode !== undefined || patch.showOutlines !== undefined) setStructureOverride(false);
    const value = parseLayerAppearance({ ...appearance, ...patch });
    setAppearance(value);
    try { localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify(value)); } catch { /* Keep the preference in this window. */ }
  };
  const effectiveAppearance = useMemo(() => structureOverride
    ? { ...appearance, showEmpty: true, structureMode: "complete" as const, showOutlines: true } : appearance, [appearance, structureOverride]);
  const toggleStructure = () => {
    if (structureOverride) setStructureOverride(false);
    else if (appearance.showEmpty && appearance.structureMode === "complete")
      changeAppearance({ showEmpty: false, structureMode: "regular" });
    else setStructureOverride(true);
  };
  // A capture may replace its preview image while keeping the same camera.
  return <LoadedScreenshot key={props.sessionKey ?? props.src} {...props} appearance={effectiveAppearance} onAppearanceChange={changeAppearance} onToggleStructure={toggleStructure} />;
}

function LoadedScreenshot({ sessionKey, measurementSnapshot, src, root, selectedNode, expandedNodeIds, geometry, layersAvailable = true, toolbarHost, onSelect, onNavigateNode, navigationDisabled = false, toolsSuspended = false, contextHints, layerFocus, hiddenNodeIds, doubleClickAction, onDoubleClick, onLayerAction, onOpenLayerMenu, onCaptureGroup, savedGroupImages, cachedGroupImages, appearance, onAppearanceChange, onToggleStructure }: Props & {
  appearance: LayerAppearance; onAppearanceChange: (value: Partial<LayerAppearance>) => void; onToggleStructure: () => void;
}) {
  const unavailableId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const layerSceneRef = useRef<LayerSceneHandle>(null);
  const surface = { frameRef, stageRef, imageRef, layerSceneRef };
  const focusedNode = layerFocus?.node ?? null;
  const focusKey = layerFocus ? `${layerFocus.kind}:${layerFocus.node.attributes?.["view-ref"] ?? layerFocus.node.id}` : null;
  const [size, setSize] = useState<PixelSize | null>(null);
  const [failed, setFailed] = useState(false);
  const frameSize = usePreviewViewport(frameRef);
  const viewport = frameSize.visible;
  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const canRender3d = Boolean(layersAvailable && enabled && root.bounds && root.children.length > 0);
  const view = useCanvasView({ surface, content: { root, src, focusKey, focusedNode, selectedId: selectedNode?.id ?? null, enabled, canRender3d },
    layout: { size, frameSize }, appearance, onCancelGesture: (): void => interaction.cancel(),
    measurementMode: (): ReturnType<typeof useLayerMeasurement>["state"]["mode"] => measurement.state.mode,
    onExitFocus: () => onLayerAction("exit-focus"), onToggleStructure });
  const { viewMode, camera, zoom, framingScope, sceneOrigin, sceneFitScale, sceneFitViewportRef, renderScale, stageWidth, stageHeight,
    commitCamera, changeZoom, fitView, resetView, applyLayerPreset, toggleCompleteStructure, changeFramingScope } = view;
  const [displayMode, setDisplayMode] = useState<LayerDisplayMode>("images");
  useLayoutEffect(() => { setDisplayMode("images"); }, [root, src, sessionKey]);
  const completeStructure = appearance.showEmpty && appearance.structureMode === "complete";
  const macPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const quickModifierLabel = macPlatform ? "Command" : "Ctrl";
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;
  const rootSelected = selectedNode?.id === root.id;
  const hover = useCanvasHover({ root, size, enabled, viewMode, surface });
  const { hover: sharedHover } = useNodeHover();
  const quickContext = useMemo(() => ({}), [root, src, sessionKey, expandedNodeIds, hiddenNodeIds, focusedNode, layerFocus?.kind, navigationDisabled, viewMode, enabled, onNavigateNode, appearance.showInvisible, appearance.showOffscreen, appearance.showEmpty, framingScope, displayMode, appearance.structureMode]);
  const quick = useCanvasQuickSelect({ context: quickContext, root, navigationDisabled, surface, onNavigateNode,
    onCancelQuickGesture: (): void => interaction.cancelQuickGesture() });
  const activeQuick = quick.active;
  const measureRecords = useMemo(() => measurementRecords(root, hiddenNodeIds, layerFocus), [root, hiddenNodeIds, layerFocus]);
  const measureById = useMemo(() => new Map(measureRecords.map(record => [record.id, record])), [measureRecords]);
  const measureHoverId = sharedHover?.source === "tree" ? sharedHover.nodeId : hover.nodeId;
  const measurement = useLayerMeasurement({ context: sessionKey ?? root, src, records: measureRecords,
    selected: selectedNode ? measureById.get(selectedNode.id) : null,
    hovered: !activeQuick && !navigationDisabled && measureHoverId ? measureById.get(measureHoverId) : null, ready: enabled });
  const measurementState = measurement.state;
  const tools = useCanvasTools({ surface, context: { root, src, sessionKey }, viewMode, ready: { toolsSuspended, navigationDisabled, enabled },
    quick, measurement, onCancelGesture: (): void => interaction.cancel() });
  const { activeTool, toolOpen, measurementToolRef, beginMeasurement, startMeasurementMode, endMeasurement } = tools;
  const gestureContext = useMemo(() => ({}), [focusKey, appearance.showInvisible, appearance.showOffscreen, appearance.showEmpty, framingScope, displayMode, appearance.structureMode]);
  const interaction = useCanvasInteraction({ surface, content: { root, src, sessionKey, selectedNode, size, enabled,
    geometryChecked: integrity.status === "checked", navigationDisabled, toolsSuspended, layerFocus, doubleClickAction, gestureContext,
    canNavigate: Boolean(onNavigateNode) }, view, quick, tools, measurement, hover, onSelect, onDoubleClick, onOpenLayerMenu });
  const { gestureActive, spacePressed, shiftPressed } = interaction;
  const keyboard = useCanvasKeyboard({ surface, view, interaction, quick, tools, measurement,
    content: { selectedNode, focusedNode, navigationDisabled, enabled }, onLayerAction });
  const handleMeasurementShortcut = keyboard.handleMeasurementShortcut;
  const requestContextHint = contextHints?.requestHint;
  const clearContextHint = contextHints?.clearHint;
  useEffect(() => {
    if (!activeQuick) clearContextHint?.("quick-select");
    if (!measurementState.pinned) clearContextHint?.("pinned-measurement");
    if (!focusKey) clearContextHint?.("layer-focus");
    if (activeQuick) requestContextHint?.("quick-select");
    else if (measurementState.pinned) requestContextHint?.("pinned-measurement");
    else if (focusKey) requestContextHint?.("layer-focus");
  }, [Boolean(activeQuick), measurementState.pinned, focusKey, requestContextHint, clearContextHint]);
  const stageStyle: CSSProperties = {
    width: stageWidth,
    height: stageHeight,
    transform: `var(--layer-live-pan, translate3d(${camera.panX}px, ${camera.panY}px, 0))`,
    willChange: "transform",
    ...(viewMode === "layers3d" ? { left: viewport.left + viewport.width / 2 - frameSize.width / 2, top: viewport.top + viewport.height / 2 - frameSize.height / 2 } : {}),
  };
  const stageShellStyle: CSSProperties = viewMode === "layers3d"
    ? { width: "100%", height: "100%" }
    : { width: stageWidth, height: stageHeight, transform: `translate(${viewport.left + viewport.width / 2 - frameSize.width / 2}px, ${viewport.top + viewport.height / 2 - frameSize.height / 2}px)` };


  const unavailable3d = !layersAvailable ? "当前为快速采集，只提供 2D 截图和控件边界。" : !enabled ? "截图尚未就绪，或截图与控件坐标不一致。" : "当前快照没有可展开的层级。";
  const unavailableQuick = viewMode !== "layers3d" ? "请切换到 3D 后选择图层。" : layerFocus?.kind === "layer" ? "仅看此层时请先退出聚焦，再查看重叠图层。" : navigationDisabled ? "正在更新快照，请稍后选择。" : !onNavigateNode ? "当前视图不支持图层定位。" : !enabled ? "截图尚未就绪。" : null;
  const currentOperation = activeQuick ? (activeQuick.mode === "position" ? "图层选择 · 点选画布查看重叠图层 · Esc 取消" : "内部选择 · 点选折叠画面 · Esc 取消")
    : measurementState.picking ? `测距 · 选择 ${measurementState.picking.endpoint === "anchor" ? "A" : "B"} · Esc 结束`
    : measurementState.pinned ? "测距 · 已固定 A / B · Esc 结束"
    : measurementState.mode === "temporary" ? "临时测距 · 悬停 B · 松开 Option / Alt 结束"
    : measurementState.mode === "live" ? `测距 · ${selectedNode ? "悬停 B，M 固定" : "选择 A"} · Esc 结束`
    : focusedNode ? `${layerFocus?.kind === "branch" ? "分支聚焦" : "仅看此层"} · Esc 退出`
    : `${viewMode === "layers3d" ? "3D 层级" : "2D 截图"} · 点击选择控件`;

  const toolbar = <div className="screenshot-view-toolbar" aria-label="截图视图工具栏" onKeyDown={handleMeasurementShortcut}>
      <div className="canvas-tool-group canvas-view-tools" role="group" aria-label="视图与缩放">
      <div className="view-mode-toggle" role="group" aria-label="截图显示模式">
        <button className={viewMode === "flat" ? "active" : ""} aria-pressed={viewMode === "flat"} type="button" onClick={() => view.chooseMode("flat")}>2D <span className="view-mode-description">平面</span></button>
        <span className="canvas-disabled-control" tabIndex={!canRender3d ? 0 : undefined} aria-describedby={!canRender3d ? `${unavailableId}-3d` : undefined}>
        <button className={`view-mode-3d ${viewMode === "layers3d" ? "active" : ""}`} aria-pressed={viewMode === "layers3d"} type="button" disabled={!canRender3d} title={!canRender3d ? unavailable3d : "展开查看已采集的控件层级"} onClick={() => view.chooseMode("layers3d")}>3D <span className="view-mode-description">层级</span></button>
        {!canRender3d && <span id={`${unavailableId}-3d`} className="canvas-disabled-reason" role="tooltip">{unavailable3d}</span>}</span>
      </div>
      <div className="zoom-controls" role="group" aria-label="截图缩放">
        <button type="button" aria-label="缩小截图" title="缩小截图" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={!size || zoom <= MIN_ZOOM}><AppIcon name="minus" size={14} /></button>
        <ContinuousZoom value={zoom} min={MIN_ZOOM} max={MAX_ZOOM} disabled={!enabled} presets={ZOOM_PRESETS} onReset={resetView}
          open={activeTool === "zoom"} onOpenChange={open => toolOpen("zoom", open)}
          onChange={next => changeZoom(next, undefined, true)} />
        <button type="button" aria-label="放大截图" title="放大截图" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={!size || zoom >= MAX_ZOOM}><AppIcon name="plus" size={14} /></button>
        <button className="zoom-fit" type="button" onClick={fitView} disabled={!size} title="适应可见画布 · 0">适应画布</button>
      </div></div>
      <div className="canvas-tool-group canvas-inspection-tools zoom-controls" role="group" aria-label="检查工具">
        <button ref={measurementToolRef} className="pin-layer-measurement" type="button"
          aria-pressed={measurementState.mode !== "off"}
          disabled={!measurementState.ready || navigationDisabled}
          title={measurementState.pinned ? `已测量：${measurementState.summary} · M 或 Esc 结束` : "选中 A，悬停 B 实时测距；按住 Option / Alt 临时测距"}
          onClick={() => measurementState.mode !== "off" ? endMeasurement() : startMeasurementMode()}>
          <AppIcon name="measure" size={18} />
          <span>{measurementState.mode !== "off" ? "结束测距" : "测距"}</span></button>
        <span className="canvas-disabled-control" tabIndex={unavailableQuick ? 0 : undefined} aria-describedby={unavailableQuick ? `${unavailableId}-quick` : undefined}>
        <button ref={quick.toolRef} className="quick-select-tool" type="button" aria-pressed={Boolean(activeQuick)}
          disabled={Boolean(unavailableQuick)}
          title={unavailableQuick ?? `查看此位置的可见图层${appearance.showEmpty ? "，包括空容器" : "；空容器可在 3D 设置中开启显示"}；按住 ${quickModifierLabel} 点选折叠画面可查找内部控件 · Esc 退出`}
          onClick={tools.toggleQuickSelect}><AppIcon name="select-inside" size={18} /><span>选择图层</span></button>
        {unavailableQuick && <span id={`${unavailableId}-quick`} className="canvas-disabled-reason" role="tooltip">{unavailableQuick}</span>}</span>
        {focusedNode && <button className="zoom-fit exit-layer-focus" type="button" onClick={() => onLayerAction("exit-focus")} title={`${layerFocus?.kind === "branch" ? "聚焦分支" : "仅看此层"}：${nodeDisplayLabel(focusedNode)} · Esc 退出`}>退出聚焦</button>}
        {!focusedNode && framingScope === "all" && <button className="zoom-fit" type="button" onClick={() => changeFramingScope("screen")}>返回当前屏幕</button>}
        {viewMode === "layers3d" && hiddenNodeIds.size > 0 && <button className="restore-layers" type="button" onClick={() => onLayerAction("restore")} aria-label={workbenchCommands["restore-layers"].label} title={workbenchCommands["restore-layers"].label}>恢复图层 ({hiddenNodeIds.size})</button>}
      </div>
      {viewMode === "layers3d" && (
        <CanvasToolPopover className="layer-settings" bodyClassName="layer-settings-body" label="3D 层级设置" open={activeTool === "settings"} onOpenChange={open => toolOpen("settings", open)}
          summary={<><AppIcon name="settings" size={18} /><span>3D 设置</span></>}>
            <div className="layer-options" aria-label="3D 层级视图参数">
              <label className="layer-highlight-label">
                <span>显示内容</span>
                <select aria-label="3D 显示内容" value={displayMode} onChange={event => setDisplayMode(event.target.value as LayerDisplayMode)}>
                  <option value="images">图片</option><option value="wireframe">仅边框</option>
                </select>
              </label>
              <label className="layer-outline-label" title={displayMode === "wireframe" ? "仅边框模式始终显示边界；切回图片后恢复此偏好" : "关闭后仍显示选中、悬停和缺图轮廓"}>
                <span>普通轮廓</span>
                <input type="checkbox" checked={appearance.showOutlines} disabled={displayMode === "wireframe"} onChange={event => onAppearanceChange({ showOutlines: event.target.checked })} aria-label="显示普通轮廓" />
              </label>
              <label className="layer-outline-label" title="显示全透明图层和没有自身画面的容器；边界受普通轮廓开关控制，子控件画面不受影响">
                <span>显示空图层</span>
                <input type="checkbox" checked={appearance.showEmpty} onChange={event => onAppearanceChange({ showEmpty: event.target.checked })} aria-label="显示空图层" />
              </label>
              {appearance.showEmpty && <label className="layer-highlight-label" title="紧凑模式将空图层贴近已有内容；完整结构恢复独立层距">
                <span>结构展示</span>
                <select aria-label="3D 结构展示" value={appearance.structureMode} disabled={displayMode === "wireframe"}
                  onChange={event => onAppearanceChange({ structureMode: event.target.value as LayerAppearance["structureMode"] })}>
                  <option value="regular">紧凑（收拢空层）</option><option value="complete">完整结构（逐层展开）</option>
                </select>
              </label>}
              <label className="layer-outline-label" title="只显示已采集的布局边界，不恢复设备画面">
                <span>不可见控件边界</span>
                <input type="checkbox" checked={appearance.showInvisible} onChange={event => onAppearanceChange({ showInvisible: event.target.checked })} aria-label="显示不可见控件边界" />
              </label>
              <label className="layer-outline-label" title="允许平移查看屏幕外图层，保持当前页面大小。也可从树中选中控件后单独聚焦。">
                <span>屏幕外图层</span>
                <input type="checkbox" checked={appearance.showOffscreen} onChange={event => onAppearanceChange({ showOffscreen: event.target.checked })} aria-label="显示屏幕外图层" />
              </label>
              {appearance.showOffscreen && !focusedNode && <div className="layer-offscreen-navigation">
                <small>保持当前屏幕大小；按住空格拖动画布，查看周围图层。</small>
                <button type="button" onClick={() => changeFramingScope(framingScope === "all" ? "screen" : "all")}>
                  {framingScope === "all" ? "返回当前屏幕" : "总览全部图层"}
                </button>
              </div>}
              <label className="layer-highlight-label">
                <span>选中强调</span>
                <select aria-label="选中强调强度" value={appearance.highlightStrength} disabled={displayMode === "wireframe"}
                  onChange={event => onAppearanceChange({ highlightStrength: event.target.value as LayerAppearance["highlightStrength"] })}>
                  <option value="light">轻（仅边框）</option>
                  <option value="medium">中</option>
                  <option value="strong">强</option>
                </select>
              </label>
              <label className="layer-highlight-label">
                <span>旋转模式</span>
                <select aria-label="3D 旋转模式" value={appearance.rotationMode}
                  onChange={event => onAppearanceChange({ rotationMode: event.target.value as LayerAppearance["rotationMode"] })}>
                  <option value="free">自由旋转</option>
                  <option value="horizontal">仅水平旋转</option>
                </select>
              </label>
              <div className="layer-appearance-help"><span>{displayMode === "wireframe" ? "仅边框不显示图片与面状强调" : "缺图轮廓始终保留"}</span><button type="button" onClick={() => { onAppearanceChange(DEFAULT_LAYER_APPEARANCE); setDisplayMode("images"); }}>恢复显示默认</button></div>
              <OrbitParameterInput parameter="layerGap" value={camera.layerGap} onChange={value => commitCamera({ ...view.cameraControl.read(), layerGap: value })} />
              <OrbitParameterInput parameter="distance" value={camera.distance} onChange={value => commitCamera({ ...view.cameraControl.read(), distance: value })} />
              <span className="orbit-readout" aria-live="polite">水平 {Math.round(camera.azimuth)}° · 俯仰 {Math.round(camera.elevation)}°</span>
              <span className="window-stack-label" title={focusedNode ? nodeDisplayLabel(focusedNode) : "截图中的全部可见层"}>{focusedNode ? layerFocus?.kind === "branch" ? "分支聚焦" : "仅看此层" : "全量展开总览"}</span>
            </div>
        </CanvasToolPopover>
      )}
      <CanvasToolPopover className="canvas-help" bodyClassName="canvas-help-body" label="画布操作帮助" summary="帮助" open={activeTool === "help"} onOpenChange={open => toolOpen("help", open)}>
          <strong>画布操作</strong>
          <p>点击选择；双击{doubleClickAction === "focus-branch" ? "聚焦分支" : doubleClickAction === "toggle" ? "展开或收起" : "展开控件"}。</p>
          {doubleClickAction !== "focus-branch" && <p>双击展开会跳过空容器，直到有画面的子层；树上箭头仍逐层展开。</p>}
          <p>{macPlatform ? "右键 / Control＋点击" : "右键"}打开控件菜单；Shift＋F10 操作当前选中项。</p>
          <p>测距：选择 A，悬停 B；M 固定，Esc 结束。按住 Option / Alt 临时测距。</p>
          <p>选择图层：查看可见重叠层；空容器可在 3D 设置中开启显示。{quickModifierLabel}＋点击折叠画面，选择内部控件。</p>
          <p>滚轮或 ＋ / − 缩放，0 适应；空格 / Shift / 中键拖动平移。3D 拖动或方向键旋转，Home 重置。</p>
          {size && <p>{size.width}×{size.height} 屏幕 px · {integrity.message}</p>}
      </CanvasToolPopover>
    </div>;

  return <>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    {contextHints && <ContextHint hint={contextHints.hint} suspended={contextHints.suspended || !enabled || navigationDisabled || gestureActive || toolsSuspended || Boolean(activeTool)}
      onShown={contextHints.markShown} onDismiss={contextHints.dismissHint} />}
    <div className={`screenshot-frame ${viewMode === "layers3d" ? "layers3d-active" : ""}`} ref={frameRef} tabIndex={0} aria-label="截图工作区" data-pan-ready={spacePressed || shiftPressed}
      data-measurement-active={measurementState.mode !== "off"}
      data-viewport-left={viewport.left} data-viewport-top={viewport.top} data-viewport-width={viewport.width} data-viewport-height={viewport.height}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={keyboard.onKeyDown}
      {...interaction.pointerHandlers}>
      {viewMode === "layers3d" && canRender3d && size && (
        <>
          <div className="viewport-grid" aria-hidden="true" />
          <div className="orbit-gizmo viewport-gizmo" aria-hidden="true">
            <span className="gizmo-axis gizmo-axis-x"><i>X</i></span>
            <span className="gizmo-axis gizmo-axis-y"><i>Y</i></span>
            <span className="gizmo-axis gizmo-axis-z"><i>Z</i></span>
          </div>
        </>
      )}
      <div className={`screenshot-stage-shell ${viewMode === "layers3d" ? "layers3d-viewport" : ""}`} style={stageShellStyle}>
        <div ref={stageRef} className={`screenshot-stage ${viewMode === "layers3d" ? "layers3d-base" : ""}`} data-coordinate-status={enabled ? integrity.status : failed ? "error" : size ? integrity.status : "loading"}
          style={stageStyle}>
          <img ref={imageRef} src={src} alt="Android screen snapshot" draggable={false}
            onLoad={event => {
              const image = event.currentTarget;
              const next = { width: image.naturalWidth, height: image.naturalHeight };
              if (validSize(next)) { setSize(next); setFailed(false); }
              else { setSize(null); setFailed(true); }
            }}
            onError={() => { setSize(null); setFailed(true); }} />
          {overlay && selectedNode && (
            <div className={`selection-overlay ${rootSelected ? "root-selection" : ""}`} style={overlay} aria-hidden="true">
              <span className="selection-label">
                <strong>{nodeDisplayLabel(selectedNode)}</strong>
                <span>{selectedNode.className ?? "unknown"}</span>
              </span>
            </div>
          )}
          {enabled && size && viewMode === "flat" && <FlatNodeHoverOverlay root={root} size={size} selectedId={selectedNode?.id ?? null} />}
        </div>
        {viewMode === "layers3d" && canRender3d && size && (
          <Layer3DPreview
            ref={layerSceneRef}
            sessionKey={sessionKey}
            src={src}
            root={root}
            selectedNode={selectedNode}
            expandedNodeIds={expandedNodeIds}
            hiddenNodeIds={hiddenNodeIds}
            focusedNode={focusedNode}
            focusKind={layerFocus?.kind}
            size={size}
            renderScale={renderScale}
            origin={sceneOrigin}
            viewport={viewport}
            camera={constrainOrbitCamera(camera, appearance.rotationMode)}
            appearance={appearance}
            displayMode={displayMode}
            framingScope={framingScope}
            onSelect={onSelect}
            onCaptureGroup={onCaptureGroup}
            savedGroupImages={savedGroupImages}
            cachedGroupImages={cachedGroupImages}
            initialFitNeeded={sceneFitScale === null}
            fitViewportRef={sceneFitViewportRef}
            onFitScale={view.onFitScale}
            measurementController={measurement}
          />
        )}
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
      {activeQuick && <QuickSelectPanel viewport={viewport} result={activeQuick.result} disabled={navigationDisabled} onPreview={quick.preview}
        mode={activeQuick.mode ?? "inside"} onModeChange={quick.changeMode}
        onConfirm={quick.confirm} onPage={quick.page} onFilter={quick.filter} anchor={activeQuick.anchor} onClose={() => { if (quick.isCurrent()) quick.close(true); }} />}
      {measurementState.mode !== "off" && !activeQuick && <MeasurementCard
        state={measurementState} root={root} savedGroupImages={savedGroupImages} snapshot={measurementSnapshot}
        viewport={{ left: 0, top: 0, width: frameSize.width, height: frameSize.height }} selectionDisabled={navigationDisabled}
        onClear={endMeasurement} onPick={beginMeasurement}
        onPin={() => measurement.toggleMeasurementPin()} onLive={startMeasurementMode}
        onUseSelected={() => { if (measurement.useSelectedMeasurementNode()) frameRef.current?.focus({ preventScroll: true }); }} />}
      {measurementState.pinned && measurementState.card && <span className="layer-measurement-status" role="status"
        data-measure-anchor={measurementState.card.anchor.id} data-measure-target={measurementState.card.target.id}
        data-measure-relation={measurementState.card.measurement.relation} data-measure-pinned="true">
        测距已固定：{measurementState.summary}。按原始外框测量，不含 3D 展开层距。
      </span>}
    </div>
    {viewMode === "layers3d" && canRender3d && size && <LayerViewControls
      camera={camera} rotationMode={appearance.rotationMode} disabled={navigationDisabled || toolsSuspended}
      completeStructure={completeStructure} onStructure={toggleCompleteStructure}
      style={{ marginLeft: viewport.left, width: viewport.width || "100%" }}
      onPreset={applyLayerPreset} onGap={layerGap => commitCamera({ ...view.cameraControl.read(), layerGap })} />}
    {size && <p className={`screenshot-status canvas-operation-status ${integrity.status}`} role="status">
      <span>{currentOperation}</span>
      {viewMode === "layers3d" && !focusedNode && selectedNode?.bounds && validBounds(selectedNode.bounds) && !clipBounds(selectedNode.bounds, size) &&
        <button className="offscreen-selection-focus" type="button" disabled={navigationDisabled || toolsSuspended}
          onClick={() => onLayerAction("focus-branch", selectedNode)} title={`单独查看 ${nodeDisplayLabel(selectedNode)}，退出后恢复当前视图`}>聚焦屏幕外控件</button>}
      <small title={measurementSnapshot?.capturedAt ? `当前画面采集于 ${measurementSnapshot.capturedAt}` : "当前画面未提供采集时间"}>
        {measurementSnapshot?.capturedAt ? `采集于 ${new Date(measurementSnapshot.capturedAt).toLocaleTimeString()}` : "采集时间未记录"}
      </small>
      {integrity.status === "mismatch" && <span>{integrity.message}</span>}
    </p>}
    {measurementState.pinned && <p className="screenshot-pinned-measurement" hidden>测距已固定：{measurementState.summary} · M 或 Esc 解除</p>}

  </>;
}
