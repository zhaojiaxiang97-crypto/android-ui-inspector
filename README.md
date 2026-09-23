# Android UI Inspector

一个本地优先、仅支持 **Debug App** 的 Android UI 层级检查工具。通过 ADB 读取真实控件树、独立 View 位图和屏幕截图，使用 WebGL 展示可展开、可选中的 3D 层级。

当前默认桌面技术栈是 Electron + React + TypeScript + Vite，目标是 Windows、macOS、Linux 桌面端。项目不需要后端账号，设备数据和快照历史默认只保存在本机。

## 当前能力

- 发现 Android SDK、PATH 和 Windows winget 位置中的 ADB，并展示设备授权状态、序列号、型号和产品信息。
- 原生 View 使用 Debug hierarchy + DDMS/JDWP；Qt/QML 使用 QML Debug 对象树。Release App 直接拒绝，不回退到 UIAutomator。
- 展示可展开的真实控件树、来源属性、bounds、独立 View 位图和设备截图；UIAutomator 解析仅保留用于历史快照和测试。
- 图层状态区分已采集、未返回位图、匹配有歧义、不可见和采集失败；缺少位图不等于控件透明。
- SurfaceView / GLSurfaceView、TextureView 及其自定义子类可读取自身缓冲画面，复用现有 3D 展开与折叠合成；不以窗口截图代替独立图层。
- 选择节点时在截图上高亮 bounds；点击截图可反查节点，并自动清理筛选、展开祖先和滚动到目标。
- 为节点生成 XPath、UiSelector、ADB 点击命令和 JSON；支持复制及通过系统保存对话框导出 JSON/XML/PNG。
- 按文本、resource-id、class 搜索，并按可操作、有标识等条件过滤。
- 本地保存 UI 快照，重启后可查看历史记录、节点变化摘要和截图方向元数据。
- 大树使用记忆化节点与虚拟列表，支持全部展开/折叠、选中定位和 Home/End 键盘导航。
- 截图等比缩放、半开边界命中、越界 bounds 裁剪，并在采集方向或尺寸冲突时暂停截图定位。
- 采集后默认展开全部分支；左侧折叠同步收起右侧子层，父层合成该分支的独立位图。展开后每层只使用自己的位图，原生 View 不裁切整屏截图补图。
- WebGL 3D 支持左键/右键拖动旋转、鼠标经过蓝色高亮、点击选中、层间距调整；直接滚轮缩放，空格/Shift/中键拖动平移。
- 3D 画布使用精准十字光标，悬停时显示控件类名和标识；蓝色表示指向、绿色表示已选中。移动超过 4px 才开始拖动，旋转时使用方向光标，仅平移时使用抓手；拖动不改变选中节点，松手后重新识别鼠标下的控件。
- 3D 中点击固定基准层，再悬停另一层即可测距；分离时显示水平/垂直边距，包含时显示四边内距，重叠或相接时明确提示。数值使用原始控件外框的 px，不是 3D 展开层距；旋转、缩放不改变数值，点击另一层会更换基准，移到空白处清除标注。
- 3D 画布右键单击图层可“隐藏此图层”，右键空白处或顶部“恢复图层”可全部恢复；也支持工作区 `Shift+F10` 菜单。只隐藏该层自身，展开的子层保留，折叠合成也排除已隐藏的图片。隐藏仅在本次查看生效，不修改手机 App、2D 原截图或保存的快照。
- 属性以半透明悬浮 Tab 展示，可拖动、收起或关闭，顶部属性按钮可重新打开；常用信息直接显示，完整属性、复制和导出保留在“更多属性”中。图层纹理仅加载当前展示的层，使用像素预算限制显存占用，超出层数上限时明确提示并保留选中节点。
- 采集显示当前阶段和用时，可取消；返回、切换设备时取消旧请求，旧结果不会覆盖新页面。
- 选中控件后显示 Debug 来源属性、screen px 几何尺寸、父级内偏移和 CSS 风格盒模型；padding 显示实际读取值，未暴露的属性不伪造为 0。
- 采用深色极简工作台布局：Toolbar 集中设备与采集操作，左侧保留 hierarchy 树，右侧统一承载 2D/3D 画布、缩放控制和节点属性；顶部搜索可用 `Ctrl/⌘+K` 快速聚焦。
- 首页采用参考图风格的单一居中状态容器，覆盖加载、ADB 缺失、无设备、待授权和已连接状态；设备采集动作只保留在顶部 Toolbar，首页“切换设备”使用轻量设备选择层。
- 提供树逻辑、真实 DOM、坐标、启动和实体设备冒烟测试，以及 Windows electron-builder 打包链路。

## 重要边界

- 必须是允许 `run-as` 的可调试 App，不仅是包名或文件名带有 debug。
- 当前支持原生 View 和带 QML Debug 插件的 Qt/QML App；尚不支持 Compose、Flutter、WebView 内部控件树。
- 原生 View 的位图先校验窗口根身份，再按名称和精确屏幕矩形唯一匹配。DDMS 的多数位图记录不带控件 ID，同名同位置的歧义记录不会强行贴图。
- 原生 View 缺少独立位图时只显示边框。SurfaceView 独立采集已在 Android 14 真机验证；Android 10–13 路径完成协议测试，其他系统版本或厂商实现仍需验证。受保护/DRM 内容不绕过，可能失败或由系统返回黑色/透明画面；嵌入式 SurfacePackage 暂不支持。同一 OpenGL 画面只对应所属 View，不解析内部绘制指令。
- QML Rectangle/Window 的真实背景色、圆角、边框和基础线性渐变会重建为独立样式图层，展开保留自身样式，折叠合成本分支。它不是 Qt 独立截图通道；其他叶节点仍可能使用截图近似，复杂自绘、渐变预设尚不支持。不会将完整 Qt Surface 重复贴到 QML 子节点上。
- 合成支持已暴露的 sibling Z、矩形裁剪、padding 裁剪和分组透明度；未暴露的圆角裁剪、任意变换矩阵、自定义绘制顺序仍不能保证与手机逐像素一致。
- 采集不是冻结的同一帧。会检查前台 Activity 和屏幕几何变化；视频、动画及同一 Activity 内的布局变化仍可能产生时间差。

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

只有显示为 `device` 且已授权的设备可以执行检查。先在手机上打开 Debug App，再在顶部选择设备并点击“采集截图”。原生 View 采集不要求修改业务代码，但 JDWP 采集视频位图时会短暂暂停目标主线程；Qt/QML 首次建立调试连接会重启目标 App。取消会断开调试连接并清理本次端口转发。

检查工作台采用双栏布局：左侧是可搜索、可筛选和可键盘操作的 hierarchy 树，右侧是完整画布，节点属性浮在画布上方，不再预留底部空间。拖动属性标题可移动面板，聚焦标题后可用方向键微调、Home 复位，Escape 关闭；收起、关闭和重新打开都不会改变相机视口。点击左侧节点会在截图上按真实 `bounds` 高亮，点击截图也会反向定位到左侧树节点；快照历史收纳在顶部的“快照与历史”按钮中。

顶部工具栏可以切换 2D 与 3D。3D 按真实父子关系展开，同级优先采用实测 Z，再参考绘制顺序和索引；展开距离是检查工具的可视化间距，不是手机的物理深度。单次最多展示 512 个子层，其他节点仍可在树中选择或通过折叠分支查看。

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
| `bun run test:tree-ui` | 真实 DOM 树交互、采集取消和过期请求回归 | `.benchmarks/tree-behavior.json` |
| `bun run test:coordinates` | 截图坐标、缩放反查、Canvas/WebGL 图层像素回归 | `.benchmarks/screen-coordinates.json` |
| `bun run test:dpi` | Electron 100%/125%/150% device-scale-factor 代理矩阵 | `.benchmarks/dpi-checks/` |
| `bun run visual:baseline` | 固定脱敏 hierarchy 在 1264×816/1440×900/1587×1000 生成视觉基线 | `.benchmarks/visual-baseline/` |
| `bun run visual:home` | 首页极简布局在 1264×816/1440×900/1587×1000 生成视觉基线 | `.benchmarks/home-visual-baseline/` |
| `bun run visual:home:states` | 首页 connected/loading/unauthorized/empty/adb-missing 五状态视觉基线 | `.benchmarks/home-state-visual-baseline/` |
| `bun run smoke:fixture-dpi` | 固定 fixture 的 100%/125%/150% 完整应用与窗口外拖动回归 | `.benchmarks/fixture-dpi-smoke/` |
| `bun run benchmark:tree` | 纯逻辑大树基准 | `.benchmarks/tree-*.json` |
| `bun run benchmark:layers` | 3D LayerRecord 大树布局基准 | `.benchmarks/layer-layout.json` |
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
bun run test:dpi
```

单元测试包含窗口身份校验、位图歧义、取消连接、Z 顺序和选中节点保留。`test:coordinates` 除坐标回归外，还在真实 Canvas/WebGL 中检查分组透明度、裁剪、padding、隐藏分支、缺失位图、折叠纹理释放和透明混合。`test:tree-ui` 额外验证取消、切换设备、返回首页和卸载时的过期请求处理。测试通过不等于完成所有机型的真机验证；最新运行结果见 [改良记录](docs/INSPECTION_RELIABILITY.md)。历史性能方法见 [树性能报告](docs/TREE_PERFORMANCE.md)。

连接授权手机后，运行完整 Windows 冒烟：

```powershell
bun run smoke:app --require-device
```

验证打包版时先执行 `bun run package:win`，再运行：

```powershell
node scripts/app-smoke.mjs --packaged --require-device
```

冒烟测试使用独立用户数据目录，覆盖沙箱、preload、设备刷新、完整 hierarchy、节点选择、3D 层级展开、layer 高亮、layer 快速切换、viewport 边缘拖动、缩放/适应、原始属性、截图反查、搜索、键盘导航和快照历史；通过后还会保存 `layers3d.png` 供人工检查。追加 `--reduced-motion` 可验证无障碍动态偏好下动画被关闭，追加 `--expect-landscape` 可验收横屏设备。报告、日志、页面截图和真实手机 XML 只写入被忽略的 `.benchmarks/`，不要把含私人页面的文件直接发布。

`bun run test:dpi` 会用独立 Electron 进程依次注入 `force-device-scale-factor=1/1.25/1.5`，复用生产 `ScreenshotPreview` 坐标 harness，并断言 `devicePixelRatio`、布局框和反查矩阵。它是可重复的 DPI 代理，不等价于 Windows 设置里的系统缩放、多显示器 Per-Monitor DPI 或实体设备显示输出。

完整的测试分层、覆盖矩阵、执行顺序、真实设备边界、证据格式和发布门槛见 [测试总计划](docs/TEST_PLAN.md)。

本轮首页设计稿：[main-interface-redesign-v2.png](docs/design/main-interface-redesign-v2.png)。它是视觉参考资产；实际布局由 `src/components/DeviceHomeView.tsx`、`src/components/AppHeader.tsx`、`src/styles/tokens.css` 和 `src/App.css` 实现。

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

`.github/workflows/static-render.yml` 已加入 Ubuntu、macOS、Windows 三平台的静态 renderer 矩阵：单测、树 UI、坐标、DPI 代理和生产构建会在对应 runner 执行；Linux Electron 检查通过 `xvfb-run` 提供无头显示环境。真实 Android 设备冒烟仍只在接入设备的 Windows/macOS/Linux runner 上执行。

`.github/workflows/native-electron.yml` 还会在三平台运行固定 fixture 的 Electron 应用冒烟、构建对应原生包、启动打包应用并上传 release artifact。打包命令不会自动发布到 GitHub；三平台 CI 的最终结果以 GitHub Actions 运行记录为准。

仓库未配置正式签名或公证凭据，CI 包可能显示未知发布者；本地打包可能自动使用本机已有的开发证书。安装、升级、卸载和干净系统发布验证仍应在目标平台继续完成。

## 目录与开发边界

```text
electron/       主进程、ADB、截图、IPC、快照持久化
src/            React renderer 和界面组件
shared/         跨进程共享类型、树算法、坐标算法、3D layer 纯函数布局
tests/          单元/DOM 回归与脱敏 UIAutomator fixture
benchmarks/     合成树、坐标页、真实 DOM 基准入口
scripts/        启动、诊断、冒烟、树与 3D layer 基准编排
build/          打包 hook 和 NSIS 扩展
docs/           性能、坐标、Windows 启动与目录约定
public/         Vite 静态资源
src-tauri/      历史 Tauri 原型，不参与默认 Electron 构建
dist*/release/  构建生成目录，不手动编辑、不提交
.benchmarks/    本机报告/截图/临时数据，不提交
```

更详细的职责、依赖方向和新文件放置规则见 [开发目录约定](docs/DEVELOPMENT_STRUCTURE.md)。核心原则是：renderer 只能通过 preload 白名单访问桌面能力；主进程校验 IPC 输入；共享算法保持纯 TypeScript；测试 fixture 必须脱敏；生成产物不得回写源码目录。

本轮 Windows 版视觉重构已完成主要代码和真机回归；固定脱敏 fixture、Windows OS DPI、多显示器以及 macOS/Linux 原生打包等环境验收项仍按计划文档逐步补齐。差距清单、目标布局、实施记录和验收标准见 [UI 设计稿对齐改造计划](docs/UI_REDESIGN_REFACTOR_PLAN.md)。

## 贡献流程

1. 先判断改动属于 `src/`、`electron/`、`shared/`、测试还是脚本，按 [开发目录约定](docs/DEVELOPMENT_STRUCTURE.md) 放置。
2. 新增解析边界时，同时补充脱敏 fixture、单元断言和必要的 UI 提示。
3. 不要把 ADB 输出、真实页面截图、个人快照或 `.benchmarks/` 内容提交到仓库。
4. 运行类型检查、单元测试和与改动相关的 UI/坐标回归。
5. 涉及 Windows 启动、权限、打包或验收时，更新对应的 [Windows 启动记录](docs/WINDOWS_STARTUP.md) 或测试报告。

## 后续方向

- 在更多 Android 版本、厂商、分辨率、系统 DPI、折叠屏和多显示器环境继续验证坐标映射。
- 收集脱敏的 Debug View/QML 数据，补充自绘控件、圆角裁剪、变换和跨帧变化的真机回归。
- 在干净 Windows 环境完成安装/升级/卸载测试；确认修复后的三平台 CI 结果，再补齐 macOS/Linux 打包启动和真实设备验证。所有 `package:*` 只生成本地包，不自动发布 GitHub Release。
- 继续评估超大树筛选、差异计算、原始属性展示和屏幕阅读器体验。

项目阶段性实施记录由工作区上级的 `ANDROID_UI_INSPECTOR_PLAN.md` 维护；仓库内的开发规则和验收说明见 `docs/`。
