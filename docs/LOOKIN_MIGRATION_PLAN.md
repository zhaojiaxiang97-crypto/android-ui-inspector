# Lookin 后续功能迁移计划

更新：2026-10-12。此前迁移、展开/状态/二维测距、继承图标、场景提示和图片预览均已整合并更新本机安装版；最新版本见[交付说明](DELIVERY.md#本机更新2026-10-12)。本轮按用户安排，在三个独立worktree中并行完成[水平旋转、长文本阅读和右键复制](#lookin-operation-details)，统一整合及组合验证通过，见[验收](CORE_ACCEPTANCE.md#lookin-operation-details-acceptance)。搜索候选、轻量分享和事件处理信息继续后置。

迁移初评对照项目源码 `98d1b53`、[Lookin 客户端 `95e30fd`](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530) 和 [LookinServer `ae39613`](https://github.com/QMUI/LookinServer/tree/ae396132ce6494477457cf450116dc760518d8ad)；2026-10-11通过 GitHub API 核对两处上游。2026-10-12的补充评估以本项目 `52a7934` 为准，再核客户端 Develop，仍为 `95e30fd`。下面区分上游已有功能和本项目的 Android 改编。

## 已有能力不重复安排

完整快照、分组/分层业务信息、默认折叠及展开档位、颜色预览与别名、按需补图、轮廓和选中强调、固定测距及二维卡片、控件图片预览/输出、属性分组显隐、双向悬停、连续动画、属性结果定位、层级路径导航、折叠分支快速选择、布局关系定位、控件状态、继承图标和场景提示均已有源码。完成范围见[原计划](LOOKIN_ALIGNMENT_PLAN.md#lookin-feature-reference)和[最新验收](CORE_ACCEPTANCE.md#lookin-discovery-acceptance)。

<a id="lookin-inspection-tools"></a>

## 继续借鉴 Lookin 的检查操作（2026-10-12）

测距调整后，新增两项桌面操作；沿用当前管理工作树、自行实现，使用现有快照和测试入口。最新范围见[验收](CORE_ACCEPTANCE.md#lookin-inspection-tools-acceptance)。

| 功能 | 上游依据 | 本项目实现 |
| --- | --- | --- |
| 快捷点选折叠内部 | [Command 临时快速选择](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L550-L558)及[折叠节点可选状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKDisplayItemNode.m#L131-L168) | Mac 用 Command、Windows/Linux 用 Ctrl＋点击，直接打开现有边界候选列表；保留工具按钮、旋转/平移及 Mac 右键，选择后沿用树导航。测距期间临时查看候选，关闭后恢复结果 |
| 不可见控件边界 | [隐藏图层显示开关](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKDisplayItemNode.m#L131-L168)和[本机偏好](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Manager/LKPreferenceManager.m#L87-L94) | 3D 设置可显示设备不可见、透明度0及祖先不可见的已有边界。采用虚线、仅边缘点选；不给不可见控件加载或补采图片。默认关闭、本机记忆，遵守手动隐藏、折叠和聚焦范围 |

客户端 Develop 仍为 `95e30fdcc8151092678387c5262bce790a0d9530`。深度筛选未在此次源码核对中找到对应功能，未以 Lookin 功能名义引入；搜索候选、轻量分享和事件处理信息仍沿用此前安排。安装包保持原候选，本轮更新源码预览。

<a id="lookin-operation-details"></a>

## 本轮操作细节

共同源码基线为`4f4f318fc7d6`，包含已修复的深层父子缩进和显式固定测距。三个subagent分别使用独立worktree与分支，公共App接线、文档和最终验证由整合方负责，合入`codex/lookin-operability-integration`。沿用Electron / React / WebGL，自行实现交互，不移植Lookin客户端源码。

| 功能 | 上游依据 | 完成条件 |
| --- | --- | --- |
| 只水平旋转 | [旋转切换及拖动](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L284-L301) | 现有3D设置可选自由/水平，默认自由；拖动、键盘、重置及聚焦返回遵守模式，保留缩放、平移、选中和固定测距；兼容旧偏好 |
| 长文本阅读 | [有高度上限的文本区域](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeTextView.m) | 文本、描述和较长属性保留换行，限制显示高度，超出内部滚动；完整复制、搜索定位和原始值保持一致，短字段维持紧凑 |
| 右键快捷复制 | [按节点生成复制项](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L331-L375) | 树/画布按实际值显示文本、资源ID、完整类名和层级路径复制，复用统一反馈；菜单取消、切换快照、刷新和迟到回复不复制旧控件 |

本轮只使用已采集快照与离线样例，保持现有SDK和快照格式；验证扩展已有树、属性、坐标和原生菜单入口，不另建公共benchmark。输入候选借鉴Lookin控制台补全，但用于现有树搜索，是后续改编；轻量分享仍见[原计划](#lookin-next-usability)。

## 迁移清单（原顺序）

| 顺序 | 功能 | 使用价值 | 改动范围 | 状态 |
| --- | --- | --- | --- | --- |
| 1 · P1 | [折叠分支内快速选择](#quick-select) | 不必逐层展开，就能找到父层画面中的按钮和文字 | 桌面端，中 | 源码完成 |
| 2 · P1 | [布局关系定位](#layout-links) | 从“对齐谁、位于谁下面”直接找到关联控件 | 桌面端，小；首版复用已采数据 | 源码完成 |
| 3 · P1 | [分层业务信息](#structured-values) | 清楚查看复杂状态，减少长字符串和零散字段 | SDK、协议、桌面端，中 | 源码完成 |
| 4 · P2 | [事件处理信息](#event-info) | 查看自有 App 登记的点击、长按和手势说明 | SDK、协议、桌面端，中 | 待开发 |
| 5 · P2 | [按场景出现的操作提示](#context-help) | 让快速选择、聚焦和固定测距容易被发现 | 桌面端，小 | 已提升优先级并完成源码，见[本轮](#lookin-next-usability) |

本轮三个subagent使用独立worktree分支，从共同基线`7e865e4188c2`开发并合入`codex/lookin-migration-integration`。操作见[快速选择](FIRST_USE.md#quick-select)、[布局定位](FIRST_USE.md#layout-links)、[分层业务信息](FIRST_USE.md#structured-values)，结果及未验范围见[迁移验收](CORE_ACCEPTANCE.md#lookin-migration-acceptance)。

<a id="quick-select"></a>

## 1. 折叠分支内快速选择

**Lookin 依据：** 按住 Command 时，折叠内部的节点可以临时参与选择；点中后先展开到目标，再选中。见[可选状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKDisplayItemNode.m#L131-L168)和[选择处理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L396-L422)。

**开发前状态：** [3D 选择](../src/components/ScreenshotPreview.tsx)只命中实际展示的平面，折叠子节点没有选择入口。2D 已能按位置找节点，不重复重做。

**已实现：** 给折叠平面增加“选择内部控件”入口。点击后按该平面的坐标查找当前分支内的候选，显示名称、类型和简短路径；悬停只显示候选轮廓，确认后展开目标的祖先并在树中定位。多个重叠候选显示列表，标明“按边界匹配”，不把边界命中宣称为真实像素命中。这是本项目对 Lookin 快速选择的改编。

- 复用当前绘制帧的射线与平面坐标，不能拿旋转后的点击直接查整屏；限制在命中的折叠分支，排除手动隐藏节点和聚焦范围外节点。
- 首版用明确入口和 Esc 退出，不直接照搬 Command，以免与现有快捷键、缩放和右键操作冲突。候选最多显示 30 条并给出总数；大分支按需查看更多。
- 首版对非1倍控件缩放、旋转或独立图placement与边界不一致的分支明确提示无法可靠映射，不按旧边界猜测。
- 悬停不展开树、不补图；确认选择才沿用正常按需加载。保留 512 个场景平面上限。取消、窗口失焦和换快照后清理临时状态。

**验收范围：** 深层折叠下能选中内部文字；旋转、缩放及三档Electron页面缩放后坐标正确；物理显示DPI仍未验证；重叠、隐藏、缺图和不可准确映射的变换有明确结果；原有折叠父层画面、拖动、测距和双击操作通过回归。

<a id="layout-links"></a>

## 2. 布局关系定位

**Lookin 依据：** 约束详情显示 FirstItem、SecondItem、关系、常量等信息，并提供关联对象跳转。见[约束详情](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/Constraint/LKConstraintPopoverController.m#L58-L80)。迁移对象关系的展示方式，Android 的布局含义按自身规则解释。

该处上游 SecondItem 按钮也绑定了 FirstItem；迁移时按实际目标重新解析，并用两个不同目标验证跳转。

**开发前状态：** [SDK](../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyTree.java)已采集 RelativeLayout、ConstraintLayout 的目标资源 ID；[属性栏](../src/components/NodePropertiesPanel.tsx)已有规则文字，但关联目标不能点击定位。

**已实现：** 把能唯一解析的目标显示为可点击控件名，点击复用现有 `navigateToNode`。`parent` 指向实际父容器；其他目标只在符合规则的同一父容器范围内，按完整资源 ID 匹配。重复 ID、缺失目标或旧快照数据不足时保留原值，显示“无法唯一定位”。偏置、权重、角度等数值不做控件链接。

**验收范围：** 父容器和唯一兄弟目标跳转正确；重复 ID、不完整树和旧快照不会误选；筛选、分支聚焦及旧会话隔离复用现有导航行为。首版只做关系列表与定位，关系连线作为后续小扩展；不推测约束是否真正生效。

<a id="structured-values"></a>

## 3. 分层业务信息

**Lookin 依据：** 支持显式 JSON 属性，用 `title / desc / details` 构造可展开的说明树，并能单独打开。它的格式是分层说明，不能直接视为通用 JSON 浏览器。见[JSON 属性入口](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/JSON/LKDashboardAttributeJsonView.m#L50-L68)和[树模型](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/JSON/LKJSONAttributeViewController.m#L53-L93)。

**开发前状态：** [业务数据协议](../shared/debug-metadata.ts)仅支持 string、number、boolean，每组都是平铺字段；复杂状态只能拆散或压成文字。

**已实现：** 增加显式树形字段，节点有稳定 key、名称、基础类型值及子项。SDK 在登记时保存数据副本；属性栏支持展开、路径搜索和完整值复制。沿用业务信息卡片，首版不另造一套窗口管理，也不自动展开 App 任意对象。

- 先定 SDK 与共享协议，再做界面；新增版本继续读取现有 v1 数据。同步确定快照文件的版本规则：新端能读旧文件，旧端遇到不支持的新文件明确拒绝。
- 首版上限：树深 8 层、每字段 128 个节点；沿用每控件 16 KiB、每次采集 256 KiB 的总业务数据预算。超限明确拒绝或省略并说明原因，不静默截断值。
- 搜索使用真实字段路径，临时展开后能恢复；换控件或会话后旧结果失效。历史、快照文件和完整复制保留实际类型，空字符串、0、false、null 可区分。

**验收范围：** 新旧协议与快照兼容规则有测试；重复 key、过深、超量、非有限数字、坏数据均有明确结果；在窄属性栏中可操作，搜索和复制不丢值。

<a id="event-info"></a>

## 4. 事件处理信息

**Lookin 依据：** 树节点有事件入口，详情包含事件名称、Target / Action，以及手势的 Enabled / Delegate。见[事件详情](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyHandlersPopoverItemView.m#L71-L119)和[服务端采集](https://github.com/QMUI/LookinServer/blob/ae396132ce6494477457cf450116dc760518d8ad/Src/Main/Server/Others/LKS_EventHandlerMaker.m#L23-L84)。

**当前缺口：** 属性栏已有可点击、长按和 `hasOnClickListeners` 状态；后者只说明标准 OnClickListener 是否存在，不能据此得到处理函数或判断整个手势链。见[Android View API](https://developer.android.com/reference/android/view/View#hasOnClickListeners())。

**首版方案：** 自有 Debug App 通过 SDK 显式登记事件类型、处理名称和说明，属性栏显示“App 显式登记”，并支持搜索、复制及随快照保存。登记信息与平台实际状态分开显示；未登记、登记为空和未采集分别表达。先复用第 3 项确定的版本与容量规则。

**完成条件：** SDK 不替换监听器、不调用处理函数、不改变事件分发；不读取 Android 私有监听器字段。换 View、清除登记和容量不足的结果正确。首版不提供 Lookin 中修改手势启用状态的开关。

<a id="context-help"></a>

## 5. 按场景出现的操作提示

**Lookin 依据：** 在相关操作中提示快速选择、空格平移等用法，并把已了解状态保存在本机。见[场景提示](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/LKStaticViewController.m#L309-L333)和[提示状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Tutorial/LKTutorialManager.m#L36-L96)。

**已实现：** 第一次使用快速选择、聚焦和固定测距时，在画布上方显示一行提示；每会话最多一条，关闭后本机记忆，可在偏好重置。暂停保留行高，退出对应操作清旧，完整范围见[本轮](#lookin-next-usability)。

**完成条件：** 不遮挡属性或画布操作，不抢键盘焦点；关闭状态能保存；采集、拖动及系统确认期间不出现新的提示。已有底部手势说明和[快捷键偏好](../src/components/PreferencesPanel.tsx)继续复用。

<a id="usability-followup"></a>

## 本轮操作完善

三项已完成。三个 subagent 从共同源码基线 `b9908fb1cfca` 开发，各用独立 worktree，统一整合到 `codex/lookin-usability-integration`。沿用当前 React / WebGL 与测试入口；操作见[使用说明](FIRST_USE.md#lookin-usability)，结果见[验收](CORE_ACCEPTANCE.md#lookin-usability-acceptance)。

| 功能 | Lookin 依据 | 本项目范围 |
| --- | --- | --- |
| 树展开档位 | [层级展开处理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource.m#L296) | 当前树一键显示前 2 层、前 4 层或全部；保留选中路径，不写默认折叠偏好；筛选和采集时禁用 |
| 控件状态说明 | [树行状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L135) | 树行、属性和画布说明手动隐藏、设备不可见、等待、缺图、自身空图与失败；折叠合成来源继续单独说明 |
| 二维测距卡片 | [二维测距结果](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Measure/LKMeasureResultView.m#L133) | 3D 固定测距后，以两控件原始外框显示二维关系、间距和对齐；只用已有数据，卡片避开属性栏与快速选择 |

**验收边界：** 原始树、图片和默认偏好不变；固定配对按原规则失效清理。窄栏、键盘、三档页面缩放及模拟 DPI 沿用现有工装检查。无图片不表示透明，自身空图不表示子树空白。安装版更新与真实手机实测另行安排。

补充评估及最新完成内容见下节。

<a id="lookin-next-usability"></a>

## 继承图标、场景提示与图片预览（源码已完成）

2026-10-12复核客户端代码后，前三项已用独立worktree并行完成；水平旋转在[本轮操作细节](#lookin-operation-details)补齐，轻量分享继续后置。

| 优先级 | 借鉴内容与依据 | 当前实现及后续范围 |
| --- | --- | --- |
| 1 · P1 | [按继承链选择类型图标](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L301-L376) | 已完成：`treeNodeKind`使用可靠SDK继承链，按最近的已知Android类型选择原图标，保留真实名称/类名。限制24层、每项512字；坏链、缺项及QML沿用原回退 |
| 2 · P1 | [场景提示](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/LKStaticViewController.m#L309-L342)与[已了解状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Tutorial/LKTutorialManager.m#L36-L95) | 已完成：快速选择、聚焦、固定测距首次操作时显示简短提示；每页面会话最多一条，关闭后本机记忆，偏好可重置。采集/拖动/弹窗暂停并保留行高，不抢焦点；退出对应操作清理，Esc先关闭可见提示 |
| 3 · P1 | [直接打开控件图像](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeOpenImageView.m#L54-L104) | 已完成：“预览图片”支持适应/100%、缩放、透明棋盘及真实解码像素尺寸。复用已保存自身/原生整组/本地重建图，注明来源；准备可取消，迟到位图释放，无保存IPC也可预览，不额外采集 |
| 4 · P2 | [自由旋转与水平旋转切换](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L284-L301)及[拖动约束](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L367-L378) | 本轮已实现：3D设置加入“仅水平旋转”，默认自由；拖动、键盘、动画和聚焦返回统一约束俯仰与侧倾，保留缩放、平移及固定测距。见[操作细节](#lookin-operation-details) |
| 5 · P2 | [快照导出图片尺寸选项](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LKExportAccessoryView.m#L40-L50)及[实际缩放逻辑](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LKExportManager.m#L81-L105) | 当前完整快照保留原图。后续可增加明确标注的轻量分享副本，降低大量独立图的文件体积；默认仍为原图，树/外框/属性不缩放，不覆盖原文件。先核验透明度、图片尺寸/坐标语义和文件兼容，再决定格式，不把缩小图用于像素验收 |

**迁移差异：** Lookin的图像入口读取UIImageView的image并交给系统Preview；本项目首版只预览已采集位图，不宣称能读出任意ImageView原始素材。棋盘底与应用内查看是Android桌面端改编。其导出“质量”选项实际缩小分辨率，不是只调整编码质量。

**本轮边界：** 图标只读取已有继承数据；提示暂停不改变画布尺寸，自动撤掉提示不等于用户已了解，也不重置本会话预算；图片预览换控件/范围/会话或关闭后取消准备并释放图片，Esc不影响原3D配对。窄窗口、错误/缺图与零额外读取沿用现有树和坐标入口，未增加重复benchmark。验证范围见[验收](CORE_ACCEPTANCE.md#lookin-discovery-acceptance)。

**并行分工：** 三个subagent分别负责图标、提示、图片预览，各用独立worktree，从共同基线`473a9a073507`开发；App、偏好和现有工装由整合方统一接线，合入`codex/lookin-discovery-integration`。原目录分支、暂存区和既有成果保留。

事件处理信息继续保留在[原第4项](#event-info)，需要自有App更新SDK并重新登记，收益依赖接入范围。更多动画与实时属性修改仍后置，优先完成上面三项。

## 后置与排除

| 方向 | 当前判断 |
| --- | --- |
| 实时改属性、禁用手势、运行方法控制台 | 会改变 App 状态；当前优先完善只读观察，继续后置 |
| iOS AutoLayout 求解、成员变量反射、专有源码跳转 | 平台或框架依赖明显；本轮只迁移可验证的 Android 布局关系与显式数据 |
| 自定义虚拟子视图 | 容易与真实 Android View 混淆；业务层级放在属性卡片，保持真实树含义 |
| 更多装饰动画、另一套搜索或导出系统 | 已有动画、搜索、快照及图片输出，先解决实际操作缺口 |

## 开发与验证安排

1. 先完成第 1 项的候选选择、坐标和会话隔离，再接树定位；离线快照与现有场景回归即可起步。
2. 第 2 项可独立开发关系解析；与第 1 项统一复用现有导航接口。并行时各用独立 worktree，共用文件由整合方修改。
3. 第 3 项先完成协议、SDK、预算和文件兼容，再接属性展示；第 4 项沿用这轮基础规则。真实手机验证在另行安排时限定样例与范围。
4. 测试扩展现有 `test:tree-ui`、图层、业务数据和快照入口，保留独有断言；不为每项新增一套重复 benchmark。实现后再运行对应测试、类型检查和构建，并区分源码完成与安装版交付。

沿用 Electron / React / WebGL。参考功能和交互，由本项目自行实现；[Lookin 客户端 GPL-3.0](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LICENSE)与[LookinServer MIT](https://github.com/QMUI/LookinServer/blob/ae396132ce6494477457cf450116dc760518d8ad/LICENSE)分别记录，不直接搬运客户端源码。
