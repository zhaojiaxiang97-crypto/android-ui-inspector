# Lookin UI 设计决策（2026-10-13）

归档范围：五轮已完成的 30 项 UI 改进。本页合并原五份计划，保留上游依据、本项目取舍和关键行为约束；不重复实施优先级、工作树分工、操作手册和测试数量。现在如何操作见[使用说明](../FIRST_USE.md)，当前代码归属见[开发目录](../DEVELOPMENT_STRUCTURE.md)，安装候选见[交付说明](../DELIVERY.md)。

上游依据固定为 Lookin Develop [`95e30fdcc8151092678387c5262bce790a0d9530`](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530)。当轮核对了源码和本机偏好，未新增 Lookin 连接 App 的实测；以下明确区分上游行为与本项目扩展。原始五文件保存在本轮共同源码快照 `25f9e27f`，文件及锚点映射另存本机清理证据。

共同约束：保留三栏和现有采集/授权/图片来源；只读值不冒充可远程编辑属性，未知或缺失数据不补造。窗口、键盘、输入法、页面缩放与物理 DPI 分别验证，源码完成不等同安装更新。五轮均使用自有离线样例和隔离配置；菜单选择、系统文件框、剪贴板及在线刷新按各轮记录使用替身，不把这些结果称为手机实测。Figma 对比、属性回写、事件信息、轻量分享及自动执行仍归其他任务。

<a id="round1"></a>

## 首轮：检查与导航

<a id="round1-item1"></a>

### 1.1 属性栏摘要与展开记忆

借鉴紧凑分组和默认折叠。顶部只保留一份身份摘要，紧接 X/Y/W/H 与已有文本、颜色；完整继承链、原始属性和关系可展开。合并重复名称、类名并缩小内边距，只读值可复制但不呈现为手机属性编辑器。用户手动展开状态可保存和恢复默认；搜索临时展开不得写入偏好，清除搜索后恢复。普通文本/图片的关键内容应在常用窗口内无需滚动可见，长名称、缺失属性和搜索定位仍可读。

依据：[属性分组与折叠](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardViewController.m#L185-L216)、[默认偏好](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Manager/LKPreferenceManager.m#L188-L190)。使用：[操作说明](../FIRST_USE.md#inspector-groups)。

<a id="round1-item2"></a>

### 1.2 工具分组与操作状态

借鉴工具栏分类和测距选中态，沿用设备与采集、视图与缩放、检查工具三组。测距与内部选择保留直接入口，次要设置放菜单；状态栏只说明当前操作与退出方式，完整快捷键放帮助。不可用原因须可由键盘访问，连接状态与画面采集时间分别表达。窄窗不重叠；弹窗、候选和测距按层处理 Esc，一次只退出当前操作。

依据：[工具栏](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Toolbar/LKWindowToolbarHelper.m#L55-L122)。使用：[操作说明](../FIRST_USE.md#工作台的操作位置)。

<a id="round1-item3"></a>

### 1.3 2D/3D 测距与结果复制

Lookin 提供双控件结果区；普通 2D 接入与复制结果是本项目扩展。两种视图共用 A/B、固定和结果卡，从树或画布选取；只有边界也可测量，并说明缺少独立图。复制包含双方名称、比较边缘、数值、单位和快照标识。继续使用屏幕 px，可靠 Android 密度确认前不增加 dp；截图裁剪不冒充独立图，缩放不改数值，换快照清旧配对，包含、重叠与四边对齐保持同一语义。

依据：[测距结果展示](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Measure/LKMeasureResultView.m)。使用：[操作说明](../FIRST_USE.md#pinned-measurement)。

<a id="round1-item4"></a>

### 1.4 折叠内部候选

借鉴 Command 临时选择，候选列表和过滤是现有能力上的改编。入口明确“选择折叠内部的控件”，面板显示当前分支及“按布局边界匹配”；文本或资源 ID 优先，类型和相对路径补充区分同名层。过滤只影响当前候选，区分总匹配和当前页；浮层避开点击目标，空间不足时停靠侧边。悬停不改选中，上下键预选、Enter 确认才展开定位，Esc 取消恢复原操作，不改原树。

依据：[选择处理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L396-L422)。使用：[操作说明](../FIRST_USE.md#quick-select)。

<a id="round1-item5"></a>

### 1.5 树搜索建议

借鉴 Lookin 输入建议交互，树搜索是本项目改编，继续复用原筛选与定位。候选仅取当前快照的文本、资源 ID 和类型，标明类别、精确匹配优先并限制数量。上下键预选、Enter 采用、Esc 先关建议；中文输入法组合期间不确认。换快照清旧，清空筛选恢复原展开和滚动，不新建第二套搜索页面。

依据：[输入候选组件](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Base/InputSearch/LKInputSearchView.m#L107-L145)。使用：[操作说明](../FIRST_USE.md#tree-search-suggestions)。

<a id="round1-item6"></a>

### 1.6 控件查看历史

这是本项目扩展，不属于已核实的 Lookin 功能。当前快照内记录有限的显式选择与关联跳转，前进/后退恢复必要的树位置及属性阅读位置；悬停、搜索预览不记历史。换快照清空，局部刷新只保留可确认身份的目标；返回父级或约束目标前的控件时，不恢复失效节点，也不向手机发送返回键。

使用：[操作说明](../FIRST_USE.md#node-visit-history)。

<a id="round1-item7"></a>

### 1.7 外观选择

借鉴 Lookin 的外观偏好，沿用颜色变量提供深色、浅色和跟随系统。默认保持深色工作台、三栏与蓝色选中主色；浅色只改变工具界面，检查画布保持中性深灰，不加装饰动画。树选中/悬停、虚线、测距蓝橙和透明棋盘均须可辨认。偏好重启保留，系统模式响应系统变化；主题切换不改快照、选择、测距或截图原像素。

依据：[外观偏好](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Manager/LKPreferenceManager.m#L249-L255)。使用：[操作说明](../FIRST_USE.md#workbench-appearance)。

<a id="round1-results"></a>

完成范围、测试数量、失败记录和本机证据见[第1轮验收](../CORE_ACCEPTANCE.md#lookin-ui-polish-acceptance)。

<a id="round2"></a>

## 第二轮：辨认与比较

<a id="round2-item1"></a>

### 2.1 树行详细模式

借鉴标题/副标题层级与搜索高亮。紧凑行 28px、详细行 44px；第二行优先已有资源 ID，缺少时显示类型，避免重复名称；名称和长 ID 尾部可辨，完整值仍可提示/复制。模式保存到本机，切换按阅读节点恢复而非套用旧行高像素，保留选中与展开。深树和虚拟滚动按新行高定位，缺 ID 不补造标识。

依据：[树行实现](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L134-L177)。使用：[操作说明](../FIRST_USE.md#tree-row-mode)。

<a id="round2-item2"></a>

### 2.2 统一查看范围

借鉴搜索/聚焦状态管理，组合范围条属于本项目改编。聚焦、筛选、可交互、有标识和手动隐藏集中显示，无条件时显示当前快照。各条件可独立退出，也可恢复完整查看；折叠偏好、不可见边界开关、选中和必要阅读位置保留。树/画布、建议、查看历史与右键定位共用状态，设备不可见不混同手动隐藏；不修改手机状态或重采。

依据：[状态处理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L122-L131)。使用：[操作说明](../FIRST_USE.md#viewing-scope)。

<a id="round2-item3"></a>

### 2.3 工作区布局记忆

借鉴可分隔工作区，持久化是本项目补充。只保存树宽、属性栏停靠/浮动、浮窗位置和大小，提供恢复默认；当前快照、筛选与查看历史仍归各自生命周期。拖动或键盘调整才保存；缩窗、换屏或页面缩放只临时限制到可见区域，不覆盖原偏好。报告定位可临时停靠，不改变保存的浮动设置；测距时属性栏与参考卡一同避让。坏配置和保存失败有兜底，恢复入口始终可达。

依据：[工作区分隔](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/LKStaticViewController.m#L58-L87)。使用：[操作说明](../FIRST_USE.md#workspace-layout)。

<a id="round2-item4"></a>

### 2.4 连续缩放

借鉴滑杆与加减形式，倍率和画布算法继续用本项目规则。倍率旁展开 25%–1600% 滑杆，保留滚轮、加减、100%和适应，支持方向键微调；窄窗只收滑杆。2D 滑杆围绕可见中心、滚轮围绕指针；3D 保留旋转和平移，结束拖动或失焦清理操作。命中与选中框保持对齐，固定 A/B 和原始 px 数值不变，不触发设备读取。

依据：[缩放控件](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Toolbar/LKWindowToolbarScaleView.m#L13-L29)。使用：[操作说明](../FIRST_USE.md#continuous-zoom)。

<a id="round2-item5"></a>

### 2.5 颜色显示格式

借鉴 Hex/RGBA 切换和偏好监听，默认 Hex，可选 RGBA 或原值；色块、当前格式、已有别名直接展示，其他格式进详情。复制须标明格式，保留来源、透明度与近似提示；未知或无效色值保留原文。Android ARGB、QML RGBA、透明色及非8位透明度仍按原语义处理，搜索与别名匹配不变。仅改字段展示，不提供手机改色或取色回写，也不改快照/截图。

依据：[显示与偏好监听](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m#L80-L108)、[格式切换](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m#L212-L215)。使用：[操作说明](../FIRST_USE.md#color-format)。

<a id="round2-item6"></a>

### 2.6 固定属性参考

借鉴辅助属性面板，固定参考与跨控件比较是本项目扩展。最多保留一份已有名称、几何、文本和颜色，标明快照及来源；缺字段留空，不补采。选另一控件仍保留，可替换或关闭；换快照清除，局部刷新标为固定时旧值或身份失效，重新固定才更新。测距优先占用右侧，属性栏与参考卡一起避让，不能挤占候选；失效身份不跟到新控件。

依据：[辅助属性面板](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardAccessoryWindowController.m#L25-L79)。使用：[操作说明](../FIRST_USE.md#node-reference)。

<a id="round2-results"></a>

完成范围、测试数量、失败记录和本机证据见[第2轮验收](../CORE_ACCEPTANCE.md#lookin-ui-round2-acceptance)。该轮原生拖动工装曾未正确处理页面缩放，修正检查坐标和加载后倍率设置才通过；原失败留档，不改写成产品问题。

<a id="round3"></a>

## 第三轮：局部操作

<a id="round3-item1"></a>

### 3.1 恢复单个隐藏图层

借鉴节点显隐菜单，只移除目标的手动隐藏记录，恢复全部仍为独立入口。父层仍隐藏时说明原因并可定位父层；设备不可见、缺图和手动隐藏分别表达。保留选中、聚焦、折叠及其他隐藏项，换快照/刷新/旧菜单按身份校验；不向设备写显隐状态。

依据：[节点显隐菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L397-L422)。使用：[操作说明](../FIRST_USE.md#single-layer-restore)。

<a id="round3-item2"></a>

### 3.2 整理当前分支

借鉴递归展开与收起子层。展开此分支包含目标及后代；收起子层保留目标展开，只收后代分支，使直接子层可见。分支外状态与必要选中路径保留，叶节点不提供动作，筛选/采集中按原规则禁用。复用树索引与展开集合，保持512层上限和虚拟滚动；操作当前树，不写新快照的默认折叠偏好。

依据：[局部展开菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L380-L394)。使用：[操作说明](../FIRST_USE.md#branch-expansion)。

<a id="round3-item3"></a>

### 3.3 搜索匹配巡览

借鉴搜索路径整理与键盘浏览；只巡览命中及显示序号是本项目扩展。祖先路径不计匹配，未选命中先显示总数，首次从首项开始，首尾循环，无匹配禁用。明确巡览才同步选择和画布，保留筛选与搜索前展开；方向键仍浏览可见行，查看历史箭头不改用途。树/搜索框焦点下用 Cmd/Ctrl+G、Shift+Cmd/Ctrl+G，Enter 优先采用建议，输入法组合不触发；范围或刷新变化重核命中，换快照清旧。

依据：[搜索整理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource.m#L613-L666)、[键盘浏览](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource%2BKeyDown.m#L14-L59)。使用：[操作说明](../FIRST_USE.md#search-match-navigation)。

<a id="round3-item4"></a>

### 3.4 图片右键操作

借鉴树和画布截图菜单，把已有预览、复制、PNG 导出接到控件图片子菜单，属性栏关闭也可用。按已有数据提供自身/分支范围，缺图说明不可用；自身图、已保存分支图、本地合成图及精度分别标明。共用图片准备、输出和系统文件框，不补采、不裁整屏冒充独立图。取消、换控件/快照和刷新隔离迟到回复，旧菜单不输出新页面同位置控件。

依据：[树菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L436-L443)、[画布菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L713-L729)。使用：[操作说明](../FIRST_USE.md#image-context-actions)。

<a id="round3-item5"></a>

### 3.5 图片预览阅读点与手势

Lookin 可独立打开图片；App 内手势与阅读点保持是本项目扩展。调倍率保留可见中心，Cmd/Ctrl+滚轮锚定指针，普通滚轮滚动，空格/中键平移，结束或失焦清理。适应、100%、加减及焦点内 +/−、0适应、1回100%可用；换图重置，缩放保留位置。100%是原像素对页面 CSS 像素，不能等同物理 DPI。透明棋盘、尺寸和来源保留，底层选择/测距/画布不变；Esc 恢复入口焦点，取消释放位图。

依据：[打开图片](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeOpenImageView.m#L73-L95)。使用：[操作说明](../FIRST_USE.md#image-preview-navigation)。

<a id="round3-item6"></a>

### 3.6 偏好分组跳转

借鉴对齐设置行与更多偏好入口，分组跳转是本项目改编。五组为交互、外观、布局、属性与颜色、帮助；窄窗换行，当前组有状态，键盘可到达标题。就地入口定位对应组，普通重开保留阅读位置。复用保存、恢复和校验，明确立即生效与保存的区别；切组不丢未保存草稿，错误仍贴近字段。

依据：[偏好布局](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Preference/LKPreferenceViewController.m#L32-L72)、[更多入口](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Toolbar/LKMenuPopoverSettingController.m#L60-L75)。使用：[操作说明](../FIRST_USE.md#preferences-navigation)。

<a id="round3-results"></a>

完成范围、测试数量、失败记录和本机证据见[第3轮验收](../CORE_ACCEPTANCE.md#lookin-ui-round3-acceptance)。

<a id="round4"></a>

## 第四轮：集中阅读

<a id="round4-item1"></a>

### 4.1 画布浮层互斥与焦点

借鉴临时弹层，工具互斥与焦点规则是本项目改编，由当前画布持有单一工具状态。缩放、3D设置、帮助只开一个；外点或失焦关闭，Esc 返回发起按钮；外点保留被点击对象正常行为，不强拉焦点。滑杆拖动、中文输入法和内部点击不误关；模态打开收起浮层，Esc 只处理最上层。关闭帮助不解除固定测距，关闭设置不重置相机。

依据：[临时弹层](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L120-L131)。使用：[操作说明](../FIRST_USE.md#canvas-tool-popovers)。

<a id="round4-item2"></a>

### 4.2 属性搜索分页

借鉴完整匹配与属性定位，每页30项是本项目有界展示。全部命中可翻到，显示范围和总数，保留点击/Enter定位、键盘页码和完整复制；翻页不自动选控件、不改树筛选或清搜索。关键词变更回首屏；普通换控件保留搜索词，但来源/刷新变化清旧页和旧定位，查看历史仍恢复搜索及阅读位置。复用既有索引和分组临时展开规则，不加设备请求；同名路径、空串/0/false/null与深层字段保持类型。

依据：[匹配集合](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardViewController.m#L350-L392)、[属性定位](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/Search/LKDashboardSearchPropView.m#L75-L89)。使用：[操作说明](../FIRST_USE.md#inspector-search-pages)。

<a id="round4-item3"></a>

### 4.3 手动隐藏清单

借鉴树行状态和显隐菜单，集中清单是本项目扩展，复用第三轮单项恢复。范围条列出真实节点名称、ID/完整父级路径及定位/恢复，最多每页30项，恢复全部独立。打开不改选择，定位复用明确导航并可清筛选/退出聚焦；恢复只删对应记录。父子同时隐藏要说明父层原因，只列手动隐藏，设备不可见与缺图另述。刷新移除失效项，换快照关闭，旧按钮不进入新快照，采集中禁改；不另建隐藏状态。

依据：[树行状态](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyRowView.m#L218-L264)、[显隐菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L397-L422)。使用：[操作说明](../FIRST_USE.md#hidden-layers-list)。

<a id="round4-item4"></a>

### 4.4 3D 仅边框

借鉴图片、边框、强调分离，主动“仅边框”是本项目扩展，不等于原有选中强调的“轻”。该模式去掉当前平面图片及面状强调，强制所需轮廓，保留选中/悬停；边缘可选，内部空白透过。沿用展开、折叠、聚焦、隐藏及不可见范围，不额外展开或补图，折叠父平面不代表全部子层。切回图片恢复原轮廓/强调偏好，保留相机、选择、纹理、固定A/B和原图输出；只记当前工作区，换快照回图片。

依据：[图片与边框](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKDisplayItemNode.m#L131-L198)。使用：[操作说明](../FIRST_USE.md#layer-wireframe)。

<a id="round4-item5"></a>

### 4.5 分层业务信息独立阅读

借鉴独立 JSON 阅读，采用现有 App 内只读弹窗，不增加原生多窗口。展示控件、字段路径、类型和来源，共用分层渲染与完整分支/叶值复制，支持折叠和弹窗内搜索。未知字符串不强解析 JSON，不改变顺序、空值或数值类型，沿用数据预算。弹窗搜索/折叠与属性栏各自保存本次状态；关闭恢复入口焦点和阅读位置，换节点/快照或来源刷新关闭旧内容，Esc 不影响画布/测距。

依据：[打开JSON](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/JSON/LKDashboardAttributeJsonView.m#L50-L69)、[阅读窗口](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/JSON/LKJSONAttributeWindowController.m#L19-L29)。使用：[操作说明](../FIRST_USE.md#structured-value-reader)。

<a id="round4-item6"></a>

### 4.6 颜色就地复制菜单

借鉴颜色入口与格式菜单，上游编辑能力只改编为只读复制。有效色块支持点击/键盘，提供 Hex、RGBA、原值并显示来源、透明度及近似；原详情和复制按钮保留。共用转换、别名和解析，不新增解析器；未知来源/无效值只复制原值，不改全局格式或手机属性。ARGB/RGBA顺序、全透明 RGB、非8位透明度和精确别名保持；关闭回入口，换节点不复制旧色。

依据：[颜色入口与格式](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m#L146-L182)。使用：[操作说明](../FIRST_USE.md#color-copy-menu)。

<a id="round4-results"></a>

完成范围、测试数量、失败记录和本机证据见[第4轮验收](../CORE_ACCEPTANCE.md#lookin-ui-round4-acceptance)。

<a id="round5"></a>

## 第五轮：就地操作

<a id="round5-item1"></a>

### 5.1 2D 控件右键

借鉴预览命中后显示对象操作，普通2D截图接入是本项目改编。用既有截图坐标命中，复用文本/ID/类名/路径复制与图片菜单，目标与选中规则一致；留白不退回上次控件，无可信坐标不猜目标，键盘菜单只用有效选中。支持右键、Mac Control+点击、Shift+F10/菜单键，松开再开菜单，拖动不误开。2D只接复制、图片及局部刷新，隐藏/聚焦继续遵守3D语义；嵌套重叠、缩放/平移、缺图和旧来源保留校验，阅读操作不新增设备读取。

依据：[命中和右键](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L434-L451)、[截图菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L723-L730)。使用：[操作说明](../FIRST_USE.md#flat-node-context-menu)。

<a id="round5-item2"></a>

### 5.2 属性分组就地管理

借鉴卡片/小节管理，首版管理既有七大组，不细拆字段。标题按钮可隐藏此组或进设置，不触发展开/收起；保留键盘名称和焦点提示，隐藏后焦点回到持续可见入口。搜索旁分组浮层可逐项恢复、恢复默认、进更多设置，显示隐藏数量，全隐藏也可找回。共用偏好与保存失败反馈，搜索临时展开不写偏好；搜索中禁用隐藏并说明先清搜索，结束后恢复原显隐/折叠。

依据：[卡片管理](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardCardView.m#L319-L359)、[显隐动作](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardSectionView.m#L325-L362)。使用：[操作说明](../FIRST_USE.md#inspector-group-controls)。

<a id="round5-item3"></a>

### 5.3 右键局部刷新

借鉴树/预览的当前层和当前层及子层刷新。树、2D、3D复用现有刷新与属性栏能力规则：实时请求、View引用、来源、范围和繁忙状态有效才可用，分支仅对支持来源且有子层的节点开放；不可用原因明确。开/关菜单不读设备，点击重核对象、根、设备及请求身份，最多触发一次刷新，不建自动循环。保留进度、失败旧画面和局部状态清理；整合补了同根换设备、同快照换请求及旧直接回调隔离，迟到旧结果不能清新繁忙，刷新中属性按钮保留禁用反馈。

依据：[树菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m#L307-L328)、[预览菜单](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m#L659-L677)。使用：[操作说明](../FIRST_USE.md#local-refresh-menu)。

<a id="round5-item4"></a>

### 5.4 预览内复制与导出

借鉴独立查看与命名输出，App预览内输出是本项目改编，沿用PNG，不照搬TIFF或系统Preview。直接输出当前已准备的同一图片，标明尺寸、来源及自身/分支范围，共用校验与IPC；不重合成、不补图、不截取缩放界面。准备中、坏图或不支持时禁用；控制器支持同一预览输出，不能先关再开绕过。成功、失败或取消都在弹窗内反馈并保留倍率/阅读点，来源变化使旧操作失效；原尺寸、透明度、选择和固定测距不变。

依据：[独立查看](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeOpenImageView.m#L24-L31)、[截图输出](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LKExportManager.m#L109-L140)。使用：[操作说明](../FIRST_USE.md#image-preview-output)。

<a id="round5-item5"></a>

### 5.5 准确输入3D参数

借鉴数值字段形式，用于本项目展示参数，不是手机布局编辑。层间距/视距保留滑杆，输入共用范围、步长和绘制规则，不新增旋转表单或持久化配置。Enter提交；Esc先撤未提交草稿，再次Esc关浮层；失焦撤草稿，输入法组合不误提交。空值、非有限数、越界或不合步长说明原因并留上个有效值；保留平移、选择、图片和固定测距，聚焦返回与换快照按原规则。

依据：[数值输入控件](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Base/LKNumberInputView.m#L25-L47)。使用：[操作说明](../FIRST_USE.md#orbit-parameter-input)。

<a id="round5-results"></a>

完成范围、测试数量、失败记录和本机证据见[第5轮验收](../CORE_ACCEPTANCE.md#lookin-ui-round5-acceptance)。
