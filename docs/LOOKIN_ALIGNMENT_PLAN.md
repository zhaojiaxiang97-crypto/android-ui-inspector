# Lookin 对齐计划

更新：2026-10-12。U1–U6c已交付，原U系列后续暂停；Lookin交互、路径导航、前三项功能迁移及展开/状态/二维测距完善已完成源码及整合验证。能力看[状态](PROJECT_STATUS.md)，版本和已验范围看[验收](CORE_ACCEPTANCE.md)，验证入口看[测试计划](TEST_PLAN.md)。

<a id="下一步"></a>

## 当前安排

测试脚本、benchmark和文档已整理完成：合并重复入口，保留独有断言、失败证据与必要门禁；常用文档只维护当前结论，逐轮记录进入[验收沿革](archive/CORE_ACCEPTANCE_2026-10-09.md#ui复刻收口u1u6c2026-10-11)。本轮结果见[整理验收](CORE_ACCEPTANCE.md#本轮整理2026-10-11)。控件识别两轮评估已完成，完整树门槛未通过；[可选Helper只读后端](#helper-readonly)已完成固定样例同页、真实响应体取消、原生候选窗口和30分钟持续验证，默认UIAutomator不变。Mac arm64本机交付与实际升级/回退已完成，见[交付说明](DELIVERY.md)及[验收](CORE_ACCEPTANCE.md#local-delivery-acceptance)。原U系列后续和其他手机任务继续暂停。

首次使用方向已完成：固定完整源码、独立依赖构建、空配置真实采集及保存重开，同一快照CLI/MCP只读查询和停止共享通过；[一页上手说明](FIRST_USE.md)含真实2D/3D截图。范围见[验收](CORE_ACCEPTANCE.md#first-use-acceptance)，不扩大为干净系统安装或正式发布。按用户最新安排，新增稳定性验证和另一台干净Mac的首次安装验证暂时后置；[Artemis架构借鉴](#artemis-architecture-reference)的步骤证据及固定任务验收已完成自有样例完整流程和独立候选验证，入口见[上手第7步](FIRST_USE.md#7-可选完成一次固定样例任务)。薄任务运行层仍后置。

2026-10-12的[Artemis下一轮计划](#artemis-next-plan)四项已接入新源码：统一诊断、失败步骤日志、2D实时预览、任务进度展示。三个子代理在独立工作树开发并统一整合；安装版未更新，稳定性等暂停任务继续后置。

随后按用户要求，三个子代理在新的独立工作树完成[步骤差异、桌面任务模板与证据导出](#artemis-evidence-plan)，全量1201项、构建及实际桌面组合验证通过，见[验收](CORE_ACCEPTANCE.md#artemis-evidence-acceptance)。有限步骤自动执行放第二批，沿用现有授权与 Checker。

[Lookin功能源码复核](#lookin-feature-reference)后的五项已接入新源码：完整快照文件、分组业务信息、默认折叠、颜色预览与别名、可见图层优先与按需补图。[第二轮UI与功能候选](#lookin-ui-next)的四项也已完成源码：普通轮廓开关与选中强调、固定测距结果、控件图片输出、属性分组显隐。安装版尚未更新；新增稳定性及其他手机任务继续后置。

[剩余功能迁移计划](LOOKIN_MIGRATION_PLAN.md)前三项已通过独立worktree并行开发并统一合入新源码：折叠分支内快速选择、布局关系定位、分层业务信息。事件处理信息继续后置；其他候选、上游依据与完成边界保留在计划中。

最新补充的[继承类型图标、场景提示、已采集图片预览](LOOKIN_MIGRATION_PLAN.md#lookin-next-usability)已用三个独立worktree并行开发并统一接入源码，见[使用](FIRST_USE.md#lookin-discovery)及[验收](CORE_ACCEPTANCE.md#lookin-discovery-acceptance)。水平旋转、轻量快照分享和事件处理信息继续后置；安装版未更新。

## 已完成方向

- U1–U2：紧凑工作台、底部搜索、贴边属性卡片；搜索高亮/折叠恢复、键盘浏览、双击设置和分支聚焦。
- U3–U5：画布手势/适应、属性卡片密度/复制/搜索恢复、统一菜单/快捷键、首页与偏好。
- U6a–U6b：固定候选、包内组合回归、备份交付及真实历史工作台查看。
- U6c：首页历史下拉/AI文字、报告关闭重开/迟到隔离、权限等待提示；旧报告实际导入/截图/取消/错误保留/退出已复核。

此前等待来自用户尚未点击权限确认，原“卡住”判断已撤回；没有证据确认某个系统权限机制或事件循环根因。推测性读取线程、超时和调度改动不在最终版本中。

## 候选后续（暂停）

| 方向 | 恢复时的完成条件 |
| --- | --- |
| U6d新版手机单页 | 固定设备/App/稳定页及单次只读范围，实际属性和2D/3D独立留证，不继承旧A3结果 |
| 自动化与取消/恢复 | 先限定设备操作和故障范围，再按[原A–E计划](archive/LOOKIN_AUTOMATION_PLAN_2026-10-10.md)选择必要项目 |

上述方向均不进入当前执行队列。其他缺口见[状态](PROJECT_STATUS.md#保留缺口)。

<a id="lookin-feature-reference"></a>

## Lookin功能借鉴（源码复核）

2026-10-11对照客户端[Lookin](https://github.com/hughkli/Lookin/tree/95e30fdcc8151092678387c5262bce790a0d9530)提交`95e30fdcc8151092678387c5262bce790a0d9530`，以及端侧[LookinServer](https://github.com/QMUI/LookinServer/tree/ae396132ce6494477457cf450116dc760518d8ad)提交`ae396132ce6494477457cf450116dc760518d8ad`。源码复核后，按用户逐项授权落实五项；手机、稳定性及其他UI方向沿用既有安排。

本项目已有2D/3D、测距、分支聚焦、局部刷新、渐进显示及历史对比；SDK也已有[DebugNames](../android/README.md)业务显示名。数字资源ID已改为优先显示真实类型，原ID仍可搜索。下列建议补具体缺口，均沿用Electron/React/WebGL与Android采集链路。

| 顺序 | Lookin参考功能 | 本项目缺口及融入方式 | 工作量 |
| --- | --- | --- | --- |
| 1 | [完整快照保存](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LKExportManager.m)和[离线打开](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LookinDocument.m) | 新源码已完成：原树JSON导出保留，新增完整文件导出/打开，包含整屏、独立节点图、已取得的原生分支图与采集信息。复用[历史存储](../electron/desktop/snapshot-store.ts)、UiSnapshot和工作台；查看与保存均不临时补采 | 已完成源码，安装版未更新 |
| 2 | [分组业务调试信息](https://github.com/QMUI/LookinServer/blob/ae396132ce6494477457cf450116dc760518d8ad/Src/Main/Server/Others/LKS_CustomAttrGroupsMaker.m) | 在已有DebugNames之外，由Debug SDK显式登记组件名、归属和加载状态等有类型的只读值，属性栏按组展示并保留来源。用于自有App；未接SDK的App仍按实际采集字段展示 | 已完成源码，安装版与手机SDK未更新 |
| 3 | [按类型默认折叠](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource.m) | 新源码已完成：偏好可按精确类名及层级默认收起，默认仍全部展开。完整树保留；手动状态跨渐进采集及局部刷新，搜索临时显示路径，定位可展开原路径。不默认收起全部ReactViewGroup | 已完成源码，安装版未更新 |
| 4 | [颜色预览与别名](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/AttributeView/LKDashboardAttributeColorView.m) | 新源码已完成：Android 实时背景/文字源色、QML 已采集背景/边框源色显示透明色块，原值/CSS Hex/RGBA复制；本机别名精确匹配颜色及透明度，搜索可找到。保留原ARGB，非8位透明度的Hex标近似，未知不补猜 | 已完成源码，安装版未更新 |
| 5 | [可见图层优先与按需补图](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/LKStaticAsyncUpdateManager.m) | 新源码已完成：展示时选中优先、视口内补图，移入视口自动加载；整组请求及独立图解码各自串行去重，同次采集复用分支图。新树/刷新清旧，own/group身份分开，完整深度采集和离线零补采保留 | 已完成源码，安装版未更新 |

**首项源码已完成：完整快照导出与离线打开。** 使用见[离线文件说明](FIRST_USE.md#offline-snapshot-files)，结果见[验收](CORE_ACCEPTANCE.md#snapshot-files-acceptance)。范围：

- 文件[格式](../shared/snapshot-file.ts)保存完整UiSnapshot；普通标量保持v1，新版分层/null业务信息使用v2，新端兼容两版；分支图由[工作台](../src/features/inspection/useInspectionWorkspace.ts)按当前树身份收集，随文件和历史保存。新树/局部刷新使旧图失效，迟到图不进入新快照；已有分支图的采集时间保留。
- 离线文件沿用树搜索、选中、属性和2D/3D；恢复已保存的原生分支图，展开/再次折叠仍可用。本地重建与缺图说明保留。旧四字段树JSON只恢复实际内容，明确未包含整屏截图，不猜采集来源。
- [主进程读取器](../electron/desktop/snapshot-file.ts)校验版本、100MiB文件限制、20,000节点/200深度、唯一节点/分支引用及真实图像解码；单图16M、总128M像素。图片只接受内嵌PNG/WebP/JPEG及受限QML样式SVG，拒绝外部引用。历史保存继续按50MiB单份/30份限制。
- 文件选择取消、坏文件和超限保留当前页面；重复打开互斥，返回首页/新采集/关闭后的迟到结果不恢复旧页面。打开、保存和导出不触发手机补采、刷新或共享。单元测试及现有树/原生菜单工装承载检查，未新增重复benchmark入口。

**第二项源码已完成：分组业务信息。** [接入示例](../android/README.md#business-debug-metadata)及[验收](CORE_ACCEPTANCE.md#business-debug-metadata-acceptance)。[DebugMetadata](../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/DebugMetadata.java)只接受显式登记的有限文字、数字和布尔值；主线程登记、按组替换/删除、复用时清除，不保留全局View引用。采集仅读取已保存值，不执行业务回调或反射业务对象。每控件4组、每组16项、16KiB；整树业务值256KiB，超出明确标记未保存，不损失原树。桌面严格校验协议/类型/额度，刷新以新登记替换旧值；属性卡按组搜索、折叠、复制，并随完整快照、历史及调试报告保存。旧SDK和未接SDK的App不猜业务信息，Debug/Release样例依赖分开。

**第三项源码已完成：按类型和层级默认折叠。** 使用见[折叠设置](FIRST_USE.md#initial-tree-collapse)，结果见[验收](CORE_ACCEPTANCE.md#initial-tree-collapse-acceptance)。规则只控制展示，不裁剪原树或导出内容；根为第1层，类名区分大小写，支持完整名或短名，不支持通配符或继承匹配。保存只作用于新采集/打开的快照；显式应用到当前树会重设展开状态并保留选中路径。采集期间冻结该轮规则，新到分支按规则展开，已有分支按View身份保留手动开/关。筛选不会改真实场景，退出聚焦恢复原状态；仍为展开看自身、折叠看分支。沿用现有工装，未增加重复benchmark入口或手机采集。

**第四项源码已完成：颜色预览与别名。** 使用见[颜色说明](FIRST_USE.md#color-preview-aliases)，结果见[验收](CORE_ACCEPTANCE.md#color-preview-aliases-acceptance)。借鉴色块、格式复制和用户别名功能，沿用本项目属性栏与偏好设置。仅使用带来源的实际颜色属性，别名精确匹配RGBA（含透明度）并保存在本机；原始快照与业务值不改写。复用现有属性、偏好和采集生命周期工装，未增加benchmark入口或手机采集。

**第五项源码已完成：可见图层优先与按需补图。** 使用见[图层加载说明](FIRST_USE.md#layer-demand)，结果见[验收](CORE_ACCEPTANCE.md#layer-demand-acceptance)。统一按选中、投影视口生成展示需求；相机平移/旋转和视口变化能直接补图。进行中的整组请求和纹理解码不因展开/折叠重启；同次采集缓存跨2D/3D重挂载复用，刷新后重新取得。自身图、原生整组图和本地重建图使用不同身份，内容/布局变化使重建纹理失效，隐藏后排除包含隐藏子层的整组图。保持原纹理额度、完整深度采集及离线文件只用已保存像素；借鉴加载策略，未引入上游代码、依赖或benchmark入口。

Lookin的fast mode是图像加载策略，与本项目UIAutomator的fast语义树采集不同。

<a id="lookin-ui-next"></a>

### 第二轮UI与功能候选（四项源码完成）

2026-10-11再次核对客户端源码及现有工作台；远端HEAD仍为上述`95e30fdcc8151092678387c5262bce790a0d9530`。优先补画布辨识、测距和属性查看的小缺口。

| 顺序 | Lookin已有功能与源码 | 本项目现状 | 建议与完成条件 |
| --- | --- | --- | --- |
| 1 | [普通轮廓显隐、选中/悬停覆盖层的三级强调](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKDisplayItemNode.m) | 新源码已完成：[3D绘制](../src/features/layers/webgl-renderer.ts)支持普通轮廓开关和三级选中/悬停强调 | 设置在现有3D弹层并保存到本机；默认轮廓开启、轻档仅边框。缺图及缺图分支轮廓保留，只改显示，不改原图、层级或命中。见[使用](FIRST_USE.md#layer-appearance)与[验收](CORE_ACCEPTANCE.md#layer-appearance-acceptance)；安装版未更新 |
| 2 | [测距模式保持，松开快捷键后可继续测量](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Measure/LKMeasureController.m) | 新源码已完成：[固定控件对](../src/features/layers/useLayerMeasurement.ts)，沿用原测距和相机绘制 | M或工具栏固定两个控件；移开、改选、旋转、平移和缩放后保留。Esc先解除固定；换快照、隐藏/折叠/聚焦排除、View替换或外框变化时清除。见[使用](FIRST_USE.md#pinned-measurement)及[验收](CORE_ACCEPTANCE.md#pinned-measurement-acceptance)。Lookin锁定的是测距模式，固定控件对为本项目延伸；安装版未更新 |
| 3 | [导出选中控件的分支截图](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Export/LKExportManager.m) | 新源码已完成：[控件图片输出](../src/components/NodeImageActions.tsx)，属性栏“画面”可选自身图/分支图并导出PNG或复制 | 保留尺寸和透明度，分支优先已有原生整组图，否则用已保存独立位图本地重建；来源、采集时间和缺图明确提示，不新增手机请求。真实解码校验、取消及迟到隔离通过，见[使用](FIRST_USE.md#node-image-export)与[验收](CORE_ACCEPTANCE.md#node-image-export-acceptance)。Lookin导出groupScreenshot为TIFF，PNG/复制为本项目延伸；安装版未更新 |
| 4 | [属性分组的添加、移除](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/LKDashboardSectionView.m)及[本机保存](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Manager/LKPreferenceManager.m) | 新源码已完成：[七组显隐设置](../src/components/InspectorGroupPreferences.tsx)，沿用属性栏搜索和偏好设置 | 即时应用、本机保存及恢复默认；搜索临时显示隐藏匹配项，清除或Esc后恢复显隐和手动折叠。全部隐藏仍可设置或搜索；不存在的业务/交互组不计可见项。完整数据保留，存储失败诚实反馈。见[使用](FIRST_USE.md#inspector-groups)与[验收](CORE_ACCEPTANCE.md#inspector-groups-acceptance)；安装版未更新 |

四项源码已完成，沿用现有工作台、偏好和验证入口，无需手机安装或新增重复benchmark。本轮按用户要求启动三个独立managed worktree，分别负责设置模型、界面接入、回归与文档；使用含此前成果的共同基线，整合后验证。开发约定见[目录说明](DEVELOPMENT_STRUCTURE.md#worktree-development)及[AGENTS.md](../AGENTS.md)。

远程修改属性、运行时方法控制台、iOS变量追踪、AutoLayout和专有源码跳转暂不列入首批；自定义虚拟节点也不冒充真实Android View。客户端许可证为[GPL-3.0](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LICENSE)，Server为[MIT](https://github.com/QMUI/LookinServer/blob/ae396132ce6494477457cf450116dc760518d8ad/LICENSE)；本轮借鉴功能设计，未引入上游代码或运行依赖。

<a id="lookin-interactions"></a>

### 第三轮交互优化（四项源码完成）

继续参考同一固定提交，按用户要求在独立worktree与分支中并行实现，再合入`codex/lookin-interaction-integration`。使用见[上手说明](FIRST_USE.md#lookin-interactions)，验证见[交互验收](CORE_ACCEPTANCE.md#lookin-interaction-acceptance)。

| 优先级 | Lookin参考 | 本项目落实 |
| --- | --- | --- |
| 1 | [树悬停与父子引导](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyView.m) | 树/2D/3D双向高亮，直接父子引导；来源和会话隔离。搜索临时显示的折叠子层回退到物理父层，保持选择、键盘、虚拟树和画布测距 |
| 2 | [预览深度与维度过渡](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewView.m) | 220ms展开/收起及反向接续，父图就绪后交接；短视图切换和可中断的相机重置。保留own/group语义、纹理额度和减少动态效果 |
| 3 | [搜索结果定位属性](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Dashboard/Search/LKDashboardSearchPropView.m) | 真实属性行结果、所属分组、点击/Enter定位及短高亮；完整值、隐藏/折叠恢复、有限结果与迟到隔离 |
| 4 | [父子层级导航](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Hierarchy/LKHierarchyDataSource%2BKeyDown.m) | 本项目扩展为属性栏的完整父级路径：点击祖先选中并在树中定位，深层路径收起中间项，展开列表有高度上限；筛选/聚焦下明确定位，保留隐藏状态并隔离旧会话。见[使用](FIRST_USE.md#node-navigation)与[验收](CORE_ACCEPTANCE.md#node-navigation-acceptance) |

三项分别由`lookin-hover`、`lookin-motion`、`lookin-property-search`开发，整合代理连接画布并验证组合。沿用既有树和坐标入口；不引入上游实现或依赖。安装版和手机沿用原版本，稳定性等暂停任务不恢复。

第4项在前三项整合成果上继续开发，复用整合工作树的独立分支`codex/lookin-node-navigation`，完成后合回整合分支并精确同步到原目录。路径按钮为本项目扩展，没有复制Lookin实现；验证仍沿用现有树入口。

<a id="artemis参考未接入"></a>
<a id="artemis-architecture-reference"></a>

## Artemis参考与源码落地

2026-10-11固定对照`google/artemis`提交`351ca8422f7b5b54e80a9c1ce03a222e02415b6b`的主链路及29个相关源码/说明文件，并由subagent核对本项目已有能力。架构对照轮只读；随后完成步骤证据、失败分类、现有报告接入及确定性任务验收。源码及离线窗口验证分别见[逐步报告](CORE_ACCEPTANCE.md#debug-report-acceptance)、[任务验收](CORE_ACCEPTANCE.md#debug-task-acceptance)；后续独立候选的自有样例真机、停止和报告重开见[完整流程](CORE_ACCEPTANCE.md#task-sample-flow-acceptance)。尚未更新安装版，此前Helper实测另见下节。

**架构上值得学的是职责分开。** Artemis的Pro主链路把Planner规划、Operator决策、Validator动作校验/执行及Checker目标验收分开，外围由运行时管理任务、驱动访问设备、数据层保存证据，见[任务图](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/artemis/graph/graph.py)。本项目已分出device/capture/automation/desktop/shared，沿用[现有边界](DEVELOPMENT_STRUCTURE.md)，需要补的是任务证据和验收职责；无需整体迁入Python、LangGraph或新建一套设备控制层。

| Artemis模块/功能 | 本项目已有基础与缺口 | 借鉴顺序 |
| --- | --- | --- |
| [步骤、图片与工具记录](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/artemis/data_engine/models.py)及[结构化失败](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/artemis/agents/validator/incidents.py) | [会话](../electron/automation/debug-session.ts)已保存限量逐步树/图、实际目标/坐标和派发回执，错误区分阶段；[存储](../electron/automation/debug-evidence.ts)负责额度、去重和旧证据淘汰 | 首项源码完成，沿用已有采集和输入边界 |
| [只读Checker](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/artemis/agents/checker/checker.py) | 新源码固定原始目标、有序阶段和最终条件；[独立判定](../shared/debug-task-checker.ts)核两次新树，CLI/MCP显式调用，报告导入重新验树 | 第二项源码完成；只验声明的页面条件，结果分通过/失败/证据不足，未接模型 |
| [步骤检索、截图与动作标记](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/mcp_server/tools/inspect_trace.py) | [现有报告](../src/features/reports/TestReportPanel.tsx)已接入本轮调试记录、前后图、控件属性、步骤搜索和实际输入标记 | 随首项完成；历史查看只读，旧e2e仍按原始文件独立校验 |
| [任务运行与状态查询](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/mcp_server/README.md) | 当前授权会话已有过期、取消和单操作互斥，但不代表业务任务的完成/进度/验收 | 有多步执行需求时再补薄任务层；继续调用现有CLI/MCP，不把实验runner编进桌面产品 |
| [统一环境诊断](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/mcp_server/tools/diagnose.py)与日志关联 | 设备状态与专项SDK日志已有基础，业务报告的日志附件尚未展开 | 后续补只读检查结果及按任务时间段、App限定的有限日志，帮助区分环境/动作/验收失败 |
| [统一驱动](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/artemis/drivers/base.py)、[历史压缩](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/artemis/memory/context_policy.py)、[轻量远程客户端](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-client/DESIGN.md) | 设备/采集已隔离，当前以本地单设备、有限会话为主 | 保留参考；出现远程设备、多进程竞争或长任务模型上下文需求时再做。客户端文档的第二阶段版本化API是设计目标，不能当成已完成能力 |

**首项已完成：步骤证据与失败分类接入现有报告。** 当前范围：

- 保留最近100步，最多200份快照、100张独立PNG，报告及附件合计32MiB；关联会话、步骤、采集来源、前后树/图、实际动作及回执。容量不足优先丢旧证据；缺失与旧观察如实标注，不填成动作后的结果。
- 区分采集、定位、输入、验收和写盘阶段的错误；派发状态与验收结果分开，取消/超时保留原始回执，未知派发不自动重试。
- 初始调试格式v1由独立读取器核身份、时间、引用及附件摘要；任务加入后新写`inspector-debug-report-2`，继续兼容v1。复用[报告显示](../src/features/reports/TestReportPanel.tsx)，旧e2e校验保持。停止后仍可查看；专用入口直接加载本轮记录。
- 离线覆盖成功、失败、停止、缺图、容量、不同截图淘汰及旧报告兼容，真实main/preload/renderer的合成窗口通过；随后独立候选补验自有样例真机及原生报告重开。尚未更新安装版或引入模型；记录不包含3D独立图层位图，使用见[MCP记录](MCP.md#记录和数据范围)。

**第二项已完成：确定性目标验收。** 首次输入前固定本会话唯一目标、最多5阶段/20条件；按序检查，复验清除后续旧结果，最终须前置有效通过。检查只读，固定两次新观察；导入依据实际树重新判定，缺证据不能保持通过。报告显示目标、阶段、逐条件结果及当时观察，整会话仍为已记录。接口见[MCP](MCP.md#固定任务验收新源码尚未安装)与[CLI](CLI.md#固定任务验收新源码尚未安装)。

固定样例的完整流程及独立候选验收已完成：成功轮4步/6次观察/1次点击，阶段与最终条件通过，停止后原生查看、正常退出重开和真实选择器导入通过；先前被系统丢弃输入的失败轮仍显示失败，原树/图/回执保留。未加自动重试或改手机安全设置。后续再考虑薄任务运行层、模型及有限任务日志，稳定性暂停继续保留。

不照搬无限循环、burst跳过复核、自动坐标兜底或自动环境修复。Checker源码允许`inconclusive`放行执行，`assert`失败也不阻断放行；本项目要保留“通过/失败/证据不足”的验收结果，不能把允许继续执行当成测试通过。Flash/Pro是任务策略，不对应本项目fast/deep采集模式。UIAutomator2及Helper沿用下节已有判断，本轮不重复建设。

<a id="artemis-next-plan"></a>

### 下一轮：诊断、日志与动态观察（新源码已实现）

本轮按2026-10-12列出的四项计划开发，参考提交为`351ca8422f7b5b54e80a9c1ce03a222e02415b6b`。新源码已接入共用连接诊断、步骤日志、低帧率预览和会话进度，复用已有动作复核、步骤证据、任务验收和报告入口。使用见[新增工具](FIRST_USE.md#artemis-tools)，验证范围见[验收](CORE_ACCEPTANCE.md#artemis-tools-acceptance)。

| 顺序 | 任务 | 主要收益 |
| --- | --- | --- |
| 1 | 统一连接与采集诊断 | 解释“已连接却不能采集”的具体原因 |
| 2 | 失败步骤关联日志 | 在同一步查看截图、动作、回执及错误信息 |
| 3 | 可暂停的2D实时预览 | 观察页面切换、短暂弹层和动画 |
| 4 | 轻量任务进度展示 | 说明当前步骤、等待原因和停止结果 |

**1. 统一连接与采集诊断。** 参考[mobile_diagnose](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/mcp_server/tools/diagnose.py)的检查汇总和处理提示。

- 范围：复用现有设备、目标窗口和采集能力检查，汇总授权、锁屏、目标App前台状态、Helper、SDK及CLI/MCP连接状态。按所选采集方式区分必需项和可选项；缺少可选Helper不阻断UIAutomator。桌面、CLI/MCP共用结果，显示检查时间和设备/App身份；首版提供只读诊断及对应处理提示。
- 验收：覆盖正常、未授权、锁屏、App不在前台、Helper未启用、SDK不可用及连接失败；无法检查的项目显示未知。超时、取消和切换设备后，迟到结果不能覆盖当前状态；诊断不改变手机设置。

**2. 失败步骤关联日志。** 参考[失败任务与有限错误日志](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/mcp_server/tools/diagnose.py#L746)，扩展现有[步骤证据](../electron/automation/debug-evidence.ts)和[报告](../src/features/reports/TestReportPanel.tsx)。

- 范围：首版关联本程序的会话/步骤错误日志，再加入显式开启、限定目标App和任务时间段的Android日志。报告按步骤展示，支持查看与随报告保存；日志行数和附件大小有界，计入现有32MiB总预算，去除敏感配置。
- 验收：覆盖无日志、截断、采集失败、取消及导入重开；无法确认时间或App归属时标明缺证据。缺日志不改变已有动作回执或任务判定，旧报告继续可读，停止后释放本次日志采集资源。

**3. 可暂停的2D实时预览。** 参考[按观看者启停的屏幕采集](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/apps/admin_console/services/device_stream_service.py)，沿用现有截屏入口。

- 范围：用户显式开启，首版低帧率刷新截图，支持暂停、继续和关闭；3D层级仍由显式采集更新。分别显示预览与控件树的更新时间，暂停后可重新采集层级；预览帧不作为节点操作或任务验收依据。
- 验收：页面变化可见；关闭、断线、切换设备或退出后停止采集，不采用旧设备的迟到帧。验证与正常采集/调试共存时的资源占用和响应，避免并发堆积；实时截图不自动替换现有树、选中状态或3D纹理。

**4. 轻量任务进度展示。** 参考[任务状态、耗时、进度和停止控制](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/mcp_server/tools/task_manager.py)，在现有[调试会话](../electron/automation/debug-session.ts)和固定任务上补状态视图。

- 范围：展示当前步骤、耗时、采集/执行/等待页面条件等状态及停止原因。等待手机确认只在有明确请求时显示；复用现有停止和CLI/MCP查询入口，首次范围限于现有会话及声明的任务。
- 验收：覆盖等待、执行、失败、取消、到期与重开历史；状态事件绑定会话/任务，旧事件不能覆盖新任务。授权会话、操作完成与验收结果分别显示，任务通过仍由已有Checker判定。

本轮三个子代理从包含当前未提交成果的共同快照出发，在独立管理工作树开发；诊断、日志与进度、预览分别分工，统一整合。Helper运行响应和SDK实际采集未由只读诊断验证时，明确说明范围。Android日志需显式开启，不能确认归属时标记缺证据。实时预览默认关闭，每2秒刷新，繁忙时让出采集；帧不进入树或任务证据。当前完成源码及离线/桌面验证，暂停的稳定性验证、其他手机实测及长任务模型接入保持暂停，安装版未更新。

<a id="artemis-evidence-plan"></a>

## 步骤差异、任务模板与证据导出

本轮先落实此前建议的前三项，由三个子代理从当前源码共同快照 `07a5bef9b909` 分别开发，统一整合到 `codex/artemis-integration`。原目录的分支、暂存区和既有成果保留；这些是本项目的扩展，不是新增上游依赖。

| 顺序 | 功能 | 完成范围 |
| --- | --- | --- |
| 1 | 步骤前后差异 | 比较可信加载的同设备、App、页面实例与窗口观察，按唯一资源 ID 匹配逻辑控件；展示新增、消失、文字、位置及状态变化，重复或缺身份节点保持未知 |
| 2 | 固定任务模板与桌面编辑 | 选中控件生成精确条件，编辑目标、有序阶段和最终条件；本机保存、读取、更新、删除模板，显式固定到现有授权会话并只读验收 |
| 3 | 一键导出调试证据 | 选择当前或全部步骤以及树、截图、日志；保存独立证据文件夹并用原报告入口重新导入，缺少验收证据时副本保持证据不足 |

差异只供历史查看；模板不隐式开启授权，验收仍由原 Checker 核两次新树。导出只读取主进程已载入并绑定摘要的报告，取消不留半包，原记录保持。使用见[桌面入口](FIRST_USE.md#artemis-evidence-tools)，验证见[本轮验收](CORE_ACCEPTANCE.md#artemis-evidence-acceptance)。有限步骤任务执行、手机实测及安装版更新不在本轮范围。

<a id="recognition-comparison"></a>

### 控件识别采集方式（两轮评估完成）

当前`fast`已通过UIAutomator读取Android无障碍语义树，见[采集分工](MCP.md#采集分工)。UIAutomator2与Artemis的Accessibility Helper主要改变访问方式和可返回的语义信息。

| 方式 | 引入判断 | 收益与成本 |
| --- | --- | --- |
| [UIAutomator2](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/third_party/mobile_use/clients/ui_automator_client.py) | 当前不引入，优先级低 | 连接复用、控件选择/等待/输入更方便；需维护手机端自动化服务和工具兼容，识别仍依赖无障碍信息 |
| [Accessibility Helper](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/HierarchyDumper.java) | 两轮评估、固定样例产品路径及30分钟验证完成，已本机交付 | 布局标记补回样例容器，提示/错误/状态描述有效；系统栏节点和空输入框表示仍有差异，多设备/多日未验 |

- 评估仅用少量固定页面，在同设备/App版本下对比现有`fast`与Helper的耗时、可见节点/目标覆盖和连续成功率，保留空树、超时、窗口错配等失败。
- 实测收益明确后才接入；沿用现有授权、窗口和坐标校验，后端切换生成新快照并使旧节点失效。两者均不替代真实View层级、独立位图或3D采集；缺少无障碍信息的自绘控件仍可能无法定位。
- 已提供[只读对比入口](../scripts/recognition-comparison.ts)及[离线验证](../tests/recognition-comparison.test.ts)。使用现有Debug/焦点/几何校验、XML解析和PNG采集，转发复用现有资源归属校验；只请求Helper的`GET /dump?fields=xml`，不自动安装、启用、配对、输入、导航或修复服务。

将下列配置保存到本机忽略目录，例如`.benchmarks/recognition-comparison/sample-config.json`，替换序列号，先打开固定页面，再执行`bun scripts/recognition-comparison.ts .benchmarks/recognition-comparison/sample-config.json`：

```json
{
  "serial": "设备序列号",
  "packageName": "com.androiduiinspector.sample",
  "component": "com.androiduiinspector.sample/.MainActivity",
  "runs": 3,
  "targets": [{ "name": "样例文本", "text": "RED CHILD" }]
}
```

Helper已安装、启用且配对后，在配置中增加`helperTokenFile`，值为现有令牌文件的绝对路径；文件≤1KiB且仅当前用户可读写。令牌不写入报告。每轮1–5次、最多20个明确目标，只认唯一可见且有屏幕交集的匹配；Helper须返回目标App的唯一焦点窗口，空树、截断、错窗口、目标缺失/歧义、页面变化、超时均保留为失败。XML/PNG、每次结果及汇总写入新的`.benchmarks/recognition-comparison/run-*`目录；缺少Helper时仅生成fast基线，`comparable=false`并返回非零，不能当比较通过。

耗时包含身份校验、读树、同一路径PNG截图、几何校验和分析，不含转发建立及证据写盘；失败进入总耗时和成功率，不删首采，轮次交替先采Helper/fast。UIAutomator可能短暂抑制无障碍服务；Helper源码内部也有读根重试，协议未提供次数，不能把一个HTTP请求称为一次端侧尝试。两者均不保证树与截图同帧；节点数和指定目标命中不代表整页真实控件覆盖率。

2026-10-11同设备样例`MainActivity`、App版本`0.1`/code `1`、1080×2400竖屏，交替顺序比较3轮：

| 方式 | 成功 | 每次耗时（ms） | 中位耗时（ms） | 目标App可见且可定位节点 |
| --- | --- | --- | --- | --- |
| fast | 3/3 | 4358 / 4095 / 4784 | 4358 | 12 |
| Helper 1.2.0 | 3/3 | 1382 / 1154 / 1106 | 1154 | 4 |

两边均唯一命中`RED CHILD`，App版本、页面实例、焦点窗口和方向保持一致，各自树指纹稳定。Helper返回的4个App节点均能在fast中找到相同核心属性与边界；fast额外保留8个布局/背景节点。Helper总共返回4个窗口，统计只取目标App的唯一焦点窗口。本地XML/PNG、全部尝试及节点核对证据位于`.benchmarks/recognition-comparison/run-LTow0O/`（`report.json`、`node-comparison.json`）；之前fast单独基线保留在`run-N7LcMB/`，不混入本次耗时。

本页流程中位耗时缩短约74%，但这不是纯读树耗时，也不是整页覆盖率或长期稳定性结论。默认Helper树省略不重要的无障碍节点，[服务配置](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/ArtemisAccessibilityService.java)明确关闭`FLAG_INCLUDE_NOT_IMPORTANT_VIEWS`；当前fast保留更多布局层级，不能直接替换。本轮未测输入框提示/错误/状态描述、冷启动、长期后台或UIAutomator2，也没有复现服务抑制失败。

固定版本[安装包及摘要清单](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/helper_manifest.json)的Git blob、SHA-256和手机已安装APK均核对一致。首次安装被拒绝（`INSTALL_FAILED_USER_RESTRICTED`），经用户授权第二次安装成功；用户手动开启服务后配对并完成比较。测后已卸载Helper，确认包、进程和服务条目均已移除，删除本机临时令牌；用户另行开启的无障碍菜单保留，自有转发已收回，其他转发未改。原始失败和收尾记录保存在`.benchmarks/maintenance/run-20261011-mthajkh8/`。

后续顺序：独立样例先核布局节点、提示/错误/状态描述及冷启动、后台场景，结果见下节；处理与fast的差异后，再决定可选后端、来源标识和切换时旧节点失效。UIAutomator2继续保持低优先级。

#### 布局与语义验证（评估完成，完整树未通过）

[准备入口](../scripts/prepare-recognition-helper.ts)只下载上述固定提交的Helper源码及Apache-2.0许可证，逐文件核Git blob；补丁同时启用声明和运行时的`FLAG_INCLUDE_NOT_IMPORTANT_VIEWS`，使用独立包`com.androiduiinspector.a11yhelper`、名称`Inspector Layout Helper`、版本`1.2.0-inspector-layout`。构建沿用本仓库Gradle插件，编译SDK 36；旧Manifest的SDK参数保留在Gradle中。上游安装脚本、APK和签名密钥不下载，源码/产物只在忽略目录。

配置含义见[Android官方布局标记](https://developer.android.com/reference/android/accessibilityservice/AccessibilityServiceInfo#FLAG_INCLUDE_NOT_IMPORTANT_VIEWS)和[语义字段](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo)。[独立样例](../android/recognition-sample/src/main/java/com/androiduiinspector/recognition/MainActivity.java)包含两层非语义布局、输入提示/错误、状态描述及按钮；包名`com.androiduiinspector.recognition`，最低API 30，无SDK/绕过库或网络权限。样例私有`files/recognition-fixture.json`核实际框架属性，不替代Helper远程结果。

先设置本机`ANDROID_HOME`及Java 17的`JAVA_HOME`，再准备与构建：

```sh
bun scripts/prepare-recognition-helper.ts
gradle -p <上条输出的output> :app:assembleDebug --console=plain
gradle -p android :recognition-sample:assembleDebug :recognition-sample:assembleRelease --console=plain
```

真机仍手动启用Helper，临时安装、同页比较、样例冷启动和短时后台恢复分别留证，结束移除两个临时包。`recognition-comparison.ts`保持只读，不管理这些步骤。扩展配置示例：

```json
{
  "serial": "设备序列号",
  "packageName": "com.androiduiinspector.recognition",
  "component": "com.androiduiinspector.recognition/.MainActivity",
  "runs": 3,
  "helperTokenFile": "/本机私有目录/helper-session.token",
  "requireLayoutParity": true,
  "targets": [
    { "name": "外层布局", "resourceId": "com.androiduiinspector.recognition:id/layout_stage" },
    { "name": "内层布局", "resourceId": "com.androiduiinspector.recognition:id/nested_layout" },
    { "name": "输入框", "resourceId": "com.androiduiinspector.recognition:id/account_input", "helperAttributes": { "hint": "Account name", "error": "Account is required" } },
    { "name": "状态", "resourceId": "com.androiduiinspector.recognition:id/capture_state", "helperAttributes": { "state-description": "Paused" } },
    { "name": "按钮", "resourceId": "com.androiduiinspector.recognition:id/sample_action" }
  ]
}
```

`helperAttributes`只核唯一目标上的指定字段，fast缺这些字段仅如实记录；缺失或错误字段记Helper失败。报告版本2新增`layoutParity`，逐轮核目标App全部节点的父子结构、核心属性与数值边界，忽略后端ID和新增语义字段。`requireLayoutParity=true`时即使两边采集都成功，布局不一致仍使整轮比较失败；这只证明与当前fast语义树一致，不证明真实View全覆盖。

2026-10-11同台Android 14设备、独立样例版本`0.1`/code `1`、1080×2400竖屏已完成同页、样例进程冷启动后、后台340.863秒返回后的各3轮比较。两边共18次采集均唯一命中两个布局、输入框、状态和按钮；Helper准确返回`Account name`、`Account is required`和`Paused`，样例框架自检也通过。每个场景分别核同一页面实例、焦点窗口、版本和几何。冷启动仅停止独立样例，确认样例PID更换；后台前后两个进程均保持，Helper全程使用原配对。

| 场景 | fast / Helper成功 | fast / Helper中位耗时（ms） | 节点与完整布局门槛 | 本机报告 |
| --- | --- | --- | --- | --- |
| 初始同页 | 3/3 / 3/3 | 3880 / 1336 | 12 / 10；3轮均不一致 | `.benchmarks/recognition-comparison/run-pVNRI7/` |
| 样例冷启动后 | 3/3 / 3/3 | 3816 / 1171 | 12 / 10；3轮均不一致 | `.benchmarks/recognition-comparison/run-DWxdEv/` |
| 后台340.863秒再返回 | 3/3 / 3/3 | 3978 / 1401 | 12 / 10；3轮均不一致 | `.benchmarks/recognition-comparison/run-DitFOy/` |

全部9轮差异相同：Helper缺少`android:id/statusBarBackground`和`android:id/navigationBarBackground`；共享10个节点的父子路径、核心布尔属性和边界一致，仅空输入框的`text`不同。fast把提示写为`text="Account name"`；Helper上游在`isShowingHintText()`时清空text并单独返回hint，见[源码](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/HierarchyDumper.java)。没有过滤背景节点或把hint改写为text来放行，报告保留`layout-coverage`和`comparable=false`。额外两节点缺失原因尚未确认。后台恢复首次Helper耗时3419ms，后两次1401/1203ms；首采保留，不能只用中位数描述恢复表现。

当前判断：布局标记能补回样例容器，扩展语义有收益；完整树与fast仍有差异，不能直接替换。新增可选后端保留text/hint各自含义，明确系统装饰节点覆盖边界。上述耗时沿用包含PNG和校验的整段流程，不能称为纯读树速度或长期稳定性通过。

相关41项/5文件、全量811项/117文件0失败，完整构建及样例Debug/Release、Helper Debug构建通过。首次源码校验/Helper构建失败、样例安装被拒及后续修复/经用户准备后重试均保留；安装后APK与已核验产物摘要一致。测后两个临时包、进程和服务已移除，自有转发收回，令牌删除；其他服务按用户手动启用后的状态保留，没有改系统设置。原样例仍在，桌面安装进程未重启，历史/旧报告/安装包5份摘要未变。收尾脚本曾误判包缺失的返回码，独立包列表/进程/服务复核已确认移除，原失败仍留证。维护记录：`.benchmarks/maintenance/recognition-layout-20261011-7wl7z5_b/`；各场景保留完整XML/PNG、尝试及`layout-parity-analysis.json`。

<a id="helper-readonly"></a>

### 可选只读后端（固定样例产品路径已验）

CLI/MCP的`capture_ui`新增显式`backend="accessibility-helper"`，仅用于fast树和整屏截图，默认仍为UIAutomator。复用既有授权/窗口/几何、限额和转发归属，切换来源或模式先撤销旧共享；失败不换源。提示、错误、状态描述独立返回并在属性栏展示；不补系统栏节点、不把hint改成text、不降低比较门槛。Helper输入及等待验证暂不开放，操作前须显式采集UIAutomator并重新定位。使用见[MCP](MCP.md#可选-helper源码已接入仅只读)，验证与本机证据见[验收](CORE_ACCEPTANCE.md#helper-readonly-acceptance)。

固定样例已验同页语义、旧ID、401、HTTP等待响应及真实响应体的API/CLI/MCP取消和显式恢复；独立签名候选的真实授权窗口、属性显示、立即停止及30分钟/6轮双来源采集（含5分钟后台）也通过。12/10节点差异保留，临时包已移除。范围与全部失败见[补验](CORE_ACCEPTANCE.md#helper-body-window-stability-acceptance)；该阶段保留原安装版，后续Mac arm64本机升级/回退见[交付验收](CORE_ACCEPTANCE.md#local-delivery-acceptance)。

本次限定范围已完成。扩大使用范围时再安排多设备、多日与端侧任务/资源验证；不由单轮30分钟推定长期性能。UIAutomator2、Helper动作接口和自动恢复仍不在本步。

<a id="执行边界"></a>

## 设计与执行边界

Lookin参考固定在`95e30fdcc8151092678387c5262bce790a0d9530`：[工作台布局](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/LKStaticViewController.m)、[画布交互](https://github.com/hughkli/Lookin/blob/95e30fdcc8151092678387c5262bce790a0d9530/LookinClient/Static/Preview/LKPreviewController.m)。沿用Electron/React/WebGL及现有采集链路；Android数据按真实含义展示。

- 仅Debug App；展开看自身、折叠看分支，不裁整屏冒充独立图，不猜缺图透明。
- 身份、窗口、几何、裁剪、DRM、取消、迟到和授权保护不放宽；保留立即停止，不盲重试。
- 手机采集/输入/更新、模型/上传及正式发布须有当前任务范围；旧记录不延续授权。
- 稳定页3次≤15秒、首图→GPU≤500ms仍是待验目标，不因UI交付或文档整理标为完成。

<a id="1-统一快照与几何语义先做"></a>
<a id="1-补完父子画面正确性"></a>
<a id="父子画面"></a>
<a id="2-独立图边采边显示主线"></a>
<a id="采集性能"></a>
<a id="2026-10-03-慢采集定位"></a>
<a id="局部刷新"></a>
<a id="3-升级为真正的分支刷新"></a>
<a id="qt-与稳定性"></a>
<a id="4-补选中控件的真实样式属性"></a>

旧锚点仅兼容链接，原任务见[归档](archive/README.md)。
