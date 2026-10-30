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
| `tap_node` | 默认点击节点本身；可显式用具名文字定位其可点击父控件；重新观察后返回新快照，**不代表验证通过** |
| `scroll_node` | 在指定可滚动控件内滑动一次，回传新快照；不接受任意坐标，不自动反复滚动 |
| `press_back` | 复核当前窗口后发送一次返回键，再观察；可能丢弃编辑或离开 App |
| `wait_for_ui` | 精确匹配控件条件，连续两次观察符合预期才通过；超时留证 |
| `stop_debug_session` | 撤销授权并取消进行中的操作 |
| `get_snapshot` | 当前共享快照的 ID、来源、采集模式和摘要 |
| `search_nodes` | 模糊查询、精确 selector，以及可见、启用、可点击、可滚动筛选；支持分页 |
| `get_node` | 原始控件属性、尺寸、父子关系；支持分页 |
| `get_image` | 整屏截图或控件独立图像；缺失不以截图裁剪冒充 |
| `measure_nodes` | 原始布局外框距离，单位 screen px，不是 3D 展开间距 |
| `get_tree` | 按深度读取整树或子树，先序分页，返回父节点 ID；不含图片 |

也可直接用终端命令，无需 MCP 客户端：`bun run cli --help`。CLI 和 MCP 复用同一套授权及工具实现，详见 [CLI 使用说明](CLI.md)。`search_nodes` 另支持 `by=all/class/id/text/desc` 限制模糊搜索字段。

典型顺序：

```text
get_debug_session → sessionId
capture_ui(sessionId, mode="fast") → snapshotId
search_nodes(snapshotId, query="设置") → 节点列表
get_node(snapshotId, nodeId) → 确认实际可点击控件
tap_node(sessionId, snapshotId, nodeId) → 新 snapshotId，verified=false
wait_for_ui(sessionId, selector={text:"通知设置"}, state="visible") → verified=true/false
```

等待条件支持 `resourceId`、`text`、`contentDesc`、`className`，所有已填写字段精确匹配。状态支持 `visible`、`absent`、`enabled`、`disabled`；默认超时及上限均为 30 秒。只统计授权 App 的可见语义节点。“不存在”不等于绘制树内完全没有这个对象；读取失败、窗口切换不能当作消失或通过。

### 文字不可点击、父容器没有 ID

某些列表把文字和点击区域分开：文字有名称，父容器可点击但没有自己的名称/ID。默认点击仍拒绝匿名控件，不自动向上找父节点。明确需要点击这一行时：

```text
search_nodes(snapshotId, selector={text:"播放设置"}, visible=true)
get_node(snapshotId, nodeId=文字节点ID)
tap_node(sessionId, snapshotId, nodeId=文字节点ID, target="clickable-parent")
wait_for_ui(sessionId, selector=目标页面独有的文字条件)
```

此模式以文字节点为锚点，重新采集并核对唯一标识、类型、位置及最近可点击父控件的祖先关系、尺寸和状态。重名、关系/位置变化、禁用、滚动父控件、越界或点击位置有可操作子控件时拒绝，不退回任意坐标。返回`anchorNodeId`和`targetNodeId`区分文字与实际点击区域。`target="self"`为默认行为；文字本身可点击时使用默认模式。

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
- `distance` 默认 0.6，范围 0.1–0.8，表示可见控件尺寸的比例；`durationMs` 默认 350，范围 150–1000。路径留出边缘余量，短于 64px 的滑动拒绝，降低被当作点击的风险；这不是所有设备的触摸识别保证。
- 只接受快照中明确 `scrollable=true`、启用、可见且有稳定标识的容器。路径与其他可操作控件或嵌套滚动区冲突时拒绝，不猜手势会交给哪个控件。控件未暴露滚动语义时不会强行模拟。
- 每次只滑动一次；图片相同或节点不变**不代表列表到底**。无界遍历、自动寻找滚动终点暂不实现。
- 返回键不保证留在 App。若返回后到了桌面或其他 App，采集失败，旧快照失效，后续操作被拒绝；用户需手动回到授权 App 后重新观察，MCP 不会操作授权范围外的页面。

所有手机操作都返回 `dispatchState`：`not_sent` 表示未交给执行器或明确未启动输入进程；`unknown` 表示执行器报错/中断、可能发出；`sent` 只表示输入命令正常结束且没有异常回复。退出码0伴随权限拒绝、帮助/错误文字、异常输出或截断也会拒绝，不能报成`sent`。`sent` 仍不等于业务结果正确，必须检查新页面。后续截图失败会同时返回错误和 `sent`，不要把它当作“没操作”再执行一次。

### 固定任务验收（新源码，尚未安装）

已用独立候选`diagnosis-handoff-20261011-ab4c3840`完成自有样例真机及报告重开；当前本机安装版仍未包含新接口。实测步骤见[上手第7步](FIRST_USE.md#7-可选完成一次固定样例任务)，范围见[验收](CORE_ACCEPTANCE.md#task-sample-flow-acceptance)。

在首次输入请求前调用`define_debug_task(sessionId, definition)`，获得`taskId`。每个授权会话只允许一个原始目标；定义后不能替换，即使旧步骤已滚动丢弃。定义只保存条件，不采集手机。`get_debug_session`返回固定任务及最新验收记录。

`definition`含`goal`、有序`checkpoints`及`finalConditions`，格式见[CLI示例](CLI.md#固定任务验收新源码尚未安装)。自然语言目标只作说明，判断使用精确selector及`visible / absent / enabled / disabled`。最多5阶段、每组10条件、总20条件、定义12KB；阶段ID分别唯一，条件ID在整个任务中唯一。

```text
define_debug_task(sessionId, definition) → taskId
check_debug_task(sessionId, taskId, checkpointId="settings") → 阶段结果
check_debug_task(sessionId, taskId) → 最终结果
```

- 阶段按定义顺序检查；可显式复验已检查的阶段，立即清除该阶段及后续旧结果。最终验收需全部前置阶段有效通过；前置不足返回`insufficient_evidence`，不采集。
- 前置满足后固定采集两次新的UIAutomator fast观察，间隔350ms，总时限30秒；同设备、App、Activity实例、窗口和几何须一致。没有输入、等待重试或隐式换源；Helper需先显式切回UIAutomator。
- `visible / enabled / disabled`须唯一匹配屏内可见控件；`absent`只证明完整树中没有屏内可见匹配，压缩树不能证明。缺范围、匹配歧义、结果变化、取消或采集失败均不能通过。
- `taskResult.status`为`passed / failed / insufficient_evidence`：两次均满足才通过，两次均不满足为失败，其他情况为证据不足。只证明声明的页面条件，不证明付款、服务端写入等业务副作用。
- 保存两次观察、逐条件结论和检查步骤/时间。导入重新读取树并判定，缺树或额度不足降为证据不足；缺PNG不影响树条件。任务当前阶段证明优先保留在现有额度内，不扩大存储上限。

任务结果在报告中单独展示；整会话仍为“记录中/已记录”。验收后再发生输入或后续步骤已丢弃，会提示重新验收，历史结论仍对应当时观察。新写入格式为`inspector-debug-report-2`，继续读取v1调试报告与旧e2e报告。离线范围见[验收](CORE_ACCEPTANCE.md#debug-task-acceptance)。

## 采集分工

- **轻量 fast**：默认屏幕截图 + UIAutomator 无障碍语义树，避免每一步采集大量独立位图。界面使用 2D，明确标识来源。这些语义节点可能是 VirtualChild，并非重新宣称它们是真实绘制控件。点击仅支持 UIAutomator 的 fast 快照。
- **深度 deep**：复用现有 Debug View / QML 采集，供背景、遮挡和布局分析，可能明显更慢。不会为了自动调试而重启 App；QML 服务尚未建立时明确失败，需要用户先在桌面按原流程建立连接。
- 不给出毫秒级速度承诺；UIAutomator 启动和等待空闲本身可能耗时。持续动画、无法暴露语义的自绘区域可能无法自动定位。
- 选中和实时快照会同步到桌面。缺失图层、跨帧采集等限制仍然存在，视觉疑点不自动等同于业务 Bug。

### 可选 Helper（源码已接入，仅只读）

`capture_ui(sessionId, mode="fast", backend="accessibility-helper")`读取 Helper 的语义树和整屏截图；默认仍为`backend="uiautomator"`，`deep`不接受 Helper。需事先安装并手动启用已核验 Helper、完成配对，在**桌面主进程的启动环境**配置`ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE`。值为私有令牌普通文件的绝对路径，≤1KiB、POSIX权限0600、属于当前用户；拒绝符号链接。仅配置 MCP/CLI 子进程的环境不会传给已运行桌面。工具参数不接受令牌或令牌文件路径。

只请求一次`GET /dump?fields=xml`；采集截止期限30秒，转发清理另按现有短时限完成；返回大小≤8MiB、窗口≤16、节点≤5000、XML深度≤200。沿用Debug准入、授权包、前后Activity实例/焦点窗口及主屏几何复核，只发布唯一授权焦点窗口，不共享其他窗口。令牌失效、空树、截断、错窗口、几何变化或取消均明确失败；不自动安装、启用、配对、换源或重试。复用现有转发归属检查，结束收回自有转发。

快照来源为`accessibility-helper`，不标为完整绘制树。摘要保留`text`，另给`hint / error / stateDescription`；原始属性中的状态键仍为`state-description`。提示不替代text，文本选择器不匹配hint。没有独立图层，不保证系统装饰节点与UIAutomator一致，树和截图也不保证同帧。

切换后端或fast/deep模式时先撤销旧共享，即使新采集失败也不能使用旧ID；成功生成新快照并重置工作台选中。Helper快照拒绝`tap_node / scroll_node / press_back / wait_for_ui`，不会为这些命令隐式换源。需要操作或验证时，先显式`capture_ui(sessionId, backend="uiautomator")`并重新定位。[限定范围补验](CORE_ACCEPTANCE.md#helper-body-window-stability-acceptance)已通过真机部分响应体的API/CLI/MCP取消、独立签名候选真实窗口及30分钟固定样例验证；仍保留12/10节点差异。该阶段保留原安装版，后续Mac arm64本机升级/回退已完成，见[交付验收](CORE_ACCEPTANCE.md#local-delivery-acceptance)；安装、启用和令牌配置见[交付说明](DELIVERY.md)。多设备、多日及端侧任务停止仍未验。

## 安全和一致性

- 默认关闭。用户在桌面授权指定设备和包名；AI 不能通过 MCP 开启或延长授权。
- 操作前后核对前台 Activity、焦点窗口、Debug 状态和屏幕方向/尺寸。跳到其他 App、系统弹窗或无法确认窗口时拒绝操作。
- 点击、滚动、返回只使用 30 秒内的 fast 快照。执行前重新采集，对照窗口、方向和尺寸；控件操作还核对标识、文本、类型、位置和可用状态。匹配不唯一、位置变了或操作路径冲突时拒绝。发送输入命令前再次核对窗口和屏幕，并固定在主屏操作。
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

失败增加 `error.category / code / phase / message`，阶段区分采集、定位、输入、验证和留证。写盘问题另记 `recordingErrors` 并通过 `recordingWarning` 返回，不覆盖动作的原始错误或派发回执。点击、滚动、返回完成仍是 `verified:false`；`wait_for_ui`连续两次条件匹配只表示页面断言通过。固定任务使用独立`check_debug_task`结果，不能根据输入回执或单个页面断言宣布整个任务完成。

桌面“查看调试记录”直接读取本轮记录，也可在“测试报告”导入调试目录的 `report.json`；移动或复制时保留 `artifacts/`。页面支持步骤/错误搜索、前后画面与控件属性、实际点击/滑动标记。缺失、旧观察和投递未确认单独显示；只读历史不触发手机操作。旧e2e仍导入 `summary/index.json`，保持原始报告及摘要校验。调试报告预览的树、图片各限16MiB；图片须完整解码，单图16M像素、总64M像素，超限明确显示不可读取。

实际输入步骤的`inputEvidence`保留退出码、终止信号、进程启动/关闭、耗时和错误分类，以及stdout/stderr各前4096字节（UTF-8文本）及截断标记。权限拒绝、断线、非法命令、异常回复、取消/超时分别记录；取消仅终止自有主机输入进程，不关闭共享ADB服务。输入命令仍限5秒，未知结果不自动重试；设备拒绝时不会自行调整手机安全设置。错误输入之后没有新观察时，after明确为空，不伪造画面。

`resolvedInput`在输入投递前记录实际操作（点击坐标、滑动路径或返回）、屏幕尺寸/方向；控件操作另有`targetNodeId`，点击另有`anchorNodeId`。字段出现在`get_debug_session`步骤及本地失败证据中，后续取图失败也不丢失；旧记录缺失时不补猜。它只是解析结果，不代表系统命中或业务回调成功，需结合`dispatchState`、输入回复和目标页条件判断。

这些记录不自动上传，也不自动跨会话删除；含敏感内容时可从“打开失败证据”进入目录后自行删除。实时共享快照单个JSON仍限50MiB；调试留证按上述独立额度控制。工具只读取当前授权范围，不开放历史目录浏览。

不操作手机时，仍可选择 **共享当前快照（只读）**。该模式仅共享手动确认的一份快照，不开启实时会话；切换或重新采集会撤销共享。

## 暂不包含

文本输入、任意手势、自动遍历整个 App、视觉像素断言、自动修复源码和重新编译尚未加入。没有无障碍标识的自绘对象不通过猜坐标强行操作。

## 验证

```sh
bun test tests/mcp.test.ts tests/debug-session.test.ts tests/debug-evidence.test.ts tests/debug-report.test.ts tests/debug-report-integration.test.ts tests/debug-report-view.test.ts
bun test tests
bun run build
node_modules/.bin/electron scripts/native-menu-checks.cjs
```

测试覆盖 MCP 官方客户端、stdio、桥接口令与 Origin、精确搜索/布尔筛选、固定输入命令、四向滚动路径、旧快照/错 App/窗口旋转/重叠嵌套拒绝、返回后离开 App、连续观察验证、超时留证、记录保存失败、并发拒绝和取消后迟到结果不再发布。桌面测试用脱敏 fixture，不自动授权真实手机数据。

依据：[MCP 工具机制](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[Android ADB](https://developer.android.com/tools/adb)。


## 连接诊断与进度（新源码）

`diagnose_connection`只读检查所选设备和目标App，参数为`serial`、可选`packageName`、`captureMode: fast|deep`、`backend: uiautomator|accessibility-helper`及`timeoutMs: 1000–30000`。默认fast/UIAutomator。返回检查时间、固定身份、必需/可选项、处理提示和`outcome: ready|blocked|unknown`；超时、取消、设备/App/窗口改变不能显示就绪。Helper实际响应、SDK运行尚未验证时明确说明，缺少可选项不阻断其他采集方式。

`get_debug_session`和CLI的`attach`复用已有入口，新增当前步骤、采集/执行/等待/保存/失败/停止或到期状态及时间。授权有效、操作完成、Checker验收分别显示，进度不新增任务执行器，也不把操作完成当作任务通过。

会话步骤关联有界的程序错误日志。桌面授权前显式开启Android日志后，仅尝试读取目标App主进程、步骤时间范围内的错误行；不能确认PID、启动身份或时间时标记缺证据。日志与截图、回执在同一步查看，保存至原报告目录并计入32MiB总预算；停止取消本次日志请求。旧报告无日志时继续可读，缺日志不改变动作回执或Checker判定。实时预览帧只在桌面观察，不进入共享快照、报告或任务验收。
