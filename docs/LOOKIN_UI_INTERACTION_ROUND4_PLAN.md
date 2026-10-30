# Lookin UI 与交互第四轮优化计划

日期：2026-10-13。状态：6项源码已实现并验证。

本轮完成画布浮层、属性搜索完整翻页、隐藏清单、仅边框模式、结构阅读和颜色快捷菜单。保持当前三栏、颜色和常用按钮，减少来回寻找与误操作。

## 1. 基线与借鉴范围

[首轮7项](LOOKIN_UI_INTERACTION_PLAN.md)、[第二轮6项](LOOKIN_UI_INTERACTION_NEXT_PLAN.md#implementation-results)、[第三轮6项](LOOKIN_UI_INTERACTION_ROUND3_PLAN.md#implementation-results)已完成源码，共19项；加上本轮6项，共25项。本轮不重复测距、树搜索巡览、单层恢复、图片预览手势和偏好跳转。

2026-10-13通过远端 Git引用核对 Lookin Develop，仍为固定提交 [`95e30fd`](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530)。以下依据来自该源码和本项目当前源码，未新增 Lookin连接 App实测。每项分别说明 Lookin已有行为与本项目扩展。

## 2. 优先级

| 优先级 | 项目 | 实施前缺口 | 目标 |
| --- | --- | --- | --- |
| P0 | 画布浮层统一关闭与焦点返回 | 缩放已有外点关闭，设置和帮助仍独立处理，尚无统一互斥 | 打开新工具时收起旧工具，关闭规则一致 |
| P0 | 属性搜索结果完整翻页 | 统计全部命中，却只能展示前30项 | 后续命中也能定位和复制 |
| P1 | 手动隐藏项清单 | 已有单项恢复，但仍需在树中找到对应节点 | 集中看清隐藏了谁，逐项定位或恢复 |
| P1 | 3D图片／仅边框显示 | 普通轮廓和选中强调可调，无法主动去掉图片只看结构 | 在复杂重叠场景中快速检查边界 |
| P1 | 长结构信息独立阅读 | 分层业务信息集中在窄属性栏内 | 放大阅读，保留类型、路径和完整复制 |
| P2 | 颜色就地快捷菜单 | 色块仅展示，复制其他格式需展开详情 | 更快复制原值、Hex或RGBA |

## 3. 方案与验收

### P0-1：画布浮层统一关闭与焦点返回

**Lookin依据：** 就地信息使用临时弹层，点击外部会关闭。[临时弹层](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L120-L131)。**多个画布工具互斥与焦点规则是本项目改编。**

- 连续缩放、3D设置、画布帮助，同一时间只开一个；新工具打开时收起旧工具。
- 点击外部或窗口失焦收起；Esc关闭并回到发起按钮。点击外部保留被点击控件的正常行为，不把焦点强拉回来。
- 滑杆拖动、中文输入法和浮层内部点击不误关；图片／偏好等模态窗口打开时收起工具浮层，Esc先处理最上层。
- **验收：** 依次打开三个工具、点击外部、Esc、失焦和换快照，无浮层重叠或残留；关闭帮助不解除固定测距，关闭设置不重置相机。

实现入口：[画布工具栏](../src/components/ScreenshotPreview.tsx)、[连续缩放](../src/components/ContinuousZoom.tsx)。由当前画布持有一个工具状态，不新增跨应用弹层框架。

### P0-2：属性搜索结果完整翻页

**Lookin依据：** 属性搜索组织全部匹配，并提供跳转到原属性的入口。[匹配集合](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardViewController.m#L350-L392)、[属性定位](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/Search/LKDashboardSearchPropView.m#L75-L89)。**每页30项是本项目的有界展示方案。**

- 结果区增加上一页／下一页，显示“第31–60项，共125项”；30项限制改为每页限制，全部命中都可到达。
- 保留点击／Enter定位与完整值复制；翻页不自动选控件、不改变树筛选，也不清除搜索框。结果按钮和页码可用键盘操作。
- 关键词变化回第一页；节点、快照或刷新身份变化清理旧页与旧定位。只使用已有属性索引，保留原分组临时展开与清除恢复规则。
- **验收：** 0／1／30／31／1000项、同名不同路径、空字符串／0／false／null、深层业务字段及换节点时，数量、分页、定位与原值复制均正确；248px栏内可操作。

实现入口：[匹配计算](../shared/inspector-search.ts)、[结果列表](../src/components/InspectorSearchResults.tsx)、[属性面板](../src/components/NodePropertiesPanel.tsx)。沿用现有索引和定位，不增加设备请求。

### P1-1：集中查看手动隐藏项

**Lookin依据：** 树行区分未展示图像的状态，节点菜单提供对应恢复。[树行状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L218-L264)、[显隐菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L397-L422)。**集中隐藏清单是本项目扩展，单项恢复复用第三轮。**

- 查看范围条增加“查看隐藏项”，列出名称、资源ID／路径和“定位／恢复”；恢复全部继续保留为明确的独立按钮。
- 打开清单不改变选择；定位沿用已有显式导航，必要时清筛选或退出聚焦。恢复只删对应隐藏记录，不顺带恢复其他项。
- 父子同时隐藏时说明仍被哪个父层遮住；只列手动隐藏，设备不可见与缺图另按现有状态说明。大量记录每页最多30项。
- **验收：** 隐藏A/B及父子后，逐项恢复、定位与总数准确；局部刷新移除失效记录，换快照关闭清单，旧按钮不进入新快照；采集繁忙时不能修改。

实现入口：[范围条](../src/components/ViewingScopeBar.tsx)、[查看范围](../src/features/inspection/viewing-scope.ts)、[工作区动作](../src/features/inspection/useInspectionWorkspace.ts)、[隐藏关系](../shared/tree-hidden-state.ts)。不新增另一份隐藏状态。

### P1-2：3D图片／仅边框显示

**Lookin依据：** 渲染将图片、边框和强调分开，并根据可见状态分别处理。[图片与边框](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKDisplayItemNode.m#L131-L198)。**用户主动切换“仅边框”是本项目扩展，不宣称 Lookin已有同名模式。**

- 在3D设置增加“图片／仅边框”；仅边框暂时不绘制当前可见平面的图片与面状强调，仍显示正常边界、选中和悬停状态。
- 沿用当前展开、折叠、聚焦、隐藏及不可见边界范围；不额外展开或补图。折叠分支只显示现有父平面，不把它解释为所有子控件的边界。
- 仅边框强制显示该模式需要的轮廓；回到图片后恢复原普通轮廓与强调偏好。只在当前工作区记住模式，换快照回到图片；不修改原图、导出或测距。
- **验收：** 透明／缺图／折叠整组／本地合成／不可见平面提示正确；边缘可点选，内部空白不挡后层；切回图片保留相机、选中、纹理身份和固定A/B，无额外设备读取。

实现入口：[3D设置](../src/components/ScreenshotPreview.tsx)、[平面生成](../src/features/layers/Layer3DPreview.tsx)、[绘制与命中](../src/features/layers/webgl-renderer.ts)、[显示规则](../src/features/layers/appearance.ts)。现有“轻（仅边框）”只控制选中强调，不能替代本项。

### P1-3：长结构信息独立阅读

**Lookin依据：** JSON属性可在独立窗口查看。[打开JSON](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/JSON/LKDashboardAttributeJsonView.m#L50-L69)、[阅读窗口](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/JSON/LKJSONAttributeWindowController.m#L19-L29)。本项目使用已有 App内弹窗，不增加原生多窗口生命周期。

- 对已采集的分层业务字段提供“展开阅读”，打开更宽的只读弹窗，显示控件、字段路径、类型和来源；复用现有分层展示及复制规则。
- 支持字段折叠、弹窗内搜索和完整分支／叶值复制；不把未知字符串强行解析成JSON，不改变字段顺序、空值或数值类型。
- 关闭后恢复入口焦点和属性栏阅读位置；弹窗内搜索、折叠与原属性栏分别保存本次状态。换节点／快照或刷新来源后关闭旧内容，沿用既有数据预算。
- **验收：** 多层同名键、Unicode、长字符串、null／false／0／空字符串保持；960×700与150%缩放可读，Esc只关阅读弹窗，不改变画布和测距。

实现入口：[分层字段](../src/components/DebugMetadataFields.tsx)、[业务值契约](../shared/debug-metadata.ts)、[属性面板](../src/components/NodePropertiesPanel.tsx)、[通用弹窗](../src/components/EntryDialog.tsx)。

### P2-1：颜色就地快捷菜单

**Lookin依据：** 点击颜色控件进入就地菜单，并在菜单中切换表示格式。[颜色入口与格式](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m#L146-L182)。上游还支持颜色编辑；**本轮只改编为只读复制菜单**。

- 有效色块可点击或用键盘打开，提供“复制Hex／RGBA／原值”，同时显示来源、透明度和近似提示；原来的详情与复制按钮保留。
- 复用现有转换、别名和原值，不新增颜色解析器。来源未知或无法解析时，仅保留原值复制；不会改全局显示格式或手机属性。
- **验收：** ARGB／RGBA顺序、全透明RGB、非8位透明度和近似Hex、精确别名及完整原值正确；248px栏内可达，关闭返回入口，换节点不复制旧颜色。

实现入口：[颜色控件](../src/components/ColorProperty.tsx)、[显示格式](../shared/color-display.ts)、[颜色解析](../shared/inspector-colors.ts)。

## 4. 实施顺序与分工

已按用户要求分为三路并行，从包含原目录未提交成果的共同快照 `98208e2b94da` 创建独立管理工作树：

| 职责 | 负责内容 | 主要文件 |
| --- | --- | --- |
| 画布 | 工具浮层、仅边框模式 | ScreenshotPreview、ContinuousZoom、Layer3DPreview、webgl-renderer |
| 树与范围 | 隐藏项清单 | ViewingScopeBar、viewing-scope、tree-hidden-state |
| 属性 | 搜索翻页、结构阅读、颜色菜单 | inspector-search、InspectorSearchResults、DebugMetadataFields、ColorProperty |

画布使用 `lookin-round4-canvas`，树使用 `lookin-round4-tree`，属性使用 `lookin-round4-properties`。App接线、NodePropertiesPanel、useInspectionWorkspace和共享回归在 `lookin-measurement-finish` 整合。每路只修改确认的分工文件，各自保存构建和检查输出。

## 5. 验证与交付

- 扩展现有树／属性、画布坐标和实际App工装；覆盖分页边界、隐藏父子、旧来源、完整值复制与浮层退出，不为每个按钮新建独立测试项目。
- 检查1440×900、960×700和650×760压力尺寸，深浅主题及100%／125%／150%页面缩放；验证键盘、中文输入法、原生Esc、点击外部和焦点恢复。保留512层／25k节点的有界展示与原图像素断言。
- 使用自有离线样例，新增交互的手机操作与主动补采为0；页面缩放与物理DPI分别记录。相关测试、类型检查、构建和实际渲染通过后才标为已实现。
- 本次交付确认的源码、验证和文档，安装版保持原版本。源码与安装状态分开记录，边界见[交付说明](DELIVERY.md)；Figma对比、属性回写和AI自动执行继续按各自计划处理。

<a id="implementation-results"></a>

## 6. 实施结果

| 项目 | 已实现行为 | 使用说明 |
| --- | --- | --- |
| 画布浮层 | 缩放、设置、帮助互斥；外点、失焦、模态及Esc统一关闭，Esc返回入口 | [浮层操作](FIRST_USE.md#canvas-tool-popovers) |
| 属性搜索 | 全部结果按30项翻页，后续页可定位和复制；关键词或来源变化重置旧页与旧定位 | [搜索分页](FIRST_USE.md#inspector-search-pages) |
| 隐藏清单 | 真实节点、完整父级路径和隐藏父层原因；逐项恢复/定位、分页及明确恢复全部 | [隐藏清单](FIRST_USE.md#hidden-layers-list) |
| 仅边框 | 临时去掉图片和面状强调，边缘命中、空白透过；保留相机、选中、纹理与测距 | [3D边框](FIRST_USE.md#layer-wireframe) |
| 结构阅读 | 独立只读弹窗、搜索/折叠、完整分层与分支/叶值复制，来源变化关闭旧内容 | [展开阅读](FIRST_USE.md#structured-value-reader) |
| 颜色菜单 | 复用原转换、别名及透明度，复制Hex/RGBA/原值；未知来源仅复制原值 | [颜色复制](FIRST_USE.md#color-copy-menu) |

整合后 **1333项测试/183文件，0失败**；类型检查、完整构建、树/属性、工作台及实际App三档组合检查通过。

独立画布18轮共108组，属性18轮共90组；隐藏清单三档各7组及36份尺寸/主题截图，真实工作区回调三档各9组通过。原画布坐标100% / 125% / 150%各99组通过，保留实际GPU像素与命中、512层/25k节点和零设备读取断言。

已查看整合App的仅边框、结构阅读、颜色菜单及独立窄栏截图。汇总在整合工作树 `.benchmarks/lookin-ui-round4-20261013/result.json`，详细范围见[第四轮验收](CORE_ACCEPTANCE.md#lookin-ui-round4-acceptance)。普通换控件保留原有搜索词，旧页和定位重置；查看历史仍恢复搜索与阅读位置。

测试使用自有离线样例、隔离配置和真实Electron IPC；菜单选择、系统打开框、剪贴板输出及隐藏窗口中的系统下拉选择使用替身或受控事件。手机操作0，页面缩放不代表物理DPI。仅同步确认差异，保留原分支、暂存区、已有成果和工作树；安装包及手机包未更新。
