# 当前验收清单

更新：2026-10-15。当前源码完成 SDK 可选化、R0–R8 架构重构及五轮共 30 项 UI 改进；完整批次见[架构收尾](ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)。下方记录最新验收，逐轮细节集中在[历史验收](archive/ACCEPTANCE_HISTORY_2026-10-15.md)。测试数和设备范围按各轮分别解释，不累计或继承。

<a id="版本边界"></a>

## 版本边界

| 对象 | 最近确认 | 范围 |
| --- | --- | --- |
| 当前源码 | SDK 可选化已完成；最新全量 1575 项 / 215 文件通过，1 项环境跳过已单独补验 | 源码已同步；功能与设备、安装验收分别记录 |
| 桌面安装候选 | `diagnosis-handoff-20261012-746e1dc0`，Mac arm64 | 沿用此前安装版，签名、摘要与恢复路径统一见[交付说明](DELIVERY.md#本机更新2026-10-12) |
| R8 Android 样例 | 自有 Debug sample，一台 Android 14 / API 34 | 两个入口旧/新对照；不覆盖业务 App、多机型或长期稳定性 |
| 其他独立候选与 Helper | 按各自冻结版本及样例验收 | [历史结果](archive/ACCEPTANCE_HISTORY_2026-10-15.md#版本边界)不代表当前源码已重新安装 |

<a id="sdk-optional-acceptance"></a>

## SDK 可选化（2026-10-15）

对应[改造计划与实施记录](SDK_OPTIONAL_ENHANCEMENT_PLAN.md)。默认 `standard`；SDK 增强在偏好设置中显式开启。模式统一覆盖采集、后续刷新/补图/样式、连接诊断与自动调试，CLI/MCP 请求不能单独覆盖。切换清理 SDK 能力缓存并撤销实时资格，保留已采数据。

- 全量 **1575 项通过、0 失败、1 项环境跳过，215 文件，183.04 秒**。跳过原因是未指定 Android SDK 路径；补齐环境后 `sdk-capture-pipeline.test.ts` **2 项通过**，包含该完整 Java 入口用例。类型检查与完整构建通过。
- 设置界面 **18 个尺寸/缩放/主题组合**、模式切换实际 renderer 回归及完整树/画布回归通过。验证加载失败重试、保存失败保留、忙态、旧响应、已保存/本次缓存来源和快照保留。SDK 增强的路由、缺失回退、旧能力及身份/取消规则以专项测试覆盖。
- 一台 Android 14 / API 34，复用已安装的自有 `com.androiduiinspector.sdkfree`。APK manifest 无 Provider、dex 无 SDK 与绕过库，已装 APK 与核验文件 SHA-256 一致；未安装或更新 APK。
- 硬件加速文字样例首轮采到 **10 节点、6 张独立图、0 张失败**，约 **4.85 秒**。树预览约 3.70 秒，首个图像批次约 4.23 秒；同一文字控件 **3 次 JDWP 刷新**全部成功，bounds 与像素摘要一致。70 条 ADB 调用记录中无 SDK 专属 URI、会话转发或唤醒命令。
- 原生 Electron 独立配置验收 **8 组流程通过，约 30 秒**：默认模式、真实 UI 采集、2D/3D、A/B 测距、切换后的图片/选择保留与实时资格撤销、历史保存重开、导出数据往返、进程重启后的模式/历史保留。导出使用生产 `snapshotExportRequest` 和 `parseSnapshotFile` 校验，**未执行原生保存文件对话框**。
- 两次设备检查后样例进程保持稳定，原前台已恢复，转发列表未增加残留。桌面安装版未更新，业务 App 未修改。

证据：`.benchmarks/sdk-optional-20261015/`，包含全量/补验/构建日志、`device-health-summary.json`、实际刷新记录、`native-smoke-oYp03Z/result.json` 和阶段截图。增强模式真机重采、软件窗口/复杂业务页面、多系统与长期稳定性不在本轮设备验收范围；没有据此声明性能提升。

<a id="architecture-round8-acceptance"></a>

## 架构重构第八轮（2026-10-15）

对应[第八轮实施结果](ARCHITECTURE_REFACTOR_PLAN.md#17-第八轮实施结果2026-10-15)。完成 R8：共同编码队列、顺序写出、图片流发布和位图交接；样例改用 debug-only 类型化探针契约。

验证结果：

- 旧版相关专项 **19 项 / 10 文件通过**；新版最终专项 **22 项 / 11 文件通过**。新增测试编译真实完整 Java helper 和完整 SDK 入口，Android 边界使用主机替身；覆盖双线程、深度 4、乱序完成、顺序字节流、nonce/CRC/SHA、拒绝提交、失败计数、取消、迟到回收与重复清理。
- 整合全量 **1540 项 / 211 文件，0 失败**，181.47 秒；包含需要 Android API jar 的完整入口测试。类型检查、桌面完整构建通过。
- SDK 和 sample 的 **Debug、Release 构建通过**。实际 AAR 验证 Release 不含 `DebugCaptureProbe`；sample Release 不含 SDK 和新增调试 fixture。APK/AAR 的 SDK 源码身份与当前 main 源码及构建配置一致。
- Android 14 / API 34、自有 `24094RAD4C` 样例进行旧/新真实入口对照：**18 组检查一致，12 份图片清单逐项摘要一致**。图片清单统一移除每层名称的进程内引用后缀，报告比较另归一化 special refs；时序和 process UUID 不参与对照。顺序、位置、尺寸、图片内容与 debugCanvas RGBA 均保持一致。
- 两版都验证整页 **407 图 / 405 几何记录**、反序请求 12 控件的文件几何、单控件内联几何、重复 PNG、透明及半透明像素、真实 SurfaceView/TextureView 像素。两个入口均只触发一次真实超时，检查当时和迟到 UI 释放后无最终/临时文件，再单独新请求确认恢复。
- 两版额外通过动态几何 60 次图片检查、3 轮父级证据、图片隔离、捕获失败恢复、合并树失败、9 组 PNG/WebP alpha 检查，以及类型化探针的 407/405 像素与协议验证、9 类取消/迟到场景和 5 类绘制期间变化拒绝。

单列修复：旧 `captureRefs` 在选图中途异常、UI 结果晚于超时到达时会遗失已准备位图。使用相同主机边界运行完整旧/新 SDK 类，旧版两项均 `created=1 / recycled=0`，新版均只回收一次。真机检查证明文件清理与恢复，位图回收次数结论来自主机测试，未把二者混同。

保留边界：两入口的 UI 线程和位图生成时机、PNG/WebP 选择、特殊缓冲、透明失败语义、几何内联/文件规则、窗口核验与错误回复保持原规则。图片流原子发布不扩展为图片与几何文件的事务。生产公共 API、协议和依赖版本未增加；默认隐藏空层与完整结构切换等画布行为不在本轮改动范围。

初次设备工装有两个已修正问题：alpha 脚本未强制新建 Activity，未取得新 token 报告；SurfaceView 不一定进入 visible 的选图列表，现从真实控件树定位。失败日志保留，修正后用同一 fixture 和检查流程对照旧/新版本。最初缺少 PATH、回归工作树缺少依赖的环境失败也单独保留。

证据目录：整合工作树和原目录 `.benchmarks/architecture-round8-20261015/`。`regression-evidence/` 保存完整旧缺陷复现、专项与独立审查；`baseline/`、`final/` 保存设备日志和产物；`device-comparison.json`、`artifact-verification.json` 记录对照和 Release 隔离；全量、构建日志及 `round8.patch`、`sync-result.json` 记录最终交付。

这是单台 Android 14 设备上的功能验收，不是多系统兼容或性能收益结论。本轮只同步确认文件并更新自有 Debug 样例，保留原分支、暂存区和此前成果；桌面安装版未更新。

## 历史验收入口

| 主题 | 记录 |
| --- | --- |
| 架构第一至第七轮 | [批次总表](ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)及其逐轮验收链接 |
| UI 五轮与检查操作 | [第五轮](archive/ACCEPTANCE_HISTORY_2026-10-15.md#lookin-ui-round5-acceptance)、[测距面板](archive/ACCEPTANCE_HISTORY_2026-10-15.md#lookin-measurement-panel-acceptance)、[功能迁移](archive/ACCEPTANCE_HISTORY_2026-10-15.md#lookin-migration-acceptance) |
| 自动调试、Helper 与首次使用 | [任务完整流程](archive/ACCEPTANCE_HISTORY_2026-10-15.md#task-sample-flow-acceptance)、[Helper补验](archive/ACCEPTANCE_HISTORY_2026-10-15.md#helper-body-window-stability-acceptance)、[首次使用](archive/ACCEPTANCE_HISTORY_2026-10-15.md#first-use-acceptance) |
| 更早失败与权限说明 | [验收沿革](archive/CORE_ACCEPTANCE_2026-10-09.md) |

## 未验范围

新版 UI 手机复核、冷启动及旧导航问题、复杂硬件严格像素、多机型/框架/窗口、长期资源、物理 DPI、多平台安装和正式发布仍按[保留缺口](PROJECT_STATUS.md#保留缺口)维护。架构完成不关闭这些事项。

## 本机证据入口

SDK 可选化证据在 `.benchmarks/sdk-optional-20261015/`；最新架构证据在 `.benchmarks/architecture-round8-20261015/`；文档与退役文件整理在 `.benchmarks/project-cleanup-20261015/`。各轮报告和回退路径保留在对应验收记录，安装产物位置统一见[交付说明](DELIVERY.md)。真实页面、APK、配置和私有源码不公开。
