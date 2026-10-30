# Android UI Inspector

一个本地优先、仅支持 **Debug App** 的 Android UI 层级检查工具。通过ADB读取真实控件树、独立View位图和屏幕截图，用WebGL展示可展开、可选中的3D层级。

当前桌面使用Electron + React + TypeScript + Vite，面向Windows、macOS和Linux；不需要后端账号，设备数据与快照默认保存在本机。Mac arm64安装候选的版本、安装和Helper配置统一见[交付说明](docs/DELIVERY.md)；当前源码能力和保留缺口见[项目状态](docs/PROJECT_STATUS.md)。

2026-10-15：**R0–R8 架构重构已完成并验收**，源码已同步。职责边界与八轮结果见[架构收尾](docs/ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)；桌面安装候选保持原版本，UI、跨平台发布和专项设备缺口按各自记录保留。

[第一次使用](docs/FIRST_USE.md) · [项目状态](docs/PROJECT_STATUS.md) · [当前安排](docs/LOOKIN_ALIGNMENT_PLAN.md#下一步) · [最近验收](docs/CORE_ACCEPTANCE.md#architecture-round8-acceptance) · [文档索引](docs/README.md)

## 主要能力

- 发现ADB与设备授权状态；SDK提供进程内树/属性/独立图，未接SDK的原生View使用Debug hierarchy及DDMS/JDWP兼容补采，Qt/QML有专项通道。
- 左侧真实控件树与2D/3D同步选择、折叠、搜索和键盘浏览；大树虚拟化，最多展示512个子层并明确提示截断。
- 展开看控件自身图、折叠看分支合成；悬停/选中、隐藏/恢复、分支聚焦、单层查看及测距。
- 旋转/平移/缩放，2D/3D适应避开属性栏；属性默认贴边，可收起、关闭或切为浮窗。
- 属性搜索、完整值复制与按需详情；本地历史/对比，JSON/XML/PNG通过系统保存框导出。
- 渐进采集、取消和迟到隔离；首页离线历史、菜单/偏好及本地报告步骤/截图查看。
- CLI/MCP只读共享与授权调试；固定App的单次只读诊断，不自动输入、导航或重试。

## 使用边界

- App必须允许`run-as`且确实可调试；Release拒绝。桌面深度采集读取Debug View/QML，不回退到UIAutomator；CLI/MCP的fast采集默认UIAutomator，可显式选择只读Helper。
- Compose、Flutter、WebView内部树及任意自绘尚未完整支持；Surface/Texture能否读取真实画面取决于系统、厂商和保护标记，不绕过DRM。
- 位图须通过窗口身份和唯一匹配；缺图、歧义、失败与已测透明分别显示，不裁整屏冒充独立图。
- 合成支持已暴露的Z、矩形/padding裁剪和组透明度；未暴露的圆角、任意变换、绘制顺序不保证逐像素一致。采集不是冻结同一帧。
- QML可重建基础背景/圆角/边框/线性渐变，部分无可视子项控件可取独立PNG；复杂自绘和带子项画面仍有边界，首次调试连接可能重启目标App。

## 快速开始

需要Bun、Node.js 22+、Android SDK Platform-Tools及对应平台的Electron构建环境。桌面环境为Windows 10/11、macOS 12+或主流Linux。

```powershell
bun install
adb devices -l
bun run dev
```

手机开启USB调试并完成RSA授权，ADB状态须为`device`。先打开Debug App，再在首页选设备并点击“采集当前画面”；工作台顶部可再次采集。SDK增强树/属性/位图的接入见[Android说明](android/README.md)。

生产构建启动：

```powershell
bun run build
bun run start
```

修改源码后重新构建。开发模式会监听renderer、main/preload和MCP；Windows启动前准备Electron沙箱读取/执行权限，不关闭sandbox。

工作台左树、右画布，属性覆盖画布。点击树节点或截图可互相定位；底部搜索只临时显示命中路径，清除恢复原折叠。双击可设为展开/收起、聚焦分支或仅展开；退出聚焦恢复原视图，隐藏状态保留。新源码的[默认折叠](docs/FIRST_USE.md#initial-tree-collapse)可按类型/层级设置，保留完整树和手动状态。历史从首页或顶部打开，离线也可查看。

3D拖动旋转，空格/Shift/中键拖动平移，滚轮缩放。点击基准层再悬停另一层可测距，单位是原始外框px。右键或`Shift+F10`提供隐藏/聚焦；隐藏只影响当前查看，不修改手机或快照。浮窗标题可拖动、方向键微调、Home复位、Escape关闭。

属性搜索临时展开详情，清除恢复折叠；类名/ID复制完整值，未知值显示“—”，与实测0分开。菜单、顶部与右键共用动作和偏好。

新源码的[颜色预览与别名](docs/FIRST_USE.md#color-preview-aliases)支持真实源色的透明色块、原值/CSS Hex/RGBA复制；“偏好设置 → 颜色别名”可保存精确颜色名称，搜索可找到。保留原ARGB及透明度，安装版尚未更新。

新源码的[按需图层加载](docs/FIRST_USE.md#layer-demand)先处理选中和视口内图层，移动视口自动补图；同次采集的分支图可复用，刷新后失效旧图。完整深度采集与离线文件查看保留，安装版尚未更新。

| 操作 | macOS | Windows/Linux |
| --- | --- | --- |
| 采集 / 刷新 | ⌘R / ⌘⇧R | Ctrl+R / Ctrl+Shift+R |
| 搜索 / 保存 | ⌘K / ⌘S | Ctrl+K / Ctrl+S |

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `bun run dev` / `bun run build` / `bun run start` | 开发、构建、生产启动 |
| `bun run test` | 单元与解析回归 |
| `bun run test:tree-ui` | 实际树/场景、取消与迟到回归 |
| `bun run test:coordinates` / `bun run test:dpi` | 坐标/图层像素与DPR代理 |
| `bun run test:diagnosis-handoff` | 实际工作台、报告生命周期和首页检查 |
| `bun run benchmark:tree` / `bun run benchmark:layers` / `bun run benchmark:render` | 合成性能基准，方法见[树性能](docs/TREE_PERFORMANCE.md) |
| `bun run visual:baseline` / `bun run visual:home` / `bun run visual:home:states` | 固定fixture的工作台/首页/状态截图 |
| `bun run diagnose:startup software` | 启动诊断，见[Windows说明](docs/WINDOWS_STARTUP.md) |
| `bun run cli --help` | [CLI](docs/CLI.md)；[MCP接入](docs/MCP.md)默认关闭 |

完整参数和按改动选择的回归见[测试计划](docs/TEST_PLAN.md)。源码、隔离工装、安装窗口与手机分别记录；DPR代理不等于物理DPI/多显示器，合成性能不等于真机速度。

## 测试与打包

常规改动先跑相关测试，再按[测试计划](docs/TEST_PLAN.md#按改动选择回归)完成必要检查：

```powershell
bun run test
bun run build
```

桌面合成冒烟使用独立配置，不连接手机：

```powershell
node --experimental-websocket scripts/app-smoke.mjs --fixture --reduced-motion
```

真机冒烟会采集当前页面，须在当前任务明确设备/App和范围后使用`bun run smoke:app --require-device`；打包版用`node scripts/app-smoke.mjs --packaged --require-device`。截图、XML和日志仅写入忽略的`.benchmarks/`，不要发布私人页面。

```powershell
bun run package
bun run package:win
bun run package:mac
bun run package:linux
```

在对应操作系统或CI runner构建。Windows打包和NSIS安装保留既有权限并追加Electron所需读取/执行权限，renderer sandbox保持开启。打包不会自动发布到GitHub。

`.github/workflows/static-render.yml`运行三平台静态检查；`native-electron.yml`覆盖fixture冒烟、原生包构建和启动。最终CI状态看Actions记录。正式签名、公证、干净系统安装/升级/卸载仍待完成；本机临时签名不属于正式发布验收。

## 目录与贡献

`electron/`负责桌面/ADB/IPC/持久化，`src/`负责界面，`shared/`负责共享类型和纯算法，`tests/`放脱敏回归，`benchmarks/`放合成工装，`scripts/`放编排，`docs/`放说明。`dist*/release/`与`.benchmarks/`是本机产物，不手动回写源码、不提交。

详细入口和新文件位置见[开发目录](docs/DEVELOPMENT_STRUCTURE.md)。renderer仅通过preload白名单访问桌面能力；主进程校验IPC，产品不依赖诊断脚本。新增解析边界须配脱敏fixture和必要提示，运行对应回归；ADB输出、个人快照、业务截图与APK不得入库。

已完成架构批次统一看[收尾总表](docs/ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)。历史UI方案、独有失败及旧验收见[归档索引](docs/archive/README.md)；后续产品方向在[Lookin计划](docs/LOOKIN_ALIGNMENT_PLAN.md#下一步)维护，旧记录不自动恢复执行。
