# Helper 输入与真机验证

最新进展：[阶段 A](archive/automation/HELPER_INPUT_STAGE_A.md)已验证导航、单次触摸与取消；[阶段 B](archive/automation/HELPER_SCROLL_STAGE_B.md)已完成固定列表控件滚动三轮验收；[阶段 C](archive/automation/AUTOMATION_BUSINESS_STAGE_C.md)已修复无资源 ID 的精确点击，并探索进入真实收藏末卡播放，整段三轮仍未完成。下文真机数据、APK 与测试数量保留为前一批历史记录；协议说明已同步当前控件点击与滚动能力。手势无位移仍有未解决的失败样本。

2026-10-17：已为显式选择 `accessibility-helper` 的自动调试接入手机端控件点击、触摸手势和系统返回。控件点击在同一无 SDK 真机测试页连续三轮通过，计数从 12 依次变为 13、14、15，同请求重放没有重复点击。坐标手势的页面无变化问题仍未解决，不能把本次结果扩大为所有输入均已修复。

## 这次解决什么

此前 Helper 只负责观察，点击、滑动和返回仍通过 ADB `cmd input` 执行。2026-10-17 在同一无 SDK 测试页再次复现失败：

| 项目 | 实际结果 |
| --- | --- |
| 桌面授权 | `b90eb9de-9c07-41fb-a2bc-045c8e21b837`，目标 `com.androiduiinspector.sdkfree` |
| 产品请求 | `17c820b0-018c-4f52-81d1-e8f6e85be4d2` |
| 解析坐标 | `(540, 1183)`，屏幕 `1080 × 2400`，旋转 0 |
| 实际 ADB 输入 | 1 次；退出 0，无输出 |
| 系统证据 | UID 1000、system_server PID 1582，设备时间 `1792203029.803` 拒绝输入 PID 22306 |
| 产品结果 | `injection-failed / unknown / verified=false`，1623.914 ms |
| 只读复查 | 测试页计数仍为 12，没有重新点击 |

相邻 MIUIInput 日志记录了 `package:null` 的 DOWN/UP，未给出更具体的拒绝原因。本机 `/system/bin/input` 只是 `cmd input` 的包装，换命令名字没有独立实现可用。没有将问题归因于用户的 USB 安全设置，也没有修改设置。

## 实现方式

只有显式选择 Helper 后端的步骤使用新路径；UIAutomator 仍使用原受控 ADB 输入。输入方式在首次发送前确定，失败不换方式、不补发。无需接入业务 SDK，也没有新增 Android 权限：现有 Helper 已具备读取控件与发送手势的能力。

对于具备资源 ID、类名和完整屏内原始边界的最终点击控件，桌面从实际解析的节点生成固定描述，手机端唯一匹配、刷新并再次核对后执行 `ACTION_CLICK`。父控件点击使用实际父控件，不误用文字锚点；点位必须在描述的边界内。带描述的请求不使用手势或其他父节点兜底。其他点击和默认滑动预先选择触摸手势，返回使用系统返回动作。连续滚动可显式选择 `inputMethod: "accessibility"`，仅对精确定位且暴露对应动作的纵向容器执行控件滚动；失败不回退。

无资源 ID 的点击也可使用控件动作，但必须明确观察到空 ID，并具备非空白、未经裁剪的精确 contentDesc、类名及完整边界。手机端必须唯一匹配，刷新后 ID 仍为空且描述不变；缺失 ID 不充当通配符。已选定控件点击后，描述或目标校验失败立即停止，不退回手势；无 ID 且没有有效描述的控件仍可能预先选择原手势路径。滚动仍要求资源 ID。这一能力已在真实“我”标签验证，不能据此推断所有匿名控件均可点击。

`POST /inspector/input` 只接收点击、150–1000 ms 的滑动、绑定精确容器的纵向控件滚动和返回。控件滚动的实际距离由 Android 控件决定，回执方式为 `accessibility-scroll`。请求绑定桌面授权、单次物理输入 UUID、Helper 服务 UUID、完整采集 UUID、包名、窗口与主屏幕尺寸方向。没有文本输入、任意命令或其他系统全局动作。

手机端保存最近一次完整采集的凭据，最多有效 5 秒，接受动作后消费一次。主线程发送前再次核对配对、服务、焦点包和窗口、完整窗口清单、屏幕、坐标及辅助功能状态。队列有独立截止时间；超时与发送共用原子门，已返回“未发送”的排队任务不能稍后补发。

控件点击、控件滚动和系统返回限 Android 13 及以上，以便清理无障碍缓存后核对目标与窗口。坐标点击和滑动限 Android 14 及以上，要求屏幕放大与触摸探索明确关闭。更低系统版本仍可按既有能力只读观察；动作返回不支持，不自动改走其他输入路径。

同一服务中 `(sessionId, requestId)` 去重；同 ID 变参拒绝，相同请求返回原结果。最多保存 1000 条，不淘汰旧输入来接收新请求。每次实际滚动使用不同的物理请求 ID；桌面原来的步骤与计划台账继续阻止外层重放。

Android 官方区分手势分发与完成回调；分发返回 true 不证明 App 页面结果。取消可能已有部分触摸，屏幕放大和触摸探索也会影响坐标。因此成功仍需动作后的完整观察和双帧断言。[官方手势说明](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#dispatchGesture(android.accessibilityservice.GestureDescription,%20android.accessibilityservice.AccessibilityService.GestureResultCallback,%20android.os.Handler))、[回调说明](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService.GestureResultCallback)。

## 回执与失败边界

| 手机端结果 | 派发状态 | 后续行为 |
| --- | --- | --- |
| 控件动作被接受、手势完成回调或系统返回被接受 | `sent` | 继续完整采集，页面结果另行验证 |
| 发送前校验拒绝，或 `dispatchGesture` 立即返回 false | `not_sent` | 保留原因，不自动补发 |
| 控件动作调用后失败、手势取消，发送后超时、断连、无效回执 | `unknown` | 保留原请求，禁止重发或切换 ADB |

Helper 回执单独记录传输方式、设备请求和原始状态，不伪造输入子进程、退出码或系统注入日志。报告同时核对普通步骤与每次滚动的授权、包名、屏幕、采集归属及执行方式与动作的一致性，并拒绝将一份回执算作两次物理输入。历史回执缺少执行方式时显示“执行方式未确认”，不推测为手势。

结果未知后，该 Helper 授权会话保留只读观察能力，新的完整截图不能重新开启输入。HTTP 取消或桌面停止无法撤回已开始的 Android 手势；不能承诺动作立即停止。

旧 Helper 未声明 `guardedInput:true` 时，新桌面在发送输入请求前拒绝。该能力字段会被旧桌面的严格响应校验拒绝，因此本次要求桌面与 Helper 一起更新；没有承诺旧桌面读取新 Helper 的兼容性。旧 Helper 的只读观察和等待仍可供新桌面使用。

## 验证记录

最终整合后的 247 项相关回归全部通过，覆盖 26 个测试文件；测试数量不累加此前重复运行。工作树和原目录的类型检查、完整构建及差异格式检查通过。Android 输入 JVM 回归覆盖唯一匹配、刷新失败、节点变化、并发、排队超时和禁止回退；SDK 36 离线构建通过。

真机已安装的 Helper APK 为 933,976 字节，SHA256 `c3bcc17492ebdd315a07ca73c8871ba870ed7189616a59a049343291486d1d10`，从手机读取的安装包与候选一致。Manifest、签名与前一候选保持一致，没有新增权限。桌面正常启动，未加载私有测试钩子；沿用原配对文件。

### 控件点击的三轮结果

设备 `JNHA45FQBQEIRGEQ`，Android 14，目标 `com.androiduiinspector.sdkfree`，页面 `DelayedConditionActivity`。独立授权 `02b08c7d-243d-429f-9a0d-f7f88714dac2`，手机服务 `9428a7de-1480-4d35-9858-fea73640f3b2`。三轮均通过产品 CLI 点击“开始等待”，每轮重新完整读取，断言计数恰好增加 1，再等待 8 秒就绪标记；没有使用 ADB 点击或测试 Intent 改计数。

| 轮次 | 计数变化 | 设备回执区间 | 主机输入阶段 | 产品步骤总耗时 | CLI 总耗时 |
| --- | --- | --- | --- | --- | --- |
| 1 | 12 → 13 | 178 ms | 487.485 ms | 4096.091 ms | 4234.239 ms |
| 2 | 13 → 14 | 161 ms | 498.113 ms | 3401.982 ms | 3538.629 ms |
| 3 | 14 → 15 | 154 ms | 470.187 ms | 3414.615 ms | 3553.054 ms |

三次回执均为 `accessibility-click / completed / sent`，页面断言均 `verified=true`。设备区间只覆盖手机执行回执，主机输入阶段还包含边界复核和通信；产品总耗时包含动作前读取、动作后读取与双帧确认，表中不包含随后单独等待就绪的步骤。每次点击有 3 次完整观察，命令分类为 target 21、display 7、forward 8，没有 shell 输入命令。这些分类仍反映出边界读取的开销，后续可继续减少重复复核，但不能省掉页面确认。

每轮用相同外层请求 ID 再调用一次，返回原步骤；随后只读采集确认计数没有多加。三次实际输入的手机请求 ID 分别为 `f245c4d0-f3e5-46aa-a8c8-6047bb510c50`、`7829816c-9a3a-4962-81a7-a55838aa97ad`、`4802a6a3-067d-4c48-a855-e1a4531764ed`，使用不同完整采集凭据。结束后已撤销该测试授权。

独立复核确认：报告共 10 个步骤、22 次完整观察，保存 13 份快照、26 个附件引用、21 个实际文件，大小及 SHA256 全部有效。当前生产报告读取器导入成功，13 份完整树、8 张去重 PNG 均正常读取，无导入错误。每次回执的来源采集和动作前树一致，时间满足“完整采集完成 → 输入开始 → 输入结束 → 新观察开始”。报告保存在本机应用数据目录 `mcp/runs/02b08c7d-243d-429f-9a0d-f7f88714dac2/report.json`。

三次后续只读等待分别为 6990.751、6904.016、7312.595 ms，每次 3 次完整观察和 60 次 ADB 边界、屏幕与端口命令。这段耗时包含测试页设计的延迟，不等于点击耗时。下一步提速应基于这些分类减少重复读取，保留授权、焦点、几何与动作后双帧确认。

上述是同一测试页的 3 个成功样本，不代表其他 App、自绘控件、坐标点击、滑动或返回均已实机验证，也不构成稳定延迟或 P95 结论。失败实验与成功路径不同，不计算两者的提速百分比。

### 先前的手势失败仍保留

第一版手势候选已做一次真机独立实验：授权 `13e978fa-6b2f-462f-b7c7-59f7f3702ccb`，外层请求 `02606871-a1e2-4029-b113-2bd024a657ef`，手机请求 `9cd25177-37ba-41b5-813d-1475e096cee3`。Android 回调 `completed/sent`，设备回执区间 114 ms、主机输入阶段 441 ms；但计数仍为 12，等待 13 的页面断言在 12131.643 ms 超时。后两轮没有执行，也没有补发该请求。截图已核对点位在按钮内，额外只读采集仍为 12；短窗中未观测到 InputManager 拒绝，不能据此证明 App 收到触摸或归因于某项安全设置。

首次只读预检还保留了一次 HTTP 401：Helper 更新后内存配对令牌清空，恢复原配对后只读采集通过；该次没有产品输入。上述手势失败与后续语义点击候选分开保存；新候选即使成功，也不改写旧手势结果。`ACTION_CLICK` 验证的是控件动作，不能证明真实触摸分发、命中测试或拦截链正常。

原失败报告保留于本机应用数据目录：`mcp/runs/b90eb9de-9c07-41fb-a2bc-045c8e21b837/`。原请求没有被改写为成功；新路径测试使用独立授权与独立请求。

## 代码入口

- [桌面输入适配](../electron/automation/helper-input.ts)、[单步执行](../electron/automation/debug-step-executor.ts)。
- [会话与来源绑定](../electron/capture/helper-session.ts)、[有界输入客户端](../electron/capture/helper-input.ts)、[协议](../shared/helper-input.ts)。
- [手机端输入](../scripts/helper-templates/InspectorInput.java)、[完整采集与边界](../scripts/helper-templates/InspectorObservation.java)、[固定上游准备脚本](../scripts/prepare-recognition-helper.ts)。
- [输入证据](../shared/debug-input-state.ts)、[滚动与回执校验](../shared/debug-scroll-validation.ts)、[报告导入](../electron/desktop/debug-report.ts)。

相关历史：[读取并行优化](archive/automation/HELPER_BOUNDARY_PARALLEL.md)、[条件等待对照](archive/automation/HELPER_CONDITION_WAIT_COMPARISON.md)。读取性能改善不作为输入成功证据。
