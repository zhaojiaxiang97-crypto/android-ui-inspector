# Lookin UI 与交互第二轮优化计划

日期：2026-10-13。状态：6项源码已实现并完成整合验证。安装版保持此前候选。

本轮改善“辨认控件 → 确认查看范围 → 读属性 → 连续比较”的过程。三个子代理分别在独立工作树完成树与导航、画布、属性分工，再统一接入 App和偏好设置。结果见[实施结果](#implementation-results)，使用见[第一次使用](FIRST_USE.md#tree-row-mode)。

## 1. 基线与借鉴原则

前一轮[7项计划](LOOKIN_UI_INTERACTION_PLAN.md)已经合入源码：紧凑属性栏、工具状态、2D/3D测距与复制、内部候选过滤、搜索建议、查看历史及外观。这些沿用现有实现，不重复安排。源码和安装版本的区别见[交付说明](DELIVERY.md)。

本轮核对 Lookin Develop，固定版本为 [`95e30fd`](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530)。以下结论来自双方源码，未新增 Lookin 连接 App 的交互实测。标注“本项目扩展”的部分是建议方案，不声称 Lookin 已提供同样功能。

## 2. 优先级

| 优先级 | 项目 | 实施前情况 | 本轮要改善什么 |
| --- | --- | --- | --- |
| P0 | 树行详细显示 | 名称与短类名共用一行，完整标识主要靠提示 | 重名、深层和长 ID 更容易辨认 |
| P0 | 查看范围提示 | 筛选、聚焦和手动隐藏各有入口与提示 | 一眼看懂为什么只显示部分控件 |
| P1 | 工作区布局记忆 | 支持调整树宽、属性面板停靠/浮动 | 重新打开后继续使用习惯的布局 |
| P1 | 连续缩放 | 已有滚轮、加减、倍率预设和适应 | 少量拖动即可准确找到合适倍率 |
| P1 | 颜色显示格式 | 已有色块、源值、Hex/RGBA复制和别名 | 简化颜色字段，切换常用格式 |
| P2 | 固定属性参考 | 测距可固定 A/B，属性栏随当前选择变化 | 比较另一控件时仍能看到参考值 |

## 3. 具体方案与验收

### P0-1：树行增加详细显示模式

**借鉴依据：** Lookin 区分标题、副标题的视觉层级，并高亮其中的搜索命中。[树行实现](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L134-L177)。本项目已经有名称、短类名与命中字段，本轮增加可选的详细模式。

- 默认保留紧凑单行；详细模式第二行优先显示已有资源 ID，缺少时显示类型，避免重复名称。
- 名称优先保留，长资源 ID 尾部仍能辨认；完整值可通过提示和现有复制菜单读取。
- 模式保存在本机。两种模式各用确定的行高，切换时保留选中、展开和当前阅读节点，不直接套用旧行高的滚动像素，不改变树数据。
- **验收：** 重名节点可通过已有标识区分；512层深树、25k节点样例及窄侧栏的定位和虚拟滚动仍准确；缺少 ID 不补造标识。

入口：[UiTree](../src/components/UiTree.tsx)、[工作台样式](../src/styles/workbench.css)。

### P0-2：统一表达当前查看范围

**借鉴依据：** Lookin 会显式处理搜索与聚焦状态，聚焦时收起搜索入口以减少模式混淆。[状态处理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L122-L131)。本项目保留现有组合能力，采用范围提示条，属于改编。

- 在树上方集中显示当前条件，例如“聚焦：播放器”“筛选：TextView”“手动隐藏：3层”；没有条件时显示“当前快照”。
- 每个条件独立退出：清除筛选、退出聚焦、恢复手动隐藏。提供“恢复完整查看”的汇总操作，保留折叠偏好及不可见边界开关，不修改手机状态或重新采集。
- 原有树/画布入口保留；搜索建议、查看历史和右键定位共用当前状态，避免出现不同步的提示。
- **验收：** 从聚焦、筛选或隐藏状态退出后，原选中和必要阅读位置仍合理；设备不可见与手动隐藏清楚区分；长名称和窄窗口不遮挡树工具。

入口：[工作区状态](../src/features/inspection/useInspectionWorkspace.ts)、[UiTree](../src/components/UiTree.tsx)、[画布](../src/components/ScreenshotPreview.tsx)。

### P1-1：记住工作区布局

**借鉴依据：** Lookin 用可分隔工作区组织层级与检查内容。[工作区分隔](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/LKStaticViewController.m#L58-L87)。本项目已经支持调整和浮动，本轮的布局记忆是补充方案。

- 保存树宽、属性面板停靠/浮动选择，以及浮动位置和大小；统一提供“恢复默认布局”。
- 窗口变小或换显示器时，把面板限制在当前可见区域，保证树、画布和恢复入口可访问。
- 只保存工具布局。当前快照、临时筛选和查看历史继续遵守原生命周期，不混入布局偏好。
- **验收：** 1440×900调整后重开可恢复；切到960×700或150%页面缩放后无面板丢失；坏配置或保存失败有明确兜底。

入口：[树宽调整](../src/components/TreePaneResizer.tsx)、[属性面板](../src/components/NodePropertiesPanel.tsx)、[偏好设置](../src/components/PreferencesPanel.tsx)。

### P1-2：增加连续缩放入口

**借鉴依据：** Lookin 工具栏提供滑杆及加减按钮。[缩放控件](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Toolbar/LKWindowToolbarScaleView.m#L13-L29)。借鉴操作形式，继续使用本项目的倍率与画布算法。

- 在现有倍率入口展开小型滑杆，保留滚轮、加减、100%和适应，避免让常驻工具栏变长。
- 滑杆拖动实时更新倍率，沿用现有上下限并支持键盘微调；2D围绕可见画布中心缩放，滚轮继续以鼠标位置为锚点；3D保持当前视角，不在缩放时重置旋转。
- 窄窗口只收起滑杆，不隐藏倍率和恢复操作；拖动结束或窗口失焦后正确释放操作状态。
- **验收：** 2D/3D命中与选中框仍对齐；固定 A/B及原始 px测量不变；连续拖动不触发手机读取。

入口：[ScreenshotPreview](../src/components/ScreenshotPreview.tsx)、[画布工具样式](../src/styles/canvas-tools.css)。

### P1-3：颜色字段可切换显示格式

**借鉴依据：** Lookin 在颜色字段切换 Hex/RGBA，并保存显示偏好。[显示与偏好监听](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m#L80-L108)、[格式切换](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m#L212-L215)。

- 默认展示色块、常用格式和已有别名，原始值与其他格式收进详情；增加“Hex / RGBA / 原值”显示偏好。
- 复制按钮明确复制哪种格式；保留透明度和近似标记。未知来源或不合法颜色仍显示原值。
- 只改变字段展示，不提供远程改色或取色回写，不改变截图和快照中的颜色数据。
- **验收：** Android ARGB、QML RGBA、透明色及高精度透明度保持原语义；格式切换后搜索、复制和别名匹配仍正确。

入口：[ColorProperty](../src/components/ColorProperty.tsx)、[颜色模型](../shared/inspector-colors.ts)。

### P2-1：固定一份属性作为参考

**借鉴依据：** Lookin 使用辅助面板展示属性分组。[辅助属性面板](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardAccessoryWindowController.m#L25-L79)。固定参考及跨控件比较是本项目扩展。

- 属性栏增加“固定为参考”，最多保留一份名称、尺寸及已保存的文本/颜色；选择另一控件时参考内容保持。
- 参考卡注明所属快照和数据来源，只使用现有值；缺字段留空，不补采实时样式。
- 当前快照内可替换或关闭参考；换快照清除。局部刷新后标记参考为固定时的旧值，重新固定才更新。测距卡优先占用右侧，参考卡须避让，不挤占候选列表。
- **验收：** 固定 A后选择 B可同时读取两者；失效身份不跟随到新控件；主题切换、测距和 Esc关闭仍符合当前操作层级。

入口：[属性面板](../src/components/NodePropertiesPanel.tsx)、[测距结果卡](../src/features/layers/MeasurementCard.tsx)。

## 4. 实施顺序与范围

1. **第一批：** 树行详细模式、查看范围提示。先减少查找与定位中的反复确认。
2. **第二批：** 布局记忆、连续缩放、颜色格式。可按树与导航、画布、属性三路分工，在独立工作树完成后整合。
3. **第三批：** 固定属性参考。待前两批稳定后安排，避免与已有测距、图片预览和属性浮窗争用空间。

验证沿用自有离线样例与现有树、属性、工作台和坐标工装，覆盖深/浅主题、键盘、中文输入法、宽窄窗口及100% / 125% / 150%页面缩放。只有相关改动通过类型检查、构建及实际渲染检查后，才标记为完成。

本计划聚焦工具 UI与交互，不包含 Figma设计对比、实时修改手机属性或新增自动化执行能力。页面缩放检查不替代物理 DPI验证；源码实施和安装包更新分别记录。

<a id="implementation-results"></a>

## 5. 实施结果

| 项目 | 已实现行为 | 使用入口 |
| --- | --- | --- |
| 树行详细显示 | 紧凑28px/详细44px；详细行优先已有资源 ID，保留长 ID尾部；本机保存，切换保留阅读节点 | [树行模式](FIRST_USE.md#tree-row-mode) |
| 查看范围 | 聚焦、筛选、可交互、有标识和手动隐藏集中显示；可独立退出或恢复完整查看 | [查看范围](FIRST_USE.md#viewing-scope) |
| 布局记忆 | 保存树宽及属性浮窗位置、大小、停靠状态；拖动和键盘可调；窗口变小时临时限制在可见区域，保留原偏好 | [工作区布局](FIRST_USE.md#workspace-layout) |
| 连续缩放 | 倍率旁展开25%–1600%滑杆，方向键微调；2D围绕可见中心，3D保留旋转、平移和固定测距 | [连续缩放](FIRST_USE.md#continuous-zoom) |
| 颜色格式 | 默认 Hex，可选 RGBA或原值；其他格式折叠，复制明确标格式；偏好保存，来源不明保留原文 | [颜色显示](FIRST_USE.md#color-format) |
| 固定属性参考 | 最多一份已有名称、几何、文本和颜色；选另一控件仍保留，局部刷新标旧值/身份失效，换快照清除 | [固定参考](FIRST_USE.md#node-reference) |

布局仅在用户调整时保存。窗口缩小不会覆盖原偏好；从报告定位属性时临时停靠，沿用原定位行为，不改已保存的浮动设置。测距期间属性栏和参考卡一同避让。

整合验证：全量 **1300项/174文件，0失败**；类型检查、完整构建、树/属性界面及实际 App工作台检查通过。深树512层、25k节点、深浅主题、宽窄窗口及100% / 125% / 150%页面缩放已覆盖。浮窗原生指针拖动/保存/恢复默认在三档缩放通过；画布坐标同批改动三档各99组通过。

共同基线包含原目录所有未提交源码，快照为 `979710926eef`；分工工作树为 `lookin-round2-tree`、`lookin-round2-canvas`、`lookin-round2-properties`，整合在 `lookin-measurement-finish`。仅同步确认过的源码、验证和文档，原分支、暂存区及既有成果保留。证据见整合目录 `.benchmarks/lookin-ui-round2-20261013/result.json` 和[验收](CORE_ACCEPTANCE.md#lookin-ui-round2-acceptance)。

本轮只使用自有离线样例、隔离配置和模拟接口，手机操作为0；未替换安装版。原生拖动工装最初未正确处理页面缩放，修正检查坐标与加载后的倍率设置后通过；失败记录保留。
