# 历史与专项参考

架构记录区分两轮：2026-10-08 的六批结构整理保留在本目录；2026-10-14 至 15 日的 R0–R8 已完成，最新状态以[收尾总表](../ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)为准。

更新：2026-10-11。这里保留已完成方案、逐轮结果与失败反例，不作为当前待办或授权来源。UI及手机复核已暂停；当前安排看[计划](../LOOKIN_ALIGNMENT_PLAN.md#下一步)，能力看[状态](../PROJECT_STATUS.md)，门禁看[测试计划](../TEST_PLAN.md)。

| 记录 | 内容 |
| --- | --- |
| [暂停的自动化计划](LOOKIN_AUTOMATION_PLAN_2026-10-10.md) | UI方向切换前的A–E步骤、取消/恢复、确定性用例、模型与权限条件；不自动恢复执行 |
| [验收沿革](CORE_ACCEPTANCE_2026-10-09.md) | 各候选、本地/安装/手机验收及旧失败；已合入U1–U6c独有结果、权限说明和本机证据 |
| [专项测试参考](TEST_PLAN_2026-10-09.md) | 整理前完整测试契约、探针参数/预算、故障边界及历史结果 |
| [图层与界面设计沿革](LAYER_UI_HISTORY.md) | 原7份方案合并：Debug树、3D视觉/全量、折叠合成、空白层、ImageView选中和UI精简 |
| [结构重构记录](ARCHITECTURE_REFACTOR.md) | 2026-10-08 已完成的六批旧重构；本次 R0–R8 见[完成记录](../ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)，当前代码入口见[开发目录](../DEVELOPMENT_STRUCTURE.md) |
| [采集稳定性记录](INSPECTION_RELIABILITY.md) | View/Qt/Surface取图和提速的历史实现/限制 |
| [冷启动失败复核](STARTUP_FAILURE_REVIEW.md) | 排队、启动观察、只读日志及尚未证实的根因；专项暂停 |
| [阶段证据](PHASE_EVIDENCE_2026-10-05.md) | 早期SDK、像素/性能试验、采用项与反例 |
| [2026-10-04 Lookin对照](LOOKIN_ALIGNMENT_HISTORY_2026-10-04.md) | 原阶段目标、上游源码依据和历史推进顺序 |

历史文本中的“当前/下一步/已安装”只对应其原日期和候选，不覆盖当前状态。整理仅搬移/合并原文并修正相对链接；没有重新运行其中命令、研究上游、发布真实数据或删除测试报告。

本轮部分已结束试验的旧app副本经逐文件校验后改为同目录ZIP，例如`previous-permission-final.app.zip`；原验收记录中的`.app`指当时形态，恢复时先解压。源码、配置、报告与失败日志继续保留，最终候选及U6b原回退包保留展开副本。

重复的状态/计划过程叙述已从当前文档移除；整理前原文分别备份在本机 `.benchmarks/document-cleanup-20261009-38H9Gw/` 和 `.benchmarks/maintenance/cleanup-20261011-ilwnef0w/source-before/`。设计资产仍保留，不冒充真实运行截图。
