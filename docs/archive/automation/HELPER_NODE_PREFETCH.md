# 控件节点读取对照（D4）

更新：2026-10-17。固定页面对照已完成。**本轮候选不合入生产：局部节点读取有改善，但完整采集收益不稳定，五种场景中三种更慢。已恢复 D3 Helper，原预取策略保持不变。**

## 已确认的原因与限制

[D3 完整流程](HELPER_JSON_SERIALIZATION.md)中，节点访问累计 12.994 秒，本节点处理 3.974 秒。保留的 19 棵树有 292–530 个节点、最大深度 21–30、每个父节点最多 11–15 个直接子节点。它们是保留快照，不能代表全部观察，也不能从耗时直接推算 IPC 次数。

当前 API 33+ 子节点已采用 `DEPTH_FIRST | UNINTERRUPTIBLE`（40），每次观察先清缓存，逐个访问完整树。Android 14 源码提供了几个必要约束：

- 根节点 `getRoot(flags)` 使用 `bypassCache=true`，客户端因此去掉预取标志。把根节点的 8 改为 40 不会按预期增加预取。[WindowInfo](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/core/java/android/view/accessibility/AccessibilityWindowInfo.java#240)、[InteractionClient](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/core/java/android/view/accessibility/AccessibilityInteractionClient.java#638)
- 子节点命中缓存时直接返回；不可中断预取在返回前将批次放入缓存，单批最多 50 个节点。滚动窗口会暂时关闭预取，不能据一次慢读取认定 Helper 漏配。[请求与缓存](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/core/java/android/view/accessibility/AccessibilityInteractionClient.java#604)
- 增加 `SIBLINGS` 会先构造父节点并从第一个兄弟开始扫描，再用剩余额度读取后代。重复兄弟访问和昂贵的虚拟节点提供器可能使它更慢。[预取顺序](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/core/java/android/view/AccessibilityInteractionController.java#1459)
- `isNodeInCache` 是公开接口，但在 `getChild` 返回后读到 true 不代表刚才命中：一次缓存未命中的查询也可能刚把结果放入缓存。[接口说明](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#isNodeInCache(android.view.accessibility.AccessibilityNodeInfo))

这是固定 Android 14 参考实现的行为，不代替厂商 ROM 的实际对照。

## 有限候选

仅快照完整遍历中的 SDK33+ 分支，在 `i > 0` 且父节点有 2–16 个直接子节点时增加兄弟预取（42），其余保持 40。输入定位、短时等待、根节点读取、低版本调用、清缓存、完整性与窗口复核均不改。选择方式在查询前决定，失败后不切换策略补读。

阈值用于限制实验范围，不是已证明的最佳参数。理想静态树模型只用于排除明显不合适的方案；它不覆盖厂商缓存失效、滚动和动态节点提供器，不作速度结论。

## 实验方法

使用自有 Debug 测试页，分别覆盖深窄树、超过 50 个直接子节点的宽树、虚拟节点提供器，以及 epoch 改变。固定页没有计数动画；只读采集期间树字段保持不变。

| shape | 夹具节点 | 最大深度 | 最大直接子节点 | 提供方式 |
| --- | ---: | ---: | ---: | --- |
| deep300 | 300 | 23 | 15 | 真实 ViewGroup / TextView |
| deep530 | 530 | 29 | 15 | 真实 ViewGroup / TextView |
| real-wide80 | 81 | 1 | 80 | 真实 ViewGroup / TextView |
| virtual80 | 81 | 1 | 80 | AccessibilityNodeProvider |
| virtual300 | 300 | 23 | 15 | AccessibilityNodeProvider |

另有 8 个系统与页面包装节点。宽树是 80 个子节点加 1 个根节点，不能误写为总共 80 个。每个节点有固定资源 ID、父子关系和带 epoch 的描述，全部检查；计数仅输出本机日志，不更新界面。

复用现有 `helper-performance-benchmark.ts`，每块先采首样，再采 5 个正式样本；反转顺序对照，分开记录首样。每次仍走产品授权、来源检查、完整观察和原报告链，不增加采集接口或绕过校验。每块完成后立即导出其树和图片，再通过正式报告加载器核对。

要求：同块窗口、服务实例、显示几何不变；完整 XML 相同；每帧截图必须存在、完整解码且尺寸与几何一致。跨块除明确的窗口与 Activity 身份字段外，所有节点字段及子节点顺序均比较；记录树总耗时、节点访问、本节点处理、完整采集及主机耗时。额外构造节点次数不能直接称为 IPC 次数。

真实 ViewGroup 的无障碍子节点按空间顺序返回，不保证等于 addView 顺序，所以独立夹具验收比较每个父节点的完整子节点 ID 数组排序结果；虚拟 provider 仍按明确的 addChild 顺序检查。原始 XML 和整树摘要继续保留实际顺序，不重排采集结果。[Android 14 实现](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/core/java/android/view/ViewGroup.java#2453)

Helper 重启后，系统窗口枚举可能改变。本次原摘要发现最外层 `root.index` 与 `root.attributes.index` 为 3 → 1；逐字段审计确认它们等于前后授权窗口在系统数组的位置。额外的语义摘要仅在验证此绑定后把最外层这两个索引归一化为 0；原摘要保留。子节点 index 与顺序不变，窗口类型、层级、焦点、活动状态、边界、包名和显示信息仍须一致。

实验 APK 和原版均保留。候选只有在字段完整性通过且实际收益足够、没有明显场景退化时才考虑合入；否则恢复原版并保留失败或无收益记录。局部实验不替代[阶段 D](../../AUTOMATION_NEXT_STEPS.md)的完整业务前后各 10 轮验收。

## 结果

同一 Android 14 真机、同一测试 APK，执行 A1 → B1 → B2 → A2。A 为原版 40，B 为有界 42 候选；A1/B1 正序，B2/A2 反序。每块每场景 1 次首样、5 次正式样本：共 **120 次性能观察，20 次首样、100 次正式样本**。另有 12 次 epoch 变化验证，不混入性能。首样是块内第一次采集，不是独立冷启动。

所有有效样本经过正式报告加载器重新读取，校验完整树、唯一节点、父子关系、当前 epoch、PNG 解码与尺寸、服务/窗口绑定及前后显示信息。跨版本语义树一致。窗口数组位置差异按上文的窄范围规则单独验证，原始摘要没有覆盖。

下面是每种场景每版 10 次正式样本的中位数，单位毫秒；最后一列负值表示候选较快。

| 场景 | 节点访问 A → B | 整树 A → B | 产品采集步骤 A → B | 步骤变化 |
| --- | ---: | ---: | ---: | ---: |
| deep300 | 424.524 → 370.066 | 511.0 → 468.5 | 1457.760 → 1402.398 | −3.8% |
| deep530 | 637.563 → 665.086 | 773.5 → 804.5 | 1706.839 → 1777.421 | +4.1% |
| real-wide80 | 472.227 → 504.059 | 550.5 → 586.0 | 1445.455 → 1485.594 | +2.8% |
| virtual80 | 416.522 → 462.222 | 488.5 → 539.0 | 1364.318 → 1417.630 | +3.9% |
| virtual300 | 555.675 → 504.055 | 660.0 → 614.0 | 1600.423 → 1507.992 | −5.8% |

CLI 采集墙钟的中位数分别为 1589.465→1539.180、1833.625→1903.125、1570.940→1623.355、1503.200→1548.180、1727.320→1642.970 ms。deep300 正式样本墙钟最大值由 1651.480 上升至 1881.730 ms；首样墙钟中位数由 1827.075 上升至 2394.330 ms。其余首样和各块数值完整保留在本机汇总中，不混入正式样本。

样本 P95 按 nearest-rank 计算；每版 10 个正式样本时就是观察到的最大值，不能称稳定尾延迟。A/B/A 顺序能减少一部分时间偏差，但单次 ABBA、固定页面和小样本不能证明差异的因果，也不能据此估计长期成功率。

虚拟 provider 的日志提供了另一项约束：virtual80 六次观察均为 486 次 create 回调；virtual300 原版每块 1800 次，候选每块 1992 次，增加 10.7%，host 构造由 6 次变为 12 次；invalidCreates 均为 0。计数可能包含系统请求，只能说明本进程该区间的回调量，不能等同 Helper IPC 次数或缓存命中率。

因此只保留测试夹具、实验代码与记录，不移入候选的生产策略和专属回归改动。这也避免为单个场景的有限收益增加默认行为分支。本轮没有再次跑真实业务全流程，因为候选已未达到进入该阶段的条件；此前 D3 的业务记录保持原口径。

### 新鲜度、失败记录与工程检查

- 两版各 6 次 epoch 1 观察都读到全部 300 个当前 epoch 节点，截图完整。候选补测会话先真实读取 epoch 0，再切换到 1，前后证据均保留。 B2 的同形状参照是新短会话内紧邻的 virtual300-e0 预读；A2 紧邻前驱为 deep300-e0，同形状参照使用本块先前的 virtual300-e0，不能把 A2 写成连续同页刷新。独立复核确认同形状前后除预期 epoch 文本字段外，结构和几何一致。
- 首次独立审计把真实 ViewGroup 的添加顺序误当成无障碍返回顺序，原版即失败。修正的是夹具验收假设；实际节点顺序仍参与跨样本、跨版本比较，没有改变产品采集。
- 候选的首次额外 epoch 块与此前 60 次采样共用会话，达到报告 32 MiB 上限，6 帧中前 3 张截图被裁剪；该块验收失败，独立保留且排除。停止原会话后，用新短会话补测通过。没有扩大容量限制，也没有把“采集返回成功”当成“报告证据完整”。先前各性能块在容量到达前已经独立冻结并完整验证。
- 整合后的夹具与基准工具 **9 项／2 文件测试、类型检查、完整桌面构建和 Android Debug APK 离线构建通过**。JVM 夹具检查实际执行。候选自己的 21 项／10 文件测试与 APK 构建另行通过，但候选未合入，测试数量不与其他批次累加。
- 生产 Helper 已恢复 D3 APK，并核对设备安装摘要、原配对及能力接口。本轮授权已停止。桌面源码未改采集策略；保留原分支、暂存区和已有成果，没有提交或推送。

本机原始证据在主开发工作树 `.benchmarks/d4/`：四个性能块、两版新鲜度块、容量失败块、逐块原报告导出、`frozen-audit.json` 和 `comparison.json`。原始树与截图不写入公共文档。独立对照脚本位于审查工作树 `.benchmarks/d4-compare.ts`，逐块冻结及调度脚本位于主工作树 `.benchmarks/d4/`。

| 安装产物 | SHA-256 |
| --- | --- |
| 原版 D3 / 最终恢复版本 | `d4d5627546eb1ca37451a95845ab968fc1838b585d26d7e59f6b0df1ac1bd90b` |
| D4 实验候选 | `46504e018497b7557d2107fa6b1e15167595d7a1c3e3a0fe29d7d2a4f363fb69` |
| 固定测试页 APK | `7695742a0f3354222251789e622fe0dfecb9b0a7133fede4ded580c90e08dfc2` |

## 后续与复测入口

下一步优先检查主机同一校验边界内 target、display、forward 的重复子命令，先量化可消除的往返，再做受限批量读取对照。每项退出状态、动作前后重新核对、窗口切换、旋转、服务重启和取消仍必须保留；不缓存焦点、不跳过完整观察。

节点预取暂停继续调参。只有出现新机制证据，例如具体 provider 的批量成本或稳定的实际缓存失效原因，才重开此实验。完整业务前后各 10 轮及至少 20% 的提速目标仍未完成，不能用本轮局部结果替代。

- [固定测试页](../../../android/sdk-free-sample/src/debug/java/com/androiduiinspector/sdkfree/TraversalDiagnosticsActivity.java)、[有界树模型](../../../android/sdk-free-sample/src/debug/java/com/androiduiinspector/sdkfree/TraversalFixtureTree.java)、[夹具回归](../../../tests/traversal-diagnostics.test.ts)
- [既有公共采样工具](../../../scripts/helper-performance-benchmark.ts)、[正式报告读取](../../../electron/desktop/test-report.ts)、[离线计时汇总](../../../scripts/helper-timing-profile.ts)

测试页仅存在于 Debug 源集。启动 `.TraversalDiagnosticsActivity` 时提供表中的 `shape` 与有界整数 `epoch`；同一 epoch 保持静态，变更 epoch 才更换全部标记。`DUMP_TRAVERSAL_COUNTS` 只写日志，不重建页面。复测每个版本使用独立会话并逐块导出，避免将容量裁剪混入有效证据。
