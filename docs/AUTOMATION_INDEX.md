# 自动操作与 Helper 文档导航

更新：2026-10-18。本页把正在使用的操作入口、真机验收和 D1–D24 的逐轮调查分开。每份报告保留原文件名，历史数据只对应当时的源码、设备与样本；实施优先级以[下一步计划](AUTOMATION_NEXT_STEPS.md)为准。

## 先看当前状态

- **已具备的链路**：桌面操作计划执行、Helper 受控单次输入、条件等待、回读和证据归档已有实现；阶段 A 输入、阶段 B 固定列表、阶段 C 固定收藏流程分别完成其限定场景的验收。详见[计划执行器](AUTOMATION_PLAN_EXECUTOR.md)、[设备回测](AUTOMATION_PLAN_DEVICE_VALIDATION.md)和[阶段 C](AUTOMATION_BUSINESS_STAGE_C.md)。
- **性能目标仍未达成**：D12 的同条件八轮对照中，完整业务墙钟中位数下降 5.83%，低于原定的 20% 目标；不能用某一阶段的局部收益替代完整业务结论。详见[D12 对照](AUTOMATION_BUSINESS_PERFORMANCE_D12.md)。
- **D24 未完成正式回归**：正式收藏流程仍为 0/3。一次只读扫描在 1 秒期限内完成 427 次子读取，累计 794 ms；后续缓存诊断只完成本地验证，诊断包连接遇到 HTTP 401，未得到新增缓存采样。已恢复安装前 Helper，恢复后的配对连通性尚未验证。详见[D24 诊断](AUTOMATION_BUSINESS_REGRESSION_D24.md)。
- **操作边界**：默认协作式读取保持关闭；维持 1 秒发送前期限、目标完整唯一性与失败停机。未证实的优化候选和已撤回方案不因历史记录而重新启用。

## 按任务查文档

| 目标 | 当前入口 |
| --- | --- |
| 看下一步阻塞、优先级和保留缺口 | [自动操作下一步计划](AUTOMATION_NEXT_STEPS.md) |
| 了解执行器、请求与回执语义 | [计划执行器](AUTOMATION_PLAN_EXECUTOR.md)、[早期方案建议](AUTOMATION_PLAN_EXECUTOR_PROPOSAL.md) |
| 使用授权 CLI/MCP 的自动 UI 调试 | [CLI](CLI.md)、[MCP](MCP.md)、[真机计划验证](AUTOMATION_PLAN_DEVICE_VALIDATION.md) |
| 重跑限定场景并保留逐步证据 | [多轮 UI 回测](AUTOMATION_UI_REGRESSION.md)、[同机基准](AUTOMATION_DEVICE_BENCHMARK.md) |
| 看整体提速方向及已实施优化 | [性能实施脉络](AUTOMATION_PERFORMANCE_PLAN.md)、[阶段 D 进度](AUTOMATION_NEXT_STEPS.md) |
| 排查输入与导航 | [Helper 输入链路](HELPER_INPUT_TRANSPORT.md)、[跨页观察与恢复](HELPER_OBSERVATION_RECOVERY.md) |
| 查等待与只读断言 | [设备端条件等待](HELPER_CONDITION_WAIT.md)、[条件等待对照](HELPER_CONDITION_WAIT_COMPARISON.md)、[部分可见判断](AUTOMATION_PARTIAL_VISIBILITY.md) |
| 查取图或读取瓶颈 | [采集耗时](AUTOMATION_TIMING_PROFILE.md)、[内部阶段耗时](AUTOMATION_TIMING_DETAIL.md)、[边界检查并行](HELPER_BOUNDARY_PARALLEL.md) |

## 功能闭环与真实场景

| 阶段或专项 | 文档与验证边界 |
| --- | --- |
| A：输入闭环 | [输入阶段 A](HELPER_INPUT_STAGE_A.md)：新夹具控件点击、跨页、返回与取消 |
| B：固定列表 | [滚动阶段 B](HELPER_SCROLL_STAGE_B.md)：固定列表末项与滚动证据；原手势无位移问题另行保留 |
| C：固定收藏流程 | [业务阶段 C](AUTOMATION_BUSINESS_STAGE_C.md)：固定真实业务场景，不推广至任意动态列表 |
| 收藏页脚与恢复 | [末端露出及恢复](AUTOMATION_FOOTER_RECOVERY.md)：页脚可见性、证据完整性和同请求只读恢复 |

## 性能、可靠性和回归时间线

本节是**研究与实验记录**，并非按编号排列的待办清单。带有“未采用”“撤回”或“未复现”的结论仍应保留，避免重复试错。

| 批次 | 记录 | 结论范围 |
| --- | --- | --- |
| D1 | [采集耗时剖析](AUTOMATION_TIMING_PROFILE.md) | 计时与产品耗时基线 |
| D2 | [采集内部耗时](AUTOMATION_TIMING_DETAIL.md) | 请求、节点读取、编码成本拆解 |
| D3 | [大截图 JSON 优化](HELPER_JSON_SERIALIZATION.md) | 编码路径及同值校验，非完整业务收益 |
| D4 | [节点读取与预取对照](HELPER_NODE_PREFETCH.md) | 固定树实验与未采用原因 |
| D5 | [前台检查并行](HELPER_TARGET_PARALLEL.md) | 已授权前台检查的局部收益 |
| D6 | [完整业务前后对照](AUTOMATION_BUSINESS_PERFORMANCE_D6.md) | 完整流程性能对照与失败证据 |
| D7 | [长会话可靠性](AUTOMATION_RELIABILITY_D7.md) | 归档与新双帧路径变化修正 |
| D8 | [端口与 PNG 性能调查](AUTOMATION_PERFORMANCE_D8.md) | PNG 候选未达采纳门槛 |
| D9 | [后验并行](AUTOMATION_POST_RESPONSE_D9.md) | 后处理并行实现与限定验证 |
| D10 | [业务对照](AUTOMATION_BUSINESS_PERFORMANCE_D10.md) | D9 后的完整收藏八轮交叉对照 |
| D11 | [检查点优化](AUTOMATION_CHECKPOINT_D11.md) | 重复采集减少，完成局部及长会话验证 |
| D12 | [业务对照](AUTOMATION_BUSINESS_PERFORMANCE_D12.md) | 八轮墙钟中位数下降 5.83%，20% 目标未达 |
| D13 | [导航恢复调查](AUTOMATION_NAVIGATION_RECOVERY_D13.md) | 候选未过真机门槛，未整合 |
| D14 | [失败观察编码候选](AUTOMATION_REJECTED_ENCODING_D14.md)、[窗口就绪探针](AUTOMATION_WINDOW_READY_D14.md) | 编码候选未合入；就绪探针不改变默认恢复路径 |
| D15 | [同页只读耗时](AUTOMATION_READONLY_PROFILE_D15.md) | 6 次诊断采样，未改生产路径 |
| D16 | [取消后占锁](AUTOMATION_CANCELLATION_D16.md) | 本地与 ART 复现，保留取消风险 |
| D17 | [协作式读取退出](AUTOMATION_COOPERATIVE_READ_D17.md) | 可选协议与真机只读验证，默认关闭 |
| D18 | [执行器预算](AUTOMATION_EXECUTOR_BUDGET_D18.md) | 剩余预算与连续计划阻塞 |
| D19 | [读取容量](AUTOMATION_READ_CAPACITY_D19.md) | 容量修复及拒绝诊断 |
| D20 | [导航动画恢复](AUTOMATION_PIXEL_MOTION_D20.md) | 宽度变化和系统空档的有限恢复 |
| D21 | [同版本 A/B 速度对照](AUTOMATION_CONTROLLED_AB_D21.md) | 无明显稳定收益，协作协议保持默认关闭 |
| D22 | [前台失败诊断](AUTOMATION_FOREGROUND_DIAGNOSTICS_D22.md) | 失败原因分类，保持停止边界 |
| D23 | [返回后空档复现](AUTOMATION_FOREGROUND_REPRO_D23.md) | 有界调查未复现历史故障 |
| D24 | [完整业务回归与缓存诊断](AUTOMATION_BUSINESS_REGRESSION_D24.md) | 正式 0/3，新增缓存计数未取得真机回执 |

## 阅读和维护约定

先从[项目状态](PROJECT_STATUS.md)、[当前验收](CORE_ACCEPTANCE.md)判断已有能力，再查本页的专项证据。源码验证、隔离工作树、本机安装包和手机实测分别成立；同名“当前”只代表文档标注的日期。阶段性失败、已撤回候选与受限证据保留在原报告，更新结论时同时维护[下一步计划](AUTOMATION_NEXT_STEPS.md)及本页的状态摘要。

更早的 UI、SDK、架构与验收沿革见[历史归档](archive/README.md)。
