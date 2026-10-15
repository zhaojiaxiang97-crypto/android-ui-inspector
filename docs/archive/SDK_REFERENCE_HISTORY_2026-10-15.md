# SDK 协议、探针与实验历史参考

整理日期：2026-10-15。本文从原 `android/README.md` 按主题归档，保留协议细节、探针互斥条件、计时定义和失败证据，便于追溯。**归档不表示这些接口已废弃。**

接入与更新请看 [Android SDK 接入](../../android/README.md)，当前职责看 [开发结构](../DEVELOPMENT_STRUCTURE.md)，验收范围看 [核心验收](../CORE_ACCEPTANCE.md)。协议是否可用应同时核对实际 SDK 能力、源码和对应版本；历史实验候选不因此进入正式路径。

**阅读约定：** 以下保留各轮原记录。“当前／最新／本轮”“已部署／尚未部署”“下一步／待完成”和授权描述都只指原记录当轮，不能作为现在的安装状态、执行计划或操作授权。一次后续成功不覆盖先前失败。旧耗时、样例通过与本机构建不代表业务性能、通用设备能力或安装验收。文中脚本命令在仓库根目录运行；旧构建说明中的“本目录”指 `android/`，不是本归档目录。本机 `.benchmarks/` 路径只是历史证据索引，公开仓库不包含业务包或设备原始数据。

## 按主题查阅

- [历史整理与样例记录](#handoff-history)
- [排队诊断、身份引导与会话并发](#queue-identity)
- [桌面默认路线与交付记录](#desktop-handoff)
- [会话建立与计时口径](#session-timing)
- [合并树失败与绘制期核验](#merged-tree)
- [旧 SDK、无 SDK 与硬件／软件窗口](#legacy-compatibility)
- [父分支恢复、模式互斥与时序](#branch-recovery)
- [投递、连续慢化与硬件复用实验](#pipeline-experiments)
- [短父链、超时与排队诊断](#timeout-diagnostics)
- [输出流水线与轻量不可变几何](#immutable-geometry)
- [绘制分段、小批图集与内存实验](#snapshot-experiments)
- [生命周期、空闲与性能取证](#timing-experiments)
- [父链、变换与矩形放置协议](#geometry-contracts)
- [图片流、会话协议与旧接入记录](#stream-and-build)
- [业务包更新流程及历史观察](#business-update-history)
- [树就绪、刷新、取消与独立图片](#refresh-and-capture)
- [业务信息协议与样例证据](#metadata-and-samples)

<a id="handoff-history"></a>

## 历史整理与样例记录

更新：2026-10-15。架构 R8 已完成：`CapturePipeline` 拥有共同编码队列，`RefCaptureSelection` 管未提交和迟到位图，`CaptureOutput.LayerFile` 管图片流与原子发布；`DebugCaptureProbe` 仅在 SDK `src/debug`。SDK/sample 的 Debug、Release 构建通过，两条真实采集入口在一台 Android 14 自有 sample 上完成旧/新对照；本轮未更新业务 App 或桌面。范围与限制见[第八轮验收](../CORE_ACCEPTANCE.md#architecture-round8-acceptance)，全项目状态见[架构收尾](../ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)。

整理：2026-10-09。本文保留接入、协议和探针操作参考。多轮时延、旧阈值、候选及“已部署/下一步”均按原轮理解，不作为当前部署状态或待办；当前能力看[项目状态](../PROJECT_STATUS.md)，版本看[验收清单](../CORE_ACCEPTANCE.md)，顺序看[唯一计划](../LOOKIN_ALIGNMENT_PLAN.md#下一步)。真机探针、安装和重启需先明确本轮范围。

2026-10-11新增独立控件识别样例`recognition-sample`，包名`com.androiduiinspector.recognition`、最低API 30，无SDK/绕过库或网络权限。两层布局、输入框提示/错误和状态描述用于fast/Helper对照；私有`files/recognition-fixture.json`只核样例框架属性。构建：`gradle -p android :recognition-sample:assembleDebug :recognition-sample:assembleRelease --console=plain`（设置Android SDK及Java 17）。固定版本Helper的隔离构建、配置和本轮结果集中维护在[控件识别计划](../LOOKIN_ALIGNMENT_PLAN.md#recognition-comparison)。

<a id="queue-identity"></a>

## 排队诊断、身份引导与会话并发

SDK排队诊断（默认关闭；新版已同签名部署业务App）：capture/capture-visible(withTree)额外传treeQueueDiagnostics=true及正确processInstance才启用，500ms仍排队发一次JSON；结束/中断清理，普通采集不建诊断线程。Binder/LocalSocket共用shell UID2000/Debug/实例限定read-tree-task和read-sdk-build，均绕开采集监视器，不排UI；原session普通数据root兼容不扩大到诊断查询。tree-queue-v1是事件协议；sdk-source-v1是源码/配置指纹，写入BuildConfig及AAR/APK资产，不冒充二进制摘要或安全认证。主机单次库及适配核对可信本机APK/SDK和实际系统/SDK实例，只发一次绑定请求，无重试或取图回退。未接桌面默认流程，运行主桌面未更新；业务首轮在PID读取阶段停止，没有SDK/排队实机验证，详见[方案](STARTUP_FAILURE_REVIEW.md)。

`read-diagnostic-identity`在采集锁外返回PID/实例/SDK来源与查询nonce，不依赖成功读树。只接受shell/Debug、64位小写十六进制nonce和预期PID字符串；旧实例绑定查询不变。主机`createQueueIdentityBootstrap`生成新nonce并前后核对可信安装包和实际PID/startTicks，单次失败不重试，不发启动/重启命令或采集。此前75项相关、全量555项及Android构建本地通过；当前已保留数据安装业务包，不能将产物验收当运行身份或首采验收。

业务显式入口已接引导：`bun scripts/diagnostics/sdk/sdk-queue-business-probe.ts SERIAL PACKAGE PID START_TICKS /trusted/app.apk /trusted/sdk.aar --run`，只用于已观察主进程与可信产物，不发启动/重启命令。0预备树、仅1新UUID诊断请求，独立读/采集连接；15秒操作期限、250ms门禁不增，取消先恢复再关闭，自有清理未知不通过，失败报告保留而不补跑。新版已部署，但本次一次启动后的PID查询失败，入口实际调用0次；不拿后续正常页面补称冷启动结果。`observeQueueMainProcess`仅读取最多1秒/10次PID，只有正常缺PID继续，发现后一次系统stat→cmdline→stat固定身份；不启动App、取树或调用SDK。33项定向、572项全量及构建通过，冷启动缺PID路径尚未复测，再启动需授权。

受控入口：`bun scripts/diagnostics/sdk/sdk-queue-sample-probe.ts SERIAL --run`，只支持安装好的独立Debug样例。静态Activity与shell/PID/UUID限定的单次hold只在src/debug，固定1800ms自动释放、进入确认500ms，Release无这些组件或SDK。一次预备树+一次hold+一次诊断请求，保存原窗口、实际次数、日志年龄、恢复及自有资源清理；不能将主机取消当安卓任务结束。第一条自有SDK连接仅快速读标量，第二条采集；系统身份一次run-as cat读取stat/cmdline/stat，不以SDK回复替代。读失败关闭自己的资源，无content回退或第三条客户端。最新同签名保留数据更新后单轮通过：通知到状态读完85ms、15帧/暂停12ms后恢复，三转发清理及原业务窗口/PID一致。控制命令2000ms，250ms门禁不变；arm已消费，不重复样例观察，不更新/重启业务或主桌面。

会话连接已修正：SDK最多同时接纳两条shell/root客户端连接，空闲桌面连接不再挡住诊断连接，超出上限立即关闭；实际数据dispatch仍由同一Provider监视器串行，tree-ready输出保持线程隔离。close-session会关闭已接入连接并唤醒accept。实际Session源码的Java TCP替身验证通过，不等于Android LocalSocket/活View安全验收；已安装旧SDK不会自动获得修正。

历史记录（2026-10-08）：当轮结构整理及统一本地验收完成，Provider保留准入/生命周期/串行调度，Session管连接/请求，Tree管树/属性；`HierarchyCapture`保留取图编排，`CaptureFrame`管主线程帧/几何/特殊缓冲，`CaptureOutput`管编码/文件/位图所有权，不读取活View。Provider名字、DUMP权限、协议、预算和最低API不变。726项本地全量、SDK/样例Debug/Release构建、样例反射实际签名及源码标记核对通过；样例Release无SDK/诊断实现，原无操作ProbeRunner保留。**该轮仅更新源码及本地产物，未更新或测试手机包**；当时的候选交付安排见[旧重构记录](ARCHITECTURE_REFACTOR.md)，不作为当前待办。最新 R8 源码与样例验证见本文开头。

<a id="desktop-handoff"></a>

## 桌面默认路线与交付记录

交付后本地回归完成：453项完整测试、8项针对性测试及构建通过；实际桌面包CLI/MCP只读核对通过。未操作手机/更新SDK/重启桌面。源码新增普通fixture的打包禁用，尚未交付；下一项只读整理冷启动失败证据，不追加手机循环。

桌面已交付最新本机测试包：默认按钮的实际打包App基线/首图取消/恢复单轮通过，SDK图片来源、迟到隔离、同业务PID/窗口、GPU提交及转发清理通过。主桌面已备份后更新重启，手机SDK/App未更新、不重启/清数据。开发证书签名核验通过、未公证；下一项全量本地与打包只读入口核对，不再追加手机循环。

隔离桌面异步fixture烟测已通过：真实Electron/React/WebGL中取消清画面、立即恢复不混旧事件，模拟SDK来源明确，真实透明PNG标captured/全透明且仅边框，可见PNG提交GPU，无渲染错误；119项回归与构建通过。未操作手机/部署SDK/更新主桌面，不能当业务SDK或默认取图性能验收；下一项桌面版本交付，重启前确认。

桌面默认交接本地回归已通过：普通入口不覆盖默认路线，SDK来源及captured/empty传到App状态，取消/迟到隔离/新请求等待旧请求释放均覆盖；主进程取消后不再外发迟到进度。117项回归与构建通过，本轮不操作手机或更新SDK/桌面。回调及setter替身不是实际工作台渲染；下一项独立profile异步fixture烟测。

默认小页面取图新规则（本地及单轮实机通过）：复用现有SDK树成功的身份/几何校验，stream2/wake1且硬件状态明确才自动SDK图片，DDMS属性仍读取但跳过其图片。旧SDK/无SDK/未知能力和显式preferVisibleSdk=false保持兼容；大页200门槛不作盲删。SDK采用失败不启用新默认路线，不增加能力查询/重复读树或提前自启动。此路径不是显式SDK先树/merged路线，不能直接继承其4秒性能或通知验收。

真正默认路线`--default-route`单轮设置页5.756/5.331秒，各98节点/71图/0失败，70张SDK批量图加1张SDK补图，无DDMS批量图片。首图取消58ms返回，后续预览0；同进程/编码摘要/几何/空图/暂停计数/清理通过。未更新手机SDK或主桌面，无导航/重启/清数据；下一项桌面交接本地回归，不重复手机采集，不称稳定性能。

最新正式采集API稳定设置页回归：显式SDK单轮基线4.001秒/恢复3.796秒，98节点/71图/0失败，首图取消16ms返回、后续预览0，主线程恢复/图像摘要/几何/空图/连接清理通过。没有更新业务SDK或导航/重启/清数据；当前默认小树200节点阈值未改，不能把此工装当默认路线或桌面UI验收。

<a id="session-timing"></a>

## 会话建立与计时口径

最新实机结果：独立样例同签名保留数据更新后，`--session-timing`单轮passed=true；content启动1255ms，SDK call2.878ms/锁等待0.001616ms/dispatch2.792ms/openSession2.705ms。三次读树1380/85/38ms，身份/树摘要一致，原业务设置窗口恢复、转发空。SDK时间为嵌套范围不相加；只能认定该轮主要成本不在SDK call内，外部命令/Provider入口/传输尚未细分。业务包/主桌面未替换，未清数据或额外重启，旧失败不覆盖。

可选服务启动诊断：content `open-session` 的extras显式布尔`sessionTiming=true`时，新SDK返回`sessionTimingVersion=1`及`sessionCallNs`（Provider call进入至dispatch完成）、`sessionLockWaitNs`（进入至获取共用monitor）、`sessionDispatchNs`（dispatch调用）、`sessionOpenNs`（openSession创建或复用服务）。均为设备单调时钟计算的纳秒时长，范围嵌套，不相加；不包括Provider入口前、回复编码/传输。默认不启用，其他方法不计时，未授权/非Debug不返回诊断；创建失败仍返回error。主机现已接入，样例入口`bun scripts/diagnostics/sdk/sdk-session-connection-probe.ts SERIAL --session-timing`：只在需要启动时附开关，当前连接保存历史诊断，暖服务记not-started，未请求记not-requested，旧SDK缺项记unsupported，坏字段记invalid而非0。错误诊断不改变采集权限或原失败处理；样例诊断模式invalid失败、unsupported只验兼容，不算内部计时验收。SDK Debug/Release及本地回归通过，未部署手机，不将已有1144ms总段归为SDK内部成本。

独立样例探针切回原页后允许最多3秒只读等待，仅处理短暂无焦点；其他错误/目标窗口变化立即失败，不再次切页或采集。最新单轮恢复已通过，但本轮未记录发生了几次失焦重查，不称实机故障注入通过；此前收尾失败报告不改为通过。

主机现记录首次探测、兼容open-session启动、启动后连接核验三个阶段；首次探测含转发及失败清理，后核验含重新转发和探测。暖服务的后两段为0；均为当前连接的历史建立成本，不与建立总耗时或每次请求等待重复相加。最新独立样例建立1190ms：26/1144/19ms，主要在content调用整段，SDK内部时间尚未知。三次树摘要一致，但切回原页即时核验短暂无焦点，整轮报告失败；后续只读确认已恢复、转发空，不覆盖失败。不需要更新SDK或手机包。

独立样例连接探针：`bun scripts/diagnostics/sdk/sdk-session-connection-probe.ts SERIAL`，仅关闭样例会话服务并测试冷服务/暖重连/同连接读树，核对身份、树摘要、清理和原前台恢复。Android14单次结果1.333秒/69ms/39ms，首次建立1.263秒，暖建立21ms。不是业务App冷启动、整页或像素验收；业务服务保持不变。

桌面会话连接会先尝试已有SDK服务：连接和无UI探测各500ms上限，探测使用旧Session对未知方法的固定拒绝回复，不需要更新SDK。失败先释放本次socket/转发，再走原open-session；实际树/图片请求不重放。当前连接建立耗时是该连接的历史准备成本，不能与每次请求计时相加；调用内等待0不代表建立免费。业务已有服务和独立样例未启动服务的路径均通过验证，不等于业务App冷启动验收。

<a id="merged-tree"></a>

## 合并树失败与绘制期核验

业务部署补充：合并树失败修正已同签名保留数据安装到业务Debug包，手机APK摘要核对通过；设置主页单次11.466秒、98节点/71图/0失败、无内部重试通过。小树仍兼容取图，不是业务合并树故障、严格像素或冷启动验收。

样例验证：单次真实排队3002ms失败、同进程SDK恢复9图及完整入口5.142秒/15节点/9图/0失败通过。入口：`bun scripts/diagnostics/sdk/sdk-merged-tree-failure-probe.ts SERIAL`。故障阶段内部调用SDK方法，不是完整IPC故障注入。

合并树失败契约：`capture-visible` 的 `withTree` 若遇到读树超时、主队列不可用或中断，返回 `tree=failed` 与 `treeFailure=ui-timeout/ui-unavailable/interrupted`，附本次 `nonce/processInstance`，不继续选层或绘图。桌面在读缺失树文件/启动classic前处理该失败，停止重复排队；旧SDK没有合并能力时仍保留classic兼容，旧SDK明确的选层/绘图超时也停止回退。合并树日志新增nonce关联；3秒等待和任务取消/晚到丢弃规则不变。此修正不是业务主线程繁忙的根因修复。

新版 `visibleTreeGuardVersion=1`：`capture-visible` 的 `withTree` 请求使用本次已发布树，在每层同一主线程绘制任务的前后核对根/对象、位置（沿用 1px 容差）和尺寸；已知变化终止整批并返回绑定 nonce/实例/根的 `stale-tree`。桌面停止兼容补采及自动重试，不把失败记成透明。非合并请求、旧 SDK 和裁剪证据规则不变；不是整页同帧保证。`bun scripts/diagnostics/sdk/sdk-visible-tree-guard-probe.ts SERIAL` 仅操作样例，验证静态→动态拒绝→静态恢复及实际采集入口；`bun scripts/diagnostics/sdk/sdk-visible-tree-pixel-probe.ts SERIAL` 验证同进程静态 ABBA 的逐层 RGBA/几何一致，已通过 9 层、4 次对照。业务更新和首采结果见[状态](../PROJECT_STATUS.md)。

本文是接入和探针操作参考，下面的阶段结果不作为待办。当前能力/安装版本看 [项目状态](../PROJECT_STATUS.md)，执行顺序看 [唯一计划](../LOOKIN_ALIGNMENT_PLAN.md#下一步)，汇总结论看 [阶段证据](PHASE_EVIDENCE_2026-10-05.md)。新版业务包已同签名保留数据覆盖，设备摘要一致；设置页能力准入及 12 次严格文字对照通过，仅证明本轮正确性与局部耗时，实验仍默认关闭。涉及安装、重启或故障注入的探针先确认权限。

<a id="legacy-compatibility"></a>

## 旧 SDK、无 SDK 与硬件／软件窗口

旧SDK软件窗口：独立模块 `legacy-window-sample`，复用SDK-free窗口代码，只在Debug引入固定旧AAR与其绕过依赖。构建时必须传 `-PlegacySdkAar=<已核查旧AAR绝对路径>`，缺失则拒绝构建Debug；不依赖当前SDK项目。设置ANDROID_HOME/Java17后运行 `bun scripts/diagnostics/sdk/sdk-legacy-software-probe.ts SERIAL ARTIFACT_DIR`。2026-10-05静态核查旧能力缺失/安装摘要、Release无SDK和绕过库通过；正式IPC确认软件窗口树可读、刷新拒绝、输入/PID不变、随后SDK树恢复。桌面在明确软件证据且缺新版uiWakeVersion时，同时挡住旧SDK整页/指定项硬件画布和旧JDWP唤醒，未知证据保留兼容，不宣称通用软件取图。新样例独立包名com.androiduiinspector.legacywindow，不替换业务或新版SDK样例；结束恢复原前台、清理自有转发。新SDK软件窗口6次像素/几何刷新回归通过。

旧SDK：`bun scripts/diagnostics/sdk/sdk-legacy-artifact-probe.ts` 从固定提交544fd6f隔离构建，不改当前SDK；`bun scripts/diagnostics/sdk/sdk-legacy-device-probe.ts SERIAL ARTIFACT_DIR` 只降级样例并恢复摘要完全一致的新版。2026-10-05正式IPC硬件两档共6次刷新严格像素/几何一致、均JDWP；整页15节点/9图/0失败，3.575/3.703秒，PID保持。旧Provider实报缺新能力并拒绝wake-ui。这是旧硬件窗口证据，不是业务性能；旧软件窗口已通过下述独立测试壳的安全拒绝门禁。ARTIFACT_DIR须为旧产物工装的输出目录，安装前核对提交号/摘要。

完全无SDK样例：独立模块 `sdk-free-sample`，包名 `com.androiduiinspector.sdkfree`，不依赖SDK/绕过库。构建Debug/Release后设置ANDROID_HOME/Java17运行 `bun scripts/diagnostics/sdk/sdk-free-device-probe.ts SERIAL`，核查Manifest/DEX及安装摘要。2026-10-05真机硬件两档共6次刷新严格像素/几何一致、均JDWP，整页10节点/6图/0失败、2.153/2.175秒；软件明确false、刷新安全拒绝、输入和PID不变。恢复原前台并清理自有转发；拒绝不是支持软件取图，也不是业务提速。先前安装拦截/工装失败保留。

安全唤醒故障门禁：`bun scripts/diagnostics/sdk/sdk-ui-wake-device-probe.ts SERIAL`。仅操作SoftwareTextActivity样例，隔离桌面经正式IPC调用；主机代理延迟真实 `wake-ui` 成功回复，验证取消、原3秒超时、迟到丢弃及恢复像素。Debug样例以自身UID临时禁用SDK Provider，再验证明确软件窗口安全拒绝；结束恢复Provider默认状态、正常采集和原业务页。此场景是SDK入口不可用，不是完全不含SDK的APK；不阻塞手机主线程，不作物理拔线或业务性能结论。默认实验关闭。

Debug专用硬件/软件窗口：`.HardwareTextActivity`、`.SoftwareTextActivity`，Release不注册这两个入口。`bun scripts/diagnostics/sdk/sdk-text-admission-probe.ts SERIAL` 验证硬件12次、软件6次严格像素/几何/实际路由，支持 `--hardware-only` 或 `--software-only`。新版SDK声明 `uiWakeVersion: 1`；`wake-ui`校验nonce和进程实例后只向主队列投递空消息，立即返回包内PID/实例/nonce，不等待主线程、不读取View。软件目标仍拒绝实验硬件截图，普通截图选择软件画布。旧SDK/无SDK的明确软件窗口停止旧HWUI唤醒并提示升级，不宣称该兼容路径完整取图；缺硬件证据的旧路径未扩大支持。默认文字实验仍关闭；当前业务APK版本与证据见顶部入口。

<a id="branch-recovery"></a>

## 父分支恢复、模式互斥与时序

新增 `read-branch-geometry`，SDK 树显式声明 `branchGeometryVersion: 1`。桌面在新版混合快照中将其用于有界几何失配恢复：最多 8 个失败目标，单个完整父分支，整次 5 秒；读/补图/复核各一次，全部通过才原子更新坐标和图片，纯结构容器清除旧背景。窗口根或超预算跳过，旧 SDK 保留原补图兼容。

接口参数为根到目标的对象身份链，携带 16 位 nonce；返回绑定包名/PID/进程实例/根/分支的 Base64 JSON，不写共享树文件。仅沿父子路径定位，不导出整树属性；最多 32 级祖先、64 个分支节点、400 万可见像素、48KB JSON，定位检查最多 5000 个直接子对象，主线程预算 250ms、等待上限 3 秒。祖先复制几何、子项数量和有序身份摘要；分支复制完整子项身份。主线程复制，调用线程序列化，不保留活 View，失败不扩大范围或回退整树。

样例验证：`bun scripts/diagnostics/sdk/sdk-branch-geometry-probe.ts SERIAL` 检查几何协议和动态拒绝；`bun scripts/diagnostics/sdk/sdk-branch-recovery-probe.ts SERIAL` 检查真实尺寸变化后的整段补图与颜色/透明像素隔离，后者需要 `python3` 的 Pillow（仅测试依赖）。结果不是正式桌面渐进展示或业务性能验收。

完整采集恢复验证：`bun scripts/diagnostics/sdk/sdk-branch-flow-probe.ts SERIAL` 启动隔离桌面，以 Debug 样例的 `branch-recovery` / `branch-recovery-timeout` 页面验证 256 节点合并采集、3 层原子恢复与 IPC 预览新坐标；超时只在样例控件中阻塞一次 3.5 秒，验证原树保留、不发布迟到结果及同进程下一次采集恢复。正式 SDK 没有故障开关，Release 不包含测试控件。两种场景分别使用新桌面会话，故不覆盖跨 App 进程复用；也不代表物理上屏或业务性能验收。探针恢复原前台并清除本次新增的样例会话转发。

跨进程复采：上述命令追加 `--same-session-restart`，保留同一桌面/能力缓存，重启样例 App 后再采集，验证两轮 PID 不同、SDK 合并树及恢复均有效。只重启 Debug 样例，不清数据。

透明度一致性：追加 `--alpha-visibility`，在移动分支中放入 alpha=0 的子控件，验证恢复 3 层且透明项仍隐藏、无图片。旧 SDK 可追加 `--expect-alpha-rejection`，复现首次复读误报“可见状态变化”。新版分支可见性与 SDK 树一致，计入自身及祖先 alpha；非有限值和超长父链仍拒绝，不放宽身份或几何校验。此模式不能与 `--same-session-restart` 合用。

动态拒绝：追加 `--dynamic-rejection`，分别在读树后增加一个真实 DecorView 子项、在恢复补图任务后再次移动子项。验证首次复读结构拒绝不开始补图，补图后二次移动不提交候选，原树/预览不变；两种场景同进程下一次完整采集均恢复。故障只在 Debug 样例，不能与 alpha/跨进程模式合用。

桌面恢复阶段摘要：`geometry-retry-phase` 为 first-read / first-check / capture / verify-read / final-check / complete；`first-read-ms` / `capture-ms` / `verify-read-ms` / `elapsed-ms` 使用同一 `geometry-retry-` 前缀，仅保存已执行阶段的主机往返耗时，不是手机 UI/GPU 耗时；未执行步骤缺省，不伪造 0。complete 只代表几何事务通过，最终窗口确认与树提交仍需通过；`geometry-retry-mode=atomic-sdk-branch` 才表示已提交。失败也保留摘要，诊断回调异常不能改变接受、拒绝或取消结果；不增加 SDK 请求或改变预算。

外围摘要也使用 `geometry-retry-` 前缀：`recovery-phase` 区分 selection / window-before / geometry / window-after / stage / commit / committed / skipped；`total-ms` 以及 `selection-ms`、`window-before-ms`、`geometry-ms`、`window-after-ms`、`stage-ms`、`commit-ms` 拆分外围事务。`publish-ms` 单独记录提交后的计数、提示和预览回调，不包含在 total-ms 内，也不是物理上屏耗时。多 PID 情况只复用同次确认刚取得的前台目标，仍读取 Activity 所属进程；补图前后两次窗口检查均保留，不跨时刻缓存身份。

截图超时另带 `failureTiming`（桌面 `sdk-visible-failure-timing`）：version=1，observedMs 为投递到超时的时间，enteredMs / snapshotStartedMs / snapshotReturnedMs 均相对该任务投递。事件未发生则缺省，不填 0；任务未执行时只能知道已等待多久，不能声称排队已结束。截图已进入但未返回时，observedMs−snapshotStartedMs 只是截至超时的未返回时长，不是完整调用耗时或纯 GPU 耗时。queueMs / geometryMs / drawMs / verifyMs / snapshotPrepareMs / snapshotInvokeMs 是截至超时已累加的阶段汇总，排队/绘制仍在执行的未完成阶段不补造总耗时，不相加作整页墙钟。异常持有不可变时间线和计数副本，迟到任务不改写；旧 SDK 缺项兼容，格式/顺序非法则省略这项诊断，不改变原错误或图像校验。故障探针同时验证三种超时及后续恢复。

<a id="pipeline-experiments"></a>

## 投递、连续慢化与硬件复用实验

Debug 样例 UI 投递对照：启动 `stress-rectangle`，传 `geometrySerializationProbe=true`、`geometryPipelineProbe=true`、`geometryPipelineCase=ui-batch-comparison`、唯一 `probeToken`；再运行 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN ui-batch-comparison`。默认顺序 1/2/2/1/1/2，`geometryCandidateFirst=true` 反转。两条路径均调用当前 SDK 独立截图和不可变几何；只比较每次投递 1 个或最多 2 个控件。8ms 是第二项准入软门槛，不能抢占正在执行的截图；返回超过原 3 秒任务期限的整批仍拒绝。编码与待处理帧总数不超过 4，编码线程仍为 2。报告记录实际投递次数、两帧任务数量、排队/执行/最长任务及全像素/几何摘要，并验证部分失败、取消、超时迟到清理和后续恢复。不要把此样例后台流水线墙钟当桌面完整采集时间；新路径已做 12 轮一致性验证但无稳定整页提速，未接入正式 SDK。

消息调度对照：同样启动样例，但改传 `geometryPipelineCase=ui-dispatch-comparison`，运行 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN ui-dispatch-comparison`。API 28+，先验证人工 200ms 同步屏障和 120ms 主线程忙碌，再检查异步路径取消/超时迟到清理，最后每轮 407 次单控件投递，普通/异步顺序为 N/A/A/N/N/A，可用 `geometryCandidateFirst=true` 反转。两路径共享截图、不可变几何、2 编码线程/深度 4 与 3 秒期限；逐图和几何必须一致。测试屏障只在 Debug 样例，由预先排好的异步定时任务及 finally 清理；SDK 不安装屏障。官方 [Handler.createAsync](https://developer.android.com/reference/android/os/Handler#createAsync(android.os.Looper)) 不受同步屏障限制，但不能抢占忙碌主线程，且跨 Handler 顺序可能不同。人工屏障收益不代表业务提速；不直接迁移生产。

连续慢化对照：同样启动样例，分别用 `geometryPipelineCase=continuous-clean` / `continuous-fixtures`，再运行 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN CASE`。每个新进程六轮相同的普通单控件投递；clean 不预采图、不做协议突变/取消/超时前置，fixtures 保留预采和四项故障验证。首轮不是预热，所有轮次均保留，失败不重试。无预采组用首轮建立像素基准，主机逐轮检查完整几何摘要和跨进程结构；不将未做的协议突变标为通过。每轮采集前、流水线结束、像素核验后读取 CPU/Java 与 native 堆、GC 计数、系统热状态和电池温度，记录观察开销；流水线时间与核验时间分开。没有定时采样、显式 GC、温控调整或扩大预算；电池温度不代表芯片温度，缺项不填 0。[Debug runtime 统计](https://developer.android.com/reference/android/os/Debug#getRuntimeStat(java.lang.String))是近似进程累计值，GC 总时长不等于主线程停顿，native 堆也不是完整图形内存。这是有观察开销的样例诊断，不是业务完整采集速度验收。

拆分入口：`continuous-preflight` 只预采，`continuous-protocol` 只做协议/属性突变校验，`continuous-faults` 只做四项故障测试；同一启动/验证命令换 CASE 即可，均六轮普通投递。两两组合为 `continuous-preflight-protocol`、`continuous-preflight-faults`、`continuous-protocol-faults`，分别只执行名字中的两项，报告同时检查预采、协议和故障标记。两组都必须 `timedGeometryDigest=true`；无预采时首轮在流水线内建立摘要，之后严格比较，不能省掉摘要工作后宣称变快。早期没有计时摘要的记录仅作工装参考，不能作性能基线。

无 View 对照：`continuous-cpu-control` 不做前置预采/故障测试，六轮截图前后，在同一个后台探针线程串行计算固定 64MiB SHA-256；主机独立验证工作量及摘要。前三轮立即执行，后三轮等待进程年龄至少 40 秒。计算、观察、截图和像素核验分别计时，不并发争抢截图线程；首轮照常保留，没有预热重试。只读取探针线程优先级、schedstat 和各 CPU policy 的 scaling_cur_freq，无法读取则明确标缺项，不写系统设置。频率是读取瞬间的值，不能代表整轮实际运行频率；SHA 路径也不能代表 Java JSON、UI 线程或 GPU 工作。带对照的截图不是无观察开销的性能基线。仅 Debug 包包含 FixedCpuProbe，Release 不含它。

托管工作量及短窗口：同一启动/验证方式改用 `continuous-managed-control` 或 `continuous-managed-profile`，增加固定 400 万次整数混合及 4096 个 JSON 生成，主机按 Java 整数溢出规则独立验证两个结果。profile 仅在第 2/5 轮截图开始后采样，目标窗口 1 秒、间隔 2ms、缓冲 8MiB；在原任务间检查并关闭，finally 也关闭，不新增计时线程，窗口是软上限，不抢占原截图。记录实际窗口、启动/关闭开销，主机拒绝溢出、进程错配、缺少任一真实编码线程或不可解析格式。两组同样使用两个命名为 geometry-encode 的测试编码线程，不改正式线程策略。ART 方法采样属于近似归因，CPU/墙钟差值包含休眠、原生阻塞和调度，不等于运行队列等待，也不能据此认定纯 GPU 时间。采样可能影响本轮及后续运行状态，必须以独立 control 进程作性能对照；[Android Debug 文档](https://developer.android.com/reference/android/os/Debug#startMethodTracingSampling(java.lang.String,%20int,%20int))提供采样入口。Release 不含 MethodWindow，原始采样只用于样例。

软件画布门禁：`software-pixel-gate` 先采一轮原 SDK 图（无预采），随后仅对固定 ordinal 32–95 的简单系统 TextView，使用 SoftwareCanvasProvider + View.createSnapshot(skipChildren=true)。复用保守白名单、单 UI 任务的超时/迟到回收，核对尺寸/几何与全部 RGBA 摘要；遇到首个像素差异立即停止，报告 `accepted=false`，不运行性能对照。`passed=true` 仅说明基线和门禁程序完成，不代表候选通过；主机核对逐目标身份/尺寸、摘要与接受/拒绝标记。当前真机 ordinal 32 的 42×42 目标已有反例，候选未接入正式 SDK；Release 不含试验代码。

同控件分段：`continuous-matched-control` / `continuous-matched-stages` 都执行六轮完整 SDK 采集，第三轮后空等至进程年龄至少 40 秒，不做预采/故障前置。stages 在完整流水线中只累加固定 ordinal 32–95 的 64 个目标：上下文、绘制、复核、编码和 JSON 的墙钟/线程 CPU；核对三个阶段的调用数均为 64。实际主线程和两个编码线程的 stat/schedstat/优先级只读，端点覆盖完整流水线，不是 64 个目标的专属调度区间；最后执行 CPU 也不是 CPU 驻留轨迹。缺项明确标记，观察开销单列。

完成 SDK 计时及像素核验后，另对这 64 个目标代理同一 HardwareCanvasProvider，测画布、命令记录、硬件位图生成和显式 CPU copy，逐目标核对 ordinal/ref/尺寸及全部像素与 SDK 图一致。代理路径保持独立画布和 skipChildren；不合图、不改 View，也不替换 SDK。该额外诊断有几何复核、原任务期限和位图清理，只有一个位图在途，耗时单列为 extraDiagnosticNanos。显式 copy 不等于 SDK 压缩中的隐式回读，不能把额外代理阶段拼成 SDK 耗时。后续轮次会受到额外工作影响，必须另有 control 新进程；不要用此工装宣称业务提速。Release 不含 MatchedStageProbe。

硬件复用门禁：`hardware-reuse-pixel-gate` 与软件门禁同一组目标/基线/白名单，复用单套固定尺寸 HardwareRenderer/ImageReader/RenderNode，但每个 View 的 Picture 独立；透明清屏、无阴影，提交错误立即报错不重试。CPU copy 独立于可复用缓冲，Image/HardwareBuffer 逐项关闭，最终主线程关闭渲染器/读取器；主机要求 rendererCreations=1、captures=已核验数量、resourcesClosed=true。报告 `hardwareReuseGate`，全部 RGBA 一致才 accepted=true，不是性能验收。当前三个新进程的 192 张 42×42 简单文字图通过；不支持可变尺寸或复杂样式，不接生产。Release 不含 ReusableHardwareCapture。

固定目标耗时对照：`hardware-reuse-comparison` 先跑原 SDK 完整基线，随后六个 block，各对固定 64 个控件分别走原 SDK debugSnapshot + CPU copy 和复用 + CPU copy，逐项交错先后顺序；启动参数 `--ez geometryCandidateFirst true` 反转顺序。前三个 block 年龄结束要求 <30 秒，第四个前空等至至少 40 秒；每个 block 只创建一套复用资源，第一项计入初始化，销毁墙钟/CPU 另记且分析时加回。逐目标记录取图/回读墙钟、线程 CPU 与排队时间，并核对不可变几何和全部 RGBA。完成后再次跑原 SDK 完整流水线，主机核对前后图像/结构一致。对照只涵盖取图加回读，不含真实编码流水线；不能把其比例套用到整页总时间。失败保留已完成 block 和当前 block 已采数据，不重试滤掉失败。

复用异常测试：`hardware-reuse-safety` 独立新进程运行，包含异尺寸拒绝、已持有图像时重入/关闭拒绝、回读阶段抛错及恢复、关闭后拒绝、开始前取消、绘制完成但 UI 尚未交付时取消、真实 3 秒 UI 等待超时及迟到结果回收。测试延迟只在 Debug 工装里，正式等待上限不变；关闭排在拥有位图的 UI 任务后，失败路径也清理。异常前后原 SDK 完整采集及恢复像素都核对一致。图像占用测试不是塞满 ImageReader 队列，也不证明能抢占正在执行的 GPU 调用；报告 saturatedBufferQueueTested=false。Release 不含 HardwareReuseSafety。

晚阶段门禁：启动样例时另传 `--ei geometryIdleMillis 40000`，主机验证追加 `--idle40`。启动后只空等，不预采；报告等待和门禁进程年龄，主机核对至少 40 秒；早期门禁年龄要求小于 30 秒。不是通用系统性能阈值，也不是候选性能对照。

时间对照：`continuous-long-clean` 无任何前置验证，连续十二轮；`continuous-clean` 六轮，可在启动时传 `geometryIdleMillis=40000`，验证命令追加 `--idle40`，仅空等 40 秒，不预采图。等待时长单独报告，不计入流水线墙钟，启动到完成的总时间不能省掉这 40 秒。边界新增 `processStartUptimeMs`，使用公开的 [Process.getStartUptimeMillis](https://developer.android.com/reference/android/os/Process#getStartUptimeMillis()) 与 `uptimeMs` 相减，主机检查进程起点不变和时间单调。两组长程都在启动约 30 秒后变慢；两组空等组首轮已慢。因此此前六轮干净组较快不能证明前置验证是根因。当前手机上的约 30 秒现象不是通用 Android 规则，启动加速、降频和 GPU 原因均未证实。正确性测试仍保留，但应与性能进程分开，性能对照还必须匹配启动年龄。

<a id="timeout-diagnostics"></a>

## 短父链、超时与排队诊断

短父链诊断默认关闭。整页请求显式传 `shortParentDiagnostics=true` 且 `geometryFile=true` 时，对原本不支持完整矩形证据的目标，额外复制目标/直接父 View 两行，标 `diagnosticOnly=true`。只观察绘制前状态，不保证父层绘制后不变、不宣称完整裁剪；不含屏幕变换/clipContext，不用于图像放置。原有目标前后核对和完整几何校验不变。读取/序列化可选诊断失败则省略它，不影响原有效像素；后台仅使用已复制数据。桌面拒绝诊断记录携带放置字段或超过两级，旧 SDK 缺字段兼容。

健康探针增加 `--short-parent-diagnostics`，仅在隔离 Electron 实例中开启；正常桌面不启用。开启有开销：当前大树几何文件整理累计约 0.84 秒，不能作为无诊断性能基线。样例故障探针验证默认关闭、短链解码/禁止放置、单个固定自绘控件 PNG 前后一致和超时恢复；整页 436 节点/409 图/0 失败、7.299 秒。新版 AAR 已同签名、保留数据安装业务包；一次固定启动首采及同进程复采取得短父链，部分位置失配随直接父层一起变化，但采集仍慢且出现未就绪，已停止压测。不是业务提速或全量像素验收，详见对齐计划。

单控件超时诊断：新版 SDK 失败响应可带 `failurePhase`（ui-queue/geometry/draw-prepare/draw-snapshot/verify，兼容旧 draw）、`failureTarget`、`failureWaitMs` 和 `failureCompleted`，与 nonce/processInstance/rootRef 一起返回。等待时间覆盖投递至超时，completed 只统计已写记录；诊断不代表有效画面，其他失败暂不提供字段。桌面接受有界且身份匹配的数据，旧 SDK 缺项保持兼容。

细分阶段增加可选的一对 `failurePhaseStartedMs` / `failurePhaseWaitMs`：前者是从任务投递到该阶段进入的时间，后者是阶段进入到超时观测的时间，二者相加与任务等待相差最多 1ms（取整）。阶段和进入时间以同一不可变对象发布，超时冻结后不会被迟到任务更改；毫秒值不是跨进程绝对时钟。接口准备包含画布提供器选择/构造，截图调用包含平台 createSnapshot；其内部绘制/GPU/回读没有独立测量，不作归因。旧响应没有这对字段仍可使用，单边缺失、超界或时序不一致的诊断拒绝。

整页单任务诊断（可选）：`uiQueueBuckets` 以分号分隔五档计数：<1 / 1–15 / 16–49 / 50–199 / ≥200ms；`uiQueueMaxMs` 是最长排队。只统计已进入且未取消的 `captureFrame`，不覆盖全部特殊缓冲路径。`uiSlowTasks` 为 `ref|投递相对时间ms|排队ms|任务执行ms`，分号分隔，最多保留按排队/执行较大值排序的 8 条 ≥50ms 已完成任务；没有慢任务为 `-`。相对时间从本轮 CaptureTiming 创建起算，不是绝对时钟。任务执行含几何/绘制/核对/清理，不等于截图调用时长。

成功回复和取图任务超时回复都可带这组字段；超时返回冻结的部分统计，仍在执行的任务不进入已完成慢任务列表。桌面忽略缺失/无效诊断，不影响原画面校验；请求摘要同步保留，不复制图像。整批几何匹配拒绝时也保留已经文件/身份/窗口/进程校验的排队摘要，但错误快照不发布被拒绝树或像素。故障探针另有人工时间戳夹具，验证五档边界/前八条排序，不作为性能数据。真实 stress-large 样例：436 节点、409 图、0 失败、约 9.1 秒；409 个排队样本，最长 2ms，无 ≥50ms 已完成慢任务。新版已同签名保留数据安装业务包：首次被拒绝尝试最长排队 430ms、任务执行 894ms，25 秒后同进程复采最长排队 28ms；首请求仍超目标，详见当前计划，不是 GPU 定责或提速完成。

样例回归：安装新 Debug 样例后运行 `bun scripts/diagnostics/sdk/sdk-capture-failure-probe.ts SERIAL`，会重启样例并短暂阻塞样例 UI，测试排队/接口准备/截图调用超时、阶段时序及随后恢复；不改业务 App。排队/准备使用私有方法，截图调用用隔离 Provider 实例调用整页函数，不测试授权绕过或传输断线。准备阻塞只在样例 isHardwareAccelerated 的调试截图调用内生效，正常绘制不阻塞。原有报告归档后才替换样例生成的报告文件。Release 的探针入口为空实现，不含故障类和 SDK。

整页和指定控件采集的结束窗口校验也在主线程执行，最多等待 3 秒；窗口变化、Activity 消失或超时均拒绝发布成功文件。样例回归使用禁止后台读取窗口的 Activity 检查正常路径，并验证根变化和 Activity 消失被拒绝。超时后的校验任务只读，不发布文件或修改采集结果。

启动超时复测：`bun scripts/device-health-check.ts --serial=SERIAL --require-device --startup-probe --warm-ms=0`；另一组使用 `--warm-ms=40000`。隔离桌面先就绪，再重启目标 App，不清数据、不导航，25 秒后同进程复测；两轮文件分别保存，后续成功不会覆盖首轮失败。此模式不能和 `--reuse-app` 合用；默认目标为业务 Debug App，其他 App 可显式传 `--app` / `--activity`。结果为 API 送达时间，不是物理上屏时间。

当前页面连续复采：`bun scripts/device-health-check.ts --serial=SERIAL --require-device --reuse-app --repeat-current`，不重启/导航 App，同桌面间隔 25 秒采两次；要求两次都健康且 PID 一致，保存 `repeat-comparison.json`，后一次成功不能覆盖前一次失败。

<a id="immutable-geometry"></a>

## 输出流水线与轻量不可变几何

### 整页轻量不可变几何（已接入 SDK）

输出缓冲样例：启动 `geometryPipelineCase=buffered-output-comparison`，主机运行 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN buffered-output-comparison`；另起进程加 `geometryCandidateFirst=true` 反转六轮原路/候选顺序。前三轮启动早期、后三轮 ≥40 秒，候选仅在输出文件外加 64KiB BufferedOutputStream，原取图、不可变几何、SDK 编码/记录写出、2 编码线程/4 在途不变。两侧全页计时均从打开输出前开始，包含初始化、头部、最终 flush/close；后置校验含每张编码字节 SHA-256、CRC、全部 RGBA/尺寸/顺序和 405 条几何。性能组不打开细分计数，不能与旧探针排除打开/头部的耗时直接拼接。

`buffered-output-diagnostic` 单独拆分记录写出和几何汇集，不混入无计数性能对照。`buffered-output-safety` 仍保留直写文件的 write/flush/close 故障实验。

独立首采：`bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN buffered-output-first-original --first-capture-matrix`。12 个新进程，立即/空等40秒 × 原路/缓冲各三次，交替顺序，无预采或细分计数；计时包含 DigestOutputStream、初始化/头部/flush/close、SDK 窗口检查和临时文件发布。主机每次重新计算最终文件 SHA-256，并核对跨进程编码图像、RGBA、顺序/尺寸和几何；首轮失败保留，不自动重试。

`buffered-output-chain-safety` 在独立进程验证摘要/临时文件发布链：一次真实底层 write/flush/close 错误，以及通过测试专属目录触发真实 rename 失败；每次验证拒绝、描述符关闭、临时/最终/几何文件删除，再完整采集恢复（五轮成功）。每轮重新读取文件核对摘要。不是实际磁盘满、杀进程或拔线测试，也不等于崩溃持久化保证。SampleOutput 只在 Debug 样例使用，不进入 Release；新建的测试 Provider 只补发当前页面的 resumed 通知，窗口检查仍调用 SDK 原实现。

原流水线等待分组：`geometryPipelineCase=continuous-pipeline-waits`，主机 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN continuous-pipeline-waits`；不加计数的控制组为 `continuous-pipeline-waits-control`。均无预采/故障前置，前三轮启动早期、后三轮空等至进程年龄 ≥40 秒，保留首轮。固定 ordinal 32–95 与其余项分组记录 SDK UI 几何/绘制/核对、编码/JSON、样例几何摘要核验、编码入队至执行和有序输出耗时；不改变原截图、线程/预算，不加 CPU copy、额外截图或逐图日志。主采集线程的捕获调用等待、Future.get、写出、文件收尾和未归类时间互斥并严格合计为 `wallNanos`；Future.get 含完成交付开销，尾段为其子集。UI 工作及后台编码/JSON/排队为并行累计，不能叠加当整页耗时；SDK 阶段仍未拆出 GPU/原生压缩内回读。`observerNanos` 为新增计数方法开销，不覆盖所有分支/时钟成本，控制组用于检查明显扰动，不保证零扰动。主机核对分组计数、SDK 计时守恒及整页像素/几何；Release 无 PipelineWaitProbe。

完整编码对照：样例启动时设 `geometryPipelineCase=hardware-pipeline-comparison`，主机运行 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN hardware-pipeline-comparison`。六轮只在候选侧将 ordinal 32–95 的 64 个 42×42 简单系统 TextView 改用硬件资源复用，其他 343 项沿用 SDK；实际 SDK 不可变几何、编码/写文件、2 编码线程/4 在途保持不变。前三轮在启动 30 秒内结束，后三轮开始年龄 ≥40 秒；另起新进程加 `geometryCandidateFirst=true` 反转顺序。全页耗时含资源初始化、主线程 CPU copy、UI 排队和关闭；后置解码校验不计入耗时。每轮核对 407 图/405 几何、顺序、全部 RGBA/文件摘要和资源释放。候选 `draw` 包含显式 CPU copy，`snapshotPrepare/Invoke` 只覆盖未替换的 343 项，不能与原侧阶段数直接相减归因。没有稳定整页收益就停止，不上线固定尺寸池。流水线取消/迟到、复杂样式、多尺寸和业务页需另验收，旧捕获安全测试不代替流水线验收。

正式 SDK 的 `CaptureGeometrySnapshot` 在主线程复制目标和最多 8 级祖先的原始值，绘制后逐字段核对；后台再用系统 JSON API 构建原协议。不持有活 View、不跨帧复用几何，2 编码线程 / 4 在途不变。整页采集启用，小批补图保留原路径。`ImmutableGeometry` 留作 Debug 样例对照，不是生产依赖。

沿用 `GeometryPipelineProbe`：启动 `stress-rectangle`，设置 `geometrySerializationProbe=true`、`geometryPipelineProbe=true`、`geometryPipelineCase=lightweight-comparison` 和唯一 `probeToken`，再运行 `bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN lightweight-comparison`。六轮原/新交叉对照会验证原协议字节、407 张图像素、405 条几何、父层突变拒绝和有界资源清理；存在预采集，不能作为首次捕获基线。

无预热首次捕获对照：`bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN original --first-capture-matrix`。自动重启**样例 App**，每条路径立即首次和空闲 40 秒后首次各 3 轮，交替顺序；加 `--reverse` 可整组反转。等待期间无报告轮询、外部负载采样或 SDK 调用，核对进程启动身份以及跨进程画面/几何结构摘要。只操作样例，不改业务 App。

`wallNanos` 是样例捕获/编码/几何文件流水线，不含启动、空闲、主机拉取和后置图像解码校验；不是桌面上屏时间。`jsonWallNanos` 在轻量路径还包含后台 JSON 对象构建；并行累计不能相加当总耗时。首次模式跳过预采集和突变自测，正确性依据来自独立六轮交叉验证。失败保留为失败，不通过自动业务重启制造快态。

其他验收仍复用此探针：启动参数中的 `geometryPipelineCase` 与主机命令末尾一致。

- `sdk-geometry`：直接调用正式新旧捕获路径，核对 407 张图像素和 405 条几何协议，仅隔离时间戳；新路径主线程 JSON 必须为空。
- `lightweight-safety`：9 项绘制突变/取消/迟到回收；启动再加 `geometrySdkProbe=true`，验证正式路径 5 项绘制突变拒绝和恢复、排队位图所有权。不是整页断线全覆盖。
- `lightweight-comparison` 启动再加 `geometryMemoryProbe=true`：250ms 进程 PSS、Java/native 堆采样峰值。采样与无采样速度基线分开，不代表瞬时精确峰值。

SDK 整页失败收尾会回收未开始编码的排队位图；工作线程已取得的位图由其编码收尾释放，避免压缩过程中提前回收。正式公共接口验证用 `bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --idle-comparison`。新版已重新接入并保留数据更新业务 Debug 包，稳态界面回归通过；启动后超时和复杂裁剪仍待收口，结果见[当前计划](../LOOKIN_ALIGNMENT_PLAN.md)。

业务验证复用 `scripts/device-health-check.ts --serial=SERIAL --require-device --reuse-app`，新增 `previewTiming`（树/首批图送达时间与批次数）及 `geometryCoverage`（可信矩形、上下文回退、无证据的已采图数量）。送达时间不是树可操作或实际上屏；几何回退不是缺图，也不能算裁剪验收通过。与 `sdk-parent-context-probe.ts` 等其他设备采集探针**串行执行**：当前图文件为请求共享路径，同时调用可能覆盖/清理彼此的文件，污染正确性与耗时结论。

<a id="snapshot-experiments"></a>

## 绘制分段、小批图集与内存实验

### 绘制父链证据与矩形渲染

整页响应新增可选`uiQueueMs`、`geometryMs`、`drawMs`、`verifyMs`和`geometryWriteMs`，分别统计主线程排队、绘制前几何读取、独立图绘制、绘制后校验及后台几何记录/文件构建的累计耗时。用纳秒累加后统一换算，避免小控件逐项取整导致统计失真；原`renderMs`仍包含整次等待，不与子项相加。旧SDK缺少这些字段时不伪造为0。父链/矩阵/裁剪的前后校验已改为直接读取字段核对，避免主线程重复JSON构建/序列化；几何记录只序列化一次，前后变化拒绝规则不变。

截图另外提供可选`snapshotPrepareMs`（选择、创建CanvasProvider）和`snapshotInvokeMs`（`createSnapshot`调用，包含接口查找与内部绘制/像素回读），两者属于`drawMs`，不再次累加到总耗时，也不能把后者称为纯GPU绘制时间。407图真机对照证明Provider准备不是主要慢点；缓存方法元数据试验未证明稳定收益，已撤回，不改变原取图接口和画布。

样例进一步细分：`bun scripts/diagnostics/sdk/sdk-snapshot-phases-probe.ts SERIAL`会保留数据重启**样例App**，启动`stress-rectangle`并加`snapshotPhaseProbe`及新token。仅Debug样例用代理包裹原系统HardwareCanvasProvider，原View快照方法、逐次新Provider和排除子项规则不变；预热后按原/测/测/原/原/测执行6轮，逐层核对尺寸与ARGB像素SHA。每层归还主线程，最多500个控件/每图400万像素/150秒；报告只有计时与通过状态，不在主机保存图片。Release为空实现，无HiddenApiBypass依赖。

样例计时`canvasMs`是建立记录画布，`recordMs`是getCanvas返回至createBitmap进入的指令记录区间，`bitmapMs`包含结束记录、生成硬件位图及其等待；**不是纯GPU执行时间**。`cpuCopyMs`另计HARDWARE位图复制为ARGB_8888，位于`invokeMs`之外；像素摘要校验不计入这些子项，但计入`wallMs`。代理与反射也有开销，正式采集仍不使用代理。系统边界依据[Android 14 ViewDebug](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/core/java/android/view/ViewDebug.java)与[Bitmap](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/graphics/java/android/graphics/Bitmap.java)，不能推广到厂商所有版本。

小批原型：同一命令加`--batch`，仍逐层调用原快照方法，只把每层独立Picture延后到最多8层的小图集统一生成位图。图集有2px隔离边，最多400万像素/4096边长；回读后按原尺寸拆图并核对全量ARGB SHA与透明隔离边，记录前后和回读后核对自身/祖先位置、矩阵、alpha、裁剪与padding。不应用祖先画面，也不把图集当作父层合成图。`recordMs`在此模式含代理创建/接口查找/每层记录，`bitmapMs`含打包与生成图集；无限制批量的`invokeMs`为两者之和，保守混合模式另加原路径节点的调用耗时，不与旧模式的纯调用边界混用。批量的`prepareMs`/`canvasMs`未分拆不表示成本消失；混合模式`prepareMs`只计原路径节点。`hardwareBitmaps`记录实际生成次数，不是图片数量。

故障验证加`--mutation=record-alpha`、`--mutation=after-clip`或`--mutation=after-position`，必须带`--batch`；要求明确拒绝并恢复样例改动。加`--transformed`覆盖圆角背景、父缩放/alpha/clipBounds；目前该组合测试会非零退出，4个边缘像素与原路径不同，最大差1。失败诊断会额外抓一次原路径，确认基准未变化；仅用于样例诊断，不是生产自动重试。普通407层页虽有约45%的样例墙钟收益，但**不作为正式采集或复杂控件验收**，该原型未接入SDK。

保守分流：`bun scripts/diagnostics/sdk/sdk-snapshot-phases-probe.ts SERIAL --batch --conservative --transformed`。只允许无背景/前景、图标、特殊文本与画笔效果的精确TextView，祖先也须是已知系统容器且无变换/alpha/裁剪；其余绘制前走原路径，不在失败后重绘。两组各六轮407层像素一致，400层批量+7层原路径，硬件位图57次；样例墙钟均值减少约46%/34%，并非正式采集速度。三种故障选项可组合`--conservative`验证拒绝与恢复。

保留反例：`--batch --transformed --expect-pixel-difference`仅在确认预期像素失败、原基准未变及诊断齐全时成功退出。相同Picture原尺寸原点0差异、扩大目标4像素差异、再平移8像素差异、加裁剪仍8个；最大通道差1，具体GPU原因未证实。普通`--batch --transformed`仍失败，不放宽容差。编码/几何流水线样例见下方，白名单尚不能当作生产通用保证。

流水线对照：`bun scripts/diagnostics/sdk/sdk-snapshot-phases-probe.ts SERIAL --batch --conservative --transformed --pipeline`。Debug样例反射复用SDK现有编码/顺序写入与几何采集方法，不新增SDK接口；2编码线程、队列深度4、几何4MB/图片流64MB。批次按当前剩余容量缩小，实际硬件位图202–207次。两条路径同样增加一份位图所有权拷贝及编码后解码验收，成本计入墙钟；后台只处理已采集数据。六轮核对原始ARGB、编码后ARGB、图片流SHA及顺序，最后一轮主机解析CRC/nonce/进程/根/407条几何及文件摘要，并验证错误nonce/进程/根和错位记录会被拒绝。文件只保存在样例私有目录，每轮覆盖，不保存业务截图到主机。

首组/复测墙钟中位数约减少29%/28%，均值33%/35%，包含验收但不含传输/上屏，不能等同正式采集。原路径也有1层编码后ARGB变化；以原路径编码后的严格基准做第二重对照，编码前逐像素检查仍保留。加`--cancel`在批量轮中主动取消；几何故障选项也可和`--pipeline`组合，必须拒绝、归还位图/停止线程并删除失败输出。正式SDK和桌面默认路径保持原样。

队列/拷贝试验：上面命令再加`--optimized`，只在批量对照轮等深度4队列腾空后组4层批，并直接转交已核对的独立软件位图给原编码器；原路径对照轮保留额外拷贝。不扩大线程或队列，不把图集整体交给编码器，每层仍单独编码/验收。`batchSizes`下标为实际批次大小；`ownershipCopies`/`ownershipCopyMs`只计额外所有权拷贝，硬件回读和图集裁图仍存在。样例400个文字固定100个四层批+7个原路径节点，硬件位图107次，额外所有权拷贝0次。

所有`--pipeline`试验增加250ms固定延迟的后台内存采样（实际间隔还包含采样耗时），记录每轮基线/采样峰值PSS、Java使用堆及native分配堆；不是精确瞬时峰值，也不能代表完整GPU内存。`peakOwnedBytes`是编码任务持有位图的账面字节峰值，含编码器已经回收但任务尚未结束的保守计数，不等同进程驻留内存。采样与验收成本也计入墙钟；不主动GC，不以强制回收制造低峰值。初测进程PSS有升高反例，默认不启用该试验，不能只凭生成次数减少宣称耗时或内存更优。

优化两组各六轮407图全部一致，取消与三类几何突变拒绝/资源清理通过。复测优化墙钟5.210/4.727/5.674s、PSS最高205002KB，原路径也出现更高峰值；没有与旧混合稳定的额外耗时/内存收益结论。后续整图数组单独对照见下方，不能把验收器分配误当作正式SDK必需成本。

摘要单独对照：`bun scripts/diagnostics/sdk/sdk-snapshot-phases-probe.ts SERIAL --batch --conservative --transformed --pipeline --hash-comparison`。虽然复用批量探针入口，该模式所有轮都是原截图、原编码/拷贝，只有原/测交错轮切换整图/分块摘要；不允许和`--optimized`、`--chunked-hash`或记录故障组合。每轮407图的原始+解码摘要共814次，要求与整图预热基准一致，输出文件/CRC/身份/几何验收照常。

分块保留逐行大端ARGB字节流，不采样像素、不改容差；最多16384像素的int数组和字节数组（载荷≤128KiB）。统计`pixelHash.calls/maxScratchBytes/allocatedScratchBytes/hashMs`，`hashMs`是UI与编码线程的累计时间、可能重叠，不是串行墙钟；数组字节统计不含对象头、位图和其他开销。自测覆盖奇数宽度、透明/随机alpha、尾块与末像素改动。仅失败诊断仍可分配整图数组，不参与通过轮性能结论。

两组纯摘要对照407图全部一致，单次最大19837440→130384字节，每轮累计99195872→13094288字节；PSS采样高峰也降低，但分块仍出现约13秒慢尾，不能当生产提速或完整内存保证。集成测试用`--pipeline --optimized --chunked-hash`（仍需`--batch --conservative`），整图预热后所有正式轮都用分块摘要；取消/故障选项可组合。生产SDK不包含这些摘要验收器，后续性能比较须先统一探针开销。

分块组合两组各六轮407图与几何完全一致；复测混合4.323/3.861/4.955s，PSS最高157877KB，仍107次硬件位图/0额外拷贝。取消/三类几何突变仍拒绝并清理。完整业务采集及其他系统版本未据此验收。

策略拆分：在`--batch --conservative --pipeline --chunked-hash`后加`--strategy-comparison=fill`或`--strategy-comparison=transfer`，可再加`--transformed`。不能和`--optimized`/`--hash-comparison`混用。预热原路径；正式六轮都走保守批量，A/B/B/A/A/B只切换组满批或直接转交位图，控制轮不再是原逐层截图。每轮报告`fillBatch`/`transferBitmap`，分别断言107次硬件位图或0次额外拷贝；像素/文件/身份/几何验收不变。取消/三类突变限定发生在B轮，报告`failedRound=1`，避免误测A轮。

`waiting`记录队列满、等待组满批、轮尾排空的墙钟累计、等待段数/最长时间，以及UI调度累计/最大迟到时间（扣除主动1ms轮询延迟）。当前`drainMs`在队列排空时停止，**不含同步文件收尾**；此前该字段包含此开销，旧数字不可直接比较。排空包含后台编码、解码验收和几何，不是纯编码；UI调度会和队列等待重叠，后台计时也可并行，不能把这些数字相加当总耗时。

四组24轮407图全部一致。组满批额外等待约0.43–0.58s，硬件位图约200→107，但没有稳定内存收益；仅取消28–42ms拷贝没有稳定提速。慢轮截图调用与CPU回读明显增长，单次UI排队仍只有几毫秒，尚未证明GPU或GC原因。该对照只测样例编码/验收/写文件，不含传输/上屏，生产路径不改。

两种策略的取消、绘制中alpha与绘制后裁剪/位置变化共8次均在B轮拒绝，状态恢复、位图/线程归还与失败文件删除通过。149项测试、桌面及Android Debug/Release构建通过；Release不含探针/SDK，ADB无残留转发。

单次/轮尾诊断沿用这些命令，无新增生产开关。`operations`区分原截图/原回读/每层记录/图集生成/图集回读，记录次数、累计、最大项身份/尺寸/批大小。`pipeline.stages`区分任务排队、编码调用、解码、摘要验收与回收、几何构建；每项`tailMs`是最后一层提交后相交的累计阶段时间，不是独立墙钟，两线程会重叠。另报写入/轮尾写入、文件收尾、输出摘要、轮尾待写条数和总墙钟；不保存无界事件。计时自测验证边界，主机核对阶段次数和原总计对应，不把反射调用计时称为纯GPU或纯压缩成本。

定位发现探针重解析已序列化的约824KB几何，收尾耗时0.41–1.04s；正式SDK已直接拼接，无此重复操作。探针改为相同写法，预热407条真实几何和旧方式逐字节一致（`envelopeSelfTestPassed`）；正式轮`envelopeVerified=false`，避免把重复验收算进性能。修正后18轮407图、输出文件与几何全部通过，收尾6–19ms、轮尾总计29–62ms，最终队列排空11–24ms。仅消除测试工具开销，不能宣称正式SDK提速；整轮截图慢尾与组满批稳定性仍未解决。

收尾修正版两种策略共8次取消/几何突变均拒绝并完成资源/失败输出清理，计时边界和预热完整文件字节对照通过。149项测试、桌面与Android Debug/Release构建通过，Release无SDK/探针；只更新样例，不升级业务包或重启桌面。

批大小/让步比较：在`--batch --conservative --transformed --pipeline --chunked-hash`后加`--cadence-comparison=batch2`或`--cadence-comparison=yield1`，不能与`--optimized`/`--strategy-comparison`/`--hash-comparison`混用。预热原路径，正式六轮均保守批量且直接转交位图，A/B/B/A/A/B只切换一个变量：A四层/零延迟；B两层或工作片段后延迟1ms。两边每批都等深度4队列腾空，不扩大队列，不把该两层策略称为自适应填充。取消/突变只在B轮发生。

`cadence`统计批上限、单次主动延迟、工作让步次数/累计计划延迟、全部/原路径/批量处理片段；队列轮询不算工作让步，下一轮启动不加主动延迟。片段从绘制前到验证/提交完成，包含UI摘要等探针开销，**不是帧率或纯绘制时间**。`operations.rawPixelHash`单列UI摘要耗时；主机核对每轮407次摘要、分组与总计一致。片段最大项只有一条身份/尺寸记录，不增加无界日志。

两种模式各两组共24轮407图/文件/几何全部通过。两层批生成200个图集+7个原图，硬件位图207次、工作让步206次，均值慢44%/47%；四层保持107次位图、106次工作让步。1ms模式计划额外延迟106ms，均值慢6%/8%，没有稳定卡顿/内存改善。最长原路径片段含24–31ms的UI原始像素校验，不能外推业务帧率。这两个模式只保留为样例对照，不改正式SDK。

两种模式共8次取消/几何突变在B轮拒绝并恢复、清理。旧流水线六轮407图/编码/几何通过；旧无流水线8层批另六轮407图像素通过，不把该入口记为编码/几何验收。149项测试、桌面与Android Debug/Release构建通过，Release无SDK/探针；只更新样例，不升级业务包或重启桌面。

<a id="timing-experiments"></a>

## 生命周期、空闲与性能取证

性能对照：启动样例`--es mode stress-rectangle`，再运行`bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported`。该模式只在样例中使用无ActionBar主题并关闭根outline，建立400多个可验证矩形层；探针要求实际生成至少400条几何记录，预热后按ABBA顺序取三轮对照，避免把“不支持上下文而空采样”误记为性能通过。

该脚本现拆开设备调用、图片拉取/摘要/解析、静态图检查和几何拉取/验收/清理；`wallMs`包含探针检查，不是桌面上屏时间。正式SDK可选返回`uiTaskMaxMs`和`snapshotInvokeMaxMs`，旧SDK缺省不补零。样例正式路径六轮407图通过，最长UI任务20–35ms，但整轮仍3.24–11.94s波动；图片拉取约0.11s、解析1–2ms。正式整页取图不在UI线程做探针的CPU像素复制/SHA，不能沿用探针回读成本归因；后台压缩内部回读尚未独立测量。仅加计时，不改并发和取图策略。

正式路径进程对照：追加`--lifecycle-comparison`，仅配合`--supported`，不能同时开外部负载/调度采样或固定记录复制。自动启动`stress-rectangle`样例，连续组同一进程6次，重启组每次重新启动样例，共12次；追加`--restart-first`反转两组顺序。两组均没有预热或几何预校验，全部请求真实`capture-visible`及几何文件，不改SDK。**会重启测试样例，不操作业务App。**

```sh
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --lifecycle-comparison
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --lifecycle-comparison --restart-first
```

要求407目标/图片、0缺图、405条几何；连续组进程/根身份稳定，重启组进程不同，跨进程图序、类名、位置/尺寸及编码图摘要一致。启动时间`startupMs`单列；`durationMs`为SDK处理，`providerCallMs`含主机命令/通信，`wallMs`再包含拉取/验收，均不是桌面首次上屏。正常结束还核对12目标补图。分组顺序反转仍不是随机实验，也不能仅凭重启组较快就认定GC、内存或功耗根因。

两组共24次实际验证：连续组第六次分别11.508/11.453s，反向组第五次7.716s；重启组12次5.198–6.242s。图及几何输出一致，慢轮多个阶段一起升高。尚未区分累计采集量与进程存活时间，不能把重启当生产修复；下一步先测进程空闲后首次采集。

空闲时间对照：用`--idle-comparison`替代`--lifecycle-comparison`；4轮分别为立即/空闲40秒/空闲40秒/立即，追加`--idle-first`反转。每轮都重启样例，等待阶段不调用SDK、不做负载采样、不强制GC或调整功耗。保持手机解锁、样例可见。进程PID及启动ticks在等待前后核对，最终版在采集后也核对；进程变化或空闲计时超过60秒不算通过。`idleMs`、`sinceLaunchCompleteMs`及启动时间单列，40秒不计入采集墙钟；后者是距启动命令完成的主机时间，不是精确设备进程年龄。其余身份/图像/几何/预算验收保持一致。

```sh
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --idle-comparison
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --idle-comparison --idle-first
```

正反8轮均首次采集：立即5.278–5.445s，等待40秒后11.485–12.395s，跨进程输出一致。这说明多次采集不是慢态的必要条件，不证明资源累积完全不存在，也不能直接认定启动加速/功耗/GC为根因。正式策略不改，不能用重启业务App维持测试中的快态。

最终严格版补4轮：立即5.197/5.329s，空闲后12.178/12.410s，采集后进程身份及空闲时长检查通过；跨全部12个进程输出一致。

线程调度取证：空闲对照可追加 `--thread-scheduler`，跟踪样例主线程与两个真实 `inspector-encode` 工作线程（内核名称可能截为 `inspector-encod`），按 CPU 拓扑映射到对应频率策略。读取线程最后执行核心、累计运行/排队时间和策略频率；权限缺项记为未知，不补零。等待40秒期间不采样，采集前后的进程身份仍核对。

```sh
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --idle-comparison --thread-scheduler
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --idle-comparison --idle-first --thread-scheduler
# 关闭采样的对照：去掉 --thread-scheduler，其他参数不变。
```

每次读取完成后暂停1秒，最多60次；扫描最多128个线程，只保留主线程及两个编码线程。基线 `schedulerBaselineMs`、收尾 `schedulerStopMs` 单列，基线会推迟首次调用。**最后执行核心不是整段驻留轨迹**，频率在另一次命令中点读，不与线程状态同时，也不是平均频率；采样本身会增加设备工作量。累计调度差值覆盖的是采样区间，不是精确的 SDK 请求边界。

函数热点诊断：在空闲对照中追加 `--method-profile`，使用系统 `am profile` 的2ms采样及双时钟，不能与线程调度采样同时开启。只操作每轮新启动的样例进程；正式SDK不用开启分析器。

```sh
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --idle-comparison --method-profile
```

解析器只接受 [ART非流式v3双时钟格式](https://android.googlesource.com/platform/art/+/refs/heads/android14-release/runtime/trace.cc)，最多32MiB，核对PID、字典、记录数和时钟；溢出、截断、栈不匹配、缺编码线程或16位线程ID歧义均拒绝。仅汇总主线程及两个真实编码线程，按上次观测的栈近似归属线程CPU增量；不是精确函数计时，嵌套 `sdkInclusive/jsonInclusive` 不能相加。原生调用只有Java边界名称，不提供原生内部/GPU热点。启动、停止、拉取、解析和清理单列，临时trace按请求删除；失败也收尾。系统采样会暂停线程并干扰运行：本机慢态约12秒被放大到28秒，只用于选优化方向，不能用于性能验收。提速必须去掉该参数复测。

后续SDK将父链/裁剪记录合并读取、复用目标矩阵，并合并绘制后校验、直接比较矩阵值，避免重复遍历和临时JSON；保留9层上限及前后状态核对，不跨UI任务缓存。旧版六轮、新版两组各六轮407图和12目标补图通过，样例记录逐字一致；绘制后校验有所减少，整页仍有约11秒慢轮，不宣称总体提速。`transform-rectangle`样例报告新增`mergedGeometryVerified`，验证新旧记录及alpha/平移/padding/clipBounds突变拒绝；动态探针额外核对根窗口身份，目标缺失或窗口变化不算验收成功。

慢轮诊断：同一命令追加`--device-load`。仅样例，按PID/启动时间绑定，记录采集前后内存、累计CPU ticks、线程数、负载、HAL实时温度和有界GC日志；不可用指标明确标记，不补零。内存使用`dumpsys meminfo --local -s`，避免普通查询调用App转储引发主动GC；不清日志、不强制回收、不改功耗。采样耗时独立于`wallMs`，约0.5s/次，改变轮间节奏；边界内存/温度不是峰值，GC日志总工作时长不是暂停，未记录日志不代表无GC。首次普通查询组有Explicit GC干扰，不用于自然GC归因。修正组六轮407图和12目标补图通过，10.60/11.63s慢尾仍在，未看到持续内存上涨或热状态升级，根因尚未确定。

采集中频率/调度：追加`--scheduler`，可与`--device-load`同时用。一次基线后每次采样结束等1s，最多60条；设备调用异步，读取同PID/启动身份、主线程运行/排队计数、CPU簇当前频率及功耗状态。不改设置、不绕过最高频率上限权限，未知字段不补零；请求失败和正常结束均停止定时器并等待在飞读取，停止耗时单列。单条约0.3s，点读非平均频率、运行队列等待非全部阻塞，且采样自身会扰动负载。带采样与关闭采样两组六轮407图/补图通过，9.7–11.3s慢尾仍在；存在慢轮大簇多次2.5GHz的反例，不认定纯降频或GPU根因。后续优先用SDK内部CPU计时降低外部采样干扰。

SDK内部CPU诊断：受支持大树命令追加`--cpu-timing`，要求当前SDK返回`geometryCpuMs`、`drawCpuMs`、`verifyCpuMs`、`encodeCpuMs`、`geometryWriteCpuMs`；默认兼容旧SDK缺项。使用`Debug.threadCpuTimeNanos()`同线程前后差值，纳秒累计后转毫秒；不支持时不返回CPU字段。主线程记录读取/绘制/校验，编码累计两个工作线程，文件构建包含后台记录序列化与最终写文件。它不是全进程/GPU时间，也不是精确的“纯计算”计时；墙钟差值不能直接认定GPU等待。建议先不加`--scheduler`或`--device-load`，减少外部测量扰动。两组12轮407图/几何/补图通过，仍有9.945/11.586s慢尾；几何路径CPU占比较高，下一步拆分序列化与写文件，尚未实施提速。

几何构建分项：追加`--geometry-timing`严格要求JSON、UTF-8和文件写入的墙钟/CPU字段；默认兼容旧SDK缺项。JSON/UTF-8是工作线程累计值，最终UTF-8也计入；文件写入只计打开/写入/关闭，不含fsync。总构建计时还包含拼接/摘要等，不能与分项或绘制简单相加。实测主要成本在JSON，低分配候选未证明整页稳定提速，正式路径保持原序列化。

固定记录实验仅用于Debug样例，不涉及业务App。准备受支持大树后执行以下命令；固定输入由已验证的几何文件复制，不代表当前窗口或未解析原始对象。反向顺序可加`--ez geometryCandidateFirst true`，每次使用新token。报告核对token、逐字输出、数值边界和8轮计时；序列化以外的解析/校验不计入轮次。预热、类型变化和线程环境会影响结果，不用它宣称整页提速。

```sh
bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL --supported --cpu-timing --geometry-timing --serialization-fixture
adb -s SERIAL shell am start -S -W -n com.androiduiinspector.sample/.MainActivity --es mode stress-rectangle --ez geometrySerializationProbe true --es probeToken geometry-json-test
bun scripts/diagnostics/sdk/sdk-geometry-serialization-probe.ts SERIAL geometry-json-test
```

整页几何序列化已并入现有2线程、深度4的图片编码流水线，与下一层绘制重叠；工作线程只读取已核对的记录，不读取实时View，不改变图片流格式。按原顺序写图并收集对应几何，4MB文件预算保持不变。`geometryWriteMs`现在是各工作任务的累计耗时加最终写文件耗时，可能与绘制/编码重叠，不能和`renderMs`直接相加。受支持大树探针另逐层比较六轮图片摘要，防止并行处理造成串层或画面变化。

原始对象对照（无需固定文件）：增加`geometryOriginalObjects=true`，样例按实际绘制标志选取407目标，调用既有SDK逐层捕获和前后变化检查，保留405个几何对象并立即回收位图。原始/JSON读回两种输入各8轮，后台2线程/在途深度4；CPU是工作线程累计值，墙钟包含任务调度，不可相加。捕获、解析、预热和逐字校验不计入轮次；对照阶段不再同时绘制/编码，所以并非完整流水线性能。可反转来源及候选顺序，报告另含数值/字符串微测、数值类型、进程近似分配/GC增量；未知统计省略，不强制GC。这些近似计数不是独占分配、RSS或暂停，微测也不能相加替代真实序列化。两组反向与最终回归均通过，候选仍未进入正式SDK。

```sh
adb -s SERIAL shell am start -S -W -n com.androiduiinspector.sample/.MainActivity --es mode stress-rectangle --ez geometrySerializationProbe true --ez geometryOriginalObjects true --es probeToken geometry-original-test
bun scripts/diagnostics/sdk/sdk-geometry-serialization-probe.ts SERIAL geometry-original-test --original
```

完整流水线负载对照（仅Debug样例）：复用SDK逐层绘制、WebP编码、图片流和几何文件写入。两线程池，重叠组在途深度4，逐层等待组实际深度1；再在重叠组比较原序列化与候选。每次8轮ABBA，反向顺序追加`--ez geometryCandidateFirst true`并换token。

```sh
adb -s SERIAL shell am start -S -W -n com.androiduiinspector.sample/.MainActivity --es mode stress-rectangle --ez geometrySerializationProbe true --ez geometryPipelineProbe true --es probeToken geometry-load-test
bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL geometry-load-test
```

轮次墙钟包含绘制、编码、序列化、写图及最终几何文件/摘要，不含选目标、基准预校验和结束后的解码/逐像素核对。编码和JSON墙钟/CPU用报告顶层`encode*`、`json*`字段，均为工作线程累计值；`sdkPhases`仅返回捕获计时，不再输出未采样的编码/文件零值。全轮核对407张图/405条几何、位图释放、图片预算和身份/摘要。主机首等15秒后每5秒查询报告，仍有外部测量扰动。

旧版两组16轮额外保留整轮原始对象/编码图，后半组原算法8.448–11.004s、候选10.582–10.973s，没有稳定收益。当前版按写出时机释放这些数据，仅保留验证元数据/摘要和正式路径所需的几何拼接缓冲；活跃位图集合随编码结束移除。计时后从图片流逐张解码，核对CRC、位置/尺寸、结束标记及像素。计时前逐层捕获基准，仅保存几何SHA；每次实际捕获仍读取并核对实时状态，不使用缓存几何出图。摘要对比仅统一`started/ended`，本次实际时间戳值及顺序另行检查，实际输出不改。UTF-8/规范化/摘要验证仍在总墙钟内，累计额外成本单列`geometryCheckWallNanos`，不能直接从并行总耗时扣掉。

单组分别启动：追加`--es geometryPipelineCase original`（或`candidate`/`serial`），主机命令末尾传相同名称。交叉使用`candidate → original → original → candidate`和`serial → original → original → serial`，每轮新进程、新token；主机再比较各轮`pixelSha256`和不同`processInstance`。这是进程重启后经过相同预校验的样例，不是设备完全冷启动或用户端到端耗时。最终8轮像素完全一致；原算法4.307–4.510s、候选4.064–4.110s、逐层等待10.283–10.440s。候选仅两轮约5–6%差异，不证明生产稳定收益；释放数据和重启同时变化，不能单独归因内存或GC。正式策略不变。

<a id="geometry-contracts"></a>

## 父链、变换与矩形放置协议

`capture-refs` 可选 `geometryEvidence=true`，仅允许最多8个目标；普通 View 在同一主线程绘制任务记录自身及最多8级祖先的身份/父身份、屏幕位置、尺寸、滚动、alpha、可见性、矩阵与裁剪标志。绘制前后这些字段变化就拒绝出图；不改业务控件，不保证全页或 Surface/Texture 缓冲同帧。返回的有界 Base64 JSON 绑定既有请求 nonce、进程和根身份；桌面再校验父链及图片几何。旧 SDK 忽略扩展时不伪造证据，截断父链明确标注未到根。本阶段只诊断，不用新坐标自动更新旧树，也未读取任意自绘 clip 路径。

`capture-geometry` 样例及 `scripts/diagnostics/sdk/sdk-geometry-probe.ts` 另外覆盖持续移动的父层、绘制中只改变父 alpha 的控件；后者应被小批证据路径拒绝。旧 SDK 没有这些信息时保持兼容，不视为已验证。

Android 10及以上的小批证据新增 `bitmapSpace="view-local"` 与9项 `localToScreen` 矩阵，绘制前后完整矩阵变化也拒绝。矩阵来自公开的 [View.transformMatrixToGlobal](https://developer.android.com/reference/android/view/View#transformMatrixToGlobal(android.graphics.Matrix))，包含祖先变换和滚动，不从截断父链自行拼接。低版本不伪造矩阵。桌面检查矩阵、局部原点与整数屏幕坐标（允许整数舍入差，不放宽旧树匹配），共用 `shared/capture-transform.ts` 计算四角；退化或跨透视地平线拒绝。本阶段用于几何取证，尚未接入渲染/命中；完整矩阵不等于完整裁剪或透明度证据。

真机动态缩放样例确认独立图仍为局部像素，三轮同时验证局部像素、缩放后四角及父平移。此结论限于已测普通View，不扩大到Surface/Texture、自定义裁剪或所有硬件快照类型。

补图证据另有可选 `clipContext`，与父链逐项对应：`ref`、可空矩形`clipBounds`、左/上/右/下`padding`及Android 10+的完整矩阵；绘制前后变化拒绝，旧协议不要求该扩展。该信息仍不包含任意自绘裁剪路径或outline形状，不能据此认定所有裁剪已知。

已接入受限矩形渲染：普通自身图、完整父链、每级已知矩形上下文及正向轴对齐缩放/平移可生成`layerCapturePlacement`；任一级outline、未知自绘父类、旋转/镜像/透视或截断父链明确走旧路径。裁剪后的源像素、屏幕矩形与有效alpha一起传到WebGL；画面/边框/高光/命中共用矩形，完全裁掉或alpha为0不命中。测量bounds不改，折叠合成不用此单层数据，新图片替换会清除旧放置数据。

整页与超过8个目标的补图可选`geometryFile=true`：SDK写入nonce专属几何JSON，响应带字节数和SHA-256；桌面核对请求、进程、根、控件身份及每张图片的位置/尺寸。文件最多4MB，整页只为渲染器支持的矩形上下文记录证据；预算不足的层继续旧路径，不阻断图片采集。原图片流与分段预览不改，最终校验完成后再应用几何。接入SDK的分支/列表刷新使用SDK补图，未接入仍使用旧调试通道。旧SDK忽略新标志时继续兼容。真机大树与12目标批次可用`bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL`复测；受控矩形页追加`--rectangle`。

透明度/祖先裁剪和矩形放置真机回归：先启动样例 `--es mode transform-rectangle --es probeToken <本轮唯一标识>`，再运行 `bun scripts/diagnostics/sdk/sdk-transform-probe.ts SERIAL <同一标识>`。比较硬件父层自身图、软件叶子自身图与手机截屏，并取父层同任务补图核对完整父链、0.8缩放与0.5有效alpha。样例显式使用无ActionBar主题并关闭样例根outline，建立已知矩形上下文；不修改业务App裁剪。默认系统窗口可能有outline或未知容器，仍按预期回退，不据此放开业务校验。探针按本轮标识拒绝旧报告，只读样例报告与截屏；`sdk-geometry-probe.ts`另验证绘制中父clipBounds变化会被拒绝。

<a id="stream-and-build"></a>

## 图片流、会话协议与旧接入记录

这里包含 Debug SDK 和画面验证样例。SDK 提供真实 View 树、属性和独立图；接入 SDK 且至少 200 节点的页面默认尝试 `capture-visible`，DDMS/JDWP 保留兼容采集、局部刷新及缺图/特殊缓冲补采。样例通过 `debugImplementation` 引入 SDK；Release 使用无操作的 `ProbeRunner`，不包含 SDK。当前能力与下一步见 [Lookin 对齐计划](../LOOKIN_ALIGNMENT_PLAN.md)。

新版 SDK 的 `capture-visible` 可携带 16 位十六进制请求标识，写入私有临时文件头并回显。`visibleStreamVersion=1` 使用 PNG，`visibleStreamVersion=2`（Android 11/API 30+）使用无损 WebP；桌面仅对匹配本轮标识、当前进程/窗口、对象、尺寸及图片校验的完整记录提前预览，最多三批，最终仍核对完整文件 SHA-256。旧 SDK 不轮询，照原路径等整包；取消后不交付迟到批次。Android 11 以下继续 PNG 兼容路径。整页可见图采集在设备侧采用有界流水线（渲染与编码重叠、2 路编码池顺序写文件）；业务页 207 张 WebP 单次约 2.8–3.3 秒（改造前 5.2–5.9 秒），流式预览与摘要校验不变。特殊层补齐改用批接口 `capture-refs`：一次最多 80 个指定控件，普通控件取自身图、TextureView 读自身缓冲、SurfaceView 用 `PixelCopy` 取当前帧（受保护内容返回失败，不绕过 DRM），纯布局/空白/失败分别标注；桌面校验（进程实例、根、对象、尺寸、SHA-256 与逐图 CRC）不符时回退 JDWP。业务页补齐阶段约 5.1 → 2.3 秒，Surface/Texture 首次拿到真实缓冲帧。桌面侧 happy path 不再全量导出 DDMS/JDWP 层级：先以 VULW + 身份探针匹配窗口，再用 SDK 树重建结构（ref/类名/尺寸/祖先链/窗口锚点/进程逐项交叉校验，任一不符回退原 DDMS 导出），JDWP 仅作兼容回退。`capture-visible` 可携带 `withTree` 布尔扩展：调用开始先原子写入本次 nonce 的 SDK 树文件（≤4MB），桌面在调用中途 adopt 并据此匹配分片预览；旧 SDK 忽略扩展时回退经典两段式读取。Provider 另提供 `open-session`/`close-session`：桌面经 `adb forward tcp:0 localabstract:<包名>.inspector.session` 连接应用内 `LocalServerSocket` 会话通道调用同一批 handler（行式 JSON、回复与 `content` CLI 同格式），免去每次 `content` CLI 的进程启动（约 1.2 秒/次）；对端校验 shell/root UID，超时或取消即关闭会话并回退 content 调用，旧 SDK 无该方法时自动走原通道。

构建环境：JDK 17+、Gradle 9.6+、Android Platform 36 与 Build Tools 36。SDK 可集成到最低 Android 5 的 Debug App，但自身图仅对 Android 8+ 开放；目前只在 Android 14 真机验过。取得许可并安装官方 SDK 后，可在本目录执行：

```sh
gradle :sample-app:assembleDebug :sample-app:assembleRelease
```

业务工程通过本地 AAR 接入时，必须先运行 `gradle :inspector-sdk:assembleDebug`，再让业务构建引用 `inspector-sdk/build/outputs/aar/inspector-sdk-debug.aar`。只构建样例会更新其项目依赖，不一定重新生成 AAR；不能把业务构建“成功/全部跳过”当成 SDK 已更新。覆盖安装前核对 Debug 标记、签名和 APK 内的 SDK 代码；安装后核对手机 APK 摘要，保留应用数据，不因签名冲突自动卸载。

<a id="business-update-history"></a>

## 业务包更新流程及历史观察

<a id="business-sdk-update"></a>

### 业务 SDK 保留数据更新

当前授权更新已完成：业务构建/签名与实际SDK代码校验、一次保留数据安装及设备完整SHA通过，记录在本机`.benchmarks/queue-business-deploy-5s01p2/`；此前只读基线在`.benchmarks/queue-business-update-dcN7l4/preparation.json`。最新单次冷启动正常取得主进程，但唯一身份查询失败，实际采集/暂停0次；独立报告在`.benchmarks/queue-business-cold-zuBWyi/`，旧缺PID失败不覆盖。当前不需要再次构建安装。以下是更新流程约束，不是重新执行的待办；公开文档不复制业务源码、安装包或原始设备数据。

1. **固定输入。** 保存业务APK、SDK AAR、来源指纹、二进制SHA和签名基线。更新前的旧业务包缺`assets/inspector-sdk-build.json`及`read-diagnostic-identity`，不能作为新AAR的配对APK；不要伪造资产补过门禁。构建输出会覆盖旧文件，先在本机独立目录保留旧包与校验记录。
2. **准备SDK。** SDK工程使用Java 17，显式构建`:inspector-sdk:assembleDebug`；已有AAR只有在当前源码指纹、编译类与实际身份查询代码一致时才可复用。将该AAR复制到本机独立目录并记录SHA，业务构建引用这个固定副本，不跟随可变输出。
3. **构建业务Debug包。** 使用已核对的业务Gradle包装器/Java 11/Debug任务与`-PinspectorSdkAar=/absolute/frozen/inspector-sdk-debug.aar`。依赖只放`debugImplementation`，保留当前兼容的HiddenApiBypass 6.0。完整构建命令与本机路径见本地记录；沿用已验证依赖配置，先明确内存预算，不偷偷切换依赖或自动换参数重试。
4. **安装前准入。** APK包名正确、Debug为真、版本号不低于已安装包；验证新旧签名完全一致。`verifyLocalQueueBuild`核对APK/AAR完整SHA与唯一来源资产；另外检查实际DEX包含身份查询的shell/Debug/PID/nonce限制、BuildConfig指纹与会话路由，不只检查字符串。不得混入sample/hold组件；构建时固定AAR的SHA必须前后不变。签名错误、代码/来源不一致或旧包被替换即停止，不卸载、不降级或清数据。
5. **获授权才安装。** 安装前重新读取手机包路径/完整SHA，与签名基线对应；若字节变化，重新取得安装包并验证签名，不能继承本次旧包证明。确认后仅`adb -s SERIAL install -r -t --no-streaming /absolute/verified/app.apk`保留数据覆盖，不使用`-d`、卸载或清数据。安装失败保存原错误，不自动重装；覆盖可能结束当前App进程，安装后的状态不能假定与安装前相同。
6. **安装后核对。** 重新读取实际安装路径、包名/Debug/版本及完整SHA，必须等于本次可信新APK；遇到split APK停止并另做完整分包核对。安装包、AAR、SDK来源、签名及新/旧进程证据分开留存，不继承旧verify状态、PID、实例、样例结果或性能数字。本轮不主动compile/reset手机状态或替换主桌面。
7. **一次业务观察，另明确范围。** 明确一次冷启动的授权后，有界观察新主进程PID/startTicks，再用上述显式入口仅发一次诊断请求；启动命令返回不等于PID已出现，PID出现不等于UI/SDK就绪。只读元信息观察最多1秒/10次，不是SDK/树/启动重试，不扩大入口15秒操作、250ms通知或32帧预算。不得先读树、人工hold或等待成功后反复补跑。未知/提前结束/失败留证并停止；没有命中排队不等于冷启动修复，后续恢复验证另明确范围。

启动前置依赖已本地复核：Provider发布前不能把SDK锁外标量查询当独立早期观察。显式系统/JDWP单次库和`startup-stack-probe`驱动已接上；双确认绑定目标/可信APK摘要，记录实际派发起点、新PID/startTicks、命令两路输出/退出与最终JSON，不在身份失败后自动取栈。18秒操作、恢复1秒/清理3秒，窗口仍15秒；19项新增真实本机子进程/TCP回归不是实际手机或冷启动验收。实际启动/必要暂停须另明确范围，App已运行即停，不自动强停/安装/清数据。身份命令退出0但无效回复或明确content访问错误仍拒绝留证；正常daemon提示不误判，未知/截断/取消不授权工作。入口及边界见[测试计划](../TEST_PLAN.md)和[启动取证分工](STARTUP_FAILURE_REVIEW.md#启动前置依赖与取证分工)，旧真机缺失字段不回填，本轮未更新SDK或操作手机。

产物源码指纹用于版本关联，不是安全认证。签名校验器的未保护ZIP条目警告须保留，不能称每个条目都被签名覆盖；设备与可信APK的完整SHA一致另行核对。更新后成功采集、冷启动根因、像素一致性及性能改善分别验收，不相互替代。

<a id="refresh-and-capture"></a>

## 树就绪、刷新、取消与独立图片

可选树就绪通知（已同签名部署，业务设置页通知/取消恢复验收通过，不代表提速）：仅会话通道的`capture-visible`同时传`withTree=true`、`treeReadyEvents=true`时，SDK在nonce树文件原子发布后发送`Event: {"event":"tree-ready","nonce":"…","processInstance":"…","pid":…}`一行，再继续层图片抓取，最终仍为原`Result: Bundle[...]`。事件不替代树文件、窗口/进程/几何核对或最终回复；客户端须分流、绑定本次nonce/PID及实际树实例，拒绝迟到/取消结果，不延长期限。旧客户端/content调用不发事件，旧SDK忽略新参数并保留文件轮询。writer限定同次socket线程、finally释放；写通知失败不把已发布树误报失败。桌面诊断`sdk-tree-ready-event=true`仅表示本次收到且核对通知；`sdk-tree-ready-received-ms`相对合并调用起点，`sdk-tree-ready-wake`记录是否唤醒等待，不作下次请求授权或性能证明。

业务端到端检查可用 `bun scripts/device-health-check.ts --serial=SERIAL --require-device --reuse-app --repeat-current --refresh-node`。保持同一 App 页面；完整采集后另外测三次可见文字叶节点刷新，时间不计入整页结果。刷新需对象/类名一致、非空画面和合法边界；几何变化单独报告，不把旧树位置当新图的像素基准，失败不盲目重试。该探针测 API 交付，不测 WebGL 合成或物理上屏。小树可能走 DDMS 而非 SDK 全页图，必须先看阶段和节点数；不能直接归因于输出缓冲。

控件/小分支刷新返回可选 `timings`（毫秒），探针保存在单节点报告中：前后台身份检查、Activity读取、转发、两次读树、取图传输及总耗时。`取图明细.*Ms` 是取图阶段的子计时，不能和父阶段重复相加；前台/进程/Activity只读检查可并行，其耗时也不能简单相加。单节点与小分支支持此诊断，列表尚未接入；早期校验失败可能没有报告。保留刷新前后身份/窗口/几何校验和转发清理，不缓存活控件或调试连接。

小树文字单节点SDK取图仍为实验，**默认关闭**；仅隔离探针可设 `INSPECTOR_ENABLE_SDK_TEXT_REFRESH=1`。需要完整SDK树合并、进程实例、现代几何及 `refDebugCanvasVersion=1` 能力；`capture-refs` 显式 `debugCanvas=true` 仅允许一个硬件加速TextView叶节点，返回同名确认字段并使用硬件快照、PNG编码。未指定时保留原取图/格式；容器、无SDK/旧SDK及特殊层不切换，失败不盲目再抓。软件/硬件绘制以及PNG/WEBP浏览器透明边缘舍入差异都已在样例复现；修正后样例灰色文字与更新后的业务设置页均通过12次像素门禁。仍待取消/超时/迟到回复恢复验收，不能默认上线；安装后启动和原调试读树超时也未解决。

`--refresh-pixels` 保存原始编码图（扩展名png，旧路径内容可能WEBP）和浏览器解码RGBA摘要；`--expected-refresh-sha=SHA` 要求摘要/尺寸一致，失败停止且返回非零；`--refresh-text=TEXT` 可精确选择固定文字（需同时指定 `--refresh-node`）。像素解码/哈希计入探针往返耗时，API时间另列；无基准时只记录，不把健康判定当像素一致证明。Debug样例 `--es mode encoding-diagnostic` 将同一硬件/软件文字位图及色阶各编码三轮，产物在私有目录 `files/snapshot-encoding/`、报告 `files/snapshot-encoding.json`；拉到本机后用 `python3 scripts/check-snapshot-encoding.py DIR` 对照原始RGBA/PNG/WEBP，需要Pillow，不修改图片。

接口安全复测：`bun scripts/diagnostics/sdk/sdk-text-refresh-failure-probe.ts SERIAL PACKAGE TEXT`。要求前台已接入新版SDK、文字唯一且为TextView叶节点；检查缺失对象无图、错误进程/根窗口拒绝、临时/最终文件清理及随后正常取图。测试故意发无效身份，但不修改页面或清数据；失败必须保留，不作为像素或取消验收的替代。

桌面传输回归：`bun test tests/provider-session-request.test.ts tests/provider-session-transport.test.ts tests/view-refresh-commit.test.ts`。本机TCP/模拟ADB夹具验证取消、超时、迟到回复、连接恢复与清理；单测验证取消和快照替换后的更新保护。不会调用真实手机；真实SDK桌面接口复测见下，按钮/画布状态验收仍待完成，文字实验保持默认关闭。

真实SDK桌面接口复测：`bun scripts/diagnostics/sdk/sdk-text-desktop-cancel-probe.ts SERIAL TEXT`。隔离Electron使用本机延迟代理，正式preload/IPC验证后续刷新取消旧请求、30秒期限超时、迟到回复丢弃、文件/转发清理和恢复；核对浏览器RGBA、尺寸和位置。不会阻塞手机UI或更换APK，主窗口不动；运行前须已构建桌面并将手机停在稳定页。它直接调用桌面接口，不代替按钮/画布状态实测，实验仍默认关闭。

新树节点可选 `hardwareAccelerated` 必须为布尔值；只有明确true才能进入实验文字硬件路径，旧SDK缺项及软件目标不启用该路径，SDK执行时仍检查当前状态。新版本尚需业务真机字段/像素复测。探针加 `--workbench` 使用实际桌面鼠标点击，验证刷新中切换历史快照后的取消和界面状态；此模式可测普通分支SDK回复，不要求旧SDK伪造硬件证据，不验证设备侧阻塞。

启动 Debug 样例后，报告位于其私有目录 `files/isolation-probe/result.json`，图像包括 `parent-group.png`、`child-own.png` 和 `parent-own.png`。可用 `adb exec-out run-as com.androiduiinspector.sample cat files/isolation-probe/result.json | jq -e '.isolationPassed == true and .opaqueChildClipped == true'` 复核父子隔离。

样例和 `capture-own` 在 Debug SDK 中定向调用 Android 内部的 `createSnapshot(skipChildren=true)`；全页 `capture-visible` 复用 `ViewDebug` 的硬件/软件画布选择和 snapshot 路径，但在同一主线程任务中读取实际位置、尺寸并绘制，不再使用选层阶段的旧坐标。普通 View 绘制前后几何或窗口变化会拒绝出图，指定普通控件补图也做同样检查；单控件等待预算 3s，超时后的迟到位图回收，不交付。编码仍在有界后台流水线中执行。这是单控件时序一致，不保证整页所有图属于同一帧，桌面树/图身份与几何校验仍保留。普通反射在此机型会返回 `NoSuchMethodException`，现在通过 `HiddenApiBypass` 调用，没有改动设备全局隐藏 API 策略。2026-09-28 小米 Android 14 真机：父整组图含 3732 个红色子文字像素、19125 个不透明绿色子项像素；父自身图两者均为 0，自己绘制的黄色标记仍在；透明文字叶子含 4872 个红色像素，角落 alpha 为 0。绿色子项越出父边界且被裁剪，`isolationPassed=true`。同一父对象尺寸由 731×506 改到 816×591 后，自身图尺寸同步更新，仍无子文字。Surface/Texture 缓冲内容仍走专用路径，Release APK 无 SDK 或绕过库。详见 [改造方案](../LOOKIN_ALIGNMENT_PLAN.md)。

采图时序回归（需要本机 `ffmpeg`）：启动样例 `--es mode capture-geometry` 后运行 `bun scripts/diagnostics/sdk/sdk-geometry-probe.ts SERIAL`。20 个控件持续移动，像素编码绘制时屏幕位置；三轮逐图核对返回坐标，并验证绘制中改变位置的控件被全页/补图两条路径拒绝。脚本最后切回默认样例，检查父自身图不含子画面、文字透明背景不继承父层颜色。

Debug Provider 除 `capture` 树外，还可按 `ref` 调用 `capture-own`；返回尺寸、进程实例和 PNG 的 SHA-256，图片放在 App 私有 `no_backup/inspector-own-image.png`。请求只接受 shell UID、`android.permission.DUMP` 和可调试包。未知对象返回错误，不会把整组图冒充自身图。此入口尚未接入桌面 UI；其他系统版本、自绘类型和性能仍需单独验证。

在线混合快照收起父层时可按需调用 `capture-group(ref)`，在 App 内用 `View.draw` 取得整组图。桌面在抓取前后核对进程、窗口、对象、分支结构与尺寸，并核对 PNG 摘要；失败或分支含 SurfaceView/TextureView 时沿用本地合成图。3D 展开仍只显示每层自身图；SDK 给出完整 `clipToOutline` 时，桌面按原始坐标为子图套用自身和祖先的圆角遮罩。`View.draw` 不保留圆角轮廓裁剪，因此遇到非完整矩形轮廓会拒绝失真整组图；可读轮廓用独立图在本机合成，未知自定义路径只显示边框。运行 `adb shell am start -S -n com.androiduiinspector.sample/.MainActivity --es mode visual` 后可用 `adb exec-out run-as com.androiduiinspector.sample cat files/isolation-probe/visual-result.json | jq -e '.visualPassed == true'` 复验。Android 14 样例嵌套圆角像素回归与 3D 真机冒烟已通过；业务 App 当前首页没有可验的圆角父层，仍需在合适页面复验。

实验入口 `capture-own-batch` 一次接受逗号分隔的 1–10 个 `ref`，仅抓每个控件自身、单张最多 100 万像素、整批最多 200 万像素、每张最多 1 MB PNG，批处理预算 5 秒（单张等待超时可能使最终返回略晚）。图片及带 SHA-256 的清单位于私有 `no_backup/inspector-own-batch-*.png` 和 `inspector-own-batch.json`；读取者必须核对返回的清单摘要、进程实例、页面根节点、每张图片摘要与尺寸，并自行验证前台窗口。Android 14 样例同 10 个小文字控件的批量图与逐张图完全一致，三轮约 2.3–2.4 秒，逐张约 13.0 秒。运行样例回归：先用 `adb shell am start -n com.androiduiinspector.sample/.MainActivity --es mode stress` 打开页面，再执行 `bun scripts/diagnostics/sdk/sdk-batch-probe.ts DEVICE_SERIAL`。此接口尚未接入桌面默认采集，不能代替全量采集。

同一 Android 14 真机，动态样例新增子项后父自身图保持不变、变化的文字和新控件均各有自身图。业务 Debug App 的 10 个文字层也通过逐张/批量图片摘要对照；运行 `bun scripts/diagnostics/sdk/sdk-batch-probe.ts DEVICE_SERIAL com.smile.gifmaker` 可复测。业务页批量三轮调用约 2.3/4.4/3.2 秒，逐张 10 次约 17.8 秒；读图还需约 1–1.3 秒。当前只验证 10 张，尚未替代桌面 170+ 张图的完整采集。

混合模式的 Debug Provider 使用 `android.permission.DUMP` 和 shell UID 校验，没有开放网络端口。桌面从 App 私有目录读取按需生成的树，仅在进程、窗口、节点身份和几何全部匹配时与独立画面合并；失败就保留旧快照并提示。整树 JSON 在主线程只做视图遍历与对象构建，字符串化与写盘在调用线程；业务页 1204 节点实测不再触发 ≥1 秒的主线程长任务（2026-10-01）。加入不透明子项后，样例真机上 14/14 个 View 匹配（另有 1 个合成根）、9 张独立图，无警告。

Debug 构建中可调用 `DebugNames.set(view, "业务名称")` 为没有文本/ID 的控件加显示名；Release 构建请沿用样例的无操作包装，不引入 SDK。混合快照保留真实类名、ID、文本，同时读取 `LayoutParams` 类型、宽高和真实 margin；没有 margin 的参数类型不伪造 0。Android 14 真机样例已验证两处名称及负 margin；Release APK 无 SDK 类或 Provider。

<a id="metadata-and-samples"></a>

## 业务信息协议与样例证据

<a id="business-debug-metadata"></a>

### 分组业务信息（新版 SDK）

Debug App 可在主线程显式登记只读值。属性栏按组显示名称、类型和来源，支持搜索、复制；完整快照、历史和调试报告保留这些值。`false`、`0` 和空字符串均保留原值。

```java
import com.androiduiinspector.sdk.DebugMetadata;

DebugMetadata.setGroup(card, "component", "组件信息",
    DebugMetadata.text("name", "组件名", "SampleCard"),
    DebugMetadata.text("owner", "归属", "Feed"));
DebugMetadata.setGroup(card, "state", "页面状态",
    DebugMetadata.flag("loading", "加载中", false),
    DebugMetadata.number("retryCount", "重试次数", 0),
    DebugMetadata.text("error", "错误信息", ""));
// 状态变化时再登记同一组，会整体替换该组。
DebugMetadata.removeGroup(card, "state");
DebugMetadata.clear(card); // 复用控件前清除旧业务信息。
```

分层状态可继续登记在同一组中：

```java
DebugMetadata.setGroup(card, "state", "页面状态",
    DebugMetadata.nullValue("pending", "未获取"),
    DebugMetadata.tree("detail", "业务详情",
        DebugMetadata.treeNull("request", "请求",
            DebugMetadata.treeFlag("loading", "加载中", false),
            DebugMetadata.treeNumber("retryCount", "重试次数", 0),
            DebugMetadata.treeText("error", "错误信息", ""))));
```

`tree()`接收显式构造的节点，节点保留标量类型及子节点；不反射任意业务对象。同级key不能重复，不同父节点下可重复；路径以`/`分隔，key不含斜杠。每字段最多128节点、8层，根节点算第1层；子数组和登记字段立即保存副本。`nullValue()`、`treeText()`、`treeNumber()`、`treeFlag()`和`treeNull()`保留实际类型。

旧文字/数字/布尔登记仍使用业务协议v1，树或null使用v2。新版SDK声明支持v2；桌面同时读取v1/v2，快照文件只有含v2信息才写v2。使用说明见[分层业务信息](../FIRST_USE.md#structured-values)，本轮源码与SDK离线构建见[迁移验收](ACCEPTANCE_HISTORY_2026-10-15.md#lookin-migration-acceptance)，未更新手机包。

组/字段 key 用字母开头的 ASCII 标识（后续可含数字、下划线、点和短横线），最多64字符；显示名最多64字符，文字值最多512字符。每个控件最多4组、每组16项，序列化预算16KiB；数字必须有限且绝对值不超过 `9,007,199,254,740,991`。无效或超限登记抛出异常并保留原登记；同一组内字段 key 不可重复。

每次整树采集的业务值预算256KiB，超过时只返回明确的未保存标记，原控件树仍可用。SDK从控件私有tag读取登记值，不保存控件全局引用，不执行回调或反射业务对象。控件未登记、登记已清除或旧SDK缺项时，不显示业务信息卡片；信息来自采集时的登记值，App负责更新，不代表持续监听状态。

接入仍限Debug依赖，Release使用[样例包装](../../android/sample-app/src/release/java/com/androiduiinspector/sample/ProbeRunner.java)中的无操作方法。源码、离线校验和两类构建结果见[验收](ACCEPTANCE_HISTORY_2026-10-15.md#business-debug-metadata-acceptance)；本轮没有安装手机包，设备上的旧SDK不具备此接口。

SDK 还按实际 Java 父类返回去重的类继承表；属性栏仅在查看选中控件时展示。Android 14 的 20×20 样例中，435 个真实 View 均有继承链，SDK 树约 231 KB；旧 SDK 快照无此字段时仍可读取。

交互卡读取 View 的可长按、上下文点击、标准点击监听器、按下与激活标志。动态样例已验证长按和标准点击监听器可分别识别；未安装标准监听器不代表控件或子项不能响应自定义手势。旧 SDK 无此数据时不会显示该卡。

原生布局规则读取系统 `FrameLayout.LayoutParams.gravity`、`LinearLayout.LayoutParams.gravity/weight`、`RelativeLayout.LayoutParams` 的相对/父容器对齐规则，以及 ConstraintLayout `LayoutParams` 的锚点、偏置、环绕和宽高比。ConstraintLayout 通过读取其公开布局参数字段，不增加 SDK 对 ConstraintLayout 的编译依赖。Android 14 样例已验证 gravity/weight；业务 Debug App 的 1211 节点真机快照已与独立 Debug View 树严格匹配，358 个 RelativeLayout/ConstraintLayout 规则节点全量通过桥接，并在新版桌面属性栏截图确认两类规则可见。其他布局不按控件位置猜测约束。

新版 Debug SDK 的 `capture-style(ref)` 只按需读取一个控件的背景 Drawable 类型、可确定的纯色源色，以及 TextView 当前文字色和 px 字号；桌面属性栏点击“读取实时样式”后才调用。Android 14 样例已验纯色父层和文字层。渐变、自绘或 tint 不推断最终显示色；业务 App 需重新构建并接入新版 SDK 才能使用。

样例支持 `--es mode stress`（10×10 控件网格）、`--es mode stress-large`（20×20）、`--es mode dynamic`（点击红色文字后修改文本并新增控件）、`--es mode resize`（点击后只改变父子尺寸和文字，保持对象及树结构）、`--es mode surface`（纯绿色 SurfaceView）及 `--es mode partial-failure`（单层超出 400 万像素预算）。Android 14 真机上分别验证了 125 节点/108 张图、435 节点/408 张图，以及动态模式从 14 到 15 节点的重新匹配。`partial-failure` 验证超预算层明确失败、其余层继续采集，不再整批回退。若在旧画面与 SDK 树采集之间改变页面，桌面会拒绝合并并提示；下一轮可恢复。435 节点三轮中位耗时：旧通道约 24.7 秒，混合通道约 25.5 秒，尚无速度收益。

列表刷新样例另有 `--es mode list`（只新增两个条目）和 `--es mode list-replace`（新增两个并替换两个旧实例）；对应真机探针为 `bun scripts/sample-list-refresh-probe.ts --serial=<serial> --require-device --mode=list-replace`。

局部刷新回归已在同一 Android 14 真机验证：`resize` 模式刷新后父子尺寸与文字同步更新；`surface` 模式分支刷新得到三张互不串色的独立图（父蓝底、Surface 绿色缓冲、透明红字）。Surface 色值相对绘制值存在小幅色彩转换，不能用逐通道完全相等作为画面正确性的断言。单控件刷新与完整采集的物理拔线/重连已在当前 Android 14 设备验证；其他系统和更多断线时点仍待验。

当前已验证原生 View 样例及一款接入 SDK 的业务 Debug App；其他 App 仍需添加 Debug 专用依赖并重新构建，SDK 尚未发布到 Maven。多窗口、更多 Android/OEM、复杂自绘及长期内存未通用验收；上述历史小样例耗时不代表最新全页路径。
