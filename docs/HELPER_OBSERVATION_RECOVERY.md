# Helper 跨页观察诊断与恢复

更新：2026-10-16。候选 APK 已安装并核对摘要，最新桌面完成单机回测：点击、返回各自动恢复一次，最终四次输入完成路径且无重放；另修复滚动窗口边界与大 PNG 校验。默认观察后端仍为 UIAutomator，证据见[真机回测](archive/automation/AUTOMATION_DEVICE_BENCHMARK.md#helper-recovery-device-retest)。

## 解决的问题

此前真机点击和返回各发送一次后，Helper 返回 `complete=false`，只能由调用方查询状态，再发起只读恢复。报告只显示 `capture_failed`，无法区分缺根、子节点暂不可读、窗口变化或其他异常。历史记录见[跨页回测](archive/automation/AUTOMATION_DEVICE_BENCHMARK.md#helper-cross-page-acceptance)。

现在保留具体失败原因，并将少数明确的短暂失败接入现有只读恢复入口。失败响应始终不能成为可操作快照，已发送的输入不会重放。

## 已实现的规则

| 部分 | 当前行为 |
| --- | --- |
| 设备端诊断 | 19 个固定原因码，逐项累加并封顶 10000；不返回异常详情、页面正文或令牌 |
| 主机接收 | 严格校验原因码、计数和字段；旧版成功观察兼容，旧版无诊断的失败不自动恢复 |
| 可恢复原因 | 仅 `child_unavailable`、`window_inventory_changed`，且全部原因均在该白名单内 |
| 恢复前提 | Helper 后端、已绑定原服务、已发送输入或显式只读恢复；完整且新鲜的失败元数据、授权应用焦点、合法窗口清单与同一屏幕 |
| 次数与时间 | 同一调试步骤最多增加 2 次读取；首次决定恢复起共用 15 秒截止时间，后续读取和确认等待不能重置；仍受更短的原请求超时、会话到期和取消限制 |
| 身份连续性 | 成功→失败→失败→成功均核对服务、采集 ID 和单调时序；失败不能用于回退到旧快照 |
| 结果确认 | 两份确认之间若读取失败，恢复后重新取得连续两份有效观察；不能把失败解释为控件消失或已到底 |
| 滚动范围 | 失败前后焦点都必须仍是原滚动窗口；中途明确换窗即停止，不能等窗口回来后继续手势 |
| 报告与返回值 | `error.code` 保留 Helper 子码；`helperDiagnostics` 保留固定原因及计数；`observationFailures` 记录最多 3 次失败及是否继续读取，成功恢复也保留记录 |

缺根、未知窗口、窗口/节点读取异常、截断、屏幕变化、身份变化及证据不全均停止。当前没有把所有 `complete=false` 视为暂态。自动输入结果为 `unknown` 时不继续自动恢复；用户显式调用 `resume-step` 仍只读，并保留 `unknown`，不据此改写发送回执。

诊断元数据只用于决定能否再次读取，不包含可操作树或图片；报告不保存失败响应中的原始 XML、PNG 和异常文本。超时或取消保留自己的错误类别，同时附上最近一次可信诊断。历史报告没有这些可选字段仍可打开。

## 代码入口

- [设备端原因记录](../scripts/helper-templates/InspectorObservation.java)、[白名单契约](../shared/helper-observation-diagnostics.ts)。
- [失败元数据验证](../shared/helper-observation.ts)、[响应读取](../electron/capture/helper-observation.ts)、[会话与采集时序](../electron/capture/helper-session.ts)。
- [统一恢复执行器](../electron/automation/debug-step-executor.ts)、[共享预算](../electron/automation/debug-observation-recovery.ts)、[错误保留](../electron/automation/debug-step-context.ts)。
- [报告校验](../electron/desktop/debug-report.ts)、[报告恢复记录](../src/features/reports/DebugReportStepDetails.tsx)。

## 验证与交付范围

整合后 **192 项测试 / 22 文件通过**，类型检查及桌面完整构建通过。测试涵盖恢复不重复输入、步骤共享预算、超时取消、服务变化和采集重放、滚动换窗、重新双帧确认，以及成功/失败报告保存和导入。测试数按本轮计算，不与之前批次相加。

本轮 29 个代码、测试和文档文件已同步回原仓库，工作树与原仓库均完成桌面构建；原暂存区保持不变，133 个本地文档链接检查通过。

Android 测试在 JDK 17 下执行生产模板方法，覆盖全部 19 个原因；真实 SDK 36 Java 编译及完整离线 `assembleDebug` 均通过。固定来源准备的 17 个文件摘要匹配，3 个模板与整合后源码一致；没有跳过来源校验。

候选 APK 位于 `helper-completeness-diagnostics` 工作树的 `.benchmarks/recognition-helper/source-CP0cZj/app/build/outputs/apk/debug/app-debug.apk`；SHA-256 为 `fe24bf95e25fabc943b052b1977459569808ed9fd5817b5177c4db2e018fe00f`。签名校验通过，证书 SHA-256 为 `b580ff94ff43411974383522506383c5b74785709b04596ab821c2e30667527b`，与此前候选一致。

该 APK 已安装到本机 Android 14 手机，安装内容摘要与上述产物一致；最新桌面源码已重新构建并重启。此前同页采集减少 46.2% 的结果属于上一版，不能作为本轮跨页恢复的提速证据。

最新一轮点击 11.161 秒、返回 8.797 秒，各以一次白名单自动重读和双帧确认通过；上滚 7.576 秒，向下到底加同请求只读复查 10.227 秒，最终共四次输入。真实原因包括 `child_unavailable` 与 `window_inventory_changed`；首次跨页读取仍会失败，但已能自动恢复。最后底部断言遇系统导航区遮挡时正确停止，之后只读复查确认到底。三个测试会话均已停止授权。

回测修复窗口根识别和大 PNG 正则栈溢出，最终相关 96 项 / 10 文件通过，类型检查与完整桌面构建通过。完整耗时、中间失败、输入数及局限见[回测记录](archive/automation/AUTOMATION_DEVICE_BENCHMARK.md#helper-recovery-device-retest)。下一步补多次统计、多机型、旋转、服务变化与异常窗口，再做同条件 UIAutomator 对照；不据单次结果切换默认后端。
