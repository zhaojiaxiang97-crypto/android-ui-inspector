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

### 固定任务验收（新源码，尚未安装）

已用独立候选`diagnosis-handoff-20261011-ab4c3840`完成自有样例真机及报告重开；当前本机安装版仍未包含新接口。实测步骤见[上手第7步](FIRST_USE.md#7-可选完成一次固定样例任务)，范围见[验收](CORE_ACCEPTANCE.md#task-sample-flow-acceptance)。

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

定义不会采集或输入，之后不能改写；示例selector需换成实际App的精确标识。任务文件限16KiB，规范化定义限12KB。每次检查前按已有授权操作到相应页面，检查自身只读。阶段按序；复验会清除该阶段及后续结果，最终前置不足不采集。前置满足时固定两次新UIAutomator观察，不重试或自动换源。条件、额度及证据范围见[MCP任务验收](MCP.md#固定任务验收新源码尚未安装)。

`task-check`将结果JSON写stdout：`taskResult.status=passed`退出0；`failed / insufficient_evidence`退出2。非法参数、错误会话或任务ID等请求错误仍写stderr并退出1；Ctrl+C退出130。报告显示固定目标、阶段、逐条件结果和两次观察，导入缺树会降为证据不足。

### 可选 Helper 只读采集

Mac arm64本机交付版已支持以下入口；默认仍用UIAutomator：

```sh
android-ui capture --session '<会话ID>' --mode fast --backend accessibility-helper
android-ui tree --snapshot '<新快照ID>' --pretty
android-ui attributes --snapshot '<同一快照ID>' --node '<节点ID>' --pretty
android-ui capture --session '<会话ID>' --backend uiautomator
```

Helper须事先安装、手动启用、配对，并在桌面主进程启动时配置私有令牌文件。操作步骤见[交付说明](DELIVERY.md)，字段和限制见[MCP说明](MCP.md#可选-helper源码已接入仅只读)。`hint / error / stateDescription`单独返回，提示不冒充text。Helper仅支持fast采集和已有快照查询，不支持`tap / scroll / back / wait`；需先显式采集UIAutomator并重新定位才能操作。切换时旧ID立即撤销，新采集失败不会自动换源或保留旧共享。本机升级/回退已完成，验证范围见[交付验收](CORE_ACCEPTANCE.md#local-delivery-acceptance)。

### 连接与采集诊断（新源码）

构建当前源码后使用；此命令只检查状态，不采集树、截图或输入：

```sh
node dist-electron/cli.cjs diagnose --serial '<设备序列号>' --package 'com.example.app' --mode fast --pretty
node dist-electron/cli.cjs diagnose --serial '<设备序列号>' --mode fast --backend accessibility-helper --timeout-ms 15000
```

`--package`可省略，此时检查当前前台App，仍复核实际授权归属。`--mode`为fast/deep，Helper只支持fast；默认fast/UIAutomator，时限1000–30000毫秒。结果含检查时间、设备/App/窗口、必需或可选项、未知及处理提示。SDK只核安装声明，Helper只核启用与配对配置，实际服务响应未验证。CLI/MCP实时采集还需已有桌面授权连接；缺少可选Helper不阻断UIAutomator。

就绪退出0，必需项失败、未知、超时或身份变化退出2，检查结果仍在stdout；非法参数等请求错误退出1。原`doctor`继续检查共享快照和桌面授权。Android日志选项在桌面授权前选择，`attach`返回日志是否开启和当前进度；CLI无法自行开启授权或日志。

## 输出和验证

普通成功退出0；请求失败退出1，并向stderr输出JSON；Ctrl+C退出130。`task-check`未通过另退出2并保留stdout结果，见上节。`doctor`无共享/有效授权时也退出1，但诊断结果仍在stdout。`devices`将探测结果（包括`error`）写stdout，探测失败退出1；设备列表为空本身不算命令失败。

```sh
bun test tests/cli.test.ts tests/mcp.test.ts tests/debug-session.test.ts
bun run build
node dist-electron/cli.cjs --help
```

自动测试使用脱敏页面和模拟设备输入，不对真实手机执行点击或返回。覆盖 CLI 独立产物、树分页/深度/子树、查询过滤、属性分页、测距、图片格式/禁止覆盖、错误参数、旧快照拒绝、授权采集、点击/滚动/返回、验证失败留证和撤销。
