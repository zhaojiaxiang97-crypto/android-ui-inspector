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
bun run benchmark:render
bun run package:win
node scripts/app-smoke.mjs --packaged --require-device
```

`diagnose:startup` 使用无设备数据的最小本地页面，检查按钮点击、截图、preload 沙箱标记和子进程状态；不自动修复 ACL，便于对照。可选模式包括 software、default、legacy、no-in-process。失败会返回非零退出码。

`smoke:app` 构建并启动真实应用，通过仅监听回环地址的临时调试端口操作桌面 DOM，检查：

1. React 页面与真实 preload 已加载；沙箱和上下文隔离开启，页面不能访问 `require`。
2. 点击“刷新设备”，读取真实 ADB 探测结果。
3. 点击“检查 UI”，读取真实层级及截图；点击树节点并校验属性联动。
4. 检查 bounds 高亮，点击桌面截图并确认选中节点 bounds 包含点击坐标。
5. 输入搜索词并清除筛选，检查资源/运行时错误，保存实际窗口 PNG。

脚本使用 `.benchmarks/app-smoke/<时间>/profile` 作为独立用户数据目录，不读写用户原有快照历史。不会发送手机触摸或输入命令；会通过 ADB 生成/读取 UIAutomator dump 和读取屏幕截图。所有报告与截图留在本机，请勿将包含私人页面的产物直接发布。脚本退出后关闭它自己启动的应用，正常应用启动不附带调试端口。

没有授权设备时，默认明确标记真机步骤 skipped；`--require-device` 会直接失败，适合接入实机的验收。该脚本在 Windows 使用打包 EXE；macOS/Linux 的打包启动测试尚待适配。

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

没有运行会注册正式应用的安装/卸载流程。安装向导、升级/卸载、干净 Windows、其他实体分辨率、Windows 系统 DPI 以及 macOS/Linux 尚不在已验证范围内；100%/125%/150% 页面缩放测试不能代替 OS DPI 验收。
