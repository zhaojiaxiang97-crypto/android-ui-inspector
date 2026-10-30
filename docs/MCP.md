# MCP 与自动 UI 调试

目标是让 AI 完成“观察 → 定位 → 操作 → 重新观察 → 验证 → 留证”。AI 客户端负责决定下一步，桌面软件复用现有采集、控件搜索、测距和显示能力，不内置第二套 AI。

## 使用

1. 安装 Node.js 22+；源码运行先执行 `bun install`、`bun run build`。
2. 连接手机，打开要测试的 Debug App。实际通过 `run-as` 验证，不只看安装包名称。
3. macOS 选择 **文件 → MCP → 复制 MCP 配置**；其他平台使用 **自动调试** 面板。将配置添加到 MCP 客户端，更新程序后需重启客户端的 MCP 连接。
4. 选择 **开启自动调试…**，核对设备和包名后授权。默认取消；最长 30 分钟，不跨 App。
5. 向 AI 给出操作目标和预期，例如：“找到设置按钮，点击后确认出现‘通知设置’”。
6. 工具栏会显示授权状态和 **立即停止**。打开 **自动调试** 可看最近操作；失败后点击 **打开失败证据**。

配置仍为 stdio，不需要手动填写端口或口令。以软件复制的实际路径为准：

```json
{
  "mcpServers": {
    "android-ui-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/server.cjs"],
      "env": {
        "ANDROID_UI_INSPECTOR_MCP_SNAPSHOT": "/absolute/path/to/userData/mcp/current.json"
      }
    }
  }
}
```

客户端找不到 Node 时，将 `command` 改为 Node 可执行文件的绝对路径。开发入口为 `dist-electron/mcp.cjs`，打包入口为 `Resources/mcp/server.cjs`。

## 已实现

| 工具 | 用途 |
| --- | --- |
| `get_debug_session` | 获取桌面已授权的会话 ID、当前快照 ID、设备、包名、到期时间、最近 20 步及失败证据位置；不会自行授权 |
| `capture_ui` | 实时采集，默认 `fast`；需要独立图层时才使用 `deep` |
| `perform_ui_step` | 新采集后按精确 selector 唯一定位，发送一次点击/滚动/返回，可接着验证预期条件 |
| `scroll_until` | 在唯一容器内有界连续滚动，连续两次确认目标或明确终点；无进展不算到底 |
| `get_ui_step` | 用会话和请求 ID 只查已存状态/结果，不采集、不输入、不增加步骤 |
| `resume_ui_step` | 对已发送或可能发送的原请求仅恢复观察和原预期验证，不重发输入 |
| `tap_node` | 默认点击节点本身；可显式用具名文字定位其可点击父控件；重新观察后返回新快照，**不代表验证通过** |
| `scroll_node` | 在指定可滚动控件内滑动一次，回传新快照；不接受任意坐标，不自动反复滚动 |
| `press_back` | 复核当前窗口后发送一次返回键，再观察；可能丢弃编辑或离开 App |
| `wait_for_ui` | 精确匹配条件；可显式指定 backend 直接读取本步骤新双帧，无需先采集；超时留证 |
| `stop_debug_session` | 撤销授权并取消进行中的操作 |
| `get_snapshot` | 当前共享快照的 ID、来源、采集模式和摘要 |
| `search_nodes` | 模糊查询、精确 selector，以及可见、启用、可点击、可滚动筛选；支持分页 |
| `get_node` | 原始控件属性、尺寸、父子关系；支持分页 |
| `get_image` | 整屏截图或控件独立图像；缺失不以截图裁剪冒充 |
| `measure_nodes` | 原始布局外框距离，单位 screen px，不是 3D 展开间距 |
| `get_tree` | 按深度读取整树或子树，先序分页，返回父节点 ID；不含图片 |

也可直接用终端命令，无需 MCP 客户端：`bun run cli --help`。CLI 和 MCP 复用同一套授权及工具实现，详见 [CLI 使用说明](CLI.md)。`search_nodes` 另支持 `by=all/class/id/text/desc` 限制模糊搜索字段。

<a id="perform-ui-step"></a>

### 复合单步（新源码，真机对照待补）

目标及预期明确时，可用一次 `perform_ui_step` 合并“新观察 → 定位 → 操作 → 验证”。先调用 `get_debug_session` 取得授权会话；示例中的 UUID、资源 ID 和文字需替换为实际值：

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "requestId": "00000000-0000-4000-8000-000000000002",
  "target": {
    "selector": { "text": "设置" },
    "within": { "resourceId": "com.example:id/profile_actions" },
    "target": "clickable-parent"
  },
  "action": { "kind": "tap" },
  "expect": { "selector": { "text": "通知设置" }, "state": "visible" },
  "timeoutMs": 45000
}
```

- `target.selector` 使用精确匹配，必须唯一命中。可选 `within` 先精确找到唯一的范围节点，再在其子树内找目标；可选 `clickable / scrollable` 放在 `target` 下。缺失、重名、禁用、跨 App/窗口均停止，不选择第一个候选。
- `target.target` 默认 `self`；只有明确需要点文字父容器时才指定 `clickable-parent`。后续仍检查父链、有效输入范围、几何及遮挡。
- `action.kind` 支持 `tap / scroll / back`。滚动例子为 `{"kind":"scroll","direction":"down","distance":0.6,"durationMs":350}`，仍只滑动一次；返回用 `{"kind":"back"}`，不传 `target` 或视觉确认。
- `expect` 可省略；省略后即使输入成功且获得新快照，也只有 `verified:false`。提供预期后仍需连续两次观察符合；输入后的首次新观察可作为第一次确认，操作前快照不能计入。
- 默认预算 45 秒，可设 1000–60000 毫秒，输入、恢复和条件等待共享本次预算，同时受会话到期与取消约束。

新入口总是先采集 UIAutomator fast 观察，再按 selector 定位，不要求外部先提供 `snapshotId + nodeId`。这次观察直接用作操作前依据；输入前的即时窗口和屏幕检查仍保留。没有自动跳过“已选中”控件的规则；调用方发现目标已满足时，应直接验证或进入下一步。

同会话、同 `requestId`、同参数会返回进行中状态或已保存结果，不重复输入。同 ID 改变 selector、预期、超时或视觉确认都会拒绝。调用方超时后先查原 ID：

```text
get_ui_step({sessionId, requestId})
resume_ui_step({sessionId, requestId, timeoutMs:30000})
```

`get_ui_step` 不触发手机读取，结果中的 `snapshotCurrent` 说明记录的快照是否仍是当前共享快照；找不到请求时返回 `found:false`。`resume_ui_step` 只接受原发送状态为 `sent / unknown` 的请求，在授权会话内继续观察和验证原 `expect`；没有原预期时不会补成验证通过。恢复预算默认30秒、范围1000–60000毫秒，不修改原动作参数。

`requestState` 为 `running / completed / interrupted`；`completed` 只表示请求结果已保存，不能代替 `verified`。`dispatchState` 单独说明输入是否发出，即使后来观察确认了页面条件，也不会把原 `unknown` 回执改写成 `sent`。重启后不自动恢复授权或输入；重读台账中的未完成请求会保守标记中断，可能已经发送的输入记为未知。

需要视觉确认时，返回的新截图必须实际查看。复合入口使用 `visualConfirmation:{snapshotId,description}`，仍比较新旧像素、目标身份、窗口、尺寸及重叠证据；旧确认不能直接套用到新截图。若原请求明确 `not_sent`，查看截图后用**新的 requestId** 提交带确认的参数；同 ID 改参会被拒绝。`sent / unknown` 时仅查询或恢复观察，不用新 ID 重发原动作。

离线固定场景中，旧 `capture_ui → tap_node → wait_for_ui` 调用观察5次，复合入口调用观察3次，两者均输入1次并保留两次确认。这只是模拟调用次数对照，不代表真机时间、模型等待或整项任务提速。P2有界连续滚动见下节；P3 的可选 Helper 观察与操作见[后端说明](#helper-observation)。

`perform_ui_step` 和 `scroll_until` 可传 `backend:"accessibility-helper"`，默认仍为 `uiautomator`。一个请求及 `resume_ui_step` 全程固定原后端和 Helper 服务实例；恢复不读取当前选择来改写原来源。Helper 缺少完整证据时拒绝操作，失败不自动回退。显式切换来源后必须重新定位，节点 ID、坐标和视觉确认不能跨后端复用。

<a id="scroll-until"></a>

### 有界连续滚动

`scroll_until` 将固定容器内的观察与滚动交给桌面执行，减少 Agent 逐次往返。以下是寻找明确列表终点的输入示例，UUID 和标识需替换为实际值：

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "requestId": "00000000-0000-4000-8000-000000000003",
  "target": { "selector": { "resourceId": "com.example:id/favorites_list" } },
  "direction": "down",
  "until": { "selector": { "text": "没有更多了" }, "kind": "end_marker" },
  "loading": { "text": "加载中" },
  "empty": { "text": "暂无收藏" },
  "maxScrolls": 6,
  "timeoutMs": 120000
}
```

- `target.selector` 必须唯一定位可见、启用的滚动容器；可选 `target.within` 限定唯一子树。每次重新采集后重定位，不复用旧节点 ID。`until.selector / loading / empty` 都只在目标容器内精确匹配；缺少语义的自绘内容不能靠截图相似度冒充命中。
- `until.kind` 默认为 `target`；明确终点用 `end_marker`。连续两次可见观察确认后分别返回 `target_found / end_reached` 与 `verified:true`。找到时只停止并返回观察，不自动点击目标。
- 可选 `loading` 用于识别加载中的容器，加载期间只观察。可选 `empty` 独立识别空列表；确认后返回 `empty`，仍为 `verified:false`。无进展只返回 `no_progress`，不能证明到底。
- `maxScrolls` 默认6、范围1–12；`timeoutMs` 默认120000、范围1000–120000。所有观察、输入和确认共享预算，并受取消和会话到期约束。`distance` 默认0.6、范围0.1–0.8；`durationMs` 默认350、范围150–1000，仅控制手势。方向与 `scroll_node` 一致。
- `inputMethod` 缺省为 `gesture`。显式 `accessibility` 仅支持 Helper、`up / down`、包含 `resourceId` 与 `className` 的唯一容器，手机端须支持对应方向动作；实际滚幅由控件决定。不能带 `visualConfirmation`，失败不回退到手势或 ADB。
- `until.reveal:"scroll"` 是显式的继续查找选项，目前仅支持 Helper 向下滚动；容器和目标都必须带精确 `resourceId / className`。唯一目标被已知底栏遮挡时只记为尚未到达，在原次数、时间和进展限制内继续原方向滚动。目标完整落入有效视口并通过窗口检查、双帧确认后才成功；未知遮挡、重复目标、隐藏目标及加载/空列表冲突仍停止。不使用部分可见断言，不改变输入安全检查。
- 每次动作独立复核授权、窗口、几何、容器与路径。手势方式的 `visualConfirmation:{snapshotId,description}` 只可用于第一个手势；旧确认不自动用于后续页面。Helper 连续两次已发送输入后进展仍未知则 `interrupted`，不视为到底。

结果顶层的 `scrollTask` 含 `stopReason / iterations / observationIds`；每次迭代保留前后快照、耗时、解析路径、输入回执与进展状态。MCP 文本只摘要请求 ID、次数、停止原因和验证结果，结构化结果保留完整逐次记录，不自动附带旧图片。`scroll_limit / timeout / cancelled / container_missing / interrupted` 均表示停止原因，不能代替成功验证；输入是否发送仍看 `dispatchState`，部分输入成功后停止也不回退成 `not_sent`。

`get_ui_step` 同样查询 `scroll_until`。同请求 ID、同参数只返回原状态，异参数拒绝；重复调用不继续滚动。`resume_ui_step` 只观察并验证原目标/终点，**不会续滑**。滚动请求为 `not_sent` 时也可只读重验，例如目标已在第一屏、第二次确认读取失败；普通 `perform_ui_step` 的恢复仍要求原输入为 `sent / unknown`。需要继续一段时，先读新观察、确认当前位置及已知回执，再用新请求 ID 定义下一段；未知输入结果不能靠换 ID 重试。恢复入口不会增加滚动输入。

外部 MCP 客户端也有自己的请求超时，部分客户端（包括未覆盖配置的官方 JavaScript SDK）默认60秒。要使用完整120秒执行预算，客户端超时需设为至少135秒；例如官方 SDK 的 `callTool(..., undefined, { timeout: 135000 })`。内置 CLI 已设置135秒，桌面桥接为130秒。客户端超时会传递取消信号，已发出的输入不能撤回；用原请求 ID 查询结果，不能把客户端超时当作“未操作”。

固定 24 项测试列表已完成三轮控件滚动、双帧末项和同请求重放验收，详见[阶段 B](archive/automation/HELPER_SCROLL_STAGE_B.md)。完整业务与同条件性能回测仍待补；不会把“达到终点”直接当作“最后一个视频已播放”。

原有分步接口继续可用：

```text
get_debug_session → sessionId
capture_ui(sessionId, mode="fast") → snapshotId
search_nodes(snapshotId, query="设置") → 节点列表
get_node(snapshotId, nodeId) → 确认实际可点击控件
tap_node(sessionId, snapshotId, nodeId) → 新 snapshotId，verified=false
wait_for_ui(sessionId, selector={text:"通知设置"}, state="visible") → verified=true/false
```

`wait_for_ui` 等待条件支持 `resourceId`、`text`、`contentDesc`、`className`，所有已填写字段精确匹配。状态支持 `visible`、`absent`、`enabled`、`disabled`；该接口默认超时及上限均为 30 秒。只统计授权 App 的可见语义节点。“不存在”不等于绘制树内完全没有这个对象；读取失败、窗口切换不能当作消失或通过。

`backend` 可显式设为 `uiautomator` 或 `accessibility-helper`，直接在本步骤内读取两个不同的新帧；不需要提前调用 `capture_ui`。省略时继续沿用当前快照来源，没有新增默认后端。Helper 双帧仍检查完整性、服务、窗口和几何，partial 的两帧都必须晚于本步骤开始；不会拿上一条命令的旧画面凑数。显式切换来源时先撤销旧快照，读取失败也不能沿用旧 ID。

### 点击后页面切换的恢复

点击、滑动或返回已经成功发送后，如果新观察遇到窗口正在切换、暂时没有有效控件树，或焦点暂为空（`null-focus`），可以在同一步骤里额外读取最多2次，间隔250ms。首次决定恢复后，后续读取和确认等待共用15秒截止时间，同时受更短的原请求预算约束；旧动作接口总预算仍为45秒。恢复只读，不再次输入；成功返回新 `snapshotId` 和当前读取阶段的 `observationAttempts`。旧单步动作仍为 `verified=false`，复合步骤仅在后续连续两次条件符合后返回 `verified=true`。两份确认之间读取失败，必须重新双帧确认。点击和返回允许正常的授权内 Activity 跳转，滚动始终固定原窗口。

Helper 仅在错误为 `helper-incomplete`，全部原因属于 `child_unavailable / window_inventory_changed`，且失败元数据通过原服务、采集时序、授权焦点和窗口/屏幕核对时恢复。缺根、未知异常或无诊断的旧失败响应仍停止；失败树和图片不能发布。结果与报告的 `observationFailures` 保留失败及继续读取的决定，`error.helperDiagnostics` 保留固定原因及计数，超时/取消也保留最近可信诊断。完整规则与部署状态见[实现记录](HELPER_INPUT_TRANSPORT.md#helper-observation-recovery)。

离开授权 App、焦点歧义、断连、截图/屏幕几何异常、取消及输入结果不确定不进入这轮自动重试。恢复耗尽仍保留 `dispatchState=sent`，不能重复点击；复合请求可随后通过 `resume_ui_step` 只读恢复。操作前暂时无焦点仍阻断输入，输入前继续核对同一 Activity 实例、窗口和屏幕；固定任务验收仍按原规则读取两次，不受此重试影响。

收到点击返回的新快照后，优先直接查询它，无需再调用一次 `capture_ui`。只有页面后来发生变化、快照过期或明确失败时才重新采集；找控件先用具名/精确筛选，避免拉取整树。

### 文字不可点击、父容器没有 ID

某些列表把文字和点击区域分开：文字有名称，父容器可点击但没有自己的名称/ID。默认点击仍拒绝匿名控件，不自动向上找父节点。明确需要点击这一行时：

```text
search_nodes(snapshotId, selector={text:"播放设置"}, visible=true)
get_node(snapshotId, nodeId=文字节点ID)
tap_node(sessionId, snapshotId, nodeId=文字节点ID, target="clickable-parent")
wait_for_ui(sessionId, selector=目标页面独有的文字条件)
```

此模式以文字节点为锚点，重新采集并核对唯一标识、类型、位置及最近可点击父控件的祖先关系、尺寸和状态。重名、关系改变、尺寸变化、位置超出下述容差、禁用、滚动父控件、越界或点击位置有可操作子控件时拒绝，不退回任意坐标。返回`anchorNodeId`和`targetNodeId`区分文字与实际点击区域。`target="self"`为默认行为；文字本身可点击时使用默认模式。

点击定位允许小幅整体平移：控件宽高不变，两个方向分别不超过8个屏幕像素和对应尺寸的10%，且该控件的语义身份在前后两棵树中都唯一。使用新观察中的坐标，仍检查遮挡、可见和启用状态。父控件模式逐级核对父链同样的尺寸及平移范围。重复标识仅保留原有的精确坐标匹配；尺寸变化、明显移动和滚动目标不适用此容差。

### 可见性与重叠的视觉确认

节点摘要同时返回兼容字段 `visible` 和证据字段 `visibilityEvidence`。后者为 `visible / hidden / unknown`：XML 明确提供 `visible-to-user=true/1` 才是 `visible`，`false/0` 是 `hidden`；缺失、非法值或旧快照没有该字段时为 `unknown`。兼容字段可能在来源缺失时默认 `true`，不能据此认定控件实际可见，也不能用布局 bounds 推断遮挡顺序。

默认点击或滑动遇到无法确定的重叠时不发送输入，返回 `dispatchState=not_sent` 和 `recovery.kind=visual_confirmation_required`。恢复信息含重新观察得到的 `snapshotId`、锚点 `nodeId`、实际操作区域 `targetNodeId`、重叠控件 `overlaps`。Agent 应读取这个新快照的**整屏截图**，确认目标确实可见，再基于返回的新 ID 重试：

```text
get_image(snapshotId=恢复信息中的snapshotId) → 整屏截图
tap_node(sessionId, snapshotId=同一新snapshotId, nodeId=恢复信息中的nodeId, target=恢复信息中的target,
  visualConfirmation={description:"整屏中收藏入口清晰可见，位于赞入口右侧"})
scroll_node(sessionId, snapshotId=同一新snapshotId, nodeId=恢复信息中的nodeId,
  direction="down", visualConfirmation={description:"整屏中视频列表可见，没有弹窗覆盖"})
```

`description` 必须是 1–512 字符的非空描述。仅在 Agent 已查看对应快照整屏并完成判断后使用；这是观察证据，**不是 force，也不要求用户额外许可**。CLI 对应 `tap/scroll --visual-confirm '实际看到的目标描述'`。执行器仍重新采集并严格比较目标区域前后像素，核对身份、窗口、几何和授权 App；目标失效、明确不可见、跨 App 或嵌套滚动冲突仍拒绝。不开放任意坐标，不自动改选父控件；每次输入仍只发送一次。`sent/unknown` 时禁止按此流程盲目重发，必须先确认操作结果。

视觉确认重试先读取控件树，再截取整屏，避免用先前画面验证后出现的控件。点击比较新旧目标区域的并集及周围24px；滚动比较实际滑动路径及周围24px安全带，并限制在有效滚动区域内。均要求解码后的像素完全一致；区域外视频或底栏动画不影响确认，区域内动画仍会要求重新观察。同时比较重叠控件的身份、边界、交互状态及窗口归属；滚动还比较通道内可操作子控件，新出现的透明交互层不会因挂在列表子树下而漏过。节点路径和遍历顺序变化本身不算新冲突。确认不提供系统合成画面与控件树的原子同步保证，输入后仍须检查结果。

### 底栏与滚动区域边界重叠

UIAutomator 的滚动容器布局范围可能延伸到底栏后面。点击判断会区分[可点击与可滚动标记](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo)：同一 App 中，不可点击、可滚动、完整包含目标且范围严格更大的容器，不单独当作另一个点击目标。默认点击和显式父控件点击共用这条规则；其他重叠不能仅凭 bounds 判断遮挡顺序，按上述视觉确认流程处理。跨 App、身份无效和嵌套滚动区域仍拒绝。

这条规则没有推断绘制顺序，滚动容器仍可能吸收点击。`dispatchState=sent`只表示输入发出，须读取新页面，核对目标选中状态或明确页面条件；页面未改变不能报成导航成功。30秒快照时限、操作前的新观察、窗口/屏幕核对和一次输入仍执行，拒绝时返回`not_sent`。

滚动另行派生有效区域，不修改用于检查的原始布局 bounds。先在原始区域核对 App/窗口，再按屏幕、根窗口、可滚动祖先和明确裁剪容器缩小范围。对于同窗口、不同分支、贴共同内容容器底边的一排标准 `ActionBar$Tab`，仅在至少三个可点击 Tab、恰好一个选中、横排且高度合理时避让；普通按钮、底部弹窗、1px 节点和名称中含 `bottom_bar` 都不作为充分依据。该识别只是路径规划，不证明 Z-order，也不会从遮挡检查中删除整个分支。尚未覆盖所有自定义导航控件。

有效区域和导航结构必须在新旧观察中一致，否则先返回新快照要求重新定位，不现场改变路径后直接发送。实际路径保留两端至少20%且不少于24px的边距，通道内仍检查其他控件和嵌套滚动；明确不同窗口即使位于裁剪掉的区域或目标子树内，也不能通过视觉确认放行。

### 第二阶段：长页面与返回

精确搜索和等待共用同一套匹配规则。`query` 是不区分大小写的模糊查询，`selector` 是区分大小写的精确查询；两者与 `visible`、`enabled`、`clickable`、`scrollable` 布尔筛选取交集。省略布尔筛选代表不限，传 `false` 就只找状态为假的控件。结果摘要直接给出启用和滚动状态，减少额外属性读取。

```text
capture_ui(sessionId) → snapshotId
search_nodes(snapshotId, selector={resourceId:"com.example:id/list"}, visible=true, enabled=true, scrollable=true)
scroll_node(sessionId, snapshotId, nodeId, direction="down") → 新 snapshotId
search_nodes(新 snapshotId, selector={text:"通知设置"}, visible=true)
…确认找到目标后再点击，找不到时按用户给定的次数上限决定是否继续…
press_back(sessionId, snapshotId=最新快照) → 新 snapshotId
wait_for_ui(sessionId, selector={text:"设置"}) → verified=true/false
```

- `direction` 是**查看内容的方向**：`down` 看下方，手指向上滑；`right` 看右侧，手指向左滑。支持四个方向。
- `distance` 默认 0.6，范围 0.1–0.8，表示请求距离相对有效滚动区域的比例；因两端保留边距，实际距离最多60%。`durationMs` 默认 350，范围 150–1000。短于64px的滑动拒绝，降低被当作点击的风险；这不是所有设备的触摸识别保证。
- 只接受快照中明确 `scrollable=true`、启用、可见且有稳定标识的容器。路径存在无法确定的重叠时先请求上述视觉确认；嵌套滚动冲突始终拒绝，不猜手势会交给哪个控件。控件未暴露滚动语义时不会强行模拟。
- `scroll_node` 每次只滑动一次；`scroll_until` 可在固定上限内连续滚动寻找明确条件。图片相同或节点不变**不代表列表到底**，不支持无界遍历。
- 返回键不保证留在 App。若返回后到了桌面或其他 App，采集失败，旧快照失效，后续操作被拒绝；用户需手动回到授权 App 后重新观察，MCP 不会操作授权范围外的页面。

所有手机操作都返回 `dispatchState`：`not_sent` 表示明确未发送，`unknown` 表示可能已发送但结果不能确认，`sent` 表示输入通道给出可信的发送/完成回执。ADB 路径要求输入命令正常结束且无异常回复；退出码0伴随权限拒绝、帮助/错误文字、异常输出或截断也不能报成 `sent`。Helper 没有输入子进程，以校验通过的动作接受或手势完成回执为准；控件动作调用后返回 false 仍记 `unknown`，不能据此重发。`sent` 不等于业务结果正确，必须检查新页面。后续截图失败会同时返回错误和 `sent`，不要把它当作“没操作”再执行一次。

### 固定任务验收（新源码，尚未安装）

已用独立候选`diagnosis-handoff-20261011-ab4c3840`完成自有样例真机及报告重开；当前本机安装版仍未包含新接口。实测步骤见[上手第7步](FIRST_USE.md#7-可选完成一次固定样例任务)，范围见[验收](archive/ACCEPTANCE_HISTORY_2026-10-15.md#task-sample-flow-acceptance)。

在首次输入请求前调用`define_debug_task(sessionId, definition)`，获得`taskId`。每个授权会话只允许一个原始目标；定义后不能替换，即使旧步骤已滚动丢弃。定义只保存条件，不采集手机。`get_debug_session`返回固定任务及最新验收记录。

`definition`含`goal`、有序`checkpoints`及`finalConditions`，格式见[CLI示例](CLI.md#固定任务验收新源码尚未安装)。自然语言目标只作说明，判断使用精确selector及`visible / absent / enabled / disabled`。最多5阶段、每组10条件、总20条件、定义12KB；阶段ID分别唯一，条件ID在整个任务中唯一。

```text
define_debug_task(sessionId, definition) → taskId
check_debug_task(sessionId, taskId, checkpointId="settings") → 阶段结果
check_debug_task(sessionId, taskId) → 最终结果
```

- 阶段按定义顺序检查；可显式复验已检查的阶段，立即清除该阶段及后续旧结果。最终验收需全部前置阶段有效通过；前置不足返回`insufficient_evidence`，不采集。
- 前置满足后固定采集当前来源两次新的 fast 观察，间隔350ms，总时限30秒；同设备、App、Activity实例、窗口和几何须一致。没有输入、等待重试或隐式换源；Helper 还需完整树、可见区域和同一服务实例证据，旧只读快照不能验收。
- `visible / enabled / disabled`须唯一匹配屏内可见控件；`absent`只证明完整树中没有屏内可见匹配，压缩树不能证明。缺范围、匹配歧义、结果变化、取消或采集失败均不能通过。
- `taskResult.status`为`passed / failed / insufficient_evidence`：两次均满足才通过，两次均不满足为失败，其他情况为证据不足。只证明声明的页面条件，不证明付款、服务端写入等业务副作用。
- 保存两次观察、逐条件结论和检查步骤/时间。导入重新读取树并判定，缺树或额度不足降为证据不足；缺PNG不影响树条件。任务当前阶段证明优先保留在现有额度内，不扩大存储上限。

任务结果在报告中单独展示；整会话仍为“记录中/已记录”。验收后再发生输入或后续步骤已丢弃，会提示重新验收，历史结论仍对应当时观察。新写入格式为`inspector-debug-report-2`，继续读取v1调试报告与旧e2e报告。离线范围见[验收](archive/ACCEPTANCE_HISTORY_2026-10-15.md#debug-task-acceptance)。

## 采集分工

- **轻量 fast**：默认屏幕截图 + UIAutomator 无障碍语义树，避免每一步采集大量独立位图。界面使用 2D，明确标识来源。这些语义节点可能是 VirtualChild，并非重新宣称它们是真实绘制控件。点击仅支持 UIAutomator 的 fast 快照。
- **深度 deep**：复用现有 Debug View / QML 采集，供背景、遮挡和布局分析，可能明显更慢。不会为了自动调试而重启 App；QML 服务尚未建立时明确失败，需要用户先在桌面按原流程建立连接。
- 不给出毫秒级速度承诺；UIAutomator 启动和等待空闲本身可能耗时。持续动画、无法暴露语义的自绘区域可能无法自动定位。
- 选中和实时快照会同步到桌面。缺失图层、跨帧采集等限制仍然存在，视觉疑点不自动等同于业务 Bug。

<a id="helper-observation"></a>
<a id="可选-helper源码已接入仅只读"></a>

### 可选 Helper 观察与操作

`capture_ui(sessionId, mode="fast", backend="accessibility-helper")`读取 Helper 的语义树和整屏截图；默认仍为`backend="uiautomator"`，`deep`不接受 Helper。需事先安装并手动启用已核验 Helper、完成配对，在**桌面主进程的启动环境**配置`ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE`。值为私有令牌普通文件的绝对路径，≤1KiB、POSIX权限0600、属于当前用户；拒绝符号链接。仅配置 MCP/CLI 子进程的环境不会传给已运行桌面。工具参数不接受令牌或令牌文件路径。

新版桌面的实时 Helper 采集与操作均要求观察 v1 服务，不会退回旧 `/dump` 协议；旧快照和报告仍可只读查看。旧 Helper 安装版需升级，或显式改用 UIAutomator。

兼容 Helper 通过能力协商提供同一次请求内的树、后置无损截图、显式可见区域、窗口和屏幕证据。树后截图有明确顺序，但不保证严格同帧。会话复用自己创建的转发，结束或失效时释放，不接管其他进程的转发。沿用 Debug 准入、授权包、前后 Activity 实例/焦点窗口及主屏几何复核，只发布唯一授权焦点窗口。令牌失效、空树、截断、错窗口、几何变化或取消均明确失败；不自动安装、启用、配对或换源。

快照来源为`accessibility-helper`，不标为完整绘制树。摘要保留`text`，另给`hint / error / stateDescription`；原始属性中的状态键仍为`state-description`。提示不替代text，文本选择器不匹配hint。没有独立图层，不保证系统装饰节点与UIAutomator一致，树和截图也不保证同帧。

切换后端或 fast/deep 模式时先撤销旧共享，即使新采集失败也不能使用旧 ID；成功生成新快照并重置工作台选中。完整 Helper 快照支持 `tap_node / scroll_node / press_back / wait_for_ui / check_debug_task`；输入另需新版 `guardedInput:true` 能力，旧 Helper 仍可只读观察。Helper 步骤使用绑定本次完整采集的手机端控件点击、触摸手势或系统返回，`scroll_until` 还可显式选择控件滚动；首次发送前确定方式。UIAutomator 保留受控 ADB 输入，失败不自动切换方式。操作前仍重新读取同来源并校验窗口、Activity、几何、节点及遮挡。点击/返回允许正常导航；两次确认必须稳定在同一窗口，连续滚动还固定初始窗口。服务重启、重复采集 ID 或返回其他来源会停止当前步骤；恢复只读且必须匹配原服务实例。原输入已发送或未知时，不允许通过切换后端重发；输入实现、版本兼容和未知后会话只读限制见 [Helper 输入与验证](HELPER_INPUT_TRANSPORT.md)。

此前同页性能对照和经手动只读恢复的单机动作回测见[历史记录](archive/automation/AUTOMATION_DEVICE_BENCHMARK.md#helper-cross-page-acceptance)。本轮诊断候选已安装，最新桌面完成单机点击/返回自动恢复及滚动回测，最终路径四次输入无重放；遮挡后只读复查、多次统计及剩余边界见[最新回测](archive/automation/AUTOMATION_DEVICE_BENCHMARK.md#helper-recovery-device-retest)。安装、启用和令牌配置见[交付说明](DELIVERY.md)。

## 安全和一致性

- 默认关闭。用户在桌面授权指定设备和包名；AI 不能通过 MCP 开启或延长授权。
- 操作前后核对前台 Activity、焦点窗口、Debug 状态和屏幕方向/尺寸。跳到其他 App、系统弹窗或无法确认窗口时拒绝操作。
- 旧 `tap_node / scroll_node / press_back` 只接受30秒内的fast快照，执行前重新采集；`perform_ui_step` 直接采集新快照并唯一定位。带视觉确认时仍须使用30秒内的当前参考快照。两条路径都检查窗口、方向、尺寸、身份、可用状态及输入范围；发送输入命令前再次核对窗口和屏幕，并固定在主屏操作。
- 树、截图和点击不是同一原子操作；快速动画或复用相同标识的动态列表仍存在时序限制。请在稳定的测试页面使用，不把坐标核对当作绝对防误触保证。
- 每次采集生成新快照 ID；任何手机操作发出前使旧快照失效。结果未知、断线或超时不能盲目重试，已发出的操作不能撤回。
- 同一时刻仅执行一个调试动作，不把并发请求排队后用旧位置执行。
- **立即停止**、返回设备页、手动重新采集、切换历史快照、页面重载、关闭程序或授权到期都会撤销会话。重启后不自动恢复。
- MCP 只提供固定操作，不提供任意 shell、任意文件路径、任意坐标/按键或源码修改。操作可能有业务副作用，客户端必须对支付、删除、发送、返回丢弃编辑等敏感操作另行取得用户确认；软件不能仅凭按钮名字判断业务风险。
- stdio 客户端通过桌面内部桥接执行操作：只绑定 `127.0.0.1` 的随机端口，使用每次会话生成的随机口令，拒绝浏览器 Origin 和无口令请求；配置文件为本地用户受限权限。不是局域网或公网服务。
- 同一系统用户可读取本地会话文件，不将其当作同一用户下恶意进程的隔离边界。

## 记录和数据范围

实时采集会向已配置的 MCP 客户端提供页面文本、属性和截图。接入云端 AI 时数据可能由客户端发送到模型服务；停止不能收回已经返回的数据。在 3D 中隐藏节点不是隐私过滤。

本机 `userData/mcp/runs/<sessionId>/report.json` 保存版本化调试记录；树与属性、整屏PNG分别放在同目录的 `artifacts/` 中，按内容摘要去重。最近100步滚动保留，记录总步数和丢弃数；最多200份快照、100张独立PNG，记录及唯一附件合计32MiB，单树2MiB、单图10MiB。容量不足优先移除旧证据并标明缺失，不中断原动作。树文件保留采集身份和属性，不包含3D独立图层位图。`reportPath` 在首个步骤落盘后返回；停止后仍可查看，空会话停止时也生成记录。

前后观察分别标为 `current / previous / missing`，含接受观察的时间、来源和缺失原因。输入失败或操作后采集失败时，旧画面不会冒充新结果；树与截图不保证同帧。兼容 `steps.json` 仍保留最近100步，`last-failure.json` 仍保存最后一次失败及前后树；两者各限8MiB，截图改由新报告关联，不再嵌入兼容文件。这两个文件的额度独立于新报告32MiB额度。

失败增加 `error.category / code / phase / message`，阶段区分采集、定位、输入、验证和留证。写盘问题另记 `recordingErrors` 并通过 `recordingWarning` 返回，不覆盖动作的原始错误或派发回执。旧点击、滚动、返回完成仍是 `verified:false`；`wait_for_ui` 或带预期的复合/恢复步骤连续两次条件匹配，只表示页面断言通过。固定任务使用独立`check_debug_task`结果，不能根据输入回执或单个页面断言宣布整个任务完成。

复合请求另在会话目录的 `requests.json` 保存请求、发送状态及结果，最多1000条、16MiB；台账满时拒绝新请求，不删除旧条目来腾出去重空间。这一额度独立于报告的32MiB额度。发送前先保存不确定状态，台账写入失败会阻断输入；确认回执和最终结果随后保存。`get_ui_step` 不新增报告步骤，`resume_ui_step` 会记录恢复观察，但不会增加输入回执。导入报告时若恢复步骤缺少原请求（例如仅导出恢复步骤），预期条件不可复核，显示未验证。

返回值及 `step.timings` 保存单调时钟总经过时间、关联编号、阶段起止区间、结果、观察原因及设备命令类别/次数。树和截图可并行，报告按区间展示，不相加当总耗时；失败和取消也保留。命令计时不保存参数、令牌或输出正文；单步最多2048个区间，超限保留省略数及累计次数。旧报告缺字段时显示“未记录”。最终计时元数据回填自身不计时，跨请求的Agent判断、工具往返及截图查看也不包含在单步耗时中。

桌面“查看调试记录”直接读取本轮记录，也可在“测试报告”导入调试目录的 `report.json`；移动或复制时保留 `artifacts/`。页面支持步骤/错误搜索、前后画面与控件属性、实际点击/滑动标记。缺失、旧观察和投递未确认单独显示；只读历史不触发手机操作。旧e2e仍导入 `summary/index.json`，保持原始报告及摘要校验。调试报告预览的树、图片各限16MiB；图片须完整解码，单图16M像素、总64M像素，超限明确显示不可读取。

ADB 输入步骤的`inputEvidence`保留退出码、终止信号、进程启动/关闭、耗时和错误分类，以及stdout/stderr各前4096字节（UTF-8文本）及截断标记。Helper 输入另以 `transport=accessibility-helper` 和 `helperInput` 保存设备回执；没有输入子进程，进程字段保持空值，不用它们推断“未发送”。权限拒绝、断线、非法命令、异常回复、取消/超时分别记录。ADB 输入命令仍限5秒，取消只终止自有主机输入进程、不关闭共享ADB服务；Helper HTTP取消不证明手机已停止。未知结果不自动重试，设备拒绝时不会自行调整手机安全设置。错误输入之后没有新观察时，after明确为空，不伪造画面。

`resolvedInput`在输入投递前记录实际操作（点击坐标、滑动路径、控件滚动或返回）、屏幕尺寸/方向；控件操作另有`targetNodeId`，点击另有`anchorNodeId`。控件滚动使用 `action.kind=scroll` 与方向，回执为 `accessibility-scroll`，不伪造滑动坐标或手势标记。字段出现在`get_debug_session`步骤及本地失败证据中，后续取图失败也不丢失；旧记录缺失时不补猜。它只是解析结果，不代表系统命中或业务回调成功，需结合`dispatchState`、输入回复和目标页条件判断。

滚动另记录 `resolvedInput.scrollRegion`：有效范围 `viewport`、含安全带的通道范围 `confirmationBounds`、用于规划避让的导航区域 `excludedNavigationBounds`。坐标均为 screen px；导入导出保留这些字段并校验实际动作、屏幕及确认区域的一致性。控件滚动还核对原请求方式、方向与回执方式。旧报告不要求补齐。

采用视觉确认的输入还记录 `resolvedInput.visualConfirmation`：Agent 查看过的 `referenceSnapshotId`、执行前重读的 `currentSnapshotId`、`description`、比对区域 `region`（left/top/width/height）、区域像素 `sha256` 和 `overlapNodeIds`。这些字段留存确认依据，不等于目标操作已成功。

这些记录不自动上传，也不自动跨会话删除；含敏感内容时可从“打开失败证据”进入目录后自行删除。实时共享快照单个JSON仍限50MiB；调试留证按上述独立额度控制。工具只读取当前授权范围，不开放历史目录浏览。

不操作手机时，仍可选择 **共享当前快照（只读）**。该模式仅共享手动确认的一份快照，不开启实时会话；切换或重新采集会撤销共享。

## 暂不包含

文本输入、任意手势、自动遍历整个 App、视觉像素断言、自动修复源码和重新编译尚未加入。没有无障碍标识的自绘对象不通过猜坐标强行操作。

## 验证

```sh
bun test tests/mcp.test.ts tests/debug-session.test.ts tests/debug-evidence.test.ts tests/debug-report.test.ts tests/debug-report-integration.test.ts tests/debug-report-view.test.ts
bun test tests/debug-ui-step.test.ts tests/debug-ui-step-report.test.ts tests/debug-timing.test.ts tests/debug-timing-report.test.ts
bun scripts/automation-offline-baseline.ts 10
bun test tests
bun run build
node_modules/.bin/electron scripts/native-menu-checks.cjs
```

测试覆盖 MCP 官方客户端、stdio、桥接口令与 Origin、精确搜索/布尔筛选、固定输入命令、四向滚动路径、旧快照/错 App/窗口旋转/重叠嵌套拒绝、返回后离开 App、连续观察验证、超时留证、记录保存失败、并发拒绝和取消后迟到结果不再发布。桌面测试用脱敏 fixture，不自动授权真实手机数据。

依据：[MCP 工具机制](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[Android ADB](https://developer.android.com/tools/adb)。


## 连接诊断与进度（新源码）

`diagnose_connection`只读检查所选设备和目标App，参数为`serial`、可选`packageName`、`captureMode: fast|deep`、`backend: uiautomator|accessibility-helper`及`timeoutMs: 1000–30000`。默认fast/UIAutomator。独立MCP诊断使用标准模式，跳过SDK安装声明探测，SDK项明确显示“增强未启用”，不视为缺SDK失败；工具参数不接受模式覆盖。返回检查时间、固定身份、必需/可选项、处理提示和`outcome: ready|blocked|unknown`；超时、取消、设备/App/窗口改变不能显示就绪。Helper实际服务响应未验证时明确说明，缺少可选项不阻断其他采集方式。

`get_debug_session`和CLI的`attach`复用已有入口，新增当前步骤、采集/执行/等待/保存/失败/停止或到期状态及时间。授权有效、操作完成、Checker验收分别显示，进度不新增任务执行器，也不把操作完成当作任务通过。

会话步骤关联有界的程序错误日志。桌面授权前显式开启Android日志后，仅尝试读取目标App主进程、步骤时间范围内的错误行；不能确认PID、启动身份或时间时标记缺证据。日志与截图、回执在同一步查看，保存至原报告目录并计入32MiB总预算；停止取消本次日志请求。旧报告无日志时继续可读，缺日志不改变动作回执或Checker判定。实时预览帧只在桌面观察，不进入共享快照、报告或任务验收。
