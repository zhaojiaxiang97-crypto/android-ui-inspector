# Lookin UI 与交互第五轮优化计划

日期：2026-10-13。状态：待实施；本次交付计划文档。

建议先做 **2D控件右键、属性分组就地管理**。本轮重点是缩短常用操作路径，沿用三栏、颜色变量和现有菜单，不再增加一套工作台。

## 1. 基线与借鉴范围

前四轮共25项已完成源码，最近结果见[第四轮验收](CORE_ACCEPTANCE.md#lookin-ui-round4-acceptance)。测距、查看历史、搜索建议/巡览/分页、隐藏清单、仅边框、结构阅读和颜色菜单继续复用。

2026-10-13核对远端Git，Lookin Develop仍为固定提交 [`95e30fd`](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530)。以下结论来自该版本源码与本项目当前源码，未新增Lookin连接App实测。每项区分上游已有行为和本项目改编。

## 2. 优先级

| 优先级 | 项目 | 当前缺口 | 目标 |
| --- | --- | --- | --- |
| P0 | 2D控件右键入口 | 画布菜单和键盘菜单目前只在3D接通 | 在截图上直接复制、预览和输出对应控件 |
| P0 | 属性分组就地管理 | 显隐必须进入偏好窗口 | 阅读时直接隐藏/恢复分组，减少跳转 |
| P1 | 右键局部刷新 | 已有刷新按钮，但节点菜单没有刷新动作 | 从树或画布直接刷新此层/此分支 |
| P1 | 图片预览内复制与导出 | 预览只有阅读工具，输出要先关闭 | 确认图片后直接输出，保留阅读点 |
| P2 | 准确输入3D展示参数 | 层间距和视距只有滑杆 | 能重复设置指定数值，滑杆仍可用 |

## 3. 具体方案与验收

### P0-1：2D控件右键入口

**Lookin依据：** 预览中的右键菜单绑定实际命中对象，提供对象操作与截图输出，见[命中和右键](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L434-L451)、[截图菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L723-L730)。**扩展到本项目普通2D截图是改编。**

- 2D右键按已有截图坐标换算找到控件，复用文本/资源ID/类名/路径复制及“控件图片”子菜单；菜单目标与当前选中规则保持一致。
- 空白处不回退到上一个控件。坐标校验未通过时，不能按指针位置猜目标；键盘菜单只使用当前有效选中节点。
- 支持右键、Mac Control＋点击、Shift＋F10/菜单键；沿用3D右键松开后开菜单的规则，不让拖动误开。2D首版只接复制、图片及后续局部刷新，隐藏/聚焦继续按3D语义处理。
- **验收：** 图片留白、嵌套重叠、缩放/平移、缺图、坐标不一致、菜单取消和旧快照回复均正确；输出保留原像素与透明度，新增设备读取0。

入口：[画布](../src/components/ScreenshotPreview.tsx)、[坐标换算](../shared/screen-coordinates.ts)、[共享菜单契约](../shared/layer-context-menu.ts)、[原生菜单](../electron/desktop/layer-context-menu.ts)。

### P0-2：属性分组就地管理

**Lookin依据：** 属性卡片可打开管理入口，在当前位置添加或移除属性小节，见[卡片管理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardCardView.m#L319-L359)、[显隐动作](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardSectionView.m#L325-L362)。**本项目首版按已有七大分组管理，不细拆字段。**

- 各大分组标题增加轻量管理入口，可“隐藏此组”或转到现有分组设置。管理按钮不触发标题的展开/收起，保留键盘名称和焦点提示。
- 搜索框旁现有“分组”入口先打开七组选项的小浮层，支持逐项恢复、恢复默认，并保留“更多设置”跳转；有隐藏项时显示数量，全部隐藏仍可找回。
- 显隐复用现有偏好与保存失败反馈，不创建第二份状态。搜索中的临时展开不写入偏好；搜索进行时禁用“隐藏此组”并说明先清除搜索，避免操作后仍显示造成误解。
- **验收：** 七组分别隐藏/恢复、全隐藏、保存失败、重开、搜索结束后的显隐/折叠恢复正确；248px栏、深浅主题、键盘和外点/Esc关闭可用。

入口：[属性面板及分组标题](../src/components/NodePropertiesPanel.tsx)、[现有设置](../src/components/InspectorGroupPreferences.tsx)、[偏好状态](../src/features/inspection/useInspectorGroups.ts)、[分组契约](../shared/inspector-groups.ts)。

### P1-1：右键刷新此层／此分支

**Lookin依据：** 树和预览菜单都有“刷新当前层”和“刷新当前层及子层”，更新进行中禁用，见[树菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L307-L328)、[预览菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L659-L677)。

- 在树、3D及接通后的2D菜单中提供“刷新此层／刷新此分支”，复用已有 `refreshViewNode`；不另建采集接口或自动刷新循环。
- 能力判定与属性栏共用：有效实时请求、目标View引用、来源和范围均满足才可用；离线/历史、无SDK引用、采集/刷新繁忙时给出明确原因。分支动作只用于现有支持来源和有子层的节点。
- 打开/取消菜单不请求设备。点击后重新核对目标对象、根、请求身份和繁忙状态，单次动作最多触发一次已有刷新；保留现有进度、失败旧画面及局部刷新后的状态清理。
- **验收：** 菜单与属性栏能力一致；此层/分支范围正确，连续点击、切设备/快照、旧菜单、部分失败与父图缓存失效正确。离线请求0，在线工装只发出预期的一次请求。

入口：[工作区菜单与刷新](../src/features/inspection/useInspectionWorkspace.ts)、[App能力接线](../src/App.tsx)、[动作类型](../shared/types.ts)、[共享校验](../shared/layer-context-menu.ts)、[原生菜单](../electron/desktop/layer-context-menu.ts)。

### P1-2：图片预览内直接复制／导出

**Lookin依据：** 控件图片可以独立查看，也有以控件名称导出的入口，见[独立查看](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeOpenImageView.m#L24-L31)、[截图输出](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LKExportManager.m#L109-L140)。**预览内放输出按钮是本项目改编；沿用PNG，不照搬上游TIFF或外部Preview应用。**

- 在现有预览工具区增加“复制图片／导出PNG”，来源、尺寸和自身/分支范围仍清楚；不用关闭弹窗再找原入口。
- 输出当前已经准备好的同一张图片，复用现有校验和输出IPC，不重新合成、补图或抓取缩放后的界面。准备中、坏图或不支持输出时禁用。
- 控制器目前会阻止预览打开期间的新动作，需要补同一预览的输出分支；不能通过先关闭预览再重新运行来绕过。输出反馈留在弹窗内，成功、失败或取消均保留倍率与阅读点，来源变化使旧操作失效。
- **验收：** 自身/原生分支/本地合成、透明PNG、原尺寸、取消保存、复制失败和旧来源正确；960×700及150%可达，输出不改变选择或固定测距，设备读取0。

入口：[图片预览](../src/components/NodeImagePreview.tsx)、[输出控制器](../src/features/layers/useNodeImageActionController.ts)、[图片准备](../src/features/layers/prepareNodeImagePreview.ts)、[既有输出界面](../src/components/NodeImageActions.tsx)。

### P2-1：准确输入3D展示参数

**Lookin依据：** 数值控件把字段名与可直接输入的数值放在一起，见[数值输入控件](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Base/LKNumberInputView.m#L25-L47)。**将此方式用于本项目相机展示参数是扩展，不是修改手机布局属性。**

- 在现有3D设置中，层间距和视距保留滑杆并可输入，例如120px和1120px；输入与滑杆共用原范围/步长校验，初版不增加旋转参数表单。
- Enter提交，Esc先撤回未提交草稿，再次Esc关闭浮层；失焦撤回草稿。空值、非有限数、越界或不符合步长时说明原因，保留上次有效值。
- 只改变当前相机展示，保留平移、选中、图片与固定测距；聚焦返回及换快照遵守现有规则，不增加持久化配置。
- **验收：** 范围端点、步长、非法输入、输入法、滑杆同步、Esc层级、聚焦返回及150%窄窗正确；实际绘制参数与提交值一致。

入口：[3D设置](../src/components/ScreenshotPreview.tsx)、[相机规则](../shared/orbit-camera.ts)、[工具浮层](../src/features/layers/CanvasToolPopover.tsx)。

## 4. 实施顺序与分工

先交付两项P0，再补局部刷新和预览输出；P2作为小扩展后做。若随后安排并行，建议三路各用包含当前未提交成果的独立管理工作树：

| 职责 | 负责内容 | 文件边界 |
| --- | --- | --- |
| 画布 | 2D菜单、准确输入展示参数 | ScreenshotPreview、CanvasToolPopover及坐标/相机检查 |
| 属性 | 就地分组显隐与恢复 | 分组组件、偏好状态和属性样式 |
| 图片与菜单 | 预览输出、原生刷新菜单 | NodeImagePreview、输出控制器、原生菜单及对应检查 |

App、NodePropertiesPanel、useInspectionWorkspace和共享动作契约由整合方统一修改，先约定最小接口，避免多人同时改公共文件。复用当前管理工作树与依赖，源码及输出分别留在各自目录，整合只移确认差异。

## 5. 验证与交付

- 扩展现有菜单/坐标、属性分组、图片输出、局部刷新和相机测试；沿用树/工作台及真实App工装，不为每个按钮新建测试项目。
- 覆盖1440×900、960×700与650×760压力尺寸，248px属性栏、深浅主题、100%/125%/150%页面缩放、键盘和中文输入法。保留原像素、透明度、512层/25k节点和旧来源隔离断言。
- 自有离线样例验证新增阅读操作请求0；局部刷新另用替身核一次请求及取消/失败，实际手机范围另记，页面缩放不代表物理DPI。
- 实施后完成相关测试、类型检查、构建和实际渲染，再标源码完成。旧四轮1333项通过是基线，不作为本轮功能已经实现的证明。
- 本次只新增计划与文档索引，安装版保持此前候选。Figma对比、属性回写、事件信息、轻量分享与AI自动执行继续按各自计划处理，见[迁移安排](LOOKIN_MIGRATION_PLAN.md)及[交付边界](DELIVERY.md)。
