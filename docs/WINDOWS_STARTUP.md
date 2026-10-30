# Windows 沙箱启动修复与验收

记录日期：2026-09-12。环境：Windows 10.0.26200 x64、Electron 44.3.0、Bun 1.4.2、测试脚本 Node.js 24.19.0。

## 问题与修复

本次发现三个相互独立的问题：

| 问题 | 本机证据 | 修复 |
| --- | --- | --- |
| 沙箱子进程不能读取运行时文件 | 最小本地页也失败；renderer/GPU 退出码 `-2147483645`，即 `0x80000003`；仅追加 ACL 后同一探针通过 | 为 Electron 运行时目录追加 `S-1-15-2-2` 的可继承 ReadAndExecute |
| preload 找错目录 | 主进程产物将 `__dirname` 固化为源码 `electron` 目录；日志显示 `electron/preload.cjs` 不存在 | 通过 `app.getAppPath()` 拼接 `dist-electron/preload.cjs` 和 `dist/index.html` |
| 本地页面资源路径不正确 | Vite 产物引用 `/assets/...`，在 `file://` 下找不到 JS/CSS | 配置 `base: "./"`，生成相对资源路径 |

Electron 官方仓库有与受限运行时文件 DACL 对应的 [Windows GPU/renderer 故障报告 #51761](https://github.com/electron/electron/issues/51761) 和 [LPAC 可执行文件访问报告 #49143](https://github.com/electron/electron/issues/49143)。它们提供了排查线索；本机结论依据上述最小探针的修复前后对照，并不代表所有 Windows 白屏都由 ACL 引起。

正式应用继续启用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。只保留 `app.disableHardwareAcceleration()` 软件渲染，移除之前的 `in-process-gpu`、强制 ANGLE 等组合开关。启动失败会写入应用用户数据目录下 `logs/startup.log` 并显示错误提示。

## 权限范围

- `scripts/windows-runtime-access.ps1` 仅接受 Development/Unpacked 两个固定目标，验证目标目录和对应 EXE，拒绝目录本身是重解析点的情况。
- 开发目标：`node_modules/electron/dist`；Windows x64 打包目标：`release/win-unpacked`。
- 只追加受限应用包 SID `S-1-15-2-2` 的读取/执行权限及文件/目录继承。不赋予写权限、不重置原 ACL、不修改源码或工作区根目录权限。
- 修改前将目录原始访问 SDDL 备份到 `.benchmarks/acl/`；已有满足要求的权限时不重复修改，并检查 EXE 是否继承。回滚前应比较后续权限变更，不直接覆盖整份旧 ACL。
- `start`/`dev` 启动辅助脚本自动准备开发运行时；`build/after-pack.cjs` 为解包产物准备权限。目标不是约定的 Windows x64 输出目录时明确报错，避免误改其他路径。
- `build/installer.nsh` 在实际 `$INSTDIR` 上以 `icacls /grant` 追加相同权限。命令失败会提示并返回失败，不带着已知权限故障静默完成安装。

这些权限只解决运行时文件可读性，不绕过 Android 授权、不提升应用权限，也不关闭 renderer 沙箱。

## 复现与回归

```powershell
bun run prepare:windows
bun run diagnose:startup software default
bun run test
bun run smoke:app --require-device
bun run benchmark:layers
bun run benchmark:render
bun run test:dpi
bun run package:win
node scripts/app-smoke.mjs --packaged --require-device
```

`diagnose:startup` 使用无设备数据的最小本地页面，检查按钮点击、截图、preload 沙箱标记和子进程状态；不自动修复 ACL，便于对照。可选模式包括 software、default、legacy、no-in-process。失败会返回非零退出码。

`smoke:app` 构建并启动真实应用，通过仅监听回环地址的临时调试端口操作桌面 DOM，检查：

1. React 页面与真实 preload 已加载；沙箱和上下文隔离开启，页面不能访问 `require`。
2. 点击“刷新设备”，读取真实 ADB 探测结果。
3. 在顶部 Toolbar 选择已授权设备，点击唯一的“采集截图”，读取真实层级及截图；点击左侧树节点并校验右侧高亮联动。
4. 校验右侧 2D/3D 层级视图、父子 layer、breadcrumb、360°球面相机、layer 快速切换、默认正面姿态、viewport 边缘拖动、键盘旋转、25%–1600% 缩放和适应窗口。
5. 检查 bounds 高亮、节点几何尺寸/盒模型属性，点击桌面截图并确认选中节点 bounds 包含点击坐标。
6. 输入搜索词并清除筛选，检查资源/运行时错误，保存实际窗口 PNG；3D 状态额外保存 `layers3d.png`。

追加 `--reduced-motion` 会通过 CDP 模拟系统动态偏好并断言 3D layer 的 CSS 动画为 `none/0s`；追加 `--expect-landscape` 会要求真实截图为横屏并核对 rotation/尺寸 metadata。`benchmark:layers` 在纯共享布局层覆盖 1,000、5,000、10,000、25,000 节点和 balanced/wide 两种树形，验证 96/256 layer 上限。

`test:dpi` 会以 1/1.25/1.5 三个 `force-device-scale-factor` 启动隔离 Electron，复用生产 `ScreenshotPreview` 坐标矩阵，每档 25 组并检查 `devicePixelRatio`。这是系统 DPI 的可重复代理；不会修改当前 Windows 显示缩放，也不能替代多显示器 Per-Monitor DPI 实测。

3D 相机的 `Yaw` 可环绕完整 360°，`Pitch` 会限制在接近水平极点之前；Alt+左键或右键拖动负责环绕，空格/Shift/中键负责平移，Ctrl/⌘+滚轮负责截图倍率。节点详情中的 screen px 宽高由 UIAutomator `bounds` 实测计算；原生 Android 不是 CSS DOM，padding、border、margin 和真实 content 区域会显示为“未暴露”，不能把未知值当成 0。

脚本使用 `.benchmarks/app-smoke/<时间>/profile` 作为独立用户数据目录，不读写用户原有快照历史。不会发送手机触摸或输入命令；会通过 ADB 生成/读取 UIAutomator dump 和读取屏幕截图。所有报告与截图留在本机，请勿将包含私人页面的产物直接发布。脚本退出后关闭它自己启动的应用，正常应用启动不附带调试端口。

没有授权设备时，默认明确标记真机步骤 skipped；`--require-device` 会直接失败，适合接入实机的验收。无设备时可用 `--fixture --viewport=WxH` 运行固定视觉基线；三平台打包启动由 `scripts/packaged-startup.mjs` 和 native CI workflow 负责。

## 已验证结果与边界

- 最小探针：software/default 两种模式均通过，按钮计数为 1，窗口截图非空，renderer 沙箱为 true、完整性等级为 untrusted；GPU 进程沙箱为 true。
- 本地构建真实应用：五项检查通过，授权设备 1 台，当前页面 15 个节点、约 6.0 KB XML、1080×2400 PNG，renderer 错误列表为空。
- 打包后的 `release/win-unpacked/Android UI Inspector.exe`：同样五项检查通过，手机当时页面 29 个节点、约 11.8 KB XML、1080×2400 PNG；沙箱/上下文隔离均为 true，Node 未暴露，renderer 错误列表为空。节点数量差异来自两次检查时手机页面不同。
- `bun run package:win` 成功，afterPack 权限准备与 NSIS include 均已接入，打包版启动前的权限检查为 `changed: false`，证明测试脚本未临时补修产物 ACL。
- ASAR 中主进程、preload、HTML 与本次构建一致，没有嵌入开发机源码绝对路径，也未包含基准/冒烟脚本。
- 额外使用隔离 NSIS 探针执行了正式 `customInstall` 宏：在 `.benchmarks/installer-acl/runtime with spaces` 中确认原 ACL 保留、仅新增读取/执行权限、子文件正确继承、重复执行 ACL 不变。此探针不注册应用、不创建快捷方式、不写卸载注册表；不能代替完整安装流程验收。
- 七项树工具测试通过；正常沙箱下真实 DOM 八类行为检查通过。性能数值见 [性能报告](TREE_PERFORMANCE.md)。
- 原始对照：`.benchmarks/startup/2026-09-12T07-16-51-181Z/`（修复前）、`.benchmarks/startup/2026-09-12T07-33-26-827Z/`（修复后）。
- 本地构建实机报告：`.benchmarks/app-smoke/2026-09-12T07-32-34-404Z/`。
- 打包版实机报告：`.benchmarks/app-smoke/2026-09-12T07-35-25-218Z/`。

虚拟列表接入时的历史 NSIS 产物：112,220,485 字节，SHA-256：`91080EFFCD72B343A18F0540DC3A2CC7E6E2F8BD140AF2696FC6E8626E3D2E40`。当前产物已由下述坐标修复版本替换；没有代码签名，不能把构建日志中的 signtool 步骤理解为已签名。

后续虚拟列表回归：本地构建和打包 EXE 分别于 `2026-09-12T07:53:27Z`、`2026-09-12T07:56:28Z` 通过七项真实应用检查，均读取 25 个节点、约 10.1 KB XML 和 1080×2400 PNG。新增检查包括空筛选后的重复截图定位、全部展开及 End/Home 键盘导航；沙箱/上下文隔离仍开启，观察到的 renderer 错误为空。完整记录见 [性能报告](TREE_PERFORMANCE.md)。

后续坐标修复（2026-09-12）：构建版 `08:22:01Z`、打包 EXE `08:24:53Z` 各通过 8 项实机检查；打包版 `08:27:40Z` 增加快照 metadata 保存/读取/历史预览后通过 9 项。截图均为 2400×1080 横屏，XML 及截图前后方向一致，18 个节点、约 7.3 KB XML，renderer 错误为空。沙箱/隔离保持开启，打包运行前权限检查 `changed: false`。详见 [坐标验收](SCREEN_COORDINATES.md)。

用户切回竖屏后，同一打包 EXE `08:30:02Z`、构建版 `08:30:11Z` 均通过 9 项检查：1080×2400、29 节点、约 11.8 KB XML，XML/前后 frame rotation 均为 0，renderer 错误为空。报告分别在 `.benchmarks/app-smoke/2026-09-12T08-30-02-403Z/` 与 `2026-09-12T08-30-11-524Z/`。

解析 fixture 和边界修复后的打包版于 `08:42:11Z` 通过 9 项检查；加入 200 层 XML 深度预算后的最新包又于 `08:57:27Z` 通过 9 项竖屏实机检查，当前页面 77 个节点、约 26.2 KB XML。报告分别在 `.benchmarks/app-smoke/2026-09-12T08-42-11-949Z/` 与 `2026-09-12T08-57-27-979Z/`。

最新 NSIS：`release/Android UI Inspector Setup 0.1.0.exe`，112,306,932 字节，约 107 MiB；SHA-256：`2D57C01E85502336DA7ACF7FD3CB737025DCCC9FE9F0066ACE975F5C18340F2B`，Authenticode 状态 `NotSigned`。ASAR 共 227 条目，5 个 JS/CSS/HTML 构建文件与本地生成文件逐字节一致；包含完整 hierarchy、原始属性和虚拟节点提示逻辑，不含基准、冒烟脚本或 fixture。

完整 hierarchy、原始属性表和 VirtualChild 提示改动后的最终打包版于 `10:13:50Z` 通过 10 项竖屏实机检查，当前页面 36 个节点、约 14.2 KB XML，确认使用完整 hierarchy 模式，renderer 错误为空。报告在 `.benchmarks/app-smoke/2026-09-12T10-13-49-966Z/`。

3D 层级展开与缩放首轮接入后，开发构建于 `2026-09-13T09:51:20Z` 通过新增检查：读取 1 台授权设备、50 个节点、约 20.2 KB XML、1080×2400 PNG；树节点自动进入 3D、layer 与树选中态一致、breadcrumb/父子选项可见、方向键旋转、125% 放大和重置通过，renderer 错误为空。报告及人工检查图在 `.benchmarks/app-smoke/2026-09-13T09-51-20-257Z/`。

同一实现生成的历史 Windows 打包版于 `2026-09-13T09:52:40Z` 通过相同 13 项冒烟检查：沙箱/上下文隔离保持开启、Node 未暴露、3D layer 与缩放回归通过，renderer 错误为空。报告及 `layers3d.png` 在 `.benchmarks/app-smoke/2026-09-13T09-52-40-302Z/`；该次 NSIS 为 112,311,633 字节，SHA-256：`00A4AC3F128408128176533B1BEEAE21EE0F6A956FC590AD6212AE5415DEDC99`。

后续补充回归：`2026-09-13T10:59:32Z` 开发版 reduced-motion 冒烟通过，报告 `.benchmarks/app-smoke/2026-09-13T10-59-32-280Z/`；`2026-09-13T11:01:46Z` 同一 Windows 打包版锁定手机横屏后通过，实际 PNG 为 2400×1080、rotation 为 1，报告 `.benchmarks/app-smoke/2026-09-13T11-01-46-531Z/`。测试结束后手机恢复原来的 `accelerometer_rotation=0`、`user_rotation=0`。

`benchmark:layers` 最新报告为 `.benchmarks/layer-layout.json`：25,000 节点 balanced 树 focus layout 中位数 5.737ms、P95 11.427ms；wide 树中位数 3.117ms、P95 6.760ms；全部层级均限制在 256 个 layer 内并记录折叠数量。新增缩放后的坐标回归为 100%/125%/150% 各 25 组，共 75 组。

`test:dpi` 于 `2026-09-13` 在本机 Windows 11 以 Electron devicePixelRatio 1/1.25/1.5 各通过 25 组坐标检查；报告分别写入 `.benchmarks/dpi-checks/dpi-1.json`、`dpi-1_25.json`、`dpi-1_5.json`。当前系统只读检查显示 `AppliedDPI=96`、`Win8DpiScaling=0`，因此本次没有把系统设置切换到 125%/150%。

固定脱敏视觉基线于 `2026-09-13T15:12:29Z` 通过 `bun run visual:baseline` 生成，报告目录为 `.benchmarks/visual-baseline/2026-09-13T15-12-29-331Z/`，覆盖 `1264×816`、`1440×900`、`1587×1000` 三个精确 viewport；每组包含工作台截图、3D 截图和 DOM rect JSON。

首页极简改造后的固定视觉基线于 `2026-09-13T16:09:29Z` 通过 `bun run visual:home` 生成，报告目录为 `.benchmarks/home-visual-baseline/2026-09-13T16-09-29-012Z/`；三种 viewport 均确认双卡片、字号层级、Toolbar 高度、旧首页模块移除和唯一采集入口。

固定 fixture 的完整应用 DPI/窗口外输入回归于 `2026-09-13T15:16:13Z` 通过 `bun run smoke:fixture-dpi`，报告目录为 `.benchmarks/fixture-dpi-smoke/2026-09-13T15-16-13-117Z/`；`devicePixelRatio=1/1.25/1.5` 均通过，应用 shell/body 无泄漏 transform，文档无横向溢出。

新增 `.github/workflows/native-electron.yml`：Ubuntu、macOS、Windows runner 会运行 fixture 应用冒烟；三平台分别构建原生包，并用 `scripts/packaged-startup.mjs` 检查打包应用的标题、沙箱、上下文隔离、Node 暴露和 renderer errors。首次 workflow 运行需要远端 runner 产生最终环境证据。

手势和快速切换专项的最新开发版报告为 `.benchmarks/app-smoke/2026-09-13T11-18-22-380Z/`：15 项检查通过，验证了点击另一张 layer 后选中树和 layer 集合同步替换、Alt+左键拖动到截图 viewport 边缘后 3D 旋转、方向键旋转、缩放/适应、截图反查和快照恢复，renderer 错误为空。该冒烟使用 DevTools 的真实鼠标事件并把终点放在 screenshot frame 边缘；窗口外继续拖动的 pointer capture 仍建议在桌面人工回归中补充确认。

重新打包并纳入统一手势处理器后的最终 Windows 版于 `2026-09-13T11:23:34Z` 通过 15 项竖屏实机冒烟，报告 `.benchmarks/app-smoke/2026-09-13T11-23-34-431Z/`；最终包 `release/Android UI Inspector Setup 0.1.0.exe` 为 112,311,861 字节，SHA-256：`45D60FCC4491FE6418E1A077123B18DB22231F8CC27DBA865DF5FD35C03DC668`。同一最终包的 reduced-motion 回归于 `2026-09-13T11:24:08Z` 通过，报告 `.benchmarks/app-smoke/2026-09-13T11-24-08-622Z/`，CSS 动画为 `none/0s`，renderer 错误为空；最终包锁定手机横屏后的专项于 `2026-09-13T11:27:04Z` 通过，实际 PNG 为 2400×1080、rotation 为 1，报告 `.benchmarks/app-smoke/2026-09-13T11-27-04-156Z/`，结束后恢复测试前的 `accelerometer_rotation=1`、`user_rotation=0`。

同一 `release/win-unpacked/Android UI Inspector.exe` 使用独立 profile 于 `2026-09-13T11:44Z` 做桌面人工回归：真实设备采集 46 节点完整 hierarchy，深层 VirtualChild 自动进入 3D，选中层高亮、layer 平面切换、125% 缩放/适应、键盘旋转和拖到 screenshot frame 边缘均通过；未触碰用户原有安装实例。

2026-09-13 新增高倍率、球面相机和节点度量后，最新 `release/win-unpacked` 与 NSIS 打包版均通过 15 项实机冒烟，报告为 `.benchmarks/app-smoke/2026-09-13T13-42-19-161Z/`；覆盖 25%–1600% 倍率预设、3D layer、相机 HUD、属性面板、screen px 几何尺寸和 CSS 风格盒模型，renderer errors 为空。最新 NSIS 大小 112,313,534 字节，SHA-256 为 `59CB4D4B58BC24AD65B36654E52212A1B6F3AC24CA9D1523A167A1F4CDE9F5CF`。连续超过 360° 的人工扫视和另一页面横屏人工检查仍属于补充验收，不影响自动回归结论。

极简浅色工作台重设计后的最终包于 `2026-09-13T14:04:25Z` 通过 14 项打包版实机冒烟，报告为 `.benchmarks/app-smoke/2026-09-13T14-04-25-034Z/`；完整标题、Toolbar 搜索、左侧 hierarchy、右侧 2D/3D 画布、节点属性和浅色快照历史均已纳入构建，沙箱/上下文隔离保持开启、Node 未暴露、renderer errors 为空。最终 NSIS 为 112,315,903 字节，SHA-256：`6DA5C0A007EACAA2CE9188DD7A7D04CF8129B224349AC854467DDB67E9828C7D`。

本轮设计稿差距改造后的最终包于 `2026-09-13T14:50:23Z` 通过 16 项打包版实机冒烟，报告为 `.benchmarks/app-smoke/2026-09-13T14-50-23-332Z/`；检查页标题栏不再占据主工作区，左侧树和右侧画布从 Toolbar 后直接开始，右侧工具栏一行化，属性三栏、浅色 3D 网格、X/Y/Z gizmo 和低频层级设置均已纳入构建。窗口 `1264×815`，画布高度 `408.4px`，节点详情高度 `230px`，无横向溢出；sandbox/context isolation 正常、Node 未暴露、renderer errors 为空。该版后续又因 fixture/基线功能重建，最新 NSIS 为 112,317,914 字节，SHA-256：`7D97ED2D1488171C36351A996BE0FB72F9712B77D11DB7B007E11324430395C9`。

最新重建包于 `2026-09-13T15:25:16Z` 通过 15 项打包版实机冒烟，报告为 `.benchmarks/app-smoke/2026-09-13T15-25-16-116Z/`；打包启动探针于 `2026-09-13T15:25:01Z` 通过，报告为 `.benchmarks/native-packaged/2026-09-13T15-25-01-274Z/`。

首页改造后的最终重建包于 `2026-09-13T16:09:00Z` 通过 16 项打包版实机冒烟，报告为 `.benchmarks/app-smoke/2026-09-13T16-09-00-319Z/`；打包启动探针于 `2026-09-13T16:08:45Z` 通过，报告为 `.benchmarks/native-packaged/2026-09-13T16-08-45-560Z/`。最终 NSIS 为 112,319,424 字节，SHA-256：`2AA4BB06A53684E5325929E7B0CFCEC7AB52234751D37F02E1971B4AE78B608B`。

没有运行会注册正式应用的安装/卸载流程。安装向导、升级/卸载、干净 Windows、其他实体分辨率、Windows 系统 DPI 以及 macOS/Linux 尚不在已验证范围内；100%/125%/150% 页面缩放测试不能代替 OS DPI 验收。

本次曾在 Windows 上尝试 `electron-builder --linux --publish never --config.directories.output=.benchmarks/package-linux`；Linux 解包阶段完成后长时间无进一步输出，当前机器没有 Docker 或可用 WSL 发行版，已停止该次构建，未将其记为 Linux 运行验证。`.github/workflows/static-render.yml` 已提供 Ubuntu/macOS/Windows 的静态检查入口，首次 CI 运行和 macOS/Linux 原生打包启动仍是后续验收项。
