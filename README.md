# Android UI Inspector

一个本地优先的 Android UI 层级检查工具。它通过 ADB 连接实体 Android 设备，读取 UIAutomator hierarchy、截图和显示元数据，把节点属性与设备画面对应起来，帮助开发者定位控件、分析布局和复现 UI 问题。

当前默认桌面技术栈是 Electron + React + TypeScript + Vite，目标是 Windows、macOS、Linux 桌面端。项目不需要后端账号，设备数据和快照历史默认只保存在本机。

## 当前能力

- 发现 Android SDK、PATH 和 Windows winget 位置中的 ADB，并展示设备授权状态、序列号、型号和产品信息。
- 默认执行完整 `uiautomator dump`；完整模式失败时才回退到 `--compressed`，界面会明确标注可能缺失节点的快照。
- 展示可展开的 UI 树、节点标准属性、完整原始 XML 属性、bounds 和设备截图。
- 对 `View$VirtualChild` 等虚拟无障碍节点显示来源与能力边界提示。
- 选择节点时在截图上高亮 bounds；点击截图可反查节点，并自动清理筛选、展开祖先和滚动到目标。
- 为节点生成 XPath、UiSelector、ADB 点击命令和 JSON；支持复制及通过系统保存对话框导出 JSON/XML/PNG。
- 按文本、resource-id、class 搜索，并按可操作、有标识等条件过滤。
- 本地保存 UI 快照，重启后可查看历史记录、节点变化摘要和截图方向元数据。
- 大树使用记忆化节点与虚拟列表，支持全部展开/折叠、选中定位和 Home/End 键盘导航。
- 截图等比缩放、半开边界命中、越界 bounds 裁剪，并在采集方向或尺寸冲突时暂停截图定位。
- 提供树逻辑、真实 DOM、坐标、启动和实体设备冒烟测试，以及 Windows electron-builder 打包链路。

## 重要边界

UIAutomator 能看到的是 Android 无障碍/窗口层级，不等于应用内部所有绘制对象。以下内容可能只返回容器或虚拟节点：

- Compose、QML、自绘 Canvas 或游戏渲染中的内部元素；
- WebView 内未暴露给 Android 无障碍树的 DOM；
- 厂商组件或应用主动隐藏的子节点；
- 只有视觉存在、没有可访问语义的图形。

因此项目会保留完整 XML 的原始属性，也会显示“完整/压缩 hierarchy”和 VirtualChild 提示，但不会把不可见的绘制内容伪装成可定位控件。要获得更深层信息，需要目标应用开启无障碍语义，或使用目标应用专用调试协议。

## 快速开始

### 环境

- Windows 10/11、macOS 12+ 或主流 Linux 发行版
- [Bun](https://bun.sh/)
- Node.js 22+（启动辅助脚本和自动化验收使用）
- Android SDK Platform-Tools（提供 `adb`）
- 对应平台的 Electron/electron-builder 构建环境

### 安装依赖

```powershell
bun install
```

### 连接手机

1. 在 Android 手机上开启开发者选项和 USB 调试。
2. 使用 USB 连接手机，在 RSA 授权弹窗中允许这台电脑。
3. 确认 ADB 状态：

```powershell
adb devices -l
```

只有显示为 `device` 且已授权的设备可以执行“检查 UI”。项目只读取设备信息、UIAutomator XML 和屏幕截图；自动化验收不会向手机发送点击或输入。

### 启动开发环境

```powershell
bun run dev
```

该命令会同时启动 Vite renderer、Electron main/preload 监听构建和桌面窗口。Windows 下启动前会准备本项目 Electron 运行时所需的沙箱读取/执行权限。

如果只想运行最近一次生产构建：

```powershell
bun run build
bun run start
```

修改源码后需要重新执行 `bun run build`；`start` 不依赖 Vite 开发服务器。

## 常用命令

| 命令 | 用途 | 输出 |
| --- | --- | --- |
| `bun run dev` | 开发模式启动 Electron | 监听 `dist-electron/`，Vite 使用 `1420` 端口 |
| `bun run build` | 类型检查并生成生产构建 | `dist/`、`dist-electron/` |
| `bun run start` | 启动本地生产构建 | 读取 `dist/` 和 `dist-electron/` |
| `bun test` | 单元测试和解析回归 | 终端结果 |
| `bun run test:tree-ui` | 真实 DOM 树交互回归 | `.benchmarks/tree-behavior.json` |
| `bun run test:coordinates` | 截图坐标映射回归 | `.benchmarks/screen-coordinates.json` |
| `bun run benchmark:tree` | 纯逻辑大树基准 | `.benchmarks/tree-*.json` |
| `bun run benchmark:render` | 真实 DOM/虚拟树基准 | `.benchmarks/tree-virtual.json` |
| `bun run prepare:windows` | 准备 Windows Electron 沙箱权限 | 本机运行时目录 |
| `bun run diagnose:startup software` | 诊断开发构建启动链路 | `.benchmarks/startup/` |
| `bun run smoke:app --require-device` | 开发构建真实窗口/真机冒烟 | `.benchmarks/app-smoke/` |
| `bun run package:win` | 构建 Windows NSIS 安装包 | `release/` |

## 测试与验收

提交前建议至少运行：

```powershell
bun x tsc --noEmit
bun test
bun run test:tree-ui
bun run test:coordinates
```

当前已验证的基线是：44 项单元测试通过；树 UI 回归覆盖旧基线和虚拟树行为；坐标回归在 100%/125%/150% 页面缩放下共覆盖 72 组。性能方法和结果见 [树性能报告](docs/TREE_PERFORMANCE.md)，坐标边界见 [截图坐标验收](docs/SCREEN_COORDINATES.md)。

连接授权手机后，运行完整 Windows 冒烟：

```powershell
bun run smoke:app --require-device
```

验证打包版时先执行 `bun run package:win`，再运行：

```powershell
node scripts/app-smoke.mjs --packaged --require-device
```

冒烟测试使用独立用户数据目录，覆盖沙箱、preload、设备刷新、完整 hierarchy、节点选择、原始属性、截图反查、搜索、键盘导航和快照历史。报告、日志、页面截图和真实手机 XML 只写入被忽略的 `.benchmarks/`，不要把含私人页面的文件直接发布。

## 打包

```powershell
# 当前操作系统
bun run package

# 指定目标
bun run package:win
bun run package:mac
bun run package:linux
```

跨平台发布应在对应操作系统上构建，或使用对应平台的 CI runner。Windows x64 打包会为 `release/win-unpacked` 准备 Electron 沙箱运行时权限；NSIS 安装时也会在实际安装目录追加读取/执行权限，同时保留既有权限，不会关闭 renderer sandbox。

当前安装包未配置 Authenticode/Apple Developer 签名，干净系统可能显示未知发布者。安装、升级、卸载以及 macOS/Linux 的发布验证仍应在目标平台继续完成。

## 目录与开发边界

```text
electron/       主进程、ADB、截图、IPC、快照持久化
src/            React renderer 和界面组件
shared/         跨进程共享类型、树算法、坐标算法
tests/          单元/DOM 回归与脱敏 UIAutomator fixture
benchmarks/     合成树、坐标页、真实 DOM 基准入口
scripts/        启动、诊断、冒烟、基准编排
build/          打包 hook 和 NSIS 扩展
docs/           性能、坐标、Windows 启动与目录约定
public/         Vite 静态资源
src-tauri/      历史 Tauri 原型，不参与默认 Electron 构建
dist*/release/  构建生成目录，不手动编辑、不提交
.benchmarks/    本机报告/截图/临时数据，不提交
```

更详细的职责、依赖方向和新文件放置规则见 [开发目录约定](docs/DEVELOPMENT_STRUCTURE.md)。核心原则是：renderer 只能通过 preload 白名单访问桌面能力；主进程校验 IPC 输入；共享算法保持纯 TypeScript；测试 fixture 必须脱敏；生成产物不得回写源码目录。

## 贡献流程

1. 先判断改动属于 `src/`、`electron/`、`shared/`、测试还是脚本，按 [开发目录约定](docs/DEVELOPMENT_STRUCTURE.md) 放置。
2. 新增解析边界时，同时补充脱敏 fixture、单元断言和必要的 UI 提示。
3. 不要把 ADB 输出、真实页面截图、个人快照或 `.benchmarks/` 内容提交到仓库。
4. 运行类型检查、单元测试和与改动相关的 UI/坐标回归。
5. 涉及 Windows 启动、权限、打包或验收时，更新对应的 [Windows 启动记录](docs/WINDOWS_STARTUP.md) 或测试报告。

## 后续方向

- 在更多 Android 版本、厂商、分辨率、系统 DPI、折叠屏和多显示器环境继续验证坐标映射。
- 收集并脱敏更多 UIAutomator 输出，补充厂商属性、异常 bounds、虚拟节点和深层 hierarchy 回归。
- 在干净 Windows 环境完成安装/升级/卸载测试，并补齐 macOS、Linux 启动验证。
- 继续评估超大树筛选、差异计算、原始属性展示和屏幕阅读器体验。

项目阶段性实施记录由工作区上级的 `ANDROID_UI_INSPECTOR_PLAN.md` 维护；仓库内的开发规则和验收说明见 `docs/`。
