# UI 设计稿对齐改造计划

状态：Windows 版和固定视觉基线已实施，跨平台原生任务已接入 CI
版本：v0.1 视觉对齐改造
日期：2026-09-13

## 1. 改造目标

本计划用于把当前 Electron + React 工作台进一步对齐已确认的极简浅色 UI 设计稿。当前版本已经完成基础换肤，但实际 EXE 截图与设计稿在信息层级、垂直空间分配、工具栏编排和 3D 画布细节上仍有明显差异。

本次改造的核心不是重新实现功能，而是重排已有功能，让用户的主路径保持清晰：

```text
顶部选择设备/采集
        ↓
左侧选择 hierarchy 节点  ─────→  右侧查看 2D/3D 截图
                                      ↓
                         下方查看属性、几何尺寸、盒模型
```

必须保留的能力：

- ADB 设备发现、授权状态和设备切换；
- 顶部唯一截图采集入口；
- hierarchy 树搜索、过滤、展开、键盘导航和选中定位；
- 2D/3D 切换、节点高亮、layer 点击同步；
- 25%–1600% 缩放、适应窗口、重置、平移和 360°球面相机；
- 节点常用属性、几何尺寸、布局盒模型和原始 XML 属性；
- 本地快照保存、历史预览、diff 和导出；
- 当前 renderer sandbox、context isolation、preload 白名单和只读 ADB 边界。

明确不在本次范围内：

- 不新增 ADB 点击、输入、滑动或其他写设备命令；
- 不把 UIAutomator hierarchy 伪装成应用内部真实 RenderNode/Z 序；
- 不新增 WebView/CDP computedStyle 实现；
- 不修改历史快照数据格式；
- 不为了匹配设计稿而把 3D 默认姿态改成容易造成“整屏倾倒”的斜视角。

## 2. 对照基线和证据

### 2.1 对照文件

设计稿：

```text
C:/Users/zhaojiaxiang/.codex/generated_images/01a0911f-5948-7070-8302-52951e7231b6/exec-4e93862c-4c04-4cd5-bf8b-8c063c69606e.png
```

当前打包版实机截图：

```text
F:/develop2/android-ui-inspector/.benchmarks/app-smoke/2026-09-13T14-04-25-034Z/layers3d.png
```

设计稿约为 `1587 × 1000`，实际实机截图约为 `1264 × 816`。两张图不是同一窗口尺寸，因此验收时既要做比例对照，也要在相同 viewport 下重新截图，不能只比较绝对像素。

### 2.2 实机截图状态说明

当前 `layers3d.png` 是冒烟脚本在完成 Alt+拖动 3D 旋转之后截取的，不是干净的默认正面状态。因此画布中的较大倾角不能全部归因于布局问题。后续视觉基线必须在以下状态截图：

- 设备已连接；
- hierarchy 已采集；
- 选择一个有有效 bounds 的节点；
- 3D 已打开但相机执行“重置”；
- 缩放为 100%；
- 没有打开快照历史详情或 diff 详情；
- 没有搜索过滤条件；
- 动画已完成或启用 reduced-motion。

## 3. 差距清单

### 3.1 P0：信息层级和垂直空间分配

这是影响最大的一组问题，需要优先处理。

| 区域 | 设计稿 | 当前 EXE | 影响 |
| --- | --- | --- | --- |
| 顶部到主工作区 | Toolbar 后直接进入左右工作区 | Toolbar 后又有“界面层级”标题区 | 主工作区整体下移 |
| 右侧顶部 | 直接显示 2D/3D、缩放和 Orbit 工具 | 先有“设备画面”标题，再有“快照与历史”，再有多行工具栏 | 工具分散且占用高度 |
| 画布高度 | 右侧主体区域的大部分高度 | 当前约 350px，纵向空间不足 | 3D 层级不够舒展 |
| 属性面板 | 三列内容完整可见 | 截图底部只能看到属性标题，内容被截断 | 节点分析主功能不可见 |
| 左侧树 | 树内容从顶部较早开始 | 搜索、复选框、展开按钮占据大量顶部空间 | 可见节点数减少 |

改造结论：应先重排布局行，而不是继续微调颜色或字体。右侧属性面板必须成为正常窗口尺寸下的可见内容，不应依赖用户继续滚动才能看到第一行属性。

### 3.2 P0：右侧工具栏拆分

设计稿将主要查看控制放在一个紧凑的水平工具带中：

```text
[2D] [3D 层级]       [适应] [重置]       [−] 100% [+]      Orbit / Yaw / Pitch / 距离
```

当前 EXE 分成多个逻辑区域：

1. 2D/3D 切换和缩放按钮；
2. 包含父级、包含子级、范围选择；
3. 层间距滑块；
4. 视距滑块和 Yaw/Pitch 状态。

这导致右侧工具栏在 1264×816 窗口中占据过高的垂直空间。应将常用操作放在首行，把低频 3D 参数收纳为紧凑的辅助区或可折叠区；宽窗口下保持一行，窄窗口下才换行。

### 3.3 P0：节点属性区域不可见

设计稿在画布下方直接呈现：

- 常用属性；
- 几何尺寸；
- 布局盒模型。

当前实际窗口中，属性区域位于截图状态文字之后，首屏底部只能看到“常用属性”“几何尺寸”“布局盒模型”的标题，属性行和盒模型图被窗口底部裁掉。

改造要求：

- 在 `1264 × 816` 视口下至少完整显示三个分栏的标题和第一批核心字段；
- 在 `1587 × 1000` 视口下完整显示三个分栏的主要字段；
- 原始 XML、选择器和导出操作可以继续位于属性卡片之后，通过右侧滚动查看；
- 不能通过缩小到难以阅读的字体来“挤出”空间。

### 3.4 P1：左侧功能重复且密度偏高

设计稿左侧主要展示层级树，当前 EXE 同时出现：

- 顶部全局搜索；
- 左侧树内搜索框；
- “可操作”“有标识”复选框；
- 全部展开、全部折叠、定位选中按钮；
- 树标题和节点数量。

这些功能本身都需要保留，但呈现方式需要调整：

- 顶部全局搜索继续作为默认搜索入口，并与 `treeQuery` 共用状态；
- 左侧局部搜索不再和全局搜索重复占据显眼位置，可改成树面板内的“高级筛选”折叠区；
- 复选框和展开操作放入紧凑工具带；
- 树标题、节点数量和折叠按钮保持一行；
- 只有在窄窗口或用户展开高级筛选时才增加额外行。

### 3.5 P1：当前实际多出设计稿没有的上下文栏

当前 EXE 比设计稿多出以下区域：

- `UIAUTOMATOR HIERARCHY / 界面层级 / 返回设备` 区域；
- 右侧 `设备画面 / serial` 区域；
- `快照与历史` 常驻摘要条；
- 画布下方较高的坐标和操作提示区。

这些信息不是全部无用，但不能都以独立大行显示。处理方案：

- 将“界面层级”变为紧凑上下文标题，或和左侧“层级树”合并；
- 将设备序列号和截图方向放入右侧工具栏的次要文字；
- 快照历史保留 `<details>` 和保存/清空/预览/diff 功能，但默认只显示一行摘要；
- 坐标核对信息保留为画布底部状态条，压缩为单行并支持超长文本省略。

### 3.6 P1：3D 画布缺少设计稿中的视觉锚点

设计稿中的 3D 画布包含：

- 淡灰色透视地面网格；
- 右下角 X/Y/Z 坐标轴指示器；
- 柔和的中心光晕；
- 透明层级向后展开；
- 设备截图保持可识别且不被过度倾斜。

当前 EXE：

- 背景较平，透视网格不明显或没有；
- 没有坐标轴指示器；
- 画布右侧有滚动条；
- 画布边缘出现偏橙色的强调边框；
- 自动化拖动后的层面倾角较大，视觉重心偏移。

改造要求：

- 为 `Layer3DPreview` 增加纯 renderer 的轻量网格层和坐标轴 gizmo；
- 网格和 gizmo 不能参与节点命中测试；
- 普通 overflow 滚动条隐藏或改成和浅色主题一致的细滚动条；
- 画布外框使用中性灰，橙色只用于警告状态，不用于正常选中画布；
- 3D 默认仍为 yaw=0、pitch=0 的安全正面姿态，设计稿的轻微透视只作为视觉构图参考；
- 通过“重置”回到正面后再生成视觉基线截图。

### 3.7 P1：Toolbar 控件和品牌细节未完全对齐

设计稿与当前 EXE 的差异包括：

- 设计稿采集按钮使用相机图标和“采集截图”；当前为黑点和“重新采集”；
- 设计稿 Toolbar 留白更宽，当前在 1264px 窗口中控件间距较紧；
- 设计稿左上角是简洁的窗口/品牌标识，当前是绿色方形减号标识；
- 设计稿字体层级更明显，当前部分辅助文字过小；
- 设备型号、授权状态、刷新按钮和搜索框的宽度比例不同。

改造原则：

- 保留 Windows 窗口可用性，不直接复制 macOS traffic-light 作为真实系统按钮；
- 将采集按钮恢复为明确的相机符号 + 采集语义；
- 在宽窗口中扩大 Toolbar horizontal padding 和控件间距；
- 在窄窗口中按优先级压缩设备信息和辅助文字，而不是压缩主按钮可读性；
- 重新定义标题、section heading、辅助标签和 monospace 状态文字的字号层级。

### 3.8 P2：截图数据和 UI 状态导致的视觉误判

设计稿展示的是 Settings 页面、多个深度层和一个已选中 TextView；当前实机截图展示的是另一部手机页面和 `FrameLayout/LinearLayout/content` 节点。以下差异属于数据不同，不应通过 UI 改造强行消除：

- 节点数量、class、text、resource-id 不同；
- 手机截图内容不同；
- layer 数量和层叠形状不同；
- 真实设备序列号和型号不同。

后续验收应使用脱敏固定 fixture 做布局基线，再使用真实手机做功能验收。不要把真实手机截图或 XML 提交到仓库。

## 4. 目标信息架构

### 4.1 宽窗口目标（≥1200px）

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 品牌/标题 │ 设备选择 │ 连接状态 │ 刷新 │ [采集截图] │ 全局搜索              │  64px
├────────────────────────────────────────────────────────────────────────────┤
│ 层级树                         │ 2D/3D  适应 重置  缩放  Orbit/参数         │  52px
│ 节点数量                       ├─────────────────────────────────────────────┤
│ 紧凑高级筛选（默认收起）       │                                             │
│                                │           2D/3D 截图画布                   │  flex
│ hierarchy 虚拟列表             │           网格、gizmo、layer                │
│                                ├─────────────────────────────────────────────┤
│                                │ 坐标/方向/提示状态条                        │  28px
│                                ├─────────────────────────────────────────────┤
│                                │ 常用属性 │ 几何尺寸 │ 布局盒模型             │  220px+
└────────────────────────────────────────────────────────────────────────────┘
```

目标比例：

- Toolbar：`64–68px`；
- 左侧树：主工作区宽度的 `28%–31%`，最小 `280px`；
- 右侧工具栏：`48–56px`；
- 画布：右侧剩余高度的 `50%–60%`，最小 `260px`；
- 状态条：`24–30px`；
- 属性面板：最小 `210–240px`，正常窗口首屏可见；
- 快照历史默认只占一行，展开后在右侧滚动区域内显示。

### 4.2 窄窗口目标（≤1100px）

- Toolbar 允许第二行，但采集按钮和全局搜索不能消失；
- 左树宽度降到 `260px`，不得低于 `230px`；
- Orbit 低频参数进入折叠行；
- 属性三个分栏可以从三列变为纵向堆叠；
- 右侧画布和属性面板使用同一个纵向滚动容器；
- 不得让整个 Electron window 因 3D transform 发生倾斜或横向溢出。

### 4.3 手机/小窗口目标（≤850px）

- 维持现有响应式单列 fallback；
- 树和预览纵向排列；
- 属性分栏纵向排列；
- 搜索、采集、设备切换仍可操作；
- 本次不追求与宽桌面稿完全相同，只保证功能和层次清楚。

## 5. 代码改造方案

### 5.1 `src/App.tsx` 结构调整

保留现有状态和 callback，优先做 DOM 层级重排：

1. 将设备选择、连接状态、刷新设备、唯一采集按钮和全局搜索固定在顶层 Toolbar。
2. 将当前独立的 `inspector-heading` 压缩为上下文信息行，避免单独占据大块高度。
3. 将左右 `inspector-grid` 作为检查工作台的主要 flex/grid 容器。
4. 将右侧 `snapshot-drawer` 改成紧凑摘要，不让空历史记录占据多行。
5. 将 `ScreenshotPreview` 的 2D/3D 控制、截图画布、状态条和节点详情作为右侧连续区域。
6. 将左侧局部搜索和高级过滤控制收纳为可折叠区域，但继续复用 `treeQuery`、`interactiveOnly` 和 `identifiedOnly` 状态。
7. 不删除现有导出、原始 XML、快照 diff 和树键盘导航 DOM 入口，避免破坏自动化测试。

如果 JSX 继续变得过长，再拆分以下纯展示组件：

- `src/components/InspectorToolbar.tsx`：设备、连接、采集、全局搜索；
- `src/components/HierarchyToolbar.tsx`：节点计数、折叠、定位、高级过滤；
- `src/components/InspectorContextBar.tsx`：层级摘要、设备序列号、快照摘要；
- `src/components/OrbitGizmo.tsx`：3D 坐标轴和方向提示。

拆分的前提是状态仍由 `App.tsx` 统一持有，不能在组件之间复制 selected node 或 snapshot 状态。

### 5.2 `src/components/ScreenshotPreview.tsx`

- 把 2D/3D 切换、缩放和相机控制整理为单一 `preview-toolbar`；
- 常用控制优先显示：2D/3D、适应、重置、缩放；
- 低频控制保持现有功能，但收纳在同一工具栏的辅助区或折叠区；
- 画布和 `NodePropertiesPanel` 之间只保留一个紧凑状态条；
- 重置操作必须同时恢复缩放、平移和安全正面相机；
- 继续使用实际 image/stage layout 尺寸，不能改回外层 `transform: scale()`；
- 保持 2D 命中和 3D layer 点击的数据契约不变。

### 5.3 `src/components/Layer3DPreview.tsx`

- 增加不接收鼠标事件的 `.layer-grid` 背景层；
- 增加不接收鼠标事件的 `.orbit-gizmo`，显示 X/Y/Z 方向；
- 将 gizmo 固定在 viewport 右下角，不随 layer plane 的 DOM 点击区域移动；
- 继续使用共享 `OrbitCamera` 和 `data-node-id`；
- 默认姿态保持 `yaw=0/pitch=0/roll=0`；
- 视觉基线时使用 `reset` 之后的截图，不依赖测试脚本拖动后的状态；
- layer plane 阴影、透明度和选中绿色边框统一为浅色主题 token。

### 5.4 `src/components/NodePropertiesPanel.tsx`

- 保留三栏信息结构和所有字段；
- 将第一批核心字段放在每栏最上方，确保首屏可见；
- 对超长 class、package、resource-id 使用省略 + title，而不是把列撑宽；
- 盒模型图保留“未暴露”语义，不把未知 CSS 值填成 0；
- 原始 XML 和导出操作继续放在三栏下方；
- 设计稿的文字较大，不能只通过降低属性文字到不可读尺寸解决空间问题。

### 5.5 `src/App.css` 样式清理

当前样式文件是在旧深色主题后追加一大段浅色 override，后续容易出现“旧规则仍影响新布局”的问题。本次实施时要把样式从“末尾覆盖”整理成清晰分区：

```text
1. :root 颜色和尺寸 token
2. 全局 reset / typography
3. 顶部 Toolbar
4. 设备态和空状态
5. 检查工作台 grid
6. 左侧 hierarchy
7. 右侧 preview toolbar / canvas / status
8. 节点属性和盒模型
9. 快照历史 / diff
10. 响应式断点
11. reduced-motion
```

样式要求：

- 删除已失效的深色背景、深色文字和与浅色主题冲突的重复规则；
- 用 CSS custom properties 统一 line、surface、text、muted、accent、warning；
- 避免同一个选择器在文件末尾被多次覆盖；
- 所有 3D transform 限定在 `.layer-scene` 或 layer plane 内；
- `body`、`.app-shell` 和 `.workspace` 不得因为 3D 状态产生旋转、skew 或横向溢出；
- 正常状态不使用橙色画布外框，橙色只用于 mismatch、warning 或不可用状态；
- 滚动条使用浅色主题样式，3D 画布默认不出现浏览器原生粗滚动条。

## 6. 分阶段实施顺序

### P0：建立固定视觉基线

- [x] 增加脱敏固定 hierarchy 和固定截图 fixture，避免真实手机页面差异影响视觉判断。
- [x] 增加固定 viewport 截图：`1264×816`、`1440×900`、`1587×1000`。
- [x] 规定截图前自动执行 100% 缩放、相机重置、清空搜索和关闭快照详情。
- [x] 记录当前版本的关键 DOM rect 和 computed style，形成改造后视觉基线报告。

交付物：视觉基线截图、DOM 尺寸 JSON、问题清单。

### P1：重排工作台骨架

- [x] 压缩/合并检查标题区、设备画面标题区和快照摘要区。
- [x] 让左右主工作区从 Toolbar 下方尽早开始。
- [x] 设置右侧 `preview-pane` 为明确的纵向 grid/flex，画布和属性面板共享剩余高度。
- [x] 确保 `1264×816` 下属性三栏标题和第一批字段可见。

验收重点：页面不再出现“画布很小、属性只露标题”的情况。

### P2：重编排 Toolbar 和左侧树工具

- [x] 右侧 2D/3D、适应、重置、缩放和 Orbit 状态整理为一条主工具栏。
- [x] 层间距、范围、包含父子等低频参数收纳到辅助区。
- [x] 左侧局部搜索/过滤改为高级筛选，默认折叠或压缩。
- [x] 顶部全局搜索继续绑定同一个 tree query，并验证 `Ctrl/⌘+K`。

验收重点：宽窗口下一行看清主要操作，功能没有丢失或产生两套筛选状态。

### P3：画布视觉补齐

- [x] 增加透视地面网格和右下角 X/Y/Z gizmo。
- [x] 修正画布外框、滚动条、层面阴影和背景光晕。
- [x] 统一正常状态、选中状态、warning 状态的边框颜色。
- [x] 校验 3D transform 只影响画布内部，不影响整个窗口。

验收重点：默认正面安全姿态、手动旋转仍可到背面和顶部、窗口不倾倒。

### P4：属性区和响应式细节

- [x] 调整属性三栏的最小高度、列宽和字号层级。
- [x] 让 class、resource-id 等长字段省略而不撑破布局。
- [x] 校验盒模型卡片在 1264px 实机视口可读；1587px 固定 fixture 仍待补充。
- [x] 完善 1100px、850px、560px 断点下的换行和滚动策略。

验收重点：属性信息可见、可读，且不牺牲 2D/3D、树和采集功能。

### P5：视觉回归和打包版验收

- [x] 运行静态检查、单测、树 UI、坐标、DPI 和生产构建。
- [x] 使用固定 fixture 生成三种 viewport 的改造后截图；报告写入 `.benchmarks/visual-baseline/`。
- [x] 使用当前授权 Android 实机验证开发版。
- [x] 重新生成 Windows NSIS 安装包。
- [x] 使用打包版验证标题、Toolbar、树、画布、属性、快照和 3D 操作。
- [x] 在截图前通过重置回到 100%/Yaw 0°/Pitch 0°，并保留拖动后的 3D 交互证据图。

交付物：改造后视觉截图、开发版报告、打包版报告、安装包 SHA-256、计划文档更新。

## 7. 可量化验收标准

### 7.1 视觉布局

- [x] `1264×816`：Toolbar、左右主工作区、右侧画布和属性三栏均在首屏出现；属性区至少显示标题和 3 行核心字段。
- [x] `1587×1000`：右侧画布占主要面积，属性三栏的主要字段和盒模型主体完整可见。
- [x] 宽窗口 `≥1200px` 时主要预览操作保持一行，不能因为低频参数形成三层以上工具栏。
- [x] 左右栏比例稳定在约 `30/70`，左侧不因树工具条异常扩张。
- [x] 右侧画布高度不低于可用右侧空间的约 `50%`，同时给属性区保留最小 `210px`。
- [x] 正常状态不出现粗浏览器滚动条、橙色调试边框或旧深色背景残留。
- [x] 字体层级至少区分产品标题、区域标题、属性标签、属性值和辅助状态文字。

### 7.2 功能回归

- [x] 顶部只存在一个主截图采集按钮。
- [x] 全局搜索、局部高级过滤、清空搜索和 `Ctrl/⌘+K` 仍然可用。
- [x] 左侧树选择会更新 2D 高亮、3D layer、breadcrumb 和属性面板。
- [x] 画布点击会反向定位树节点，筛选状态和祖先展开行为不变。
- [x] 25%–1600% 缩放、适应、重置和 Ctrl/⌘+滚轮坐标锚点不回归。
- [x] 3D Alt/右键旋转、空格/Shift/中键平移、方向键旋转和 layer 点击不回归。
- [x] 快照保存、历史加载、diff、JSON/XML/PNG 导出不回归。
- [x] screenshot geometry mismatch 时仍然禁止误导性的 2D/3D 定位高亮。

### 7.3 安全和性能

- [x] `contextIsolated === true`、`nodeExposed === false`、renderer errors 为空。
- [x] 不增加 ADB 写命令，不改变 preload 白名单之外的访问。
- [x] 3D 网格和 gizmo 不进入 layer hit-test，不影响节点选择。
- [x] 大树虚拟列表、layer 数上限和 25,000 节点布局基准保持当前结果。
- [x] reduced-motion 下新增网格/gizmo 不引入必须播放的动画；layer 动画仍正确关闭。

## 8. 测试和工具计划

### 8.1 自动化检查

继续使用现有命令：

```powershell
bun x tsc --noEmit
bun test tests
bun run test:tree-ui
bun run test:coordinates
bun run test:dpi
bun run build
```

补充一个视觉基线脚本或扩展现有 `scripts/app-smoke.mjs`，至少检查：

- `topbar`、`inspector-grid`、`preview-toolbar`、`screenshot-frame`、`node-details` 的 bounding rect；
- 设计稿关键区域是否存在；
- `getComputedStyle` 中不再出现正常态深色背景和橙色画布边框；
- 属性面板的可见高度是否达到阈值；
- 3D 默认相机状态是否为 yaw/pitch 0，且重置后 transform 稳定；
- 视口内是否存在不应出现的水平滚动溢出。

### 8.2 人工检查

使用同一固定 fixture 和同一 viewport，检查：

1. 初始检查工作台是否接近设计稿的空间分配；
2. 点击根节点、深层节点和没有 text 的节点；
3. 切换 2D/3D、重置相机和 100%/200% 缩放；
4. 展开高级过滤、打开快照历史和 diff；
5. Alt+拖动到前、后、左、右、上、下视角；
6. 在窗口宽度变化后确认不出现整窗倾倒和横向溢出；
7. 使用真实 Android 实机确认内容数据变化不会破坏布局。

### 8.3 打包验收

```powershell
bun run package:win
node scripts/app-smoke.mjs --packaged --require-device
```

打包版验收报告需要记录：

- 安装包相对路径、文件大小和 SHA-256；
- 实机序列号不写入公开文档正文，只保存在本机 `.benchmarks/`；
- 视觉基线截图路径；
- 设备截图尺寸、方向和 hierarchy 模式；
- 3D layer 数、默认相机 HUD、属性面板可见性；
- sandbox、context isolation、Node 暴露和 renderer errors。

## 9. 风险、回滚和取舍

| 风险 | 预防 | 回滚点 |
| --- | --- | --- |
| 压缩标题区后用户找不到层级上下文 | 保留紧凑上下文行和节点计数 | 恢复标题区但不恢复多层空白间距 |
| 收起局部筛选导致高级功能难找 | 高级筛选有明确入口，状态继续显示 | 暂时恢复局部工具条 |
| 属性区增高导致截图画布过小 | 用 grid 行约束，设置画布和属性双重最小值 | 恢复当前可用布局，单独调整窗口阈值 |
| 增加网格/gizmo 影响 3D 命中 | `pointer-events:none`，增加 DOM 命中回归 | 关闭装饰层，保留 layer 交互 |
| CSS 清理引入旧功能样式回归 | 每阶段运行现有 smoke 和截图对照 | 保留分阶段 commit 或按区块恢复样式 |
| 设计稿的轻微倾角诱发整屏倾倒 | 默认姿态继续为 0/0，倾角只由用户手势产生 | 立即回到正面相机默认值 |
| 真实手机内容不同造成“没对齐”的误判 | 固定脱敏 fixture + 实机功能双轨验收 | 不修改数据解析和树算法 |

## 10. 当前实施记录

### 10.1 代码落地

- [x] `src/App.tsx`：顶部增加返回设备次要操作；检查页标题区不再占用主工作区高度；左侧局部搜索保留，高级过滤默认收起；采集按钮统一显示“采集截图”。
- [x] `src/components/ScreenshotPreview.tsx`：右侧主工具栏一行化；3D 层级设置收纳到弹出式低频设置；画布视口增加浅色网格和坐标轴 gizmo。
- [x] `src/components/Layer3DPreview.tsx`：保留 layer plane、breadcrumb 和原有命中逻辑，装饰层不参与节点选择。
- [x] `src/App.css`：浅色主题下重新分配检查页行高、左右栏、画布和属性区；增加响应式断点、滚动条、选中边框和网格/gizmo 样式。
- [x] `scripts/app-smoke.mjs`：增加工作区 rect、属性可见高度、工具栏高度、横向溢出、网格/gizmo/低频设置存在性断言。

### 10.2 最新验收

- [x] `bun x tsc --noEmit`、`bun test tests`：56 项通过。
- [x] `bun run build`：renderer CSS/JS 和 Electron 主进程构建通过。
- [x] `bun run test:tree-ui`：树行为和 125% 页面缩放回归通过。
- [x] `bun run test:coordinates`：100%/125%/150% 各 25 组，共 75 组通过。
- [x] `bun run test:dpi`：devicePixelRatio 1/1.25/1.5 各 25 组通过。
- [x] 开发版授权 Android 实机报告：`.benchmarks/app-smoke/2026-09-13T14-48-10-465Z/`，16 项通过，窗口 `1264×815`；右侧画布 `408.4px`、节点详情 `230px`，无横向溢出，renderer errors 为空。
- [x] Windows 打包版授权 Android 实机报告：`.benchmarks/app-smoke/2026-09-13T14-50-23-332Z/`，16 项通过；sandbox/context isolation 正常、Node 未暴露、renderer errors 为空。
- [x] 最终 NSIS：`release/Android UI Inspector Setup 0.1.0.exe`，112,319,424 字节，SHA-256 `2AA4BB06A53684E5325929E7B0CFCEC7AB52234751D37F02E1971B4AE78B608B`。

### 10.3 固定基线与环境回归

- [x] 新增 `tests/fixtures/visual-screen.svg` 和固定 `uiautomator-portrait.xml` 组合；截图与 hierarchy 共用 `1080×2400` 坐标空间，不含真实设备数据。
- [x] 新增 `scripts/visual-baseline.mjs` 和 `bun run visual:baseline`，在 `1264×816`、`1440×900`、`1587×1000` 三个精确 viewport 生成 `app.png`、`layers3d.png` 和 `result.json`。
- [x] 三种固定 viewport 已通过完整 fixture smoke，最新报告为 `.benchmarks/visual-baseline/2026-09-13T16-09-50-058Z/`；三组 screenshot 均为 `1080×2400`，左右布局、属性区、3D 网格/gizmo、低频设置和横向溢出断言通过。
- [x] 新增 `scripts/fixture-dpi-smoke.mjs` 和 `bun run smoke:fixture-dpi`，在 `devicePixelRatio=1/1.25/1.5` 下运行完整应用回归，并覆盖窗口外坐标输入后的手势清理；最新报告为 `.benchmarks/fixture-dpi-smoke/2026-09-13T16-18-07-857Z/`。
- [x] 新增 `scripts/packaged-startup.mjs`，可在当前平台发现并启动 `release/` 中的原生包，检查标题、preload 沙箱、上下文隔离、Node 暴露和 renderer errors。
- [x] 新增 `.github/workflows/native-electron.yml`，在 Ubuntu/macOS/Windows runner 执行固定 fixture 冒烟，并在三平台构建/启动打包应用后上传 release artifact。
- [ ] 真实 Windows 设置中的物理 OS DPI、多显示器 Per-Monitor DPI、桌面窗口外释放鼠标，以及首次 GitHub Actions 三平台运行仍需要对应外部桌面/runner 产生最终环境证据；本机可重复的代理和 workflow 已完成。

最新 Windows 打包版补充记录：`2026-09-13T16:09:00Z` 的 `.benchmarks/app-smoke/2026-09-13T16-09-00-319Z/` 通过 16 项真实设备冒烟；`scripts/packaged-startup.mjs` 于 `2026-09-13T16:08:45Z` 通过，报告为 `.benchmarks/native-packaged/2026-09-13T16-08-45-560Z/`。

### 10.4 首页极简改造与可读性优化（2026-09-13）

- [x] 使用 ImageGen 生成新的首页视觉参考：[docs/design/main-interface-redesign-v2.png](design/main-interface-redesign-v2.png)。
- [x] `src/App.tsx` 将旧首页的 Hero、指标网格、状态横幅和设备/准备面板改为“已连接设备 + 开始之前”双卡片结构，减少重复状态信息和视觉噪声。
- [x] 截图采集动作仍只保留在顶层 Toolbar；首页仅用文字引导用户使用 Toolbar，不新增第二个截图按钮。
- [x] `src/App.css` 统一使用 Segoe UI Variable / Microsoft YaHei 系统字体栈，增大首页标题、步骤标题、正文和检查工作台树/属性文字，增加行高、留白和卡片内边距。
- [x] 检查工作台进入时隐藏首页，确保返回/进入状态不会出现两套主界面叠加。
- [x] 新增 `scripts/home-visual-baseline.mjs` 与 `bun run visual:home`，使用固定 fixture 在三种桌面 viewport 检查首页布局、字号、Toolbar 高度、旧模块移除、单一采集入口和水平溢出。
- [x] 首页三种 viewport 的视觉基线已通过，报告为 `.benchmarks/home-visual-baseline/2026-09-13T16-09-29-012Z/`；1264×816、1440×900、1587×1000 均检查双卡片、可读字号、单一 Toolbar 采集入口、旧模块移除和无水平溢出。
- [x] 最终源码通过 `bun test tests`（56 项）、`bun run test:tree-ui`、`bun run test:coordinates`（75 组）、`bun run test:dpi`（3×25 组）、`bun run smoke:fixture-dpi`（3 档）和完整 fixture smoke。
- [x] 最终 Windows 打包版通过启动探针与 16 项真实 Android 实机冒烟；最终 NSIS 为 112,319,424 字节，SHA-256 `2AA4BB06A53684E5325929E7B0CFCEC7AB52234751D37F02E1971B4AE78B608B`。

## 11. 完成定义

只有以下条件全部满足，才将本阶段标记为完成：

- [x] `1264×816` 关键窗口尺寸下，信息层级和属性可见性达到目标；`1440×900`、`1587×1000` 固定 fixture 也已通过。
- [x] 设计稿中的浅色、双栏、单一主 Toolbar、右侧画布 + 属性结构在实际 EXE 中可直接辨认。
- [x] 3D 网格、坐标轴、层级展开和安全正面默认姿态均已验证。
- [x] 现有 2D/3D、缩放、相机、树、属性、快照、导出和坐标回归全部通过。
- [x] 开发版和 Windows 打包版实机冒烟均通过，renderer errors 为空。
- [x] README、总计划、Windows 启动记录和本计划中的报告路径、包校验值已同步。
- [x] 未把真实手机 XML、PNG、快照或 `.benchmarks/` 产物提交到仓库。
- [x] 固定 fixture、三种 viewport、DPI 代理、窗口外输入清理代理、原生包启动脚本和三平台 CI 编排均已完成；最新 Windows 包为 112,319,424 字节，SHA-256 `2AA4BB06A53684E5325929E7B0CFCEC7AB52234751D37F02E1971B4AE78B608B`。
- [ ] 物理 Windows OS DPI/多显示器和首次三平台 CI 运行的环境证据仍待外部 runner/桌面产生。

## 12. 关联文档

- 总体路线：[ANDROID_UI_INSPECTOR_PLAN.md](../../ANDROID_UI_INSPECTOR_PLAN.md)
- 开发目录：[DEVELOPMENT_STRUCTURE.md](DEVELOPMENT_STRUCTURE.md)
- 截图坐标：[SCREEN_COORDINATES.md](SCREEN_COORDINATES.md)
- Windows 启动和打包记录：[WINDOWS_STARTUP.md](WINDOWS_STARTUP.md)
- 项目入口：[README.md](../README.md)
