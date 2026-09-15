# Android UI Inspector 测试总计划

状态：已冻结为阶段性测试计划，适用于当前 Electron + React 桌面应用

版本：v1.0

日期：2026-09-15

本文档是仓库内测试工作的统一入口。它定义测试目标、分层、矩阵、边界、证据和发布门槛；它不新增产品功能，也不把尚未具备环境条件的验证写成已通过。

## 1. 测试目标

测试要回答四个问题：

1. 共享解析、坐标、树和 3D 数学是否在边界输入下保持确定性；
2. Electron 窗口、preload、ADB 只读采集和 React 工作台是否按既定契约协同工作；
3. 用户主路径——连接设备、采集 hierarchy/截图、选择节点、查看属性、旋转/缩放、保存快照——是否可回归；
4. 哪些结论只适用于固定 fixture、开发版、Windows，哪些结论已经由真实设备或目标平台提供证据。

测试不以“所有组合都跑一遍”为目标，而以风险覆盖、可重复证据和清晰边界为目标。

## 2. 产品范围与测试边界

### 2.1 本阶段纳入测试

| 范围 | 测试对象 | 必须验证的行为 |
| --- | --- | --- |
| 桌面壳层 | BrowserWindow、原生菜单、标题栏、窗口尺寸 | 应用能启动；Windows/Linux 不出现未使用的默认菜单；原生窗口控制保持可用 |
| 安全边界 | sandbox、contextIsolation、preload 白名单 | renderer 无 Node 暴露；桌面能力只能经白名单 API 使用 |
| 设备发现 | ADB 路径、版本、设备授权态 | 已授权、待授权、无设备、ADB 缺失和探测错误可区分 |
| 只读采集 | UIAutomator XML、屏幕截图、显示方向/尺寸 | 采集结果保留原始属性；方向和截图尺寸不被错误旋转；失败状态可解释 |
| hierarchy 工作台 | 树、筛选、展开、键盘导航、虚拟列表 | 节点选择稳定；深层节点能定位；大树不产生无界 DOM |
| 截图交互 | 2D 高亮、反向命中、缩放、适应、重置 | 坐标映射与原始 bounds 一致；截图外点击不误选；倍率边界确定 |
| 3D 视图 | layer 展开、WebGL、回退、相机和命中 | 父子层有稳定 Z 顺序；可安全回到正面；旋转不把状态泄漏到页面外 |
| 属性与快照 | 属性、几何、盒模型、原始 XML、selector、历史快照 | 缺失/未知值不伪造；长值不撑破面板；快照恢复保留自身 geometry |
| 交付链路 | build、Windows/macOS/Linux package、启动探针 | 构建和包启动符合对应平台证据要求；生成物不进入源码和测试 fixture |

### 2.2 明确不纳入本阶段

以下内容不能通过增加测试用例的方式偷偷变成产品承诺：

- 不测试或实现 ADB 点击、输入、滑动、安装、卸载、修改系统设置等写设备动作；
- 不把 WebView DOM、Compose/QML 内部绘制对象、Canvas/Game 渲染内容当成 UIAutomator 必然可见；
- 不测试云同步、账号体系、远程服务、第三方网盘或任何未在产品范围内的网络 API；
- 不把 Electron `force-device-scale-factor` 代理当成 Windows 系统 DPI、Per-Monitor DPI 或多显示器实测；
- 不把一个真实 Android 设备当成全部厂商、Android 版本、折叠屏和分辨率的兼容证明；
- 不把固定 fixture 的视觉截图当成真实设备内容准确性的证明；
- 不在仓库提交真实手机 XML、截图、快照、序列号、包名或测试日志中的个人数据；
- 不以屏幕阅读器实测缺失为由宣称完整无障碍认证；当前只验证语义结构、键盘路径和可见焦点的自动化部分；
- 不为了测试而关闭 sandbox、context isolation、CSP 或 preload 白名单；历史诊断脚本不能替代正式应用验收。

## 3. 测试分层

测试分层从快到慢、从纯逻辑到真实环境排列。下层失败时不应跳过而直接相信上层结果。

| 层级 | 名称 | 运行环境 | 目的 | 证据等级 |
| --- | --- | --- | --- | --- |
| T0 | 类型、构建和静态检查 | 本机或 CI | 发现类型、打包入口、脚本语法和产物问题 | 必须 |
| T1 | 纯逻辑/解析单测 | Bun/Node，无窗口、无设备 | 覆盖 XML、PNG、bounds、树、相机、layer layout、状态机 | 必须 |
| T2 | 真实 DOM 行为 | Electron/Chromium + 合成数据 | 覆盖树焦点、虚拟列表、选择同步、键盘和布局边界 | 必须 |
| T3 | 确定性应用 smoke | Electron + 脱敏 fixture | 覆盖 preload、工作台主路径、WebGL、快照和导出 | 必须 |
| T4 | 真实设备开发版 smoke | 接入且已授权的 Android 设备 | 确认 ADB 真实输出没有破坏主路径；只读采集 | 发布前至少一次 |
| T5 | 原生包和目标平台 | 对应 OS runner/桌面 | 确认安装包、沙箱、原生窗口和启动链路 | 目标平台发布前 |
| T6 | 人工探索和环境验收 | 真实桌面/多显示器/辅助技术 | 验证自动化无法可靠覆盖的体验和环境差异 | 单独标注，不替代自动化 |

T3/T4/T5 的通过不能反向替代 T0/T1/T2。T6 没有环境证据时必须标记为“未验证”。

## 4. 测试数据与脱敏规则

### 4.1 Fixture 数据分组

固定 fixture 只模拟结构和边界，不模拟某个用户的真实页面：

| 数据组 | 覆盖内容 |
| --- | --- |
| portrait/landscape | 方向、display rotation、不同截图尺寸 |
| legacy/OEM/virtual | 缺失属性、数字布尔值、厂商字段、VirtualChild、稀疏 index |
| invalid | XML entity、坏 bounds、倒置 bounds、空 bounds、截断 PNG、错误方向 |
| tree shapes | 小树、深树、相邻 ID、重复结构、500/5000/25000 节点合成树 |
| visual fixture | 固定 `1080×2400` SVG/PNG 与脱敏 hierarchy，保证视觉基线可复现 |
| home states | connected、loading、unauthorized、empty、adb-missing |

### 4.2 脱敏检查

提交前必须检查：

- XML/JSON/日志中不存在真实 serial、设备名、手机号、账号、地址、个人文本或真实包名；
- `tests/fixtures/` 只保留合成样本；真实采集只写入被忽略的 `.benchmarks/`；
- 视觉基线不使用真实手机截图作为仓库资产；
- 导出和快照测试使用临时用户数据目录，不污染开发者已有历史；
- 测试命令的 stdout/stderr 不打印原始 XML、PNG data URL 或完整快照内容。

## 5. 覆盖矩阵设计

### 5.1 基础矩阵

基础矩阵每次回归都应覆盖以下维度：

| 维度 | 必测值 | 说明 |
| --- | --- | --- |
| 首页状态 | connected、loading、unauthorized、empty、adb-missing | `empty` 映射为 `no-device`；错误态另由异常分支覆盖 |
| 固定窗口 | `1264×816`、`1440×900`、`1587×1000` | 代表小桌面、中桌面和宽桌面 |
| 页面缩放 | 100%、125%、150% | `test:coordinates` 覆盖，重点看 CSS 像素映射 |
| Electron DPR 代理 | 1、1.25、1.5 | `test:dpi` 覆盖；不是系统 DPI 结论 |
| 屏幕方向 | portrait、landscape、rotation 0/90/180/270 | 解析和坐标层覆盖；真实设备按当前可用设备记录 |
| 视图模式 | 2D、3D、WebGL fallback | fallback 需要人工/受控环境触发并记录 |
| hierarchy 形状 | 平、深、宽、重叠、VirtualChild、无 bounds | 用例应覆盖选择、展开、定位和属性缺失 |

### 5.2 组合规则：全面但不越界

不做完整笛卡尔积。组合按风险选择：

1. T1 纯逻辑对所有边界值做完整等价类和边界值覆盖；
2. T2/T3 使用 `1264×816` 作为完整交互基线，再用另外两个窗口验证布局不回归；
3. 页面缩放与 DPR 各自跑完整矩阵，二者的交叉只选择坐标、overlay、滚动和 3D gizmo 的代表用例；
4. 首页五状态 × 三窗口是固定视觉基线，共 15 组，不再添加无风险价值的更多尺寸；
5. 真实设备只验证“数据协议兼容和主路径可用”，不承诺用一台设备覆盖所有环境；
6. 发现缺陷时增加最小复现 fixture，不直接扩张成无限设备/尺寸矩阵。

## 6. 测试项目与用例要求

### 6.1 T0：类型、构建和静态检查（P0）

执行：

```powershell
bun x tsc --noEmit
bun run build
node --check scripts/app-smoke.mjs
git diff --check
```

通过标准：

- TypeScript、renderer、Electron main/preload 全部构建成功；
- 生成的 `dist/` 和 `dist-electron/` 只作为构建产物，不回写源码；
- 测试编排脚本无语法错误；
- diff 无空白错误；
- 不因测试而关闭 Electron 安全选项。

### 6.2 T1：纯逻辑与解析单测（P0）

执行：

```powershell
bun test tests
```

覆盖要求：

- XML：属性顺序、实体、缺失字段、数字布尔值、坏 XML、深层 hierarchy；
- PNG/显示：截断数据、portrait/landscape、rotation、解码尺寸和 metadata；
- 坐标：小数 client 坐标、边缘 half-open、裁剪、重叠节点、空/无效 bounds、方向不一致；
- 树：preorder、筛选祖先保留、展开/折叠、相邻 slash ID、虚拟列表窗口和深层定位；
- 相机：yaw 环绕、pitch 限制、键盘/拖动、重置和逆变换；
- layer layout：父子深度、Z 顺序、最大层数、无 bounds/隐藏节点、选中节点不丢失；
- 首页状态：loading、ADB 缺失、错误、无设备、待授权、connected 的优先级。

边界：单测不启动真实 ADB、不触碰手机、不依赖窗口像素和网络。

### 6.3 T2：DOM、树和键盘行为（P0/P1）

执行：

```powershell
bun run test:tree-ui
```

必须检查：

- 选择节点只更新实际受影响路径，重复选择保持稳定；
- 展开/折叠不误触发选择；筛选后恢复原树和手动展开状态；
- 500 行以下与 500 行以上的虚拟化阈值行为；
- 25,000 节点下 DOM 行数有上限，滚动和定位不产生无界节点；
- Home/End、方向键、Enter/Space、焦点容器和 `aria-activedescendant`；
- 125% 页面缩放下行高、焦点、滚动和 selected row 仍一致；
- 新快照和缺失选中 ID 不残留旧状态。

自动化选择器可以使用稳定的 `data-*` 属性，但不得因此制造额外可见节点或改变布局。

### 6.4 T2：坐标、截图和方向（P0）

执行：

```powershell
bun run test:coordinates
```

当前矩阵要求：100%、125%、150% 页面缩放各 25 组，共 75 组。

每组至少包含：

- fit、固定倍率和高倍率（25%–1600%）；
- 鼠标下锚点缩放和滚动偏移；
- 左/右/上/下边缘点击、截图外点击、空白区域点击、1px overlay；
- portrait、landscape、square、180° 和错误方向；
- 解码失败、旧快照兼容、截图替换后的旧尺寸清理；
- 生产 `ScreenshotPreview` 使用的映射函数与独立预期值对比。

通过标准：

- 原始 Android bounds 和显示截图处于同一明确的坐标协议；
- 不乘 Android density、Windows DPR 或 Electron 缩放得到“看起来正确”的坐标；
- 截图外输入不选择节点；
- 方向/尺寸不一致时禁止错误高亮并给出可见状态。

### 6.5 T2/T3：DPI 与窗口代理（P0/P1）

执行：

```powershell
bun run test:dpi
bun run smoke:fixture-dpi
```

`test:dpi` 使用 Electron `force-device-scale-factor=1/1.25/1.5`；`smoke:fixture-dpi` 还覆盖固定窗口、完整应用和窗口外拖动。

必须把报告中的 scope 写清楚：它们是可重复代理，不是 Windows Settings 的物理 OS DPI、多显示器、混合缩放或实体手机输出验收。物理环境需要 T6 证据。

### 6.6 T3：首页状态与视觉基线（P0）

执行：

```powershell
bun run visual:home:states
```

矩阵为五种首页状态 × 三个固定 viewport，共 15 组。每组记录：

- 顶栏、状态容器、设备图形、标题、正文、主按钮和帮助入口的 rect；
- body/document 水平溢出；
- connected 态的型号、Android 版本和“开始检查/切换设备”；
- unauthorized/empty/adb-missing/loading 的独立文案与按钮禁用态；
- 旧 Hero、指标、状态横幅、双卡片和重复截图入口不存在；
- 视觉截图和结构 JSON 只来自脱敏 fixture。

视觉差异要区分：

- 设计意图差异：信息层级、留白、字体和主操作位置；
- 环境差异：系统字体、窗口装饰、DPR、截图编码；
- 数据差异：真实设备型号和 hierarchy 内容。

不以逐像素相等作为唯一通过标准；结构、溢出、对比度和关键操作优先。

### 6.7 T3：完整 fixture 应用 smoke（P0）

执行：

```powershell
node scripts/app-smoke.mjs --fixture --reduced-motion
```

在 `1264×816` 基线至少验证：

1. sandbox、context isolation、preload 和 Node 不暴露；
2. 设备刷新、唯一顶部采集入口和检查页进入/返回；
3. hierarchy 选择、筛选、展开、键盘导航、深层定位；
4. 2D/3D 切换、WebGL renderer、网格/gizmo、层命中和快速切换；
5. 3D 拖动、键盘旋转、滚轮缩放、适应、重置和窗口外释放清理；
6. screenshot bounds 高亮、反向树定位、方向/尺寸状态；
7. 属性、原始属性、VirtualChild 提示、盒模型和 selector；
8. 快照保存/恢复、历史预览、diff 和导出；
9. reduced-motion 下动画关闭但功能仍然可用；
10. renderer errors 为空、document 无水平溢出。

fixture smoke 不发送任何 ADB 写设备命令，且不把测试截图当作真实产品数据。

### 6.8 T4：真实 Android 设备 smoke（P0 发布前）

前置条件：

- 设备通过 USB 连接并在手机上明确授权 RSA；
- `adb devices -l` 中目标状态为 `device`；
- 设备页面不包含不应被记录的隐私信息，或只保存本地受控报告；
- 测试操作者确认本轮只读采集，不执行手机点击/输入/安装命令。

执行：

```powershell
node scripts/app-smoke.mjs --require-device --reduced-motion
```

真实设备只验证：

- ADB 发现、型号/Android 版本读取和授权态；
- 真实 XML/截图能进入当前工作台；
- 真实节点选择、截图反查、属性和 3D layer 不破坏布局；
- 断开/重连时不继续对失效 serial 采集；
- renderer errors、权限和报告隔离正常。

真实设备测试不得据此宣称所有 Android 厂商/版本/分辨率兼容。需要横屏时由操作者把设备切到可验证页面，并在报告中记录方向；脚本不能强制改写设备方向。

### 6.9 T3/T5：Electron 安全与 IPC（P0）

每次主进程或 preload 变更都检查：

- BrowserWindow 仍为 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；
- renderer 中 `window.require`、Node globals 和文件系统能力不可用；
- preload 只暴露当前需要的白名单方法，不暴露任意 IPC 通道；
- 主进程对 serial、导出格式、文件名、快照输入和 ADB 路径做校验；
- 异常只返回可展示错误，不把完整设备 XML、截图 data URL 写入日志；
- 导出路径由用户选择或安全默认值决定，不能通过输入拼接任意路径；
- 取消、超时、断连和重复触发不会导致窗口崩溃或继续执行过期采集。

当前自动化重点是配置和行为探针；依赖系统权限、杀毒软件、真实安装目录的安全结论仍需目标 Windows/CI 环境证据。

### 6.10 T5：打包、安装和启动（P0/P1）

目标平台分别执行，不用一个平台的包冒充另一个平台：

```powershell
bun run package:win
node scripts/packaged-startup.mjs
node scripts/app-smoke.mjs --packaged --fixture --reduced-motion
```

macOS/Linux 使用对应的 `package:mac`/`package:linux` 和目标平台启动探针；Linux 无头 runner 需要 `xvfb-run`。

必须记录：

- OS、架构、Electron/Bun/Node 版本和构建 commit；
- 安装包路径、大小、SHA-256、是否签名；
- 安装、升级、启动、关闭、卸载和再次安装；
- 包内 sandbox/preload/Node 暴露探针；
- ADB 发现路径和临时目录权限；
- Windows 原生菜单/窗口控制，macOS traffic-light，Linux 窗口装饰的实际观察结果。

本计划不要求在没有目标 OS 或签名环境时伪造通过证据；包构建成功不等于安装/升级/卸载全部通过。

### 6.11 T1/T2：性能和资源回归（P1）

执行：

```powershell
bun run benchmark:tree
bun run benchmark:layers
bun run benchmark:render
```

关注指标：

- 1,000/5,000/25,000 节点的索引、筛选、展开和定位耗时；
- 虚拟列表挂载行数、长任务和 React 无意义重渲染；
- 3D 最高 512 层时的 layer layout、draw call、纹理数量和 Canvas 像素；
- 连续旋转只更新相机绘制，松开后再提交 React 状态；
- ResizeObserver、WebGL 纹理和组件卸载是否释放；
- 大 XML、长属性值、快照 diff 是否造成主线程阻塞或无界内存增长。

性能基准用于发现回归和决定优化优先级，不对所有电脑给出固定 FPS/耗时承诺。出现明显退化时保存基线 JSON 和最小复现输入。

### 6.12 T6：人工探索、可访问性和真实环境（P1/P2）

人工检查只补充自动化无法可靠证明的内容：

- Windows 100%/125%/150% 系统显示缩放、跨显示器拖动窗口和不同字体设置；
- 横屏、竖屏、方形截图和窗口尺寸变化中的构图、滚动、gizmo、选中框；
- 3D 正面、背面、左右、俯视、仰视和重置后的可读性；
- 键盘无鼠标完成设备选择、搜索、树操作、相机和属性托盘操作；
- Windows Narrator/NVDA 或 macOS VoiceOver 的基础朗读顺序、焦点和错误提示；
- WebGL 不可用时的 2D 回退、坏图片、坏 XML、设备断开和恢复文案；
- 主题/系统字体变化时中文、英文长词、serial、XPath 和 resource-id 的溢出。

人工结果必须记录 OS、显示器、缩放、字体、设备和步骤。没有实际环境就保留“待验证”，不得用自动化代理替代。

## 7. 失败分类与重试规则

### 7.1 严重级别

| 级别 | 定义 | 发布处理 |
| --- | --- | --- |
| P0 | 无法启动、数据损坏、错误写设备、sandbox 失效、主路径不可用、坐标误操作 | 阻断发布，必须修复 |
| P1 | 主要平台/设备/viewport 功能回归，深层定位、快照、3D 或属性不可用 | 默认阻断；若为环境缺证据必须明确标注 |
| P2 | 可绕过的视觉、文案、辅助操作或非主路径性能问题 | 记录、定优先级，不得伪装成已解决 |
| P3 | 不影响当前范围的建议或未来功能 | 只进入 backlog，不扩大本计划 |

### 7.2 Flaky 处理

- 同一命令第一次失败时只允许在相同环境重试一次；
- 第二次通过也不能删除第一次失败的报告，要记录“间歇性失败”；
- 超时必须保留 stdout/stderr、环境、报告路径和最后状态；
- 不得通过无限加大 timeout、跳过断言或关闭安全选项把失败变成通过；
- 若失败只出现在外部桌面/设备环境，标记为环境阻塞，并保留可复现的 fixture 结论。

## 8. 执行编排

### 8.1 Pull Request 快速门

适用于 `shared/`、`src/`、`electron/`、测试和脚本的普通改动：

```powershell
bun x tsc --noEmit
bun test tests
bun run test:tree-ui
bun run test:coordinates
bun run test:dpi
bun run build
```

涉及 UI 状态、布局或截图预览时追加：

```powershell
node scripts/app-smoke.mjs --fixture --reduced-motion
```

### 8.2 UI/交互改动门

涉及首页、顶栏、树、画布、属性或响应式 CSS 时追加：

```powershell
bun run visual:home:states
bun run smoke:fixture-dpi
```

并人工查看至少一张首页 connected、一个错误态和一张检查页截图。人工截图只保留在 `.benchmarks/`。

### 8.3 设备/发布候选门

涉及 ADB、采集、显示 geometry、Electron main/preload、package 配置或发布时追加：

```powershell
node scripts/app-smoke.mjs --require-device --reduced-motion
bun run package:win
node scripts/packaged-startup.mjs
node scripts/app-smoke.mjs --packaged --require-device --reduced-motion
```

macOS/Linux 使用对应 runner 和对应 package 命令。真实设备与安装包证据必须分别记录，开发版通过不自动继承给打包版。

### 8.4 CI 门

`.github/workflows/static-render.yml` 负责三平台静态 renderer 检查；`.github/workflows/native-electron.yml` 负责三平台 fixture smoke、原生包构建和启动探针。CI 失败时上传报告和日志，但不得上传真实设备数据。

三平台 CI 通过只能说明 runner 环境下的固定 fixture 和包启动通过；不能代替 Windows 物理 DPI、多显示器、签名、真实 Android 设备或屏幕阅读器验证。

## 9. 报告、证据和保留策略

### 9.1 报告最小字段

每次可发布验收至少记录：

```json
{
  "generatedAt": "ISO-8601",
  "commit": "git revision",
  "command": "exact command",
  "environment": { "os": "", "arch": "", "viewport": "", "scale": "" },
  "fixtureOrDevice": "fixture name or redacted device label",
  "success": false,
  "checks": [],
  "rendererErrors": [],
  "artifactPaths": [],
  "limitations": []
}
```

### 9.2 路径约定

- 自动化报告、截图、临时 profile、日志：`.benchmarks/<suite>/<timestamp>/`；
- 性能 JSON：`.benchmarks/` 下对应固定文件或时间目录；
- 测试 fixture：`tests/fixtures/`，必须脱敏并可审查；
- 测试计划、验收说明和限制：`docs/`；
- 构建产物：`dist/`、`dist-electron/`、`release/`，不可手工编辑或提交。

`.benchmarks/` 只适合本地或受控 CI artifact，不应直接发布到 GitHub 仓库。报告引用路径时同时写明它是本机、CI、开发版还是打包版。

## 10. 发布门槛

阶段性发布候选只有在以下条件满足时才可标记为“已验证”：

- [ ] T0 类型、构建、脚本和 diff 检查全部通过；
- [ ] T1 单测覆盖本次改动的纯逻辑边界；
- [ ] T2 DOM/树/坐标相关回归全部通过；
- [ ] T3 fixture smoke、视觉基线和必要的 DPI 代理全部通过；
- [ ] 涉及 ADB 时，至少一次 T4 真实设备开发版通过，且报告脱敏；
- [ ] 涉及发布时，目标平台 T5 安装/启动/安全探针通过；
- [ ] 所有 P0/P1 失败已修复或明确阻断发布；
- [ ] 外部环境未验证项已列在限制中，没有被自动化代理替代；
- [ ] README、相关计划和报告路径同步；
- [ ] Git diff 不包含真实设备数据、构建产物和临时文件。

## 11. 当前冻结基线（2026-09-15）

本测试计划冻结时，仓库已有以下证据：

- `bun run build` 通过；
- `bun test tests`：66 项通过；
- `bun run test:tree-ui`：树行为和 125% 页面缩放通过；
- `bun run test:coordinates`：100%/125%/150% 各 25 组，共 75 组通过；
- `bun run test:dpi`：DPI 代理 1/1.25/1.5 各 25 组通过；
- 首页五状态 × 三 viewport：15 组视觉/结构基线通过；
- fixture 完整应用 smoke：21 项通过；
- 当前接入 Android 设备开发版 smoke：22 项通过，renderer errors 为 0；
- 物理 Windows OS DPI、多显示器、最新源码对应的打包版实机回归以及首次三平台 CI 运行，仍按本计划保留为待验证环境证据。

以上基线是当前代码的快照，不是对未来改动的永久承诺。修改 ADB、坐标、窗口、CSS、WebGL、快照或 preload 时，必须按第 8 节重新选择测试层级。

## 12. 变更影响与维护规则

| 改动位置 | 最低追加测试 | 需要同步的文档 |
| --- | --- | --- |
| `shared/capture-display.ts`、`electron/adb.ts` | T1 + T3，涉及设备时 T4 | `SCREEN_COORDINATES.md`、本计划 |
| `shared/screen-coordinates.ts`、`ScreenshotPreview` | T1 坐标 + T2 DOM + T3 fixture | `SCREEN_COORDINATES.md`、本计划 |
| `shared/visible-tree.ts`、`UiTree` | T1 树 + T2 tree UI + 大树基准 | `TREE_PERFORMANCE.md`、本计划 |
| `Layer3DPreview`、相机/layout | T1 layer/orbit + T3 WebGL/拖动 + 人工 T6 | 3D 计划、UI 重构计划、本计划 |
| 首页/顶栏/CSS/token | T2 + 首页视觉基线 + T3 fixture | `UI_REDESIGN_REFACTOR_PLAN.md`、README、本计划 |
| `electron/main.ts`、`preload.ts`、IPC | T0 + T3 安全探针 + 目标包 T5 | `WINDOWS_STARTUP.md`、本计划 |
| package/workflow/installer | T0 + T5 + CI | README、`WINDOWS_STARTUP.md`、本计划 |

新增测试前先说明它要防止的风险、所属层级、输入是否脱敏、通过标准和报告位置。只增加“看起来更全面”但没有风险对应关系的组合，不进入默认门禁。

## 13. 关联文档

- 项目入口：[README.md](../README.md)
- UI 视觉与结构：[UI_REDESIGN_REFACTOR_PLAN.md](UI_REDESIGN_REFACTOR_PLAN.md)
- 开发目录：[DEVELOPMENT_STRUCTURE.md](DEVELOPMENT_STRUCTURE.md)
- 截图坐标：[SCREEN_COORDINATES.md](SCREEN_COORDINATES.md)
- 树性能：[TREE_PERFORMANCE.md](TREE_PERFORMANCE.md)
- Windows 启动：[WINDOWS_STARTUP.md](WINDOWS_STARTUP.md)
