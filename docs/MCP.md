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
| `tap_node` | 通过会话、快照 ID 和节点 ID 点击；重新观察后返回新快照，**不代表验证通过** |
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

所有手机操作都返回 `dispatchState`：`not_sent` 表示尚未交给输入执行器，`unknown` 表示输入执行器报错/中断、可能发出，`sent` 表示输入命令已完成。`sent` 仍不等于业务结果正确，必须检查新页面。后续截图失败会同时返回错误和 `sent`，不要把它当作“没操作”再执行一次。步骤记录同样保存此状态。

## 采集分工

- **轻量 fast**：屏幕截图 + UIAutomator 无障碍语义树，避免每一步采集大量独立位图。界面使用 2D，明确标识来源。这些语义节点可能是 VirtualChild，并非重新宣称它们是真实绘制控件。只在此模式下允许点击。
- **深度 deep**：复用现有 Debug View / QML 采集，供背景、遮挡和布局分析，可能明显更慢。不会为了自动调试而重启 App；QML 服务尚未建立时明确失败，需要用户先在桌面按原流程建立连接。
- 不给出毫秒级速度承诺；UIAutomator 启动和等待空闲本身可能耗时。持续动画、无法暴露语义的自绘区域可能无法自动定位。
- 选中和实时快照会同步到桌面。缺失图层、跨帧采集等限制仍然存在，视觉疑点不自动等同于业务 Bug。

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

本机 `userData/mcp/runs/<sessionId>/steps.json` 保留最近 100 步，含请求参数、时间和结果。每次会话只保留最近一次失败的 `last-failure.json`，内含相关步骤和前后快照（图片为 data URL）。点击、滚动、返回之后的验证失败，保留的是操作前后画面。快照有各自时间戳，不是同一时刻拍摄；采集失败时最新快照可能为空或仍是上一次成功观察。留证失败会明确提示；步骤记录写入失败也会通过 MCP 的 `recordingWarning` 返回，不只显示在桌面。

这些记录不自动上传，也不自动跨会话删除；含敏感内容时可从“打开失败证据”进入目录后自行删除。单个 JSON 上限 50 MB，超限明确报错。工具只读取当前授权范围，不开放历史目录浏览。

不操作手机时，仍可选择 **共享当前快照（只读）**。该模式仅共享手动确认的一份快照，不开启实时会话；切换或重新采集会撤销共享。

## 暂不包含

文本输入、任意手势、自动遍历整个 App、视觉像素断言、自动修复源码和重新编译尚未加入。没有无障碍标识的自绘对象不通过猜坐标强行操作。

## 验证

```sh
bun test tests/mcp.test.ts tests/debug-session.test.ts
bun test tests
bun run build
node_modules/.bin/electron scripts/native-menu-checks.cjs
```

测试覆盖 MCP 官方客户端、stdio、桥接口令与 Origin、精确搜索/布尔筛选、固定输入命令、四向滚动路径、旧快照/错 App/窗口旋转/重叠嵌套拒绝、返回后离开 App、连续观察验证、超时留证、记录保存失败、并发拒绝和取消后迟到结果不再发布。桌面测试用脱敏 fixture，不自动授权真实手机数据。

依据：[MCP 工具机制](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[Android ADB](https://developer.android.com/tools/adb)。
