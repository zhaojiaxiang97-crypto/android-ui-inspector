# 文档导航

目录整理：2026-10-21。先看日常入口，再从专题索引查专项研究与历史实验。功能状态、验收结果、安装版本和下一步安排仍以其专页为准。

已结束的 A–C、D1–D24 自动调试实验保存在 [`archive/automation/`](archive/automation/README.md)。本轮将图标说明、Helper 等待与恢复、SDK 可选化、产品风险验收和 Lookin 迁移记录合入对应主题，保留独有的设计依据与失败证据。当前开源参考调查统一查[执行记录](OPEN_SOURCE_REFACTOR_EXECUTION.md)。

## 日常入口

| 要做什么 | 文档 |
| --- | --- |
| 开始使用、查看交互与配置 | [第一次使用](FIRST_USE.md) |
| 查看当前能力和缺口 | [项目状态](PROJECT_STATUS.md) |
| 查看已验范围与历史结果 | [验收清单](CORE_ACCEPTANCE.md) |
| 安装、升级、备份或回退 | [本机交付](DELIVERY.md) |
| 查代码职责和依赖 | [开发目录](DEVELOPMENT_STRUCTURE.md)、[架构完成记录](ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout) |
| 选择测试与发布检查 | [测试计划](TEST_PLAN.md) |
| 查看产品级风险专项（源码已整合，尚未发布） | [2026-10-19 风险验收](CORE_ACCEPTANCE.md#product-risk-20261019) |
| 使用可选 SDK、CLI 或 MCP | [Android接入](../android/README.md)、[CLI](CLI.md)、[MCP](MCP.md) |
| 选择标准采集或 SDK 增强 | [使用说明](FIRST_USE.md#sdk-enhancement)、[实施与验收范围](archive/SDK_REFERENCE_HISTORY_2026-10-15.md#sdk-optional-enhancement) |
| 查看产品方向和候选边界 | [Lookin计划](LOOKIN_ALIGNMENT_PLAN.md#下一步)、[检查功能迁移](LOOKIN_ALIGNMENT_PLAN.md#lookin-migration-history) |
| 研究当前 3D 排层与投影取舍 | [图层源码研究](LOOKIN_LAYER_RENDERING_REDESIGN.md#8-实施结果) |
| 研究无 SDK 采集速度与 ARTEMIS 的适用范围 | [采集链路改造方案](CAPTURE_PIPELINE_REDESIGN.md) |
| 按开源参考推进下一轮性能与可靠性改造 | [开源参考改造计划](OPEN_SOURCE_REFACTOR_PLAN.md) |
| 核对大树超时、Perfetto、Provider 节点 ID 审计及整段性能预算 | [A0–A2 实际执行记录](OPEN_SOURCE_REFACTOR_EXECUTION.md#a2-latency-budget-20261021) |
| 了解自动操作、Helper、性能和逐轮结果 | [自动调试与 Helper 专题索引](AUTOMATION_INDEX.md) |
| 继续自动操作的当前工作 | [下一步计划](AUTOMATION_NEXT_STEPS.md)、[开源参考改造计划](OPEN_SOURCE_REFACTOR_PLAN.md) |
| 维护坐标、性能、图标和平台启动 | [截图坐标](SCREEN_COORDINATES.md)、[树性能](TREE_PERFORMANCE.md)、[图标](README.md#iconography-guide)、[Windows启动](WINDOWS_STARTUP.md) |
| 使用独立 e2e 实验 | [实验说明](../scripts/experiments/tester-e2e/README.md) |

## 专题与研究

- **自动 UI 调试 / Helper**：[专题索引](AUTOMATION_INDEX.md)按执行器、阶段 A–C、D1–D24 性能与故障调查组织；[历史实验目录](archive/automation/README.md)保留 A–C 和 D1–D24 原报告。
- **产品与交互**：[Lookin 对齐](LOOKIN_ALIGNMENT_PLAN.md)、[迁移候选](LOOKIN_ALIGNMENT_PLAN.md#lookin-migration-history)、[3D 图层设计](LOOKIN_LAYER_RENDERING_REDESIGN.md)。
- **采集与 SDK**：[采集链路重构研究](CAPTURE_PIPELINE_REDESIGN.md)、[可选 SDK 实施记录](archive/SDK_REFERENCE_HISTORY_2026-10-15.md#sdk-optional-enhancement)、[Android 接入](../android/README.md)。
- **工程与检验**：[架构收尾](ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)、[开发目录](DEVELOPMENT_STRUCTURE.md)、[测试计划](TEST_PLAN.md)。

## 历史参考

- [自动调试逐轮历史](archive/automation/README.md)：阶段 A–C、D1–D24、早期执行器方案和性能试验，保留失败证据。
- [UI 五轮设计记录](archive/LOOKIN_UI_DESIGN_2026-10-13.md)：原五份计划合并，保留 30 项设计、上游依据与实施后的取舍。
- [2026-10-11 至 15 日验收](archive/ACCEPTANCE_HISTORY_2026-10-15.md)：架构、UI、自动调试、安装与设备的逐轮结果及失败证据。
- [SDK 专项与实验参考](archive/SDK_REFERENCE_HISTORY_2026-10-15.md)：协议细节、探针限制和历史实验；接入入口仍在 Android README。
- [图层与界面沿革](archive/LAYER_UI_HISTORY.md)：早期图层设计，以及开始页、离屏显示与聚焦的实现依据。
- [归档索引](archive/README.md)：更早方案、失败与版本沿革。

2026-10-21 的最新只读诊断以[A2 实测](OPEN_SOURCE_REFACTOR_EXECUTION.md#a2-probe-aba-20261021)为准：自有 758 节点页面 8/8 超时；固定竖屏 308 节点的计时探针 A/B/A 共 24/24 次完整通过、全部零输入，原版前后漂移 +1.35%，计时版相对两端原版平均基线差 +1.12%。尚无可安全用于生产的提速候选；正式 D24 业务回归仍为 0/3，20% 整段提速未达成。[D24 原始失败记录](archive/automation/AUTOMATION_BUSINESS_REGRESSION_D24.md)仅对应其当时状态。

## 维护规则

- 能力写状态，安排写计划，门禁写测试，实测写验收；历史细节进入归档，不多页复制“当前版本”或逐轮播报。
- 自动调试进行中的最新轮次留在根目录；结束或撤回的逐轮报告放入 [`archive/automation/`](archive/automation/README.md)，同时更新[专题索引](AUTOMATION_INDEX.md)，不再堆到根目录。
- 合并或删除文件时同步引用与锚点；保留独有设计、断言、失败和证据路径，删除重复分工与过期执行安排。
- 源码、隔离工装、安装窗口、手机和目标平台分别说明；历史命令不自动成为当前任务。
- 私有源码、APK、业务画面、配置和日志只留本机忽略目录；文档截图使用已核验的自有样例。

<a id="iconography-guide"></a>

## 图标

本轮使用 OpenAI 内置 imagegen 逐张绘制 56 个透明 PNG 图标，统一替换工具栏、控件树、属性面板、弹窗及空状态中的自定义静态图标。

- [图标总览](iconography.html)：按 16 / 20 / 32 px 查看，支持深浅主题和名称搜索。
- [生成记录](../src/assets/icons/manifest.json)：每张图的最终提示词与文件校验值。
- 图片：`src/assets/icons/*.png`，保留 imagegen 输出的原始像素与透明度。
- 接入：`src/components/AppIcon.tsx` 与 `src/styles/app-icon.css`。PNG 的透明轮廓用作 CSS mask，沿用所属控件的文字颜色。

### 使用约定

工具栏主要图标为 18～20 px；控件树为 16 px；展开与关闭按钮为 10～14 px。方向通过旋转同一个箭头图标表达，复制、关闭等相同操作始终复用同一张图。

图标为装饰元素，按钮继续保留原有文字、提示与可访问名称。鼠标悬停、选中、禁用时随控件颜色变化。

系统原生控件、数据状态圆点、颜色色块，以及依据实际控件尺寸绘制的测距图和 3D 轮廓，继续使用原来的交互或数据绘制方式。
