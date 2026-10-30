# Lookin UI 与交互第三轮优化计划

日期：2026-10-13。状态：6项已完成源码、并行整合及验证；安装版保持此前候选。结果见[实施结果](#implementation-results)。

本轮补齐 **单个图层恢复、当前分支展开、搜索巡览、图片右键操作、预览手势和偏好跳转**，减少检查时的往返和误操作。

## 1. 评估基线

[首轮7项](LOOKIN_UI_INTERACTION_PLAN.md)和[第二轮6项](LOOKIN_UI_INTERACTION_NEXT_PLAN.md#implementation-results)已完成源码：测距、内部候选、搜索建议、查看历史、外观、详细树行、查看范围、布局记忆、连续缩放、颜色格式及固定属性参考等。本轮在这些能力上继续优化。

2026-10-13通过 GitHub API核对 Lookin Develop，仍为 [`95e30fd`](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530)。以下依据来自固定源码与本项目当前源码；未新增 Lookin 连接 App实测。巡览快捷键、图片预览手势和偏好分组跳转明确属于本项目改编。

## 2. 优先级

| 优先级 | 项目 | 实施前缺口 | 预期收益 |
| --- | --- | --- | --- |
| P0 | 恢复单个手动隐藏图层 | 只有恢复全部，不能只找回一个 | 保留其他隐藏状态，继续检查目标 |
| P0 | 当前分支展开/收起子层 | 只有当前层、全树和展开档位 | 无需聚焦或改变其他分支即可整理局部 |
| P1 | 搜索命中巡览 | 方向键会经过祖先路径，没有命中序号 | 连续检查同名控件，清楚知道看到第几个 |
| P1 | 图片操作进入右键菜单 | 预览、复制和导出集中在属性栏 | 从树或画布就能打开已有控件图片 |
| P1 | 图片预览保留阅读位置 | 调倍率会回到左上角，主要靠按钮缩放 | 连续查看文字边缘、透明区域和大图 |
| P2 | 偏好分组跳转 | 设置增长为长页面，入口都落在顶部 | 从当前操作直接到对应设置 |

## 3. 具体方案与验收

### P0-1：恢复单个手动隐藏图层

**Lookin依据：** 树菜单按当前节点状态提供显示截图或边框、临时隐藏。[节点显隐菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L397-L422)。本项目已有隐藏与恢复全部，本轮补对应的单项恢复。

- 在手动隐藏节点的树右键菜单增加 **恢复此图层**；恢复全部入口继续保留。只移除这个节点的手动隐藏记录。
- 父层仍被隐藏时，提示原因并提供定位隐藏父层；设备不可见、缺图和手动隐藏继续分别表达，恢复后仍按实际数据显示。
- 保留选中、聚焦、折叠和其他隐藏项。换快照、刷新或旧菜单回调按当前节点身份校验。
- **验收：** 同时隐藏 A/B，只恢复 A后 B仍隐藏；父子都隐藏、设备不可见和缺图时提示正确；不向设备写入显隐状态。

入口：[工作区动作](../src/features/inspection/useInspectionWorkspace.ts)、[菜单动作校验](../shared/layer-context-menu.ts)、[桌面菜单](../electron/main.ts)、[查看范围提示](../src/components/ViewingScopeBar.tsx)。

### P0-2：整理当前分支

**Lookin依据：** 树菜单提供递归展开和收起子层。[局部展开菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L380-L394)。

- 树与画布右键增加 **展开此分支**、**收起子层**。前者展开目标及其后代；后者保留目标展开，收起后代分支，让直接子控件仍可见。
- 分支外的展开、隐藏和选中状态保持；必要时保留当前选中路径。叶节点不显示这两项，筛选和采集期间沿用现有禁用规则。
- 这是当前树的显示操作，默认折叠偏好继续用于新快照。使用已有树索引和展开集合，保持512层上限及虚拟滚动。
- **验收：** 只展开一个25k节点样例中的分支，旁边分支不变；收起子层后目标与直接子层可见；聚焦返回、详细行与键盘定位准确。

入口：[展开计算](../shared/tree-collapse.ts)、[树索引](../shared/visible-tree.ts)、[工作区动作](../src/features/inspection/useInspectionWorkspace.ts)、[菜单定义](../shared/workbench-commands.ts)。

### P1-1：逐个巡览搜索命中

**借鉴形式：** Lookin将搜索命中及相关路径组织进树，并用方向键连续浏览。[搜索整理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource.m#L613-L666)、[键盘浏览](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource%2BKeyDown.m#L14-L59)。**只巡览命中与序号是本项目扩展。**

- 筛选生效时，在搜索区增加 **上一个匹配 / 下一个匹配** 和“第2个 / 共8个”；祖先路径不计入匹配序号。未选中匹配时先显示总数，首次巡览从首个开始。
- 明确巡览才选中并同步画布；保留筛选条件和搜索前展开状态。树方向键仍浏览可见行，顶部查看历史箭头仍用于访问历史。
- 树或树搜索框有焦点时，提供 Cmd/Ctrl＋G、Shift＋Cmd/Ctrl＋G；首尾循环，无匹配禁用。建议列表的 Enter仍优先采用候选，中文组合输入不触发巡览。
- **验收：** 重复名称、文本/ID/类型命中与祖先混排时计数正确；深树虚拟行能定位；聚焦、范围变化和局部刷新后重新核命中，换快照清旧。

入口：[树行与定位](../src/components/UiTree.tsx)、[树搜索输入](../src/components/TreeSearchInput.tsx)、[匹配计算](../shared/tree-utils.ts)、[查看状态](../src/features/inspection/useInspectionWorkspace.ts)。

### P1-2：从树或画布直接操作图片

**Lookin依据：** 树与画布菜单可直接导出当前控件截图。[树菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L436-L443)、[画布菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L713-L729)。本项目把已有预览、复制和导出接到该入口。

- 右键增加 **控件图片** 子菜单，按已有数据提供自身图/分支图的预览、复制和导出 PNG；缺图说明不可用原因。
- 所有入口复用当前图片准备、输出和预览流程，明确“自身图 / 已保存分支图 / 本地合成图”及精度说明；使用已有图片，不主动补采或用整屏裁剪冒充独立图。
- 取消、换控件、换快照及刷新隔离迟到回复；文件选择沿用已有系统弹窗，成功反馈沿用现有状态。
- **验收：** 属性栏与右键对同一节点输出一致；透明 PNG、缺图和合成分支说明一致；旧菜单不输出新页面中的同位置控件。

入口：[图片操作](../src/components/NodeImageActions.tsx)、[图片计划](../shared/node-image-export.ts)、[图片准备](../src/features/layers/prepareNodeImageExport.ts)、[菜单分发](../src/features/inspection/useInspectionWorkspace.ts)、[桌面菜单](../electron/main.ts)。

### P1-3：图片预览保持阅读点

**借鉴边界：** Lookin图片属性可独立打开到系统预览。[打开图片](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeOpenImageView.m#L73-L95)。本项目已在 App内提供预览，**以下手势与位置保持属于本项目扩展**，只使用已有图像。

- 调倍率时保留当前可见中心，Cmd/Ctrl＋滚轮以指针处为锚点；普通滚轮继续滚动查看。支持空格或中键拖动平移，结束/失焦正确清理。
- 适应、100%和加减继续可用，预览区获得焦点后可用＋/−、0适应、1回到100%。操作只影响预览窗，底层画布、选中和测距保持。
- 换图片时重置阅读位置，调倍率时保持。100%表示原图像素与页面 CSS像素的对应，页面缩放和物理 DPI另行说明。
- **验收：** 大图滚到右下角后放大仍能看到同一位置；透明棋盘、解码尺寸及图片来源保留；Esc关闭后焦点回到发起入口，取消不残留位图。

入口：[图片预览](../src/components/NodeImagePreview.tsx)、[预览准备](../src/features/layers/prepareNodeImagePreview.ts)、[样式](../src/styles/node-image-preview.css)。

### P2-1：偏好设置更容易定位

**Lookin依据：** 偏好用对齐的设置行和就地说明表达效果，画布设置可转到更多偏好。[偏好布局](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Preference/LKPreferenceViewController.m#L32-L72)、[更多入口](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Toolbar/LKMenuPopoverSettingController.m#L60-L75)。**分组跳转是本项目改编。**

- 在现有偏好窗顶部提供“交互 / 外观 / 布局 / 属性与颜色 / 帮助”的分组跳转；窄窗可换行，当前分组有清楚状态。
- 从属性栏的“分组”等就地入口打开时，直接定位对应设置；普通打开保留上次阅读位置。
- 沿用每组现有保存、恢复和校验，明确立即生效与点击保存的区别；分组跳转保留未保存输入，错误信息仍靠近对应字段。
- **验收：** 960×700及150%缩放下能到达所有设置；键盘可跳转并读到标题；输入非法规则、保存失败或切换分组时，草稿和反馈保持。

入口：[偏好窗口](../src/components/PreferencesPanel.tsx)、[通用弹窗](../src/components/EntryDialog.tsx)、[App入口](../src/App.tsx)、[偏好样式](../src/styles/entry.css)。

## 4. 实施顺序与分工

| 批次 | 职责 | 内容 |
| --- | --- | --- |
| 第一批 | 树与导航 | 单个图层恢复、分支展开、搜索命中巡览 |
| 第二批 | 图片与预览 | 图片右键动作、预览位置和手势 |
| 第三批 | 偏好入口 | 分组跳转、对应设置定位、草稿保留 |

已从包含原目录未提交成果的共同快照 `129cba5422cc` 创建三个独立管理工作树：`lookin-round3-tree`、`lookin-round3-images`、`lookin-round3-preferences`。共享菜单契约、App接线与最终验证统一在 `lookin-measurement-finish` 完成；各路只修改自己负责的文件。保持现有三栏与颜色变量，复用当前状态和输出流程。

## 5. 验证与交付

- 用自有离线样例覆盖深树、25k节点、重名、隐藏父子、缺图和透明图片；核设备操作与主动补采为0。
- 扩展已有树、属性、原生菜单及图片预览工装；相关测试、类型检查、构建和实际渲染通过后才标完成。
- 窗口覆盖1440×900、960×700及650×760压力尺寸，深浅主题和100% / 125% / 150%页面缩放；检查键盘、中文输入法、焦点恢复和拖动取消。物理 DPI单独验收。
- 分别记录源码、预览和安装版状态。本轮只同步确认的源码、验证与文档，安装边界见[交付说明](DELIVERY.md)。Figma对比、实时属性回写、事件采集和自动执行沿用其他计划。

<a id="implementation-results"></a>

## 6. 实施结果

| 项目 | 已实现行为 | 使用说明 |
| --- | --- | --- |
| 单层恢复 | 只恢复右键目标；隐藏父层仍有原因与定位入口，其他隐藏记录保留 | [恢复图层](FIRST_USE.md#single-layer-restore) |
| 分支整理 | 展开当前分支、收起后代；保留分支外状态和选中路径，筛选/采集时禁用 | [分支展开](FIRST_USE.md#branch-expansion) |
| 搜索巡览 | 仅计算真实匹配，显示序号、首尾循环；按钮及 Cmd/Ctrl＋G，兼容建议与中文输入法 | [逐个查看匹配](FIRST_USE.md#search-match-navigation) |
| 图片右键操作 | 树/画布的自身图与分支图共用预览、复制和 PNG导出；属性栏关闭时仍可操作 | [图片快捷入口](FIRST_USE.md#image-context-actions) |
| 图片预览 | 中心/指针锚定缩放、空格/中键平移及＋/−/0/1；关闭恢复焦点，换图清旧 | [预览手势](FIRST_USE.md#image-preview-navigation) |
| 偏好跳转 | 五组导航，属性就地入口直达对应组，普通重开保留阅读位置；跳转保留草稿和错误 | [设置导航](FIRST_USE.md#preferences-navigation) |

整合后 **1318项测试/179文件，0失败**；类型检查、完整构建及原有树/属性/工作台回归通过。真实产品 main/preload/renderer组合在100% / 125% / 150%页面缩放下通过，覆盖菜单恢复、搜索快捷键、关闭属性栏后的图片预览、PNG复制/保存、设置重开及旧菜单隔离。

分工工装另覆盖512层/25k节点、深浅主题、窄栏、大图阅读点和键盘/输入法；图片与偏好工装各18轮，原画布坐标三档缩放各99组通过。已查看整合窗口、图片预览与偏好截图。汇总在整合工作树 `.benchmarks/lookin-ui-round3-20261013/result.json`，详细范围见[第三轮验收](CORE_ACCEPTANCE.md#lookin-ui-round3-acceptance)。

测试使用自有离线样例与隔离配置，菜单选择、系统保存框和剪贴板输出使用替身；手机操作为0。页面缩放不代表物理 DPI验收。原目录分支、暂存区和已有成果保留，工作树与失败记录继续保留；安装包及手机包未更新。
