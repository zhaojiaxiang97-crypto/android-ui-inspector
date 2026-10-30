# 自动调试历史记录

归档整理于 2026-10-21。本目录保留阶段 A–C、D1–D24 的逐轮性能和可靠性实验，以及早期方案和真机回测；原文件名、正文、失败记录和小节锚点均保留。目录迁移不代表这些候选已重新启用或验收通过。

日常使用和当前决策请先查看[自动调试专题索引](../../AUTOMATION_INDEX.md)、[下一步计划](../../AUTOMATION_NEXT_STEPS.md)及[A0–A2 最新执行记录](../../OPEN_SOURCE_REFACTOR_EXECUTION.md)。[D24 记录](AUTOMATION_BUSINESS_REGRESSION_D24.md)保留其 10 月 18 日的失败基线，专题索引列出了 D1–D24 各轮入口。

## 按问题查找

| 需要查什么 | 历史记录 |
| --- | --- |
| 计划执行、早期设计和真机验收 | [方案建议](AUTOMATION_PLAN_EXECUTOR_PROPOSAL.md)、[真机计划验证](AUTOMATION_PLAN_DEVICE_VALIDATION.md) |
| 首次输入、列表滚动、固定业务流程 | [阶段 A](HELPER_INPUT_STAGE_A.md)、[阶段 B](HELPER_SCROLL_STAGE_B.md)、[阶段 C](AUTOMATION_BUSINESS_STAGE_C.md) |
| 收藏末端和可见性判定 | [末端露出与恢复](AUTOMATION_FOOTER_RECOVERY.md)、[部分可见断言](AUTOMATION_PARTIAL_VISIBILITY.md) |
| P0–P4 提速实施沿革、真机对照 | [性能计划](AUTOMATION_PERFORMANCE_PLAN.md)、[同机基准](AUTOMATION_DEVICE_BENCHMARK.md) |
| D1–D12 的耗时、并行与检查点 | [D1](AUTOMATION_TIMING_PROFILE.md)、[D2](AUTOMATION_TIMING_DETAIL.md)、[D12](AUTOMATION_BUSINESS_PERFORMANCE_D12.md)；其余轮次见[专题索引](../../AUTOMATION_INDEX.md#性能可靠性和回归时间线) |
| D13–D23 的恢复、取消、容量与失败 | [D16](AUTOMATION_CANCELLATION_D16.md)、[D19](AUTOMATION_READ_CAPACITY_D19.md)、[D23](AUTOMATION_FOREGROUND_REPRO_D23.md)；其余轮次见[专题索引](../../AUTOMATION_INDEX.md#性能可靠性和回归时间线) |

## 阅读约定

记录中的“当前”“下一步”“已安装”仅对应记录当时的源码、设备和日期。实验失败、撤回的优化和受限回执仍需保留，不能把不同批次的数字拼成新的稳定性能结论。测试代码、APK 和设备证据仍按原记录定位；本轮仅调整文档目录和相对链接。
