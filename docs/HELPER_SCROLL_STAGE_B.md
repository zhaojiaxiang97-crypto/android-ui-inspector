# 固定列表滚动验收（阶段 B）

更新：2026-10-17。**固定 24 项列表的三轮验收通过**：每轮 3 次控件滚动找到第 24 项；重放计划和滚动请求均未新增输入或观察。120 项相关测试、完整桌面构建和 Android 构建通过。

本次完成的是显式选择 Helper 的固定纵向列表。真实业务中的“收藏最后一条视频”仍属于[下一步阶段 C](AUTOMATION_NEXT_STEPS.md#阶段-c完成用户原来的完整任务)，尚未验收。原手势路径的失败原因仍未解决。

## 改了什么

- 在现有 `scroll_until` 中增加 `inputMethod: "accessibility"`，调用目标容器的 `ACTION_SCROLL_FORWARD / BACKWARD`；未填写时仍使用原手势路径。CLI 对应 `--input-method accessibility`。没有增加第二套计划解释器。
- 首版只允许 Helper、纵向、资源 ID 与类名精确定位的唯一容器。桌面和手机依次复核可见、启用、可滚动、当前方向动作支持、窗口与采集归属；不允许视觉确认兜底。
- 每次输入前重新校验。执行方式在首次发送前确定，失败不切换到手势或 ADB；调用控件动作后返回 false 也记为 `unknown`，不能认为绝对没有发生变化。
- 实际动作、回执、报告分别记录为 `scroll`、`accessibility-scroll`；导入时核对方向与执行方式。旧计划缺省字段的摘要保持兼容。
- 收不到有效回执时保留未知结果；原请求可查、失败报告可导入，同 ID 重放不重新发送。

可运行定义：[控件滚动计划](../scripts/fixtures/helper-semantic-scroll-end.plan.json)。原[手势计划](../scripts/fixtures/helper-scroll-end.plan.json)保留作失败对照。两者是独立实验，不在一次失败后自动切换。

## 进展与终点分别判断

测试页的系统浮窗遮住了部分列表行，导致原来的完整行签名无法判断进展。现在仍保留完整签名判断“无变化”，但在相同 Helper、页面及容器范围内，还允许两类更窄的证据证明“有变化”：

1. 唯一、未被遮挡的共同条目沿预期方向移动；尺寸或非滚动轴变化、方向冲突仍是未知。
2. 整页替换时，旧的明确条目在新帧全部可见条目中消失，且新的明确条目在旧帧全部可见条目中不存在。两边都满足才成立。

这些只证明内容变化，不能证明输入已投递或列表到底。连续两次输入后进展仍未知会中断；无变化、超时、超限也不算到达末项。成功仍需要明确结束标记通过两次新观察，并满足原有完整观察和区域遮挡检查。生产判断允许使用裁剪后的可见范围；本次末项原始边界完整露出是额外核对的夹具证据。

Debug 夹具额外记录真实 `performAccessibilityAction` 调用及返回值，便于与产品回执交叉核对。列表内部增加 8dp 底部留白，使最后一行完全离开系统导航区域；没有放松生产侧可见性判断。24 行及滚动容器范围保持不变，这些诊断内容仅在 Debug 包中，Release 包未改变。

## 真机结果

环境：Android 14，设备 `DEVICE_SERIAL`，应用 `com.androiduiinspector.sdkfree` 的 `InputDiagnosticsActivity`。桌面正常启动，未加载私有追踪钩子。三轮使用独立会话和独立页面实例，轮间重置测试页；每轮最多 6 次滚动、滚动步骤最多 30 秒，整段计划最多 45 秒。

| 轮次 | 整段计划 | 计划滚动子步骤 | 实际控件动作 | 终点 | 重放新增输入 / 观察 |
| --- | ---: | ---: | ---: | --- | --- |
| 1 | 14.566 秒 | 8.115 秒 | 3 | 第 24 项，双新帧确认 | 0 / 0 |
| 2 | 14.190 秒 | 8.600 秒 | 3 | 第 24 项，双新帧确认 | 0 / 0 |
| 3 | 14.171 秒 | 8.878 秒 | 3 | 第 24 项，双新帧确认 | 0 / 0 |

时间来自 `measurement.run.durationMs` 与 `measurement.run.steps[0].durationMs`；子步骤包含计划调度封装，不能与报告内更窄的执行阶段计时混用。重放检查的前后只读采集另计；表中的“新增观察 0”仅指两次重放本身。

三轮最终页面状态相同：滚动位置 `2669px`、滚动变化回调计数 `43`，点击、导航、坐标点击与 DOWN/UP/CANCEL 均为 0。语义滚动不产生真实触摸，这符合预期，不能据此宣称触摸路径已修好。手机端每轮记录 3 次实际向前滚动，位置依次为 `0 → 1146 → 2292 → 2669`。

末项原始边界为 `[34,2151][1046,2309]`，完整高度 158px，位于容器 `[34,1186][1046,2332]` 内。成功依据是完整末项的双新帧确认；滚动计数文本可能滞后，前两轮第一确认帧的文本仍为 2292，第二确认帧与最终状态才更新为 2669，不能把计数文本当成每帧同步证据。

独立审计确认：3 个不同会话、计划和页面实例，9 个唯一物理请求对应 App 实际收到的 9 次向前滚动。每轮用当前生产报告加载器导入 11 份树、9 张唯一 PNG，0 加载错误；附件大小、SHA-256 和完整 PNG 解码均通过。每份报告图片为 23,328,000 像素，低于 67,108,864 像素预算；三轮合计 69,984,000 像素，继续保持独立报告。App 日志另存并核对哈希与时序，不是报告内嵌附件。产品侧多轮合并报告的按需加载仍未实现。

## 保留的失败

| 实验 | 观察到的事实 | 结论 |
| --- | --- | --- |
| 原手势计划 | 6 次回执均为 `completed / sent`，但新截图、控件树和 App 日志均未观察到触摸或位移；滚动位置一直为 0，最终次数用尽 | 系统回执不等于 App 变化，原因未解决。没有继续调参或补发原请求 |
| 新 Helper 安装后的首次预检 | 内存配对被重置，读取返回 HTTP 401；计划未发送输入 | 恢复已有配对并通过能力预检后，另建会话进行三轮验证；该失败未计入成功样本 |

系统浮窗与导航区域解释了部分“进展未知”，但浮窗没有覆盖原手势的中心路径，不能据此断言它吞掉了触摸。阶段 A 的一次成功滑动属于另一个页面实例，也不能替代本次失败记录。

## 验证与边界

- 120 项相关测试通过，覆盖 16 个文件：协议、旧摘要兼容、计划、滚动进展、报告、HTTP 回执与 Java 输入校验。没有累加子代理重复运行的测试数量。
- 完整桌面构建通过，含类型检查。Helper、Debug 与 Release 示例 Android 构建通过；Helper 与 Debug 包已安装，无新增权限。
- JVM 反例覆盖“控件先改变位置再返回 false”，结果必须未知且不能重发。无回执的 HTTP 失败也能保留并导入失败报告。
- 三轮只是当前固定容器的功能证据，不是长期成功率、P95 或提速结论；失败的手势路径与成功的控件路径不能计算加速比例。
- 尚未验证虚拟列表、继续加载、多容器业务页和实际视频播放。下一步先做阶段 C，再基于相同成功流程做性能对照。

最终 Helper APK：934548 字节，SHA-256 `97c0a8ffb21ed37e3e9735ae7ce491d9a84299deb1002d1758383b51a0c3a7e4`。Debug 示例 APK：886262 字节，SHA-256 `70066d617db2d590e5b713691d187501dd0e4445c71775d3a487a753e51a2da0`。本轮会话均已结束，软件保持运行；代码尚未提交或推送。

## 本机复核入口

测量、重放和设备日志位于工作树 `/Users/zhaojiaxiang/.codex/worktrees/standard-capture-performance/开源项目2/.benchmarks/`，不随源码提交。

| 记录 | 相对路径或编号 |
| --- | --- |
| 成功三轮 | `stage-b-semantic-verified-1/`、`-2/`、`-3/` |
| 重放核对 | `stage-b-semantic-audit-1/summary.json`、`-2/summary.json`、`-3/summary.json` |
| App 原始日志 | `stage-b-semantic-touch-1.log`、`-2.log`、`-3.log`；按页面实例和时间区间区分历史事件 |
| 手势失败 | `stage-b-round-1/`、`stage-b-failed-fixture-touch.log`；会话 `348abdb9-7631-4316-91c7-729640a4a30b` |
| 配对预检失败 | `stage-b-semantic-round-1/`；会话 `d0f10a13-f240-4de0-8415-63521be6f75b` |
| 回归日志 | `stage-b-final-tests.log`；原目录 `.benchmarks/stage-b-semantic-build.log` |

| 轮次 | 会话 | 计划 runId |
| --- | --- | --- |
| 1 | `5338d8ea-8ffe-4c1d-9c9c-db5b7ebd8cc7` | `203d6be9-1392-4abb-9fe2-019ba1517448` |
| 2 | `7c5a3f03-ccc6-46d6-87fc-00868d98f36a` | `26714a13-44ad-4888-85a2-826d80d578f5` |
| 3 | `7ce74d17-4897-4317-bf21-0ad44a2e4c23` | `af816726-759f-43a3-ad5c-188b177c9054` |

原报告分别位于 `~/Library/Application Support/android-ui-inspector/mcp/runs/<会话>/report.json`。独立审计汇总位于 `/Users/zhaojiaxiang/.codex/worktrees/device-wait-android/开源项目2/.benchmarks/stage-b-audit/round-1.json`、`round-2.json`、`round-3.json` 和 `three-round-summary.json`；最后一份汇总 SHA-256 为 `93ea920d8806a86509229fe243d741219a3adf8855a1c81d222c41f91ce7314b`。

主要代码：[共享契约](../shared/debug-step-input.ts)、[滚动执行](../electron/automation/debug-scroll-execution.ts)、[输入适配](../electron/automation/helper-input.ts)、[手机输入](../scripts/helper-templates/InspectorInput.java)、[手机观察](../scripts/helper-templates/InspectorObservation.java)、[报告校验](../shared/debug-scroll-validation.ts)。
