# 开发目录与依赖边界

更新：2026-10-15。架构重构已拆出桥接契约、桌面采集与生命周期、快照用例和工作台命令；第二轮明确 Provider 池、采集会话、补图和局部刷新的归属；第三轮拆出画布相机、手势与工具控制；第四轮分开纯场景计算、绘制帧、GPU 纹理和组图采集；第五轮明确采集上下文、取图路由和错误分类，底层命令只继承取消信号；第六轮分开自动调试会话、目标规则、步骤执行和证据记录；第七轮统一图片事实的读取，展示和导出各自保留策略。范围与后续批次见[重构计划](ARCHITECTURE_REFACTOR_PLAN.md)。Electron 为当前桌面运行时；Tauri 仅保留历史原型。

## 按职责找代码

```text
electron/
├─ main.ts、preload.ts     桌面组装、剩余IPC流程、桥接实现
├─ device/                ADB执行、设备发现、前台身份、截图、输入回复
├─ capture/               采集编排、原生/Qt树、图层匹配、独立图、局部刷新
├─ sdk/                   SDK会话、协议解析、树/图关联、几何恢复
├─ automation/            授权调试、CLI/MCP入口、共享与撤销
├─ desktop/               窗口生命周期、采集服务/IPC、原生菜单、导出、存储与报告
└─ platform/              自有子进程和端口转发资源

src/
├─ App.tsx                页面组装、设备入口与命令处理表
├─ components/            设备首页、树、截图交互、属性面板等界面
├─ features/inspection/   浏览状态、采集控制器、补图/刷新、纯定位器生成
├─ features/automation/   授权事件、共享/停止与异步回复隔离
├─ features/history/      快照导入/导出/保存/历史用例、比较模型和展示
├─ features/workbench/    命令分发、菜单订阅和快捷键
├─ platform/              应用组装时绑定的桌面窄接口
├─ features/reports/      本地e2e报告、步骤/错误/截图与显式只读诊断
├─ features/layers/       React场景、投影、图层呈现规则、WebGL渲染
└─ styles/、App.css        主题变量与界面样式

shared/                   平台无关的类型、坐标、树、布局和协议规则
android/                  Debug SDK、样例及Android专项验证
scripts/                  启动、打包、冒烟和基准入口
├─ diagnostics/sdk/       SDK专项探针与观察工具
├─ diagnostics/startup/   启动诊断、固定日志读取、栈观察
└─ lib/                   测试编排复用，不被产品引用
tests/、benchmarks/       单元测试、脱敏样本、DOM/坐标/GPU回归
docs/                     状态、计划、验收与使用说明
build/、.github/          打包钩子和CI
```

## 核心入口

Android表中的Java文件均位于`android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/`。

| 要修改的内容 | 首先看这里 |
| --- | --- |
| 桌面桥接契约与能力适配 | `shared/desktop-api.ts`、`src/platform/desktop-services.ts`；preload 用 `satisfies DesktopApi` 校验 |
| 窗口操作与应用退出 | `electron/desktop/window-operation-scope.ts`、`create-desktop-runtime.ts`；取消并等待操作、调试、预览，再关闭 Provider |
| 桌面采集与请求身份 | `electron/desktop/inspection-service.ts` 持有在途请求和实时会话；`capture-ipc.ts` 校验来源与参数 |
| 工作台菜单、按钮与快捷键 | `src/features/workbench/useWorkbenchCommands.ts`、`workbench-dispatch.ts`；复用 shared 命令可用规则 |
| 快照文件与历史 | `src/features/history/useSnapshotLibrary.ts` 持有导入失效令牌与历史；`snapshot-file-service.ts` 构建导出内容 |
| 整页采集与回退 | `electron/capture/inspection.ts`；`createInspectionRunner` 注入设备与图片边界，负责就绪等待、native/QML 分流、尝试预算和最终身份核对 |
| 请求、尝试与阶段状态 | `electron/capture/run-context.ts` 显式传递选项、请求身份、当前尝试路由和阶段取消；重试只共享首次锁定的组件 |
| SDK/DDMS 取图路由与错误 | `electron/capture/capture-plan.ts` 保留用户偏好并接纳已验证的 SDK 能力；`capture-errors.ts` 在旧错误边界分类，内部重试读取错误类别 |
| SDK 树身份核验 | `electron/capture/sdk-tree-verification.ts` 复用本次调用的已核验证据，或执行读树前后核对；不额外发能力探测请求 |
| 命令取消与清理 | `electron/device/command-context.ts` 只保存 `AbortSignal`；自有转发的建立和清理可退出请求取消范围，`device` 不引用采集类型 |
| 独立图片采集 | `electron/capture/debug-images.ts`、`electron/capture/sdk-images.ts` |
| JDWP连接、报文与元数据批次 | `electron/capture/jdwp-transport.ts` |
| DDMS窗口核验及树/图采集编排 | `electron/capture/view-debug.ts` |
| JDWP安全位图补采 | `electron/capture/view-bitmaps.ts` |
| 窗口与图片协议解析 | `electron/capture/view-protocol.ts` |
| 图层几何与匹配 | `electron/capture/layer-images.ts` |
| 控件/分支/列表刷新 | `electron/capture/refresh.ts` |
| SDK连接与取消 | `electron/sdk/provider-session.ts` 工厂拥有连接/回收/销毁；`provider-session-request.ts` 负责请求协议；桌面由 `main.ts` 创建并注入 |
| Android准入、生命周期和串行调度 | `HierarchyProvider.java` |
| Android会话和请求解码 | 同目录`HierarchySession.java` |
| Android控件树、属性及布局编码 | 同目录`HierarchyTree.java` |
| Android取图参数、目标选择、批量调度与窗口核验 | 同目录`HierarchyCapture.java` |
| Android主线程帧、几何核验及特殊缓冲 | 同目录`CaptureFrame.java`、`IsolatedCapture.java` |
| Android编码、记录/文件输出和位图所有权清理 | 同目录`CaptureOutput.java` |
| 自动调试授权与生命周期 | `electron/automation/debug-session.ts` 保留门面，拥有授权、并发准入、停止、日志收尾和进度事件 |
| 自动调试步骤执行 | `debug-step-executor.ts` 拥有当前观察、输入前证据和输入请求历史，分派采集、输入与等待；`debug-step-context.ts` 保存单步事实 |
| 自动调试目标与验收规则 | `debug-target-resolution.ts` 处理稳定匹配、坐标和遮挡；`debug-task-execution.ts` 处理任务定义、阶段顺序和两次新观察的验收，不执行设备或文件操作 |
| 自动调试证据记录 | `debug-session-recording.ts` 拥有会话目录并组合已有 `debug-evidence.ts`；记录错误与操作结果分开，保留兼容文件与容量限制 |
| 可选Helper只读后端 | `electron/capture/accessibility-helper.ts`拥有私有令牌、HTTP限额、唯一授权窗口与自有转发；`device-actions.ts`复核App/几何，`debug-session.ts`撤销切源旧共享并拒绝Helper输入；对比脚本复用此HTTP读取 |
| 当前树、选中、展开、聚焦/隐藏、双击偏好与菜单动作 | `src/features/inspection/useInspectionWorkspace.ts` 保有浏览状态，并组合采集与刷新能力 |
| 采集、取消、进度与预览接纳 | `inspection-session.ts` 控制请求身份；`useInspectionSession.ts` 连接接口订阅、计时器与 React |
| 补图、局部刷新和旧结果隔离 | `useSnapshotAugmentation.ts` 拥有刷新身份；`group-image-cache.ts` 按源快照/节点复用补图；`inspection-refresh.ts` 校验并构建新树；`inspection-presentation.ts` 计算选中/展开映射。均在 `src/features/inspection/` |
| 树行/搜索/键盘 | `src/components/UiTree.tsx`拥有临时搜索路径、焦点/滚动；`shared/tree-utils.ts`共用匹配和命中来源；真实展开仍归工作台hook |
| 树展开档位 | `shared/tree-collapse.ts`按当前根计算2层/4层/全部，保留选中祖先；`TreeExpansionPresets.tsx`只展示当前树操作，`UiTree.tsx`沿用工作台展开回调，不写默认偏好 |
| 继承类型图标 | `shared/tree-utils.ts`有界解析 SDK 真实继承链并匹配已知 Android 类型，`UiTree.tsx`沿用原图标和真实类名，缺失/坏链/QML保留回退 |
| 场景操作提示 | `shared/context-hints.ts`拥有每会话机会与已了解记录；`useContextHints.ts`处理本机偏好、采集/弹窗暂停及会话隔离；`ContextHint.tsx`暂停时保留占位，`ScreenshotPreview.tsx`接操作开始/退出及拖动、Esc门卫，偏好支持重置 |
| 控件图片预览 | `NodeImageActions.tsx`管理预览/输出取消，`NodeImagePreview.tsx`展示原尺寸/透明棋盘及缩放；`prepareNodeImagePreview.ts`核验真实解码尺寸，复用`prepareNodeImageExport.ts`已有图与分支重建，并收回取消后迟到位图 |
| 图片采集事实 | `shared/node-capture-facts.ts` 将现有节点字段和属性适配为类型化事实；不修改 DTO、不缓存、不解码图片、不包含显示偏好 |
| 图片导出策略 | `shared/node-image-export.ts` 基于采集事实制定自身图/整组图/本地重建计划，独立校验位图与尺寸预算 |
| 控件与画面状态 | `shared/node-presentation-status.ts`区分设备/用户显隐、自身图片事实与呈现来源；`NodePresentationStatus.tsx`由树、属性和画布共用，不触发采集 |
| 二维测距卡片 | `shared/measurement-card.ts`只使用原始外框；`useLayerMeasurement.ts`沿用固定配对与清理；`MeasurementCard.tsx`展示原始间距/对齐，`ScreenshotPreview.tsx`负责可用区域、快速选择避让与滚轮隔离 |
| 树/画布悬停 | `src/features/inspection/NodeHoverContext.tsx`按根与会话保存来源状态，`shared/node-hover.ts`拥有有限通知/父子引导/物理祖先回退；`src/features/layers/CanvasHoverOverlay.tsx`按实际2D坐标合并指针帧，`src/features/layers/Layer3DPreview.tsx`区分画面强调和测距指针目标 |
| 连续图层动画 | `src/features/layers/motion.ts` 只计算有界过渡；`scene-frame-runtime.ts` 拥有已绘制帧、折叠动画和离场纹理交接判断；`canvas-camera.ts` 与 `useCanvasView.ts` 拥有相机中断和视图淡入。动画帧直接绘制，不逐帧更新 React 状态 |
| 属性精确搜索 | `shared/inspector-search.ts`匹配完整值并限制结果数；`src/features/inspection/inspector-search-index.ts`索引实际属性行及显式源值，`src/components/InspectorSearchResults.tsx`展示结果，`src/components/NodePropertiesPanel.tsx`拥有临时展开、仅属性栏定位和旧目标/计时器清理 |
| 控件路径导航 | `src/components/NodePathNavigator.tsx`复用`src/features/inspection/locators.ts`的真实父子路径，拥有有界列表及本地焦点；工作台hook统一执行明确定位、筛选/聚焦处理和会话/更新期间拒绝，`src/components/UiTree.tsx`使明确定位优先于聚焦滚动恢复 |
| 菜单/右键/快捷键 | `shared/workbench-commands.ts`拥有动作名称、快捷键及可用条件；`src/App.tsx`统一分发，无原生菜单时才处理页面快捷键；`electron/desktop/application-menu.ts`拥有原生菜单，`electron/main.ts`复用右键标签，IPC校验仍归桌面边界 |
| 首页设备状态 | `shared/device-state.ts`区分连接/加载/无设备/未授权/离线/缺ADB/错误；`DeviceHomeView.tsx`展示状态和设备弹窗；App隔离重复/迟到探测并拒绝失效设备 |
| 偏好/入口弹窗 | `EntryDialog.tsx`拥有原生弹窗和关闭后焦点恢复，`PreferencesPanel.tsx`展示偏好及快捷键，`src/styles/entry.css`只管这些入口样式；双击偏好仍由工作台hook保存，不另建状态存储 |
| 工作台布局/工具/分隔条 | `src/components/AppHeader.tsx`拥有顶部容器；App挂载现有工具；`TreePaneResizer.tsx`拥有宽度；`src/styles/workbench.css`只管布局 |
| 属性卡片/浮窗 | `src/components/NodePropertiesPanel.tsx`拥有显示/收起/搜索及停靠/浮动状态，内部`InspectorGroup`保存用户折叠与临时搜索展开；`shared/inspector-groups.ts`核验七组显隐，`useInspectorGroups.ts`保存本机设置，`InspectorGroupPreferences.tsx`复用偏好入口。隐藏只改显示，搜索按匹配临时显示；诊断显式定位恢复贴边，内容样式仍在`App.css`。App复用统一复制回调，按节点/快照和请求隔离迟到反馈 |
| 画布布局与显示 | `src/components/ScreenshotPreview.tsx` 组合能力、连接事件并显示工具；外层保留外观偏好和临时完整结构开关 |
| 相机/缩放/聚焦返回 | `src/features/layers/useCanvasView.ts` 拥有视图、缩放锚点和返回状态；`canvas-camera.ts` 拥有实际绘制相机、动画与帧调度，注入绘制和调度能力；`usePreviewViewport.ts` 观察可用画布 |
| 指针/快捷键/工具互斥 | 同目录 `useCanvasInteraction.ts` 拥有手势和按下帧拾取；`useCanvasKeyboard.ts` 管监听与键盘优先级；`useCanvasTools.ts` 协调工具、测距和选层入口 |
| 画布悬停与候选 | 同目录 `useCanvasHover.ts` 连接 2D/3D 悬停；`useCanvasQuickSelect.ts` 管候选状态、分页和过期回调。A/B 测量数据仍归 `useLayerMeasurement.ts` |
| 界面授权事件、共享及迟到回复 | `src/features/automation/useDebugSession.ts` |
| CLI/MCP命令 | `electron/automation/cli.ts`、`electron/automation/mcp-server.ts` |
| 3D组件/适应与悬停 | `src/features/layers/Layer3DPreview.tsx` 拥有 memo、画布适应、标签/测距和场景句柄，组合纯模型与运行时；`useLayerSceneRuntime.ts` 连接 React、DOM 观察器和运行时销毁 |
| 纯场景计算 | 同目录 `scene-model.ts` 构建布局、平面、高亮和 framing；接收已解析纹理信息，不访问 DOM、GPU 或纹理版本缓存。选择/悬停只更新高亮，超出图层上限的选择才重算布局 |
| 绘制帧与资源协调 | `scene-runtime.ts` 拥有渲染器及 context 丢失/恢复；`scene-frame-runtime.ts` 保存实际相机、已绘制平面和投影，拾取与测距读取同一帧 |
| 纹理和组图生命周期 | `scene-texture-runtime.ts` 拥有需求队列、解码、透明区域扫描、预算与回收；`scene-group-runtime.ts` 拥有当前树/截图/会话的组图请求。GPU 恢复不重复采集组图，旧场景结果不能发布到新场景 |
| GPU操作与外部能力 | `webgl-renderer.ts` 继续实现着色器、纹理上传与绘制；`scene-runtime-ports.ts` 注入调度、图片解码和 GPU 操作，浏览器实现仅在调用时访问环境 |
| 父子图层纹理规则 | `src/features/layers/presentation.ts` |
| 相机投影与命中 | `src/features/layers/projection.ts` |
| 快照差异与定位器 | `src/features/history/model.ts`、`src/features/inspection/locators.ts` |
| 本地测试报告 | `shared/test-report.ts`定义索引；`electron/desktop/test-report.ts`核验文件；`src/features/reports/TestReportPanel.tsx`拥有离线展示状态 |
| 当前页面只读诊断 | `src/features/reports/LivePageDiagnosis.tsx`管显式采集/取消；`src/features/reports/live-diagnosis.ts`管分类和摘要；`src/App.tsx`连接工作台快照/选中及属性显式显示 |
| 图片透明度 | `electron/desktop/layer-images.ts`编排；`layer-image-alpha.ts`预检/像素规则；`webp-alpha.ts`拥有线程/预算，`webp-alpha-worker.ts`解码；`scripts/build-webp-alpha.mjs`生成worker |
| 首页、偏好、设备与空/失败状态回归 | `benchmarks/workbench-entry-verification.ts`保存源码和候选包共用的DOM断言；`scripts/lib/workbench-ui-driver.cjs`共用尺寸和键盘检查。两边分别保留源码异步交接和候选包产物核验 |
| 视觉基线 | `scripts/visual-baseline.mjs`统一工作台、首页和首页状态；三个`visual:*`命令与原输出目录保持兼容 |
| 控件识别独立评估 | `scripts/prepare-recognition-helper.ts`核固定上游源码并准备布局补丁；`scripts/recognition-comparison.ts`只读核身份、几何、布局与目标语义；`android/recognition-sample/`提供无SDK独立样例，源码/设备产物留忽略目录 |
| 候选包离线交付准备 | `scripts/freeze-desktop-candidate.mjs`冻结源码；`scripts/lib/packaged-check-evidence.cjs`核产物/证据；`scripts/packaged-handoff-checks.mjs`加载候选页面，`benchmarks/diagnosis-handoff-packaged-entry.ts`注入共用DOM断言；`scripts/native-menu-checks.cjs`及`scripts/test-report-checks.cjs`加载候选产品IPC；`scripts/packaged-readonly-check.ts`只用私有合成共享 |

## 依赖规则

- 产品代码不依赖`scripts/`、`tests/`或`benchmarks/`。诊断工具可以调用产品模块，不能反过来。
- `shared/`不依赖React、Electron、Node运行时或产品目录。
- `src/`不直接执行ADB、访问文件或引用主进程；桌面能力通过共享桥接契约和注入的窄接口；尚未迁移的功能沿用 `window.electronApi`。
- 工作台 hook 拥有浏览状态；采集控制器拥有采集身份，补图/刷新模块拥有各自请求。历史和自动调试通过 `showSnapshot` 接管，不在 App 重复写树。接口替换或卸载后旧回调失效；同一请求号内换树也不能复用旧补图回调。授权 hook 由 App 连接，授权决定仍在主进程。
- 离线测试报告只展示已保存证据，不采集手机、不接管工作台快照或调试授权；文件读取由主进程选择器确认，renderer只接核验后的结构化数据与PNG data URL。显式当前页面诊断独立发起一次只读请求，由App经工作台hook接管快照并连接树/属性显示；不是重放报告。产品不导入实验子项目或报告HTML。
- `device/`和`platform/`不反向执行采集、SDK、自动调试或桌面入口。仅类型引用不生成运行依赖。
- `main.ts` 负责启动、依赖组装和尚未迁移的 IPC。采集服务不依赖 Electron event，IPC 适配器负责来源与参数校验；窗口作用域负责取消/等待，桌面运行时负责退出顺序。Provider 池由入口显式创建，采集模块仅接收 `ProviderClient` 类型；导入模块不创建连接池或回收定时器。
- `createProviderSessionPool` 通过依赖注入管理 ADB、连接与时钟。`releaseAll()` 取消并等待当前操作、释放连接后可复用；`dispose()` 永久关闭并释放回收定时器。桌面随运行时退出销毁；直接使用采集能力的诊断脚本在 `finally` 等待销毁。CLI/MCP 走桌面桥接，不另建无用池。
- 复杂采集流程可以保留编排，但解析、几何和协议规则应放在所属模块。直接导入，不用旧路径转发层。
- JDWP传输不依赖采集编排；窗口/图片协议解析不做连接或设备操作。位图补采拥有编号、暂停/恢复与清理，窗口入口只编排DDMS流程。
- Android Provider拥有授权、Activity生命周期及数据请求锁；会话负责传输，树不执行取图或线程调度，取图不依赖Provider/会话。实时Activity和tree-ready回调由Provider提供，不固定旧Activity，不另建请求锁。
- SDK采集入口保留流程编排；帧模块不依赖输出/入口，输出只接复制的画面/几何和标识，不读取活View或排UI任务。样例反射及故障注入直接跟随实际所属类，不留旧方法转发壳。
- TypeScript/JavaScript产品模块的运行依赖不得成环。`tests/architecture.test.ts`检查静态/动态导入、直接require、内联createRequire、边界、循环、旧入口及目录导航；类型导入不算运行依赖。不对任意动态表达式或别名作完整静态分析。
- 画布交互通过窄接口调用相机和场景，不拥有 GPU 纹理或复制场景布局。实际绘制相机和控件展示的目的相机分开；取消、切换内容和卸载必须让过期帧失效。候选的上下文变化只取消相应选层动作，不扩大普通拖动的取消范围。
- 场景组件负责 memo 和适应画布，纯模型负责计算，运行时负责有状态资源。布局、高亮和纹理需求分别更新；晚到组图不能把拖动中的镜头改回 React 旧值。渲染器销毁后旧图片、扫描和动画回调失效，迟到位图仍须释放；GPU 丢失暂停组图发布，恢复后沿用同一场景的有效结果。
- 样式复用`src/styles/tokens.css`；纯模型和算法不导入CSS。测试样本必须脱敏。
- `workbench.css`在`App.css`后加载，只拥有工作台顶部、分隔区/搜索位置和停靠布局；不在其他模块重复覆盖这些尺寸。组件内容、独立截图预览及可移动浮窗保持原样式。

## 源码和生成物

`dist/`是renderer构建；`dist-electron/`是main/preload/CLI/MCP及WebP图片worker构建；`release/`是安装包。worker通过运行时App路径定位，不烘焙开发目录；sharp作为生产依赖打包。输出路径没有改，以保持启动、打包和权限脚本兼容。修改源码后重新构建，不手改产物。

`.benchmarks/`保存测试日志、截图、临时配置及备份，不进入公开仓库。可能含私人页面和日志，不能直接发布。

保留最近可用候选、回退包和独有验收证据；结束的应用副本可压缩归档，逐文件校验后再移走展开副本，并在同目录记录恢复方法。树、图层、坐标/DPI、GPU和授权生命周期检查覆盖不同问题，不因入口相似合并。

`scripts/experiments/tester-e2e/`是独立npm实验子项目，根TypeScript检查排除它，依赖/Node版本与生产项目分离，不进入Electron安装包。离线用`npm run check`；`report.mjs`/`report.test.mjs`用标准库整理旧报告为HTML与JSON索引，`npm run check:report`不操作手机。真机用例需另确认助手安装与操作范围；说明见该目录README，`.e2e/`报告忽略不发布。

`src-tauri/`不参与默认构建，不继续开发或自行删除。Android SDK结构已改并本地构建，手机上的SDK不会自动更新。

<a id="worktree-development"></a>

## Worktree并行开发

默认使用Codex管理的Git worktree，规则见[AGENTS.md](../AGENTS.md)。原目录含未提交成果时，先用临时Git索引保存共同源码基线，保留原分支、暂存区和文件；新工作树包含这些成果。上一轮属性分组基线为`9e584a9e1179`；本轮Lookin交互使用包含621份当前源码的基线`abd02ca62448`，分工如下：

| 工作树 | 所负责内容 |
| --- | --- |
| `property-groups-model` | 设置模型、保存与校验、偏好选项、单元测试 |
| `property-groups-ui` | App接入、属性显示/搜索/空状态和面板样式 |
| `property-groups-checks` | 实际App回归、使用与计划文档 |
| `lookin-hover` / `codex/lookin-hover` | 共享悬停状态、树行/父子引导、虚拟树回归 |
| `lookin-motion` / `codex/lookin-motion` | 展开/收起与反向、相机/模式过渡、真实WebGL回归 |
| `lookin-property-search` / `codex/lookin-property-search` | 实际属性结果/定位/高亮、窄面板与恢复回归 |
| `lookin-interaction-integration` / `codex/lookin-interaction-integration` | 审查并提交三分支、实际Git合并、画布接线与组合验证、文档和精确同步 |

每个代理的命令和文件操作显式指定自己的工作目录，只改所负责的文件。依赖版本相同时复用已有node_modules，源码、构建产物和测试输出分别留在各自工作树。整合只移入已确认的改动，随后运行相关检查、类型检查和构建；保留仍需使用的工作树，不再需要时用Codex归档工具处理。

后续路径导航复用上述整合工作树，在`codex/lookin-node-navigation`分支开发，再合回整合分支。基线`e1be8e8783c5`与原目录637份源码逐文件一致，包含前三项和此前未提交成果；本轮继续保留原目录的HEAD、分支和暂存区。

本轮后三项使用含641份当前源码的共同基线`7e865e4188c2`，三个subagent分别在`codex/lookin-quick-select`、`codex/lookin-layout-links`、`codex/lookin-structured-values`中开发。复用原整合目录，新建`codex/lookin-migration-integration`合并；App、属性面板、组合测试及文档由整合方接线，保护原目录分支和暂存区。

最新操作完善复用三个工作目录，分别切到`codex/lookin-expansion-presets`、`codex/lookin-node-status`、`codex/lookin-measurement-card`。共同基线`b9908fb1cfca`与原目录686份源码状态一致，统一合入`codex/lookin-usability-integration`；接线、组合回归和精确同步由整合方负责。结果见[本轮验收](CORE_ACCEPTANCE.md#lookin-usability-acceptance)。

| 本轮模块 | 职责 |
| --- | --- |
| `src/features/layers/quick-select.ts`、`QuickSelectPanel.tsx` | 当前绘制平面到屏幕坐标、折叠分支候选和分页；临时轮廓/工具状态由现有3D场景与截图组件拥有 |
| `shared/layout-relations.ts`、`src/components/LayoutRuleProperties.tsx` | 原生规则和值、唯一目标解析、原值与原因显示；定位沿用工作台hook |
| `shared/debug-metadata.ts`、`DebugMetadata.java`、`DebugMetadataFields.tsx` | v1/v2显式数据、SDK保存副本和预算、分层展开/搜索/复制；快照文件模块拥有文件版本规则 |
| `benchmarks/quick-select-checks.tsx`、`layout-relations-checks.tsx`、`structured-values-checks.tsx`、`lookin-migration-checks.tsx` | 保留各自独有断言，接入既有坐标和树UI入口；组合检查使用实际App及合成桥接 |

## 本地验证

快速检查结构：

```sh
bun test tests/architecture.test.ts tests/sdk-architecture.test.ts
```

完整本地回归：

```sh
bun test tests
bun run build
bun run test:tree-ui
bun run test:coordinates
bun run test:dpi
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/native-menu-checks.cjs
```

最后四项使用合成页面和隔离测试配置，不证明真机或已安装版本通过。手机更新、运行程序重启、提交推送和发布是独立操作。

修改画布交互时，另跑实际组件和原生输入回归：

```sh
node scripts/canvas-controller-checks.mjs
node scripts/scene-runtime-checks.mjs
node scripts/canvas-round4-checks.mjs
node scripts/canvas-round4-checks.mjs --round5
node scripts/workspace-canvas-checks.mjs
```

`canvas-controller-checks` 覆盖捕获取消、旧帧失效、会话替换、聚焦返回和缩放锚点，并保存固定场景。用 `node scripts/canvas-controller-checks-compare.mjs <重构前result.json> <重构后result.json>` 比较实际几何与截图；脚本报告像素差异，不将有差异的截图称为逐像素相同。

`scene-model.test.ts` 和 `scene-runtime.test.ts` 直接调用纯模型和带注入依赖的运行时，覆盖实际帧、迟到回调与组图/GPU 生命周期。`scene-runtime-checks` 使用真实 React 和 WebGL，主动延迟浏览器图片解码与透明区域扫描，检查换树、换截图、换会话、卸载和 context 恢复后的像素、拾取、位图关闭与 GPU 资源释放；不调用设备接口。原坐标工装继续验证动画交接、纹理预算和三档缩放。`test:dpi` 复用坐标构建输出，修改产品后先运行 `test:coordinates` 再运行它。

Android在配置JDK17和Android SDK后构建，不安装到手机：

```sh
gradle -p android :inspector-sdk:assembleDebug :inspector-sdk:assembleRelease :sample-app:assembleDebug :sample-app:assembleRelease --console=plain
```

`test:tree-ui`也执行脱敏70节点样本的授权/历史交接回归；样本不含业务截图或原始属性，不能作为像素或实际手机同步验收。
