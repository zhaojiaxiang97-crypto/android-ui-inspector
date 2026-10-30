# 自动操作与 Helper 文档导航

内容状态：2026-10-28。本页把日常操作入口和 D1–D24 的逐轮调查分开。阶段 A–C、D1–D24 的历史报告在[`archive/automation/`](archive/automation/README.md)，保留原文件名和失败证据；后续 A0–A2 开源参考调查集中在[执行记录](OPEN_SOURCE_REFACTOR_EXECUTION.md)。历史数据仅对应当时的源码、设备与样本；当前优先级见[下一步计划](AUTOMATION_NEXT_STEPS.md)。

## 先看当前状态

- **2026-10-28 P03已保存明确FIFO错误**：[P03记录](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/target-batch-capability-P03-20261028/RESULTS.md)。逐命令stdout/stderr、退出码和耗时留证已补齐；两处45项测试、真实Node14项及类型/隔离构建通过。目录和普通文件创建通过，第一个FIFO创建返回Permission denied、退出1，立即停止；18条命令含4条恢复完整归档，目录已清理，未进入取消/断连或性能采样。更底层策略来源未验证；下一步先离线移除FIFO依赖，旧失败和5%保持。

- **2026-10-28 P02正常协议通过后停止**：[P02记录](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/target-batch-android-protocol-P02-20261028/RESULTS.md)。主页面及竖屏条件通过，正常协议1/1、整次协议调用226.713ms；随后目录/FIFO准备命令失败，取消/断连未发送，完整边界计时0/4。远端错误正文漏存，具体子命令原因尚未知；已确认所有权清理并恢复原方向设置。下一步先补命令留证和能力诊断，旧失败及5%保持。

- **2026-10-28 P01环境预检失败后停止**：[P01记录](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/target-batch-android-protocol-20261028/RESULTS.md)。自有App安装包一致，但实际屏幕2400×1080、rotation=3，不符冻结竖屏条件；协议/取消/断连和计时均未开始。实际前台仍为子测试页，下一批须先核对方向和组件，再另立编号。未重连、重装或改设置，没有补跑；原校验、5%和旧失败保持。

- **2026-10-28受控执行器离线通过**：[执行器与故障验证](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/target-batch-executor-offline-20261028/RESULTS.md)。已补接收流上限、父期限、进程/管道关闭确认及独立失败归档；151项相关测试、原目录48项子集、真实Node运行24项和两处类型/隔离构建通过。源码已同步，生产未接入，设备端清理和真实耗时尚未验证；原校验、5%门槛及Q01失败保持。

- **2026-10-27窗口边界传输候选离线通过**：[候选与故障验证](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/target-boundary-batch-offline-20261027/RESULTS.md)。只合并activity/run-as，正常ADB调用4→3，原查询与焦点/屏幕顺序保持；98项相关测试、类型和隔离构建通过。生产未接入、手机未采新样本，真实封装及清理成本待独立小范围核对。

- **2026-10-27 Q01离线拆分完成**：[六个既有正式帧的分析](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/capture-control-q01-analysis-20261027/RESULTS.md)。整帧中位帧换了角色，前后目标检查承担主要差值；相同角色波动方向不一致，双帧间隔基本一致。未采新样本，原失败及5%门槛不变；下一步先设计保留原系统证据的窗口查询传输候选。

- **2026-10-27新Q01稳定性失败后停止**：[本轮结果](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/capture-control-qualification-20261027/RESULTS.md)。Q1预热及正式共18/18首次完整；小页正式整帧漂移−5.731%，超出原±5%，树漂移+2.146%通过。未启动大页正式验证、Q2或矩阵，不补跑；六项恢复和原设置恢复通过，旧记录保持。下一步先分析已有帧，见[计划](AUTOMATION_NEXT_STEPS.md)。

- **2026-10-27隔离入口接线验收**：[独立接线结果](/Users/zhaojiaxiang/.codex/worktrees/navigation-observation-audit/开源项目2/.benchmarks/capture-control-wiring-20261027/RESULTS.md)。已修复真实Electron启动识别，大小页6/6首次完整、六项取消恢复通过；原生记录保持取消，接线数据不并入Q01。

- **当前性能主线**：[完整任务观察成本账单](AUTOMATION_OBSERVATION_COST_LEDGER.md)，逐次用途、并行区间、服务端/设备成本及否决候选；对应离线分析工具已增加 observationLedger。

- **已具备的链路**：桌面操作计划执行、Helper 受控单次输入、条件等待、回读和证据归档已有实现；阶段 A 输入、阶段 B 固定列表、阶段 C 固定收藏流程分别完成其限定场景的验收。详见[计划执行器](AUTOMATION_PLAN_EXECUTOR.md)、[设备回测](archive/automation/AUTOMATION_PLAN_DEVICE_VALIDATION.md)和[阶段 C](archive/automation/AUTOMATION_BUSINESS_STAGE_C.md)。
- **性能目标仍未达成**：D12 的同条件八轮对照中，完整业务墙钟中位数下降 5.83%，低于原定的 20% 目标；不能用某一阶段的局部收益替代完整业务结论。详见[D12 对照](archive/automation/AUTOMATION_BUSINESS_PERFORMANCE_D12.md)。
- **A2 最新诊断**：2026-10-21 自有 758 节点页面只读预检 8/8 超时，后七轮 `getChild` 累计中位 801ms；308 节点 4/4 完成，均 `not_sent`。诊断包已恢复为原版，未修改生产扫描或输入门卫。详见[A2 实测](OPEN_SOURCE_REFACTOR_EXECUTION.md#a2-timing-20261021)。**D24 业务三轮仍未开展（0/3）**，旧 HTTP 401 是[D24 当时的失败](archive/automation/AUTOMATION_BUSINESS_REGRESSION_D24.md)。
- **操作边界**：默认协作式读取保持关闭；维持 1 秒发送前期限、目标完整唯一性与失败停机。未证实的优化候选和已撤回方案不因历史记录而重新启用。

## 按任务查文档

| 目标 | 当前入口 |
| --- | --- |
| 看下一步阻塞、优先级和保留缺口 | [自动操作下一步计划](AUTOMATION_NEXT_STEPS.md) |
| 区分capture/wait角色、顺序和getChild追踪需求（工装、独立入口及恢复已离线验证，未真机采样） | [角色与顺序对照方案](AUTOMATION_CAPTURE_WAIT_CONTROL_PLAN.md)、[入口及恢复清单](AUTOMATION_CAPTURE_CONTROL_DRIVER.md) |
| 查最新大树超时阶段计时和下一轮实验边界 | [A0–A2 执行记录](OPEN_SOURCE_REFACTOR_EXECUTION.md)、[开源参考计划](OPEN_SOURCE_REFACTOR_PLAN.md) |
| 了解执行器、请求与回执语义 | [计划执行器](AUTOMATION_PLAN_EXECUTOR.md)、[早期方案建议](archive/automation/AUTOMATION_PLAN_EXECUTOR_PROPOSAL.md) |
| 使用授权 CLI/MCP 的自动 UI 调试 | [CLI](CLI.md)、[MCP](MCP.md)、[真机计划验证](archive/automation/AUTOMATION_PLAN_DEVICE_VALIDATION.md) |
| 重跑限定场景并保留逐步证据 | [多轮 UI 回测](AUTOMATION_UI_REGRESSION.md)、[同机基准](archive/automation/AUTOMATION_DEVICE_BENCHMARK.md) |
| 看整体提速方向及已实施优化 | [性能实施脉络](archive/automation/AUTOMATION_PERFORMANCE_PLAN.md)、[阶段 D 进度](AUTOMATION_NEXT_STEPS.md) |
| 排查输入与导航 | [Helper 输入链路](HELPER_INPUT_TRANSPORT.md)、[跨页观察与恢复](HELPER_INPUT_TRANSPORT.md#helper-observation-recovery) |
| 查等待与只读断言 | [设备端条件等待](HELPER_INPUT_TRANSPORT.md#helper-condition-wait)、[条件等待对照](archive/automation/HELPER_CONDITION_WAIT_COMPARISON.md)、[部分可见判断](archive/automation/AUTOMATION_PARTIAL_VISIBILITY.md) |
| 查取图或读取瓶颈 | [采集耗时](archive/automation/AUTOMATION_TIMING_PROFILE.md)、[内部阶段耗时](archive/automation/AUTOMATION_TIMING_DETAIL.md)、[边界检查并行](archive/automation/HELPER_BOUNDARY_PARALLEL.md) |

## 功能闭环与真实场景

| 阶段或专项 | 文档与验证边界 |
| --- | --- |
| A：输入闭环 | [输入阶段 A](archive/automation/HELPER_INPUT_STAGE_A.md)：新夹具控件点击、跨页、返回与取消 |
| B：固定列表 | [滚动阶段 B](archive/automation/HELPER_SCROLL_STAGE_B.md)：固定列表末项与滚动证据；原手势无位移问题另行保留 |
| C：固定收藏流程 | [业务阶段 C](archive/automation/AUTOMATION_BUSINESS_STAGE_C.md)：固定真实业务场景，不推广至任意动态列表 |
| 收藏页脚与恢复 | [末端露出及恢复](archive/automation/AUTOMATION_FOOTER_RECOVERY.md)：页脚可见性、证据完整性和同请求只读恢复 |

## 性能、可靠性和回归时间线

本节是**研究与实验记录**，并非按编号排列的待办清单。带有“未采用”“撤回”或“未复现”的结论仍应保留，避免重复试错。

| 批次 | 记录 | 结论范围 |
| --- | --- | --- |
| D1 | [采集耗时剖析](archive/automation/AUTOMATION_TIMING_PROFILE.md) | 计时与产品耗时基线 |
| D2 | [采集内部耗时](archive/automation/AUTOMATION_TIMING_DETAIL.md) | 请求、节点读取、编码成本拆解 |
| D3 | [大截图 JSON 优化](archive/automation/HELPER_JSON_SERIALIZATION.md) | 编码路径及同值校验，非完整业务收益 |
| D4 | [节点读取与预取对照](archive/automation/HELPER_NODE_PREFETCH.md) | 固定树实验与未采用原因 |
| D5 | [前台检查并行](archive/automation/HELPER_TARGET_PARALLEL.md) | 已授权前台检查的局部收益 |
| D6 | [完整业务前后对照](archive/automation/AUTOMATION_BUSINESS_PERFORMANCE_D6.md) | 完整流程性能对照与失败证据 |
| D7 | [长会话可靠性](archive/automation/AUTOMATION_RELIABILITY_D7.md) | 归档与新双帧路径变化修正 |
| D8 | [端口与 PNG 性能调查](archive/automation/AUTOMATION_PERFORMANCE_D8.md) | PNG 候选未达采纳门槛 |
| D9 | [后验并行](archive/automation/AUTOMATION_POST_RESPONSE_D9.md) | 后处理并行实现与限定验证 |
| D10 | [业务对照](archive/automation/AUTOMATION_BUSINESS_PERFORMANCE_D10.md) | D9 后的完整收藏八轮交叉对照 |
| D11 | [检查点优化](archive/automation/AUTOMATION_CHECKPOINT_D11.md) | 重复采集减少，完成局部及长会话验证 |
| D12 | [业务对照](archive/automation/AUTOMATION_BUSINESS_PERFORMANCE_D12.md) | 八轮墙钟中位数下降 5.83%，20% 目标未达 |
| D13 | [导航恢复调查](archive/automation/AUTOMATION_NAVIGATION_RECOVERY_D13.md) | 候选未过真机门槛，未整合 |
| D14 | [失败观察编码候选](archive/automation/AUTOMATION_REJECTED_ENCODING_D14.md)、[窗口就绪探针](archive/automation/AUTOMATION_WINDOW_READY_D14.md) | 编码候选未合入；就绪探针不改变默认恢复路径 |
| D15 | [同页只读耗时](archive/automation/AUTOMATION_READONLY_PROFILE_D15.md) | 6 次诊断采样，未改生产路径 |
| D16 | [取消后占锁](archive/automation/AUTOMATION_CANCELLATION_D16.md) | 本地与 ART 复现，保留取消风险 |
| D17 | [协作式读取退出](archive/automation/AUTOMATION_COOPERATIVE_READ_D17.md) | 可选协议与真机只读验证，默认关闭 |
| D18 | [执行器预算](archive/automation/AUTOMATION_EXECUTOR_BUDGET_D18.md) | 剩余预算与连续计划阻塞 |
| D19 | [读取容量](archive/automation/AUTOMATION_READ_CAPACITY_D19.md) | 容量修复及拒绝诊断 |
| D20 | [导航动画恢复](archive/automation/AUTOMATION_PIXEL_MOTION_D20.md) | 宽度变化和系统空档的有限恢复 |
| D21 | [同版本 A/B 速度对照](archive/automation/AUTOMATION_CONTROLLED_AB_D21.md) | 无明显稳定收益，协作协议保持默认关闭 |
| D22 | [前台失败诊断](archive/automation/AUTOMATION_FOREGROUND_DIAGNOSTICS_D22.md) | 失败原因分类，保持停止边界 |
| D23 | [返回后空档复现](archive/automation/AUTOMATION_FOREGROUND_REPRO_D23.md) | 有界调查未复现历史故障 |
| D24 | [完整业务回归与缓存诊断](archive/automation/AUTOMATION_BUSINESS_REGRESSION_D24.md) | 2026-10-18 阶段结论；正式 0/3，之后在 A0–A2 有新增只读证据 |

## 阅读和维护约定

先从[项目状态](PROJECT_STATUS.md)、[当前验收](CORE_ACCEPTANCE.md)判断已有能力，再查本页的专项证据。源码验证、隔离工作树、本机安装包和手机实测分别成立；同名“当前”只代表文档标注的日期。阶段性失败、已撤回候选与受限证据保留在原报告，更新结论时同时维护[下一步计划](AUTOMATION_NEXT_STEPS.md)及本页的状态摘要。

更早的 UI、SDK、架构与验收沿革见[历史归档](archive/README.md)。
