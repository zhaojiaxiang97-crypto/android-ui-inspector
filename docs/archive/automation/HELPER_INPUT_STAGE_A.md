# Helper 输入闭环验收（阶段 A）

更新：2026-10-17。状态：阶段 A 输入与计划功能验收通过；合并报告的图片导入存在下述总量限制。范围：独立 Debug 测试应用 `com.androiduiinspector.sdkfree`，手机 Android 14，1080 × 2400、旋转 0。业务 App 未参与本轮测试。

## 本轮改动

- 新增独立 `InputDiagnosticsActivity` 与真实子 Activity。按钮点击、页面进入、触摸 DOWN/UP/CANCEL、滚动位置分别计数；提供无资源 ID 按钮和固定 24 项列表。
- 诊断信息使用固定高度，手势过程中不更新统计布局；触摸事件原样交给系统处理。日志保留时间、实例、坐标、处理结果，内存记录最多 128 条。
- 保留旧 `DelayedConditionActivity` 与旧资源 ID；新页面仅存在于 Debug 构建。
- 复用既有桌面计划执行器，没有增加手机脚本解释器。计划示例：[helper-input-navigation.plan.json](../../../scripts/fixtures/helper-input-navigation.plan.json)。

`source/toolType0/flags` 来自触摸事件；`displayIdSource=activity` 明确显示屏编号来自 Activity，不能冒充隐藏的事件字段。输入类别不能单独证明是人工还是注入。

## 先发现的问题

第一轮计划完成“开始等待”和“等待就绪”，随后点击进入子页。Helper 返回 `accessibility-click / completed / sent`，但动作后的第一次采集撞上窗口切换，诊断为 `window_inventory_changed + focus_invalid`，计划在第 3 步停止。

随后只读采集确认子页已打开、入口序号为 1、同一 Helper 服务未变化。第 4 步返回保持 pending，没有发送。原失败记录保留，不能把这轮计作成功或通过重复点击覆盖。

补采原始元数据后，另一次返回失败明确为：`focus_invalid`，原始包名/窗口 ID 均为空，前后只有三个系统窗口，没有应用窗口、焦点或活动窗口；服务、屏幕和时间信息正常。这是 Activity 交接的短暂空档。初次只处理“两码且起始有焦点”的修正未覆盖它，相关失败也保留。

补齐系统窗口空档后，进入子页已通过；返回又捕获到另一种拒绝帧：同一授权应用窗口在入场动画中横向移动，`x` 从 -261 变为 -97，其余窗口身份、焦点和尺寸不变，诊断仅为 `window_inventory_changed`。这一轮仍记失败，未重复发送返回。

最终修正将“失败帧可用于判断是否再读”与“完整页面可用于操作”分开：

- 只在已经确认发送的 tap/back 之后，接受经过校验的应用交接空档或同一授权焦点窗口的横向动画作为重读依据。
- 空包名和空窗口 ID 保持原值，不推断、不补写；横移动画只允许 x 变化，尺寸、纵向位置及其他窗口不变，且仍与屏幕相交。
- 沿用原有最多 2 次额外读取、15 秒恢复上限及步骤截止时间。每次都检查既有授权 App、服务、屏幕和采集新鲜度；最终仍需两份新的完整观察。
- 动作前、独立等待、验证阶段、滑动、未知输入不获得新增恢复。其他 App、输入法、服务变化或屏幕变化仍停止。任何路径都不重复发送原动作。

诊断采样只读取既有 HTTP 响应的窗口元数据副本，不增加手机请求，不保存请求头、令牌、控件树或图片。

## 最终版本：三轮导航闭环通过

每轮执行相同流程：点击开始、等待就绪、进入真实子 Activity、系统返回主页面。每轮使用精确的前后计数条件，避免旧状态误判成功。

| 轮次 | 点击 | 等待 | 进入子页 | 系统返回 | 计划总耗时 | 点击 / 导航计数 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4.551 s | 2.532 s | 5.481 s | 4.821 s | 22.674 s | 0 → 1 / 0 → 1 |
| 2 | 4.390 s | 2.657 s | 4.838 s | 4.890 s | 22.161 s | 1 → 2 / 1 → 2 |
| 3 | 4.360 s | 2.630 s | 5.446 s | 3.934 s | 21.591 s | 2 → 3 / 2 → 3 |

总耗时包含起点与终点条件采集，不等于四步耗时之和。每轮恰好两个 `accessibility-click` 和一个 `global-back`，三轮共 9 次输入，全部为 `completed / sent`。

第 1 轮返回、第 2 轮进入与返回确实碰到拒绝帧，分别记录窗口横移、系统窗口空档和窗口横移；均在一次额外读取后恢复，最终通过完整新观察验证。它们没有被删去或改记为有效截图。三轮样本不是长期成功率或性能收益证明。

## 坐标输入：取得 App 实际事件证据

| 独立样本 | 系统回执 | App 实际结果 |
| --- | --- | --- |
| 无 ID 按钮点击 | `gesture / completed / sent` | 坐标 `(540,622)` 的 DOWN/UP；坐标按钮计数 0 → 1，DOWN/UP 各 0 → 1，CANCEL 为 0 |
| 固定列表向下滚动 | `gesture / completed / sent` | 触摸从 `(540,2102)` 到 `(540,1415)`、350 ms；DOWN/UP 各 1 → 2，scrollY 0 → 1551，滚动标记可见 |

上表为生产修正前的独立取证样本。最终版本在三轮导航后又各验证一次：坐标点击仍为 0 → 1；滑动后 scrollY 为 1551、DOWN/UP 各累计 2 次、CANCEL 为 0，点击与导航计数保持 3。两次动作均经连续两份新观察确认。滑动包含惯性，所以最终滚动距离不要求等于手指位移；122～123 次滚动变化是位置回调次数，不是输入次数。

初次坐标点击整步耗时 4.219 秒，滑动 6.489 秒；对应系统回执区间仅 113 / 404 ms。最终版本为 4.137 / 6.476 秒。App 的 UP 和点击回调还略晚于系统完成回执，因此仍须观察页面确认。本轮不是提速对照实验。

两个版本各发送一次点击和一次滑动，没有换通道补发或调整参数。该结果证明这台设备在此夹具上接收到真实触摸；不代表所有业务页面可靠，也没有解释掉之前“手势完成但按钮计数不变”的历史失败。两次滑动均未到列表末项，不能据此宣称“滚动到底”已通过。

## 取消与去重

取消样本在 `wait_before_cancel` 正在等待时发出取消。计划结束为 `cancelled`，后续 `must_not_click` 保持 pending、无产品步骤编号，报告无新增输入，点击、导航与坐标点击计数不变。

最终版本同样通过取消检查：输入数保持 11（导航 9 次、手势 2 次），点击 / 导航 / 坐标点击计数保持 3 / 3 / 1。没有执行本应把点击计数变为 4 的后续步骤。

三轮导航分别重放相同 runId 和相同计划，返回原结果；前后输入步骤编号、点击和导航计数均不变，新增输入为 0。

## 构建与校验

- Debug/Release 离线构建通过，调试包签名与已安装版本相同。
- 最终 Debug APK SHA256：`5dda88ac31626c8287ed6ddf69a225e0ab8f0f6f6a4d42fede6f1c8db81312b1`。
- Release 不包含两个新 Activity、21 个资源 ID或新增权限，APK 与改动前逐字节相同：`fe1495eb2db65f4e02a9ae935763efbefba3c536294565811314a7c829152526`。
- 夹具离线行为检查覆盖独立计数、延时重置、系统触摸返回值/异常、固定布局槽位、导航保留证据与日志上限。
- 最终生产修正后，观察诊断、会话、恢复、输入与计划共 6 个测试文件 **111 项通过、0 失败**；桌面类型检查及完整构建通过。
- 初次手势与取消会话通过产品 `loadDebugReport` 重新加载：12 份树、10 张独立 PNG，附件与身份校验错误为 0。

最终三轮合并会话包含 41 个产品步骤。产品报告导入时，51 份树全部加载且身份校验通过；37 张 PNG 中加载 25 张，另 12 张因累计 64 Mi 像素预算返回 `screenshot-unavailable`。这不是身份不匹配，但也不能记成“整份报告零错误导入”。

另外对原始 PNG 逐张核对文件长度、SHA256、签名和完整解码，**37 / 37 通过，0 损坏、0 摘要错误**。图片合计 95,904,000 像素，超过 67,108,864 的单次报告导入预算。原始报告和图片未修改，本轮不扩大预算。最终报告 SHA256：`d17ee7df56c98523aab0e59de47cae365f874f684b6bc41957e3d23c933380e3`。

## 本机复核入口

原始结果位于 `/Users/zhaojiaxiang/.codex/worktrees/standard-capture-performance/开源项目2/.benchmarks/`，下表路径均相对于该工作树。报告位于本机 Application Support 的 `android-ui-inspector/mcp/runs/`，不提交私人运行记录。

| 记录 | 路径或编号 |
| --- | --- |
| 首轮失败计划 | `.benchmarks/stage-a-navigation-1/`；run `aafe8257-92d2-470b-b8ac-9f933bd38ca6` |
| 初次修正后的失败 | `.benchmarks/stage-a-navigation-fixed-1/`；run `d7a7c72a-236f-4a61-98a5-e56a3244d1cc` |
| 窗口空档取证 | `.benchmarks/stage-a-navigation-trace/`、`.benchmarks/stage-a-window-trace.jsonl`；run `6d6fba0b-a1eb-43a1-b50b-042b975fe6a1` |
| 返回窗口横移动画 | `.benchmarks/stage-a-final-navigation-1/`；run `eebb66d4-72b7-414c-a818-0a52027a93b8` |
| 失败后只读确认 | `.benchmarks/stage-a-after-failure/` |
| 坐标点击 / 滑动 | `.benchmarks/stage-a-coordinate/`、`.benchmarks/stage-a-swipe/` |
| App 事件日志 | `.benchmarks/stage-a-fixture-touch.log`，限定测试应用 PID 与 `InspectorInputFixture` 标签 |
| 取消 | `.benchmarks/stage-a-cancel/`；run `565fd497-faed-480c-b8e5-4530faa57362` |
| 原失败会话 | `7e76583a-2fa3-4430-9d64-0dee7097eac0` |
| 手势与取消会话 | `337bef5f-1a97-43c1-9280-04f1f916475e` |
| 最终三轮导航 | `.benchmarks/stage-a-verified-navigation-1/`、`-2/`、`-3/` |
| 三轮重复请求检查 | `.benchmarks/stage-a-final-replay-1/`、`-2/`、`-3/` |
| 最终坐标点击 / 滑动 / 取消 | `.benchmarks/stage-a-final-coordinate/`、`.benchmarks/stage-a-final-swipe/`、`.benchmarks/stage-a-final-cancel/` |
| 最终会话 | `dc2b32f2-d831-4765-8610-8f139d6f204f`，验收后已结束 |
| 最终 App 日志 | `.benchmarks/stage-a-final-fixture-touch.log`，限定测试应用 PID 与日志标签，按实例区分历史记录 |
| 最终回归 / 构建日志 | 工作树 `.benchmarks/stage-a-verified-tests.log`；原目录 `.benchmarks/stage-a-verified-build.log` |
| 独立报告审计 | Android 工作树 `.benchmarks/stage-a-final-audit/`；`png-verification.json` 保留逐图结果和受预算限制的摘要 |

安装、打开测试 Activity、授权属于实验准备，不计入产品步骤耗时。测试期间未更新 Helper、未重置业务 App 数据。

初次触摸日志 `stage-a-fixture-touch.log` 是独立实验文件，未加入产品报告附件。它的 SHA256 为 `c3c9706750179703e98ef5b01cb70024b0d7cfc33d813d1915cd701cb6be240b`；对应实例日志序号 1～134 连续，只有两组 DOWN/UP。报告加载校验只覆盖报告中的树和图片，不能声称同时校验了外部触摸日志。

最终日志 SHA256：`781678ff5c6ded24bfdb3a3f9f736fbd3c8612a7184e99de11a58ab987b80603`。按本次会话时间与实例过滤后，主页面实例 `7bb3aa76-eb46-4036-a54b-6aa2c3ddab28` 的序号 3～145 连续，包含 3 次开始点击、3 次进入子页、1 次坐标点击、2 组 DOWN/UP、0 次 CANCEL、122 次滚动位置回调。三个独立子 Activity 均有创建、恢复和销毁记录。会话前的准备或历史日志未混入本轮动作计数。

代码已整合回原目录；验收会话已结束，临时窗口元数据追踪已移除，软件已正常重启。改动未提交、未推送，原暂存区保持不变。

## 下一步

阶段 A 当时的结论：进入阶段 B，先基于现有坐标滚动验证固定列表末项、次数和终点证据，不因历史单次失败直接新增语义滚动或第二套执行框架。后续阶段 B 复现新的手势无位移失败，再独立实现控件滚动并通过三轮验收，见[实际结果](HELPER_SCROLL_STAGE_B.md)。真实业务的“收藏最后一条视频”及整段提速，分别留到阶段 C、D；优先级以[下一步计划](../../AUTOMATION_NEXT_STEPS.md)为准。
