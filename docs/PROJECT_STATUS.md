# 项目当前状态

2026-10-13：[UI第四轮6项](LOOKIN_UI_INTERACTION_ROUND4_PLAN.md#implementation-results)已合入源码：画布浮层互斥、属性搜索完整翻页、隐藏清单、3D仅边框、结构信息独立阅读、颜色快捷复制。三个子代理各用独立管理工作树，公共接线由整合方负责；全量1333项、类型检查、构建及三档实际App组合通过，完整结果见[验收](CORE_ACCEPTANCE.md#lookin-ui-round4-acceptance)。前三轮加本轮共25项，安装版保持此前候选。

2026-10-13：[UI第三轮6项](LOOKIN_UI_INTERACTION_ROUND3_PLAN.md#implementation-results)已合入源码：单层恢复、分支展开、搜索匹配巡览、图片右键操作、预览阅读点与手势、偏好分组跳转。三个子代理各用独立工作树；全量1318项、类型检查、构建、工作台及三档缩放原生组合通过，见[验收](CORE_ACCEPTANCE.md#lookin-ui-round3-acceptance)。原分支、暂存区和已有成果保留，安装版保持此前候选。

2026-10-13：[UI第二轮6项](LOOKIN_UI_INTERACTION_NEXT_PLAN.md#implementation-results)已合入源码：树行详细模式、统一查看范围、工作区布局记忆、连续缩放、颜色格式和固定属性参考。全量1300项、类型检查、构建、界面及三档原生拖动检查通过，见[验收](CORE_ACCEPTANCE.md#lookin-ui-round2-acceptance)。原目录已有成果和暂存区保留，安装版保持此前候选。

2026-10-13：[UI 与交互细节计划](LOOKIN_UI_INTERACTION_PLAN.md)的7项已合入源码。新增紧凑属性摘要、分组展开记忆、清楚的工具状态、2D/3D共用测距与复制、内部候选过滤、树搜索建议、查看控件前进/后退和深/浅/系统外观。操作见[第一次使用](FIRST_USE.md)，整合结果见[验收](CORE_ACCEPTANCE.md#lookin-ui-polish-acceptance)。安装包保持此前候选。

新增 [Command / Ctrl 快捷点选折叠内部](FIRST_USE.md#quick-select)和[不可见控件边界](FIRST_USE.md#invisible-layouts)：直接使用当前快照，虚线边缘可选中查看属性；测距与候选列表可配合使用。已接入源码预览，安装包保持此前候选，范围见[验收](CORE_ACCEPTANCE.md#lookin-inspection-tools-acceptance)。

测距已按 Lookin 的操作完善：选中 A、悬停 B，右侧替换属性栏并显示两张已有控件图片及水平/垂直边缘距离；支持 Option / Alt 临时测距、保持模式和固定结果。主画布不显示测距标签、线或端点。使用见[测距说明](FIRST_USE.md#pinned-measurement)，范围见[最新验收](CORE_ACCEPTANCE.md#lookin-measurement-panel-acceptance)。本轮更新源码预览，安装包仍为此前候选。

更新：2026-10-12。Mac arm64本机交付、升级与回退核验已完成；独立空配置首次使用组合通过，入口见[第一次使用](FIRST_USE.md)及[验收](CORE_ACCEPTANCE.md#first-use-acceptance)。原U系列后续暂停，脚本、benchmark和文档整理已完成。新增稳定性及干净Mac安装验证后置；[Artemis架构借鉴](LOOKIN_ALIGNMENT_PLAN.md#artemis-architecture-reference)的逐步证据、失败分类与固定任务验收已在独立候选完成自有样例真机流程及报告重开，尚未更新安装版。

本轮[Artemis四项](FIRST_USE.md#artemis-tools)已接入新源码：共用连接诊断、失败步骤日志、可暂停2D预览及会话进度。三个子代理各用独立工作树，统一合入 `codex/artemis-integration`；原目录既有成果和暂存区保留。验证范围见[验收](CORE_ACCEPTANCE.md#artemis-tools-acceptance)。本轮未更新安装版或手机包，原暂停任务仍后置。

随后三个子代理在新工作树完成[步骤差异、桌面任务模板及证据导出](FIRST_USE.md#artemis-evidence-tools)，仍统一合入 `codex/artemis-integration`。全量1201项/159文件0失败，构建、既有树/授权交接及真实桌面IPC组合通过，见[验收](CORE_ACCEPTANCE.md#artemis-evidence-acceptance)。差异不改变验收；模板复用现有授权与两次新树Checker；导出副本缺证据会降为证据不足。有限步骤自动执行留第二批，安装版与手机包未更新。

最新测距入口改为[明确选择A/B](FIRST_USE.md#pinned-measurement)：点“测量距离”，从树或画布选择两个控件，卡片显示名字并可单独重选；不再依赖悬停才能开启。22项定向测试、类型检查、完整构建、树/属性回归、三档缩放各89组及宽窄窗口实际App组合通过，见[验收](CORE_ACCEPTANCE.md#measurement-picking-acceptance)。源码和构建已同步，安装版未更新。

此前三个独立工作树完成[模板JSON共享与片段复用、控件匹配诊断、跨次运行对比](FIRST_USE.md#artemis-reuse-tools)。全量1249项/166文件0失败，类型检查、完整构建、工作台和原有证据导出回归通过；新功能真实桌面组合覆盖共享取消/冲突、候选定位与草稿保留、两次独立Checker运行及主报告来源保留，见[验收](CORE_ACCEPTANCE.md#artemis-reuse-acceptance)。同名模板保留本机内容；参考候选不计命中，缺证据不继承通过。安装版与手机包未更新。

新增[水平旋转、长文本阅读和右键复制](FIRST_USE.md#lookin-operation-details)：三个subagent各用独立worktree，统一合入`codex/lookin-operability-integration`。全量1095项、既有树/属性回归、三档缩放各87组、实际App及原生菜单检查通过，见[验收](CORE_ACCEPTANCE.md#lookin-operation-details-acceptance)。源码和构建已同步，本机安装版已更新并普通启动。

已修正深层父子在左侧树中同列的问题：真实逐级缩进、随层级延伸的连接线及横向滚动，选中/定位自动露出，聚焦返回保留横纵位置。33项相关测试、512层/25k树、三档侧栏截图、坐标回归及构建通过，见[验收](CORE_ACCEPTANCE.md#deep-tree-hierarchy-acceptance)。安装版已更新并普通启动，原5份历史保留；当前用户查看的样例页面保持。

进一步收起3D默认悬停测距：普通悬停不显示虚线/数值，按M或“固定测距”才显示，解除后立即隐藏；控件提示和主动测距保留。定向22项、三档缩放各86组、实际App组合14组、宽窄窗口及构建通过，见[验收](CORE_ACCEPTANCE.md#explicit-measurement-acceptance)。本机安装版已更新并普通启动，原5份历史保留，103节点3D页面已重开。

最新[继承类型图标、场景提示和图片预览](FIRST_USE.md#lookin-discovery)已完成源码。三个subagent分别使用独立worktree，统一合入`codex/lookin-discovery-integration`；定向47项、全量1082项、既有树/采集回归、三档坐标/DPI代理及实际窗口检查通过。结果见[验收](CORE_ACCEPTANCE.md#lookin-discovery-acceptance)，源码和构建已同步；随后已更新本机安装版并普通启动，见[本机更新](DELIVERY.md#本机更新2026-10-12)。

当前安装候选为`diagnosis-handoff-20261012-746e1dc0`，原5份历史保留，另保存了更新前的16节点样例；普通启动后已重新打开该样例的3D页面并恢复`UPDATED CHILD`选择。以下各轮“安装版未更新”为当轮记录；本轮已交付当前桌面源码，手机包保持原状。

此前[展开档位、控件状态说明和二维测距卡片](FIRST_USE.md#lookin-usability)已接入源码。三个subagent分别使用独立worktree，统一合入`codex/lookin-usability-integration`；全量1059项、树/采集组合、三档页面缩放与DPI代理及宽/窄窗口检查通过。结果见[验收](CORE_ACCEPTANCE.md#lookin-usability-acceptance)，当前源码和构建已同步，安装版未更新。

Lookin第二轮四项已接入新源码：[普通轮廓开关与选中强调](FIRST_USE.md#layer-appearance)、[固定测距结果](FIRST_USE.md#pinned-measurement)、[导出/复制控件图片](FIRST_USE.md#node-image-export)、[属性分组显隐](FIRST_USE.md#inspector-groups)。七组可分别显示/隐藏、本机保存和恢复默认；搜索临时找回隐藏信息，完整复制、快照和历史仍保留全部数据。上一轮采用[三个独立worktree](DEVELOPMENT_STRUCTURE.md#worktree-development)并行开发；结果见[属性分组验收](CORE_ACCEPTANCE.md#inspector-groups-acceptance)，安装版未更新。

Lookin第三轮前三项已接入新源码：[树/画布双向悬停、连续图层与相机动画、属性结果精确定位](FIRST_USE.md#lookin-interactions)。三个subagent各用独立worktree分支，统一合入`codex/lookin-interaction-integration`；原目录既有成果和暂存区保留。结果见[交互验收](CORE_ACCEPTANCE.md#lookin-interaction-acceptance)，安装版未更新。

后续第4项[层级路径导航](FIRST_USE.md#node-navigation)已接入新源码：属性栏点击祖先即可选中并定位，深层路径可展开，筛选/聚焦及旧会话隔离保留；同时修复进入较小聚焦树后退出丢失原滚动位置。结果见[验收](CORE_ACCEPTANCE.md#node-navigation-acceptance)，安装版未更新。

Lookin后续计划前三项已接入新源码：[折叠画面内快速选择](FIRST_USE.md#quick-select)、[布局规则目标定位](FIRST_USE.md#layout-links)、[分层业务信息](FIRST_USE.md#structured-values)。三个subagent在独立worktree开发，统一合入`codex/lookin-migration-integration`；结果见[验收](CORE_ACCEPTANCE.md#lookin-migration-acceptance)。安装版和手机包未更新；事件处理信息仍后置。

## 已实现能力

| 范围 | 能力 | 边界 |
| --- | --- | --- |
| 采集 | Debug准入、真实View树、SDK属性/独立图，DDMS/JDWP兼容补采 | Release拒绝；不保证所有框架内部节点可读 |
| 工作台 | 紧凑顶部、底部树搜索、贴边属性卡片/浮窗；2D/WebGL 3D、树与场景同步、键盘浏览、双击设置、可配置类型/层级默认折叠 | 最多512层，截断提示；大树虚拟化；搜索路径不展开真实场景；折叠不裁剪原树 |
| 图层与画布 | own/group、选中/视口优先补图及同次采集缓存、悬停/选择、折叠分支内部候选定位、隐藏/恢复、分支聚焦/单层查看、测距、旋转/平移/缩放/适应 | 展开看自身、折叠看分支；适应避开属性栏；缺图不能猜透明或裁整屏补图 |
| 属性与历史 | 名称/继承/几何/原生布局、原生布局目标定位、SDK显式分组/分层业务值、颜色源值/透明色块/精确本机别名、七组显隐/恢复默认、本机保存、搜索临时展开并恢复、完整值复制、控件自身/分支图片预览/PNG导出/复制、历史/对比/完整文件导出与离线打开 | 隐藏不删采集数据；未暴露或无效值标未知；业务信息需自有Debug App接新版SDK；截图与动态层不保证同帧，分支缺图明确标记 |
| 首页与菜单 | 连接/加载/离线/未授权/错误状态、离线历史、共享偏好、菜单与右键统一动作/快捷键 | 连接失败禁用旧设备；历史下拉可读、AI按钮完整；显式采集与立即停止保留 |
| 更新与恢复 | 渐进预览、单控件/分支/列表刷新、取消、迟到隔离、有界失败记录 | 不等于全部断线、远端任务或内存收尾已验证 |
| 特殊绘制 | SurfaceView/TextureView、Qt/QML专项取图 | 不绕过DRM；Compose/Flutter/WebView内部树及任意自绘未完整支持 |
| CLI/MCP | 读树/搜索/图片/测距；授权后采集/点击/滚动/返回/等待/留证；可选Helper只读采集 | Helper仅支持fast观察；deep是绘制树；旧导航故障根因未证 |
| e2e与报告 | 旧e2e本地步骤/截图/诊断；新源码支持最近100步逐步证据、固定目标、有序阶段及最终条件、桌面任务模板、历史步骤差异、只读验收、证据导出和导入重判 | 输入回执、页面断言、任务验收各自显示；本轮仅离线/隔离桌面验证，新增功能尚未安装；旧独立候选的单台样例真机结果不覆盖本轮，不含3D独立位图 |
| 只读诊断 | 固定App、显式单次采集、30秒停止、图像分类、节点本地定位及属性联动 | 独立于旧报告；不自动输入/导航/重试，取消恢复仍待组合验收 |

## 最近确认

[Lookin首项借鉴](LOOKIN_ALIGNMENT_PLAN.md#lookin-feature-reference)已完成新源码：完整快照文件导出/离线打开、已采集分支图随文件与历史保存、旧树JSON兼容，以及取消/坏文件/迟到隔离。入口和版本边界见[说明](FIRST_USE.md#offline-snapshot-files)，结果见[验收](CORE_ACCEPTANCE.md#snapshot-files-acceptance)；安装版仍保留原版本。

Lookin第二项已接入新源码：[SDK显式登记业务信息](../android/README.md#business-debug-metadata)，属性栏按组显示只读文字/数字/布尔值，支持搜索和原值复制；刷新移除旧登记，完整快照、历史及调试报告保留分组。源码和离线验证见[验收](CORE_ACCEPTANCE.md#business-debug-metadata-acceptance)，本轮未更新安装版或手机包。

Lookin第三项已接入新源码：[类型/层级默认折叠](FIRST_USE.md#initial-tree-collapse)。默认全部展开，可保存为新快照的规则或显式应用当前树；完整树、搜索定位、手动状态与own/group语义保留。沿用原工装验证，结果见[验收](CORE_ACCEPTANCE.md#initial-tree-collapse-acceptance)，安装版未更新。

Lookin第四项已接入新源码：[颜色预览与别名](FIRST_USE.md#color-preview-aliases)。按 Android ARGB/QML RGBA 的真实来源显示透明色块，支持原值、CSS Hex/RGBA 复制及精确透明度别名；设置本机保存，快照原值保留。QML 非 8 位透明度的 Hex 标近似，未知来源不补猜颜色。结果见[验收](CORE_ACCEPTANCE.md#color-preview-aliases-acceptance)，安装版未更新。

Lookin第五项已接入新源码：[可见图层优先与按需补图](FIRST_USE.md#layer-demand)。展示需求按选中及投影视口排序，移动视口自动补图；进行中请求去重，分支图跨折叠及2D/3D复用。新采集/刷新失效旧缓存，自身/整组/重建图身份分开，完整深度采集和离线零补采保留。固定合成工装中三次折叠请求3→1，全部移出视口且保留一个选中节点时纹理上传72→1；结果见[验收](CORE_ACCEPTANCE.md#layer-demand-acceptance)，安装版未更新。

已修复一个导致3D父层级折叠后只剩边框的路径：合成图扫描期间展开会释放纹理，再收起时队列误认完成，未重新加载。现在失效结果会按当前展示需求补图。根层级/普通父层级像素回归、三档缩放各51组、全量982项及构建通过，见[修复验收](CORE_ACCEPTANCE.md#collapsed-parent-fix)。已有103/1590节点历史页离线折叠可见，原App/历史未替换；尚未确认用户当次具体操作的触发时序。

固定任务独立候选`diagnosis-handoff-20261011-ab4c3840`从冻结的565份公开源码与空依赖目录完成936项/127文件测试、构建和严格签名。真实授权自有dynamic样例后，CLI定义、MCP阶段检查、一次CLI点击、MCP最终检查共4步/6次观察；停止撤销、原生查看及正常退出重开导入通过。首次系统丢弃输入的失败轮完整保留，重开仍判失败；成功报告按实际树重判，截图和身份对应。范围见[完整流程验收](CORE_ACCEPTANCE.md#task-sample-flow-acceptance)，上手入口见[第7步](FIRST_USE.md#7-可选完成一次固定样例任务)。当前安装版仍是下述旧版本。

当前安装`diagnosis-handoff-20261011-de87a543`，已备份完整旧App与停机userData。新版及实际回退的旧版均打开原5份历史/103节点工作台并正常退出，现已恢复新版普通启动。本机交付轮的样例采集和CLI/MCP私有合成检查分别记录，范围见[本机验收](CORE_ACCEPTANCE.md#local-delivery-acceptance)。

随后冻结完整源码，从独立依赖目录测试830项并重新构建；8份产品产物与安装版相同。新候选在空配置完成真实样例15节点采集、2D/3D/属性、保存重开，同一真实快照的包内CLI/MCP查询及撤销通过。仅单台Mac arm64/Android 14、已安装样例；干净系统首次安装未验，见[组合验收](CORE_ACCEPTANCE.md#first-use-acceptance)。原5份历史、旧报告和安装包不变。

U1–U6c界面和交互已交付。当时使用已有数据复核：首页历史、AI按钮、旧报告导入及三张截图、取消/坏索引保留、关闭重开/Escape和正常退出通过；5份历史完整，最终恢复已有103节点工作台。

用户说明此前是等待权限确认，原“程序卡住”判断已撤回，推测性读取线程、超时和调度改动已撤掉。实际报告生命周期修复与首页改进保留。

此前A3在旧候选完成一台Android 14设备、一个设置页的属性视觉复核。该证据不覆盖之后的UI版本；上述U1–U6c桌面复核没有新手机采集。各阶段失败、版本和原始证据见[验收沿革](archive/CORE_ACCEPTANCE_2026-10-09.md#ui复刻收口u1u6c2026-10-11)。

Artemis Helper的[独立识别评估](LOOKIN_ALIGNMENT_PLAN.md#recognition-comparison)已完成，完整布局仍有差异。[可选只读后端](MCP.md#可选-helper源码已接入仅只读)已补验真机响应体的API/CLI/MCP取消、独立签名候选原生窗口和30分钟固定样例持续验证，见[验收](CORE_ACCEPTANCE.md#helper-body-window-stability-acceptance)。补验当时未改产品代码和原安装版；当前本机版已包含该后端，配置见[交付说明](DELIVERY.md)。临时手机包已移除，默认UIAutomator及12/10差异保留，多设备/多日仍未验。

## 保留缺口

- U6d新版手机单页、诊断取消/迟到/恢复及取图阶段取消：暂停，恢复时重新限定范围。
- 旧工具截图差异、冷启动首采、间歇同步与CLI/MCP导航根因：尚未证实。
- 复杂硬件半透明严格像素、更多机型/框架/多窗口、长期资源及物理DPI：未全面验收。
- 自然语言自动调试、最新跨平台包、干净系统安装、正式签名/公证与发布：未完成。

源码、隔离工装、安装窗口和手机分别验收；不同版本的单轮结果不拼成稳定性能承诺。历史方案和旧“下一步”不自动恢复执行。
