# 项目当前状态

更新：2026-10-11。Mac arm64本机交付、升级与回退核验已完成；独立空配置首次使用组合通过，入口见[第一次使用](FIRST_USE.md)及[验收](CORE_ACCEPTANCE.md#first-use-acceptance)。原U系列后续暂停，脚本、benchmark和文档整理已完成。新增稳定性及干净Mac安装验证后置；[Artemis架构借鉴](LOOKIN_ALIGNMENT_PLAN.md#artemis-architecture-reference)的逐步证据、失败分类与固定任务验收已在独立候选完成自有样例真机流程及报告重开，尚未更新安装版。

Lookin第二轮四项已接入新源码：[普通轮廓开关与选中强调](FIRST_USE.md#layer-appearance)、[固定测距结果](FIRST_USE.md#pinned-measurement)、[导出/复制控件图片](FIRST_USE.md#node-image-export)、[属性分组显隐](FIRST_USE.md#inspector-groups)。七组可分别显示/隐藏、本机保存和恢复默认；搜索临时找回隐藏信息，完整复制、快照和历史仍保留全部数据。本轮采用[三个独立worktree](DEVELOPMENT_STRUCTURE.md#worktree-development)并行开发；结果见[属性分组验收](CORE_ACCEPTANCE.md#inspector-groups-acceptance)，安装版未更新。

## 已实现能力

| 范围 | 能力 | 边界 |
| --- | --- | --- |
| 采集 | Debug准入、真实View树、SDK属性/独立图，DDMS/JDWP兼容补采 | Release拒绝；不保证所有框架内部节点可读 |
| 工作台 | 紧凑顶部、底部树搜索、贴边属性卡片/浮窗；2D/WebGL 3D、树与场景同步、键盘浏览、双击设置、可配置类型/层级默认折叠 | 最多512层，截断提示；大树虚拟化；搜索路径不展开真实场景；折叠不裁剪原树 |
| 图层与画布 | own/group、选中/视口优先补图及同次采集缓存、悬停/选择、隐藏/恢复、分支聚焦/单层查看、测距、旋转/平移/缩放/适应 | 展开看自身、折叠看分支；适应避开属性栏；缺图不能猜透明或裁整屏补图 |
| 属性与历史 | 名称/继承/几何/原生布局、SDK显式分组业务值、颜色源值/透明色块/精确本机别名、七组显隐/恢复默认、本机保存、搜索临时展开并恢复、完整值复制、控件自身/分支PNG导出及图片复制、历史/对比/完整文件导出与离线打开 | 隐藏不删采集数据；未暴露或无效值标未知；业务信息需自有Debug App接新版SDK；截图与动态层不保证同帧，分支缺图明确标记 |
| 首页与菜单 | 连接/加载/离线/未授权/错误状态、离线历史、共享偏好、菜单与右键统一动作/快捷键 | 连接失败禁用旧设备；历史下拉可读、AI按钮完整；显式采集与立即停止保留 |
| 更新与恢复 | 渐进预览、单控件/分支/列表刷新、取消、迟到隔离、有界失败记录 | 不等于全部断线、远端任务或内存收尾已验证 |
| 特殊绘制 | SurfaceView/TextureView、Qt/QML专项取图 | 不绕过DRM；Compose/Flutter/WebView内部树及任意自绘未完整支持 |
| CLI/MCP | 读树/搜索/图片/测距；授权后采集/点击/滚动/返回/等待/留证；可选Helper只读采集 | Helper仅支持fast观察；deep是绘制树；旧导航故障根因未证 |
| e2e与报告 | 旧e2e本地步骤/截图/诊断；新源码支持最近100步逐步证据、固定目标、有序阶段及最终条件，只读验收和导入重判 | 输入回执、页面断言、任务验收各自显示；仅独立候选/单台自有样例真机已验，新功能尚未安装，不含3D独立位图 |
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
