# 文档索引

更新：2026-10-17。当前入口按用途维护，已完成的逐轮计划与实验放入历史参考。源码、安装候选和设备验证范围分别看对应记录。

## 当前文档

| 要做什么 | 文档 |
| --- | --- |
| 开始使用、查看交互与配置 | [第一次使用](FIRST_USE.md) |
| 查看当前能力和缺口 | [项目状态](PROJECT_STATUS.md) |
| 查看已验范围与历史结果 | [验收清单](CORE_ACCEPTANCE.md) |
| 安装、升级、备份或回退 | [本机交付](DELIVERY.md) |
| 查代码职责和依赖 | [开发目录](DEVELOPMENT_STRUCTURE.md)、[架构完成记录](ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout) |
| 选择测试与发布检查 | [测试计划](TEST_PLAN.md) |
| 使用可选 SDK、CLI 或 MCP | [Android接入](../android/README.md)、[CLI](CLI.md)、[MCP](MCP.md) |
| 选择标准采集或 SDK 增强 | [使用说明](FIRST_USE.md#sdk-enhancement)、[实施与验收范围](SDK_OPTIONAL_ENHANCEMENT_PLAN.md) |
| 查看产品方向和候选边界 | [Lookin计划](LOOKIN_ALIGNMENT_PLAN.md#下一步)、[检查功能迁移](LOOKIN_MIGRATION_PLAN.md) |
| 研究当前 3D 排层与投影取舍 | [图层源码研究](LOOKIN_LAYER_RENDERING_REDESIGN.md#8-实施结果) |
| 研究无 SDK 采集速度与 ARTEMIS 的适用范围 | [采集链路改造方案](CAPTURE_PIPELINE_REDESIGN.md) |
| 优化自动操作的耗时、复合步骤和连续滚动 | [自动调试提速计划](AUTOMATION_PERFORMANCE_PLAN.md) |
| 按当前进度安排自动操作后续工作 | [下一步计划](AUTOMATION_NEXT_STEPS.md) |
| 排查 Helper 跨页失败与只读恢复 | [诊断与恢复实现](HELPER_OBSERVATION_RECOVERY.md) |
| 减少 Helper 条件等待期间的全量采集 | [手机端短时条件等待](HELPER_CONDITION_WAIT.md) |
| 查看 Helper 前后校验并行读取的改动和实测 | [边界读取并行优化](HELPER_BOUNDARY_PARALLEL.md) |
| 排查系统触摸注入失败与 Helper 手势回执 | [Helper 输入与验证](HELPER_INPUT_TRANSPORT.md) |
| 查看独立输入夹具、跨页计划与取消实测 | [输入闭环验收](HELPER_INPUT_STAGE_A.md) |
| 查看固定列表末项、控件滚动与重放实测 | [固定列表滚动验收](HELPER_SCROLL_STAGE_B.md) |
| 查看真实收藏末卡播放、耗时与未完成项 | [阶段 C 业务回测](AUTOMATION_BUSINESS_STAGE_C.md) |
| 重复运行手机操作、统计耗时并逐步留证 | [一键 UI 多轮回测](AUTOMATION_UI_REGRESSION.md) |
| 整屏父控件被系统栏局部遮挡时验证状态 | [部分可见的只读断言](AUTOMATION_PARTIAL_VISIBILITY.md) |
| 查看收藏页脚露出、只读恢复和证据容量修正 | [收藏末端与证据修正](AUTOMATION_FOOTER_RECOVERY.md) |
| 维护坐标、性能、图标和平台启动 | [截图坐标](SCREEN_COORDINATES.md)、[树性能](TREE_PERFORMANCE.md)、[图标](ICONOGRAPHY.md)、[Windows启动](WINDOWS_STARTUP.md) |
| 使用独立 e2e 实验 | [实验说明](../scripts/experiments/tester-e2e/README.md) |

## 历史参考

- [UI 五轮设计记录](archive/LOOKIN_UI_DESIGN_2026-10-13.md)：原五份计划合并，保留 30 项设计、上游依据与实施后的取舍。
- [2026-10-11 至 15 日验收](archive/ACCEPTANCE_HISTORY_2026-10-15.md)：架构、UI、自动调试、安装与设备的逐轮结果及失败证据。
- [SDK 专项与实验参考](archive/SDK_REFERENCE_HISTORY_2026-10-15.md)：协议细节、探针限制和历史实验；接入入口仍在 Android README。
- [图层与界面沿革](archive/LAYER_UI_HISTORY.md)：早期图层设计，以及开始页、离屏显示与聚焦的实现依据。
- [归档索引](archive/README.md)：更早方案、失败与版本沿革。

## 维护规则

- 能力写状态，安排写计划，门禁写测试，实测写验收；历史细节进入归档，不多页复制“当前版本”或逐轮播报。
- 合并或删除文件时同步引用与锚点；保留独有设计、断言、失败和证据路径，删除重复分工与过期执行安排。
- 源码、隔离工装、安装窗口、手机和目标平台分别说明；历史命令不自动成为当前任务。
- 私有源码、APK、业务画面、配置和日志只留本机忽略目录；文档截图使用已核验的自有样例。
