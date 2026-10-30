# 命令行

提供 `android-ui` 命令，直接供终端、脚本和 Coding Agent 使用，不需要配置 MCP 客户端。命令参考 [Lookin 社区 CLI](https://github.com/shoujiaxin/lookin-cli) 的 `doctor / attach / tree / find / attributes / screenshot / measure` 用法；读取的是本项目的 Android 数据，不是 Lookin 的 iOS 协议。

## 启动

需要 Node.js 22+。源码目录内：

```sh
bun install
bun run cli --help
bun run cli devices --pretty
bun run cli doctor --pretty
```

构建后不依赖 Bun 或源码：

```sh
bun run build
node dist-electron/cli.cjs --help
```

可选：源码构建后执行 `npm link`，在 PATH 中添加 `android-ui`（是否需要权限由本机 npm 配置决定；不会自动执行）。下文用 `android-ui` 表示入口，也可以换成 `bun run cli` 或 `node dist-electron/cli.cjs`。

桌面安装包同时携带独立 CLI：macOS 位于 `Android UI Inspector.app/Contents/Resources/cli/android-ui.cjs`；Windows/Linux 位于安装目录的 `resources/cli/android-ui.cjs`。使用 `node "实际路径" --help`，无需另装项目依赖。

## 先授权，再读取

1. 打开桌面软件，连接手机上的 Debug App。
2. 只查看已采集页面：**文件 → MCP → 共享当前快照（只读）**。
3. 实时采集或自动操作：**文件 → MCP → 开启自动调试…**，确认设备和 App。非 macOS 使用桌面中的自动调试入口。
4. `android-ui doctor --pretty` 检查；`android-ui attach --pretty` 读取现有授权，返回会话 `id`。

**本版需要桌面软件运行；attach 不会在后台自行授权、启动 App 或延长授权。** 只读模式不能操作手机；`devices` 和帮助命令无需打开桌面。自动调试沿用现有 30 分钟授权和随时停止机制。

默认在当前用户的系统应用数据目录寻找 `android-ui-inspector` / `Android UI Inspector` 的 `mcp/current.json`。也支持：

```sh
android-ui doctor --snapshot-file "/实际用户数据目录/mcp/current.json" --pretty
```

路径也可通过 `ANDROID_UI_INSPECTOR_MCP_SNAPSHOT` 环境变量指定，必须为绝对路径；`--snapshot-file` 优先。软件的 **复制 MCP 配置** 中有实际路径。发现多个共享目录时会报错，不猜当前设备；自定义用户数据目录需明确指定。

## 查看页面

```sh
android-ui snapshot --pretty
android-ui tree --depth 3 --pretty
android-ui tree --format text
android-ui tree --node '0/0' --depth 2
android-ui find TextView --by class --limit 10 --pretty
android-ui find '' --resource-id 'com.example:id/settings' --visible true
android-ui attributes --node '0/0' --pretty
android-ui measure '0/0' '0/1' --pretty
android-ui screenshot --out ./screen.png
android-ui screenshot --node '0/0' --out ./layer.png
```

- 默认输出单行 JSON，`--pretty` 为缩进 JSON；`tree --format text` 输出缩进树，分页信息写 stderr。页面文字中的终端控制字符会转义。
- 查询使用已共享的快照，**不会隐式刷新**。返回的 `snapshotId` 可用 `--snapshot ID` 固定版本；共享已更新、撤销或桌面已退出时拒绝读取。
- `tree` 是先序排列的 `items`，含 `id / parentId / depth`。指定子树后 depth 从 0 开始，子树根的 parentId 为 null。`depth=0` 只读根，默认 200、最大 200。
- `tree` 默认最多 1000 个节点，`--limit 20000` 可读取整个受支持快照；内部每批 500 个并复核快照 ID，不拼接不同版本。`nextOffset` 非 null 时用 `--offset` 续读；`depthLimited=true` 表示深度限制省略了子节点。
- `find` 默认模糊匹配全部字段。`--by class|id|text|desc` 限制搜索字段（id 指 resource-id）。`--resource-id / --text / --desc / --class` 是精确匹配，多个条件取交集；布尔筛选接受 `true` 或 `false`。
- `find / attributes` 默认每页 20、最多 50 条；`--offset` 分页。属性另用 `--attribute-offset`，结果中的 `nextAttributeOffset` 指出后续页；单个长字段最多 512 字符后标省略号，与 MCP 一致。
- 控件 ID 只属于当前快照，不是跨采集稳定的对象地址。尺寸和测距单位是 **screen px**，按原始布局外框计算，不是可见像素范围或 3D 展开间距。
- 不传 `--node` 导出整屏；传入时只导出该层自身的画面。无独立图像则报错，绝不裁切其他层补图。按实际格式使用 `.png / .jpg / .webp / .svg`；单图上限 6 MB。文件必须不存在，目录必须已存在；不会覆盖旧图，POSIX 文件权限为 0600。

## 自动调试

先从 `attach` 获得会话 ID，再显式传入；以下尖括号内容需换为实际值：

```sh
android-ui attach --pretty
android-ui capture --session '<会话ID>' --mode fast
android-ui find '' --snapshot '<采集返回的快照ID>' --resource-id 'com.example:id/settings' --clickable true
android-ui tap --session '<会话ID>' --snapshot '<同一快照ID>' --node '<查询到的节点ID>'
android-ui wait --session '<会话ID>' --text '设置' --state visible --timeout-ms 10000
android-ui stop --session '<会话ID>'
```

文字本身不可点击、对应父容器没有名称/ID时，可明确使用文字锚点：

```sh
android-ui tap --session '<会话ID>' --snapshot '<最新fast快照ID>' --node '<文字节点ID>' --target clickable-parent
```

默认`--target self`不变。父控件模式会重新核对唯一文字、父子关系、几何和状态；重名、位置变化、滚动父控件或子控件占据点击位置时拒绝，不自动改用坐标。操作后仍需`wait`或新源码的`task-check`验证目标页面。

另有：

```sh
android-ui capture --session '<会话ID>' --mode deep
android-ui scroll --session '<会话ID>' --snapshot '<最新fast快照ID>' --node '<滚动容器ID>' --direction down --distance 0.6 --duration-ms 350
android-ui back --session '<会话ID>' --snapshot '<最新fast快照ID>'
```

- `fast` 默认：无障碍语义树和整屏截图。`deep`：真实 Debug View/QML 层级和可获取的独立图层；可能较慢，不保证所有自绘控件均有图像。
- `tap / scroll / back` **必须明确提供会话和快照 ID**，不能让 CLI 偷换为最新快照套用旧节点 ID。仅使用 30 秒内的 fast 快照，沿用窗口、App、位置和歧义校验。
- 滚动方向指要查看的内容方向（down 看下方）；每次只滑动一次。返回可能丢弃编辑或离开 App，需自行确认业务影响。
- 操作返回 `dispatchState`：`not_sent / unknown / sent`。失败时保留此字段和证据路径；`unknown / sent` 不可当作“未操作”重试。`verified=false` 不表示点击没发出，需要再观察或用 `wait`、新源码的 `task-check` 验证。
- 输入命令退出0但有权限拒绝、错误/帮助文字、异常或截断回复时也会报错。步骤记录中的`inputEvidence`保存有上限的两路输出、退出和关闭状态；明确未启动为`not_sent`，已启动但失败为`unknown`，不自动重试或修改手机安全设置。
- `attach`返回的步骤中，`resolvedInput`保留执行前解析的操作、屏幕尺寸/方向、实际目标节点及点击锚点；输入失败或后续截图失败也保留。它表示计划投递的位置，不证明Android收到事件或业务回调执行；旧版本记录可能没有该字段。
- `attach`还返回本轮 `reportPath`。最近100步的前后树、整屏截图、派发回执与错误阶段可在桌面“查看调试记录”读取，停止后仍保留；独立导入时选择该路径的 `report.json` 并保留同目录 `artifacts/`。缺图、旧观察、留证失败分别标明，动作完成不代表整体验收通过。容量及兼容文件范围见[MCP记录说明](MCP.md#记录和数据范围)。
- `wait` 用精确 selector；至少传一项 `--resource-id / --text / --desc / --class`。状态支持 visible / absent / enabled / disabled，连续两次匹配才成功。默认 30 秒，上限 30 秒。
- Ctrl+C 取消当前请求；已发出的手机操作不能撤回。`stop` 才会撤销整个桌面会话。
- 更完整的安全、跨帧限制和留证说明见 [MCP.md](MCP.md)。CLI 不增加任意 shell、任意坐标、文本输入或真实属性修改接口。

### 复合单步与请求恢复（新源码）

目标已有明确的精确条件时，可以一次完成新观察、定位、输入和预期验证：

```sh
android-ui step --session '<会话ID>' --request-id '<新UUID>' --action tap \
  --resource-id 'com.example:id/settings' --clickable true \
  --expect-json '{"selector":{"text":"设置"},"state":"visible"}' --timeout-ms 30000
android-ui get-step --session '<同一会话ID>' --request-id '<同一UUID>'
android-ui resume-step --session '<同一会话ID>' --request-id '<同一UUID>' --timeout-ms 30000
```

`step` 支持 `--action tap / scroll / back`。点击和滚动用精确 selector，可用 `--within-json '{"resourceId":"com.example:id/list"}'` 限定唯一子树；滚动另传 `--direction`，返回不传目标。`--input-json` 可传完整协议对象，与其他输入参数互斥。参数结构见 [MCP 说明](MCP.md#perform-ui-step)。

同一请求 ID、同一参数返回已有状态，不会重复输入；同 ID 改参数会拒绝。`get-step` 只查台账，不采集。输入已发送或可能发送、后续读取失败时，用 `resume-step` 继续观察原预期，不重发点击或滚动。无 `--expect-json` 时仅返回操作后观察，`verified=false`；有预期仍要求连续两次观察符合，复用操作后观察作为第一次候选。

需要视觉确认时，先查看返回的快照，再用 `--visual-snapshot-id` 与 `--visual-confirmation` 描述该图中的目标；仍核对新旧证据。原请求为 `not_sent` 且需要修改参数时使用新 UUID；`sent / unknown` 不通过换 UUID 盲目重试。`step` 和 `scroll-until` 默认 `--backend uiautomator`，也可显式选 `--backend accessibility-helper`；Helper 必须提供完整观察证据，旧只读版本不能用于输入。整个请求及 `resume-step` 固定原后端和 Helper 服务实例，不自动回退或沿用其他来源的视觉确认。单步 `timings` 包含观察、校验、输入、恢复和保存阶段，真机提速幅度尚待对照验证。

### 有界连续滚动（新源码，真机回测待补）

容器与终点标记已明确时，用一个请求完成多次滚动。示例标识需换成当前 App 实际暴露的控件：

```sh
android-ui scroll-until --session '<会话ID>' --request-id '<新UUID>' \
  --resource-id 'com.example:id/favorites_list' --direction down \
  --until-json '{"selector":{"text":"没有更多了"},"kind":"end_marker"}' \
  --loading-json '{"text":"加载中"}' --empty-json '{"text":"暂无收藏"}' \
  --max-scrolls 6 --timeout-ms 120000
android-ui get-step --session '<同一会话ID>' --request-id '<同一UUID>'
android-ui resume-step --session '<同一会话ID>' --request-id '<同一UUID>'
```

- `--resource-id / --text / --desc / --class` 精确定位滚动容器，可用 `--within-json` 限定范围；容器必须唯一、可见、启用并具有滚动语义。`--until-json` 必填，其中 `kind` 默认为 `target`，明确终点用 `end_marker`。目标、加载和空列表标记只在该容器内匹配。
- 默认最多6次滚动，`--max-scrolls` 范围1–12；整个请求默认120秒，`--timeout-ms` 范围1000–120000。`--distance / --duration-ms` 与单次滚动相同。也可用 `--input-json` 传完整输入，不能与其他步骤输入旗标混用；结构见 [MCP 连续滚动](MCP.md#scroll-until)。
- 每次手势前重新定位、核对窗口和输入路径，手势后重新观察。目标或明确终点须连续两次可见确认，才有 `verified=true`；返回 `scrollTask.stopReason` 说明停止原因。`empty` 是空列表，`no_progress` 是无进展，`scroll_limit` 是次数耗尽，均不能当作“已到底”或任务成功。
- 同 ID 同参数只返回旧状态，不重启滚动。`get-step` 查询两种复合请求；`resume-step` 只恢复原条件观察，**不会续滑剩余次数**。滚动请求即使 `not_sent` 也可只读重验，例如第一屏已有目标、随后确认读取失败；P1 的普通 `step` 仍要求原输入为 `sent / unknown`。若确需继续，从新观察确认当前位置与已知回执后，用新请求定义下一段；`unknown` 时不能盲目换 ID 重发。
- `--visual-snapshot-id / --visual-confirmation` 只用于第一个手势。后续手势遇到无法确认的重叠时会停止，不把旧确认自动套到新页面。

本阶段完成源码和离线接口验证；尚未证明真机耗时改善。达到明确终点也只验证列表条件，不会自动点击“最后一个视频”。

内置 CLI 等待响应135秒，桌面桥接等待130秒，覆盖滚动执行的120秒预算并为收尾留出时间。外部 MCP 客户端可能默认60秒超时；使用完整120秒预算时，需把客户端请求超时设为至少135秒。客户端提前取消会终止后续观察与滚动，已发出的输入不会撤回；随后仍先查询原请求。

### 固定任务验收（新源码，尚未安装）

已用独立候选`diagnosis-handoff-20261011-ab4c3840`完成自有样例真机及报告重开；当前本机安装版仍未包含新接口。实测步骤见[上手第7步](FIRST_USE.md#7-可选完成一次固定样例任务)，范围见[验收](archive/ACCEPTANCE_HISTORY_2026-10-15.md#task-sample-flow-acceptance)。

在首次输入请求前，把目标和条件保存为`task.json`：

```json
{
  "goal": "打开设置页并确认保存按钮可用",
  "checkpoints": [{
    "id": "settings", "title": "已到设置页",
    "conditions": [{ "id": "title", "selector": { "text": "设置" }, "state": "visible" }]
  }],
  "finalConditions": [{ "id": "save", "selector": { "resourceId": "com.example:id/save" }, "state": "enabled" }]
}
```

```sh
android-ui task-define --session '<会话ID>' --task-file ./task.json
android-ui task-check --session '<会话ID>' --task-id '<定义返回的taskId>' --checkpoint settings
android-ui task-check --session '<会话ID>' --task-id '<同一taskId>'
```

定义不会采集或输入，之后不能改写；示例selector需换成实际App的精确标识。任务文件限16KiB，规范化定义限12KB。每次检查前按已有授权操作到相应页面，检查自身只读。阶段按序；复验会清除该阶段及后续结果，最终前置不足不采集。前置满足时固定当前来源两次新观察，不重试或自动换源；Helper 需完整证据且两次属于同一服务、窗口和屏幕。条件、额度及证据范围见[MCP任务验收](MCP.md#固定任务验收新源码尚未安装)。

`task-check`将结果JSON写stdout：`taskResult.status=passed`退出0；`failed / insufficient_evidence`退出2。非法参数、错误会话或任务ID等请求错误仍写stderr并退出1；Ctrl+C退出130。报告显示固定目标、阶段、逐条件结果和两次观察，导入缺树会降为证据不足。

### 可选 Helper 观察与操作

默认仍用 UIAutomator。旧快照和报告仍可只读查看；新版桌面的实时 Helper 采集与操作都需要观察 v1 服务，不会退回旧 `/dump` 协议。旧 Helper 安装版需升级，或显式改用 UIAutomator：

```sh
android-ui capture --session '<会话ID>' --mode fast --backend accessibility-helper
android-ui tree --snapshot '<新快照ID>' --pretty
android-ui attributes --snapshot '<同一快照ID>' --node '<节点ID>' --pretty
android-ui step --session '<会话ID>' --request-id '<新UUID>' --backend accessibility-helper \
  --action tap --resource-id '<实际控件资源ID>'
android-ui capture --session '<会话ID>' --backend uiautomator
```

Helper 须事先安装、手动启用、配对，并在桌面主进程启动时配置私有令牌文件。操作步骤见[交付说明](DELIVERY.md)，字段和限制见[MCP说明](MCP.md#helper-observation)。`hint / error / stateDescription` 单独返回，提示不冒充 text。完整 Helper 观察支持 `tap / scroll / back / wait / task-check`，输入仍由现有受控执行器发送；旧版或缺少窗口、可见区域、无损截图证据的快照仍只读。切换时旧 ID 立即撤销，新采集失败不自动换源或保留旧共享；需要回退时显式采集 UIAutomator 后重新定位。此前同页对照与单机动作结果见[真机记录](AUTOMATION_DEVICE_BENCHMARK.md)。

本轮已实现 Helper 白名单失败的只读恢复：每步最多增加2次读取，首次恢复起共用15秒截止时间，已发送输入不重放。返回 `observationFailures` 和有界 `helperDiagnostics`；确认中途失败会重新双帧验证，滚动换窗立即停止。候选已安装，单机点击/返回自动恢复通过；最后找底部遇遮挡后仍须同请求只读复查，规则及部署边界见[诊断与恢复说明](HELPER_OBSERVATION_RECOVERY.md)。

### 连接与采集诊断（新源码）

构建当前源码后使用；此命令只检查状态，不采集树、截图或输入：

```sh
node dist-electron/cli.cjs diagnose --serial '<设备序列号>' --package 'com.example.app' --mode fast --pretty
node dist-electron/cli.cjs diagnose --serial '<设备序列号>' --mode fast --backend accessibility-helper --timeout-ms 15000
```

`--package`可省略，此时检查当前前台App，仍复核实际授权归属。`--mode`为fast/deep，Helper只支持fast；默认fast/UIAutomator，时限1000–30000毫秒。结果含检查时间、设备/App/窗口、必需或可选项、未知及处理提示。独立CLI诊断默认标准模式：跳过SDK安装声明探测，SDK项明确显示“增强未启用”，不视为缺SDK失败；命令参数不能开启增强。Helper只核启用与配对配置，实际服务响应未验证。CLI/MCP实时采集还需已有桌面授权连接；缺少可选Helper不阻断UIAutomator。

就绪退出0，必需项失败、未知、超时或身份变化退出2，检查结果仍在stdout；非法参数等请求错误退出1。原`doctor`继续检查共享快照和桌面授权。Android日志选项在桌面授权前选择，`attach`返回日志是否开启和当前进度；CLI无法自行开启授权或日志。

### 一键多轮回测

构建后复用已有桌面授权，以固定计划重复执行操作并逐步导出证据：

```sh
bun run regression:ui --plan /绝对路径/plan.json --session '<会话 UUID>' --out /绝对路径/新的结果目录
```

脚本不自动授权或重放状态不确定的输入。缺少计时、图片或控件树会单独标记，不会把操作通过当成证据完整。计划字段、恢复边界及验证结果见[多轮回测说明](AUTOMATION_UI_REGRESSION.md)。

## 输出和验证

普通成功退出0；请求失败退出1，并向stderr输出JSON；Ctrl+C退出130。`task-check`未通过另退出2并保留stdout结果，见上节。`doctor`无共享/有效授权时也退出1，但诊断结果仍在stdout。`devices`将探测结果（包括`error`）写stdout，探测失败退出1；设备列表为空本身不算命令失败。

```sh
bun test tests/cli.test.ts tests/mcp.test.ts tests/debug-session.test.ts
bun run build
node dist-electron/cli.cjs --help
```

自动测试使用脱敏页面和模拟设备输入，不对真实手机执行点击或返回。覆盖 CLI 独立产物、树分页/深度/子树、查询过滤、属性分页、测距、图片格式/禁止覆盖、错误参数、旧快照拒绝、授权采集、点击/滚动/返回、验证失败留证和撤销。
