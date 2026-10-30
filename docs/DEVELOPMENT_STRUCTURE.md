# 开发目录与依赖边界

更新：2026-10-11。UI工作暂停在U6c，测试入口、基准和文档整理已完成。Electron为当前桌面运行时；Tauri仅保留历史原型。范围和验收见[结构重构](archive/ARCHITECTURE_REFACTOR.md)。

## 按职责找代码

```text
electron/
├─ main.ts、preload.ts     桌面启动、IPC编排、桥接白名单
├─ device/                ADB执行、设备发现、前台身份、截图、输入回复
├─ capture/               采集编排、原生/Qt树、图层匹配、独立图、局部刷新
├─ sdk/                   SDK会话、协议解析、树/图关联、几何恢复
├─ automation/            授权调试、CLI/MCP入口、共享与撤销
├─ desktop/               原生菜单、导出、快照存储、本地报告读取、图像度量、测试模式
└─ platform/              自有子进程和端口转发资源

src/
├─ App.tsx                页面、设备/历史/导出与菜单编排
├─ components/            设备首页、树、截图交互、属性面板等界面
├─ features/inspection/   工作台树/采集/取消交接，纯定位器生成
├─ features/automation/   授权事件、共享/停止与异步回复隔离
├─ features/history/      快照比较模型和历史展示
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
| 整页采集与回退 | `electron/capture/inspection.ts` |
| 独立图片采集 | `electron/capture/debug-images.ts`、`electron/capture/sdk-images.ts` |
| JDWP连接、报文与元数据批次 | `electron/capture/jdwp-transport.ts` |
| DDMS窗口核验及树/图采集编排 | `electron/capture/view-debug.ts` |
| JDWP安全位图补采 | `electron/capture/view-bitmaps.ts` |
| 窗口与图片协议解析 | `electron/capture/view-protocol.ts` |
| 图层几何与匹配 | `electron/capture/layer-images.ts` |
| 控件/分支/列表刷新 | `electron/capture/refresh.ts` |
| SDK连接与取消 | `electron/sdk/provider-session.ts`、`electron/sdk/provider-session-request.ts` |
| Android准入、生命周期和串行调度 | `HierarchyProvider.java` |
| Android会话和请求解码 | 同目录`HierarchySession.java` |
| Android控件树、属性及布局编码 | 同目录`HierarchyTree.java` |
| Android取图参数、目标选择、批量调度与窗口核验 | 同目录`HierarchyCapture.java` |
| Android主线程帧、几何核验及特殊缓冲 | 同目录`CaptureFrame.java`、`IsolatedCapture.java` |
| Android编码、记录/文件输出和位图所有权清理 | 同目录`CaptureOutput.java` |
| 自动调试安全边界 | `electron/automation/debug-session.ts` |
| 可选Helper只读后端 | `electron/capture/accessibility-helper.ts`拥有私有令牌、HTTP限额、唯一授权窗口与自有转发；`device-actions.ts`复核App/几何，`debug-session.ts`撤销切源旧共享并拒绝Helper输入；对比脚本复用此HTTP读取 |
| 当前树、选中、展开、聚焦/隐藏、双击偏好、菜单动作及采集/历史/自动调试接管 | `src/features/inspection/useInspectionWorkspace.ts` |
| 树行/搜索/键盘 | `src/components/UiTree.tsx`拥有临时搜索路径、焦点/滚动；`shared/tree-utils.ts`共用匹配和命中来源；真实展开仍归工作台hook |
| 菜单/右键/快捷键 | `shared/workbench-commands.ts`拥有动作名称、快捷键及可用条件；`src/App.tsx`统一分发，无原生菜单时才处理页面快捷键；`electron/desktop/application-menu.ts`拥有原生菜单，`electron/main.ts`复用右键标签，IPC校验仍归桌面边界 |
| 首页设备状态 | `shared/device-state.ts`区分连接/加载/无设备/未授权/离线/缺ADB/错误；`DeviceHomeView.tsx`展示状态和设备弹窗；App隔离重复/迟到探测并拒绝失效设备 |
| 偏好/入口弹窗 | `EntryDialog.tsx`拥有原生弹窗和关闭后焦点恢复，`PreferencesPanel.tsx`展示偏好及快捷键，`src/styles/entry.css`只管这些入口样式；双击偏好仍由工作台hook保存，不另建状态存储 |
| 工作台布局/工具/分隔条 | `src/components/AppHeader.tsx`拥有顶部容器；App挂载现有工具；`TreePaneResizer.tsx`拥有宽度；`src/styles/workbench.css`只管布局 |
| 属性卡片/浮窗 | `src/components/NodePropertiesPanel.tsx`拥有显示/收起/搜索及停靠/浮动状态，内部`InspectorGroup`保存用户折叠与临时搜索展开；`shared/inspector-groups.ts`核验七组显隐，`useInspectorGroups.ts`保存本机设置，`InspectorGroupPreferences.tsx`复用偏好入口。隐藏只改显示，搜索按匹配临时显示；诊断显式定位恢复贴边，内容样式仍在`App.css`。App复用统一复制回调，按节点/快照和请求隔离迟到反馈 |
| 画布手势/缩放与2D适应 | `src/components/ScreenshotPreview.tsx`拥有指针生命周期、键盘/滚轮及视图状态；`src/features/layers/usePreviewViewport.ts`观察当前画布与覆盖属性栏，`shared/preview-viewport.ts`计算可见矩形 |
| 界面授权事件、共享及迟到回复 | `src/features/automation/useDebugSession.ts` |
| CLI/MCP命令 | `electron/automation/cli.ts`、`electron/automation/mcp-server.ts` |
| 3D场景/适应与悬停 | `src/features/layers/Layer3DPreview.tsx`按可见矩形适应实际图层角点，负责场景/标签/测距；不重复拥有外层手势 |
| GPU资源、着色器与绘制 | `src/features/layers/webgl-renderer.ts` |
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
- `src/`不直接执行ADB、访问文件或引用主进程；桌面能力只走`window.electronApi`。
- 当前树与请求由工作台hook拥有；历史和自动调试用`showSnapshot`接管，不在App重复写树。授权hook不直接依赖采集hook，由App连接；授权决定仍在主进程。
- 离线测试报告只展示已保存证据，不采集手机、不接管工作台快照或调试授权；文件读取由主进程选择器确认，renderer只接核验后的结构化数据与PNG data URL。显式当前页面诊断独立发起一次只读请求，由App经工作台hook接管快照并连接树/属性显示；不是重放报告。产品不导入实验子项目或报告HTML。
- `device/`和`platform/`不反向执行采集、SDK、自动调试或桌面入口。仅类型引用不生成运行依赖。
- `main.ts`负责启动和IPC流程；菜单、导出、存储有自己的模块，不逐个状态增加服务或工厂。
- 复杂采集流程可以保留编排，但解析、几何和协议规则应放在所属模块。直接导入，不用旧路径转发层。
- JDWP传输不依赖采集编排；窗口/图片协议解析不做连接或设备操作。位图补采拥有编号、暂停/恢复与清理，窗口入口只编排DDMS流程。
- Android Provider拥有授权、Activity生命周期及数据请求锁；会话负责传输，树不执行取图或线程调度，取图不依赖Provider/会话。实时Activity和tree-ready回调由Provider提供，不固定旧Activity，不另建请求锁。
- SDK采集入口保留流程编排；帧模块不依赖输出/入口，输出只接复制的画面/几何和标识，不读取活View或排UI任务。样例反射及故障注入直接跟随实际所属类，不留旧方法转发壳。
- TypeScript/JavaScript产品模块的运行依赖不得成环。`tests/architecture.test.ts`检查静态/动态导入、直接require、内联createRequire、边界、循环、旧入口及目录导航；类型导入不算运行依赖。不对任意动态表达式或别名作完整静态分析。
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

默认使用Codex管理的Git worktree，规则见[AGENTS.md](../AGENTS.md)。原目录含未提交成果时，先用临时Git索引保存共同源码基线，保留原分支、暂存区和文件；新工作树包含这些成果。本轮属性分组使用共同基线`9e584a9e1179`，并行分工如下：

| 工作树 | 所负责内容 |
| --- | --- |
| `property-groups-model` | 设置模型、保存与校验、偏好选项、单元测试 |
| `property-groups-ui` | App接入、属性显示/搜索/空状态和面板样式 |
| `property-groups-checks` | 实际App回归、使用与计划文档 |

每个代理的命令和文件操作显式指定自己的工作目录，只改所负责的文件。依赖版本相同时复用已有node_modules，源码、构建产物和测试输出分别留在各自工作树。整合只移入已确认的改动，随后运行相关检查、类型检查和构建；保留仍需使用的工作树，不再需要时用Codex归档工具处理。

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

Android在配置JDK17和Android SDK后构建，不安装到手机：

```sh
gradle -p android :inspector-sdk:assembleDebug :inspector-sdk:assembleRelease :sample-app:assembleDebug :sample-app:assembleRelease --console=plain
```

`test:tree-ui`也执行脱敏70节点样本的授权/历史交接回归；样本不含业务截图或原始属性，不能作为像素或实际手机同步验收。
