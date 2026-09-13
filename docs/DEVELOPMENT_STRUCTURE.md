# 开发目录约定

本文档定义 Android UI Inspector 当前的目录职责、依赖方向和产物边界。Electron 是默认且正在维护的桌面运行时；根目录下的 Tauri 工程只作为历史原型保留。

## 目录总览

```text
android-ui-inspector/
├─ electron/                 # Electron 主进程、ADB 和持久化
│  ├─ main.ts                # BrowserWindow、IPC handler、导出入口
│  ├─ preload.ts             # contextBridge 白名单 API
│  ├─ adb.ts                 # adb 探测、UIAutomator XML、截图
│  ├─ capture-display.ts     # 截图与显示元数据
│  └─ snapshot-store.ts      # 本地快照历史
├─ src/                      # React renderer，只负责界面和交互
│  ├─ App.tsx                 # 工作台状态、Toolbar 和左右主布局
│  ├─ App.css                 # 明亮极简主题、响应式布局和交互状态样式
│  └─ components/            # 截图预览、3D layer 和节点属性组件
├─ shared/                   # 主进程、renderer、测试共用的纯逻辑
│  ├─ types.ts
│  ├─ tree-utils.ts
│  ├─ visible-tree.ts
│  ├─ screen-coordinates.ts
│  ├─ orbit-camera.ts        # 360°球面相机纯函数
│  └─ node-metrics.ts        # bounds 几何度量纯函数
├─ tests/                    # 单元测试、DOM 回归和脱敏 XML/视觉 fixture
│  └─ fixtures/
├─ benchmarks/               # 性能/坐标基准页和合成树数据
├─ scripts/                  # 开发、诊断、冒烟、视觉基线、基准和权限辅助脚本
├─ build/                    # electron-builder hook 和 NSIS 扩展
├─ .github/workflows/        # 三平台静态检查、原生打包和启动验证
├─ docs/                     # 验收记录、设计资产、性能报告和开发约定
│  └─ design/                # ImageGen 视觉参考和界面设计稿
├─ public/                   # Vite 静态资源；目前为空，新增资源再放这里
├─ src-tauri/                # 历史 Tauri 原型，不属于默认 Electron 构建链
├─ index.html                # renderer 入口模板
├─ vite.config.ts            # renderer 开发服务器和生产构建配置
├─ tsconfig*.json            # TypeScript 配置
└─ package.json              # 命令、依赖和打包配置
```

以下目录由命令生成，不能当作源码目录提交或直接修改：

```text
dist/                        # Vite renderer 产物
dist-electron/               # Electron main/preload 产物
release/                     # electron-builder 安装包和 unpacked 应用
.benchmarks/                 # 测试报告、日志、截图、临时 profile 和 ACL 备份
src-tauri/target/            # Cargo/Tauri 编译缓存
```

这些目录已加入忽略规则。`.benchmarks/` 可能含真实手机页面的 XML、PNG 和日志，发布前必须确认没有私人信息。

## 依赖方向

```text
src/ ───────────────┐
                    ├─> shared/
                    └─> window.electronApi ─> electron/preload.ts

electron/main.ts ─────> electron/adb.ts / snapshot-store.ts
electron/adb.ts ──────> shared/types.ts
tests/ ───────────────> shared/、electron/ 中可测试的纯逻辑
benchmarks/ ──────────> shared/ 和 renderer 组件的基准入口
scripts/ ─────────────> 构建产物、测试页和 Electron 启动入口
```

约束如下：

- `shared/` 不能依赖 Electron、Node 专属运行时或 React；设备协议和树算法优先放这里。
- `src/` 不能直接执行 ADB、读写文件或调用 Node API；桌面能力必须经过 `preload.ts` 暴露的白名单 API。
- `electron/` 可以使用 Node/Electron，但 IPC 输入仍要在主进程校验。
- `tests/` 的 XML 和截图输入应脱敏；新增厂商差异时优先增加 fixture 和解析测试，不要把真实个人页面放进仓库。
- `benchmarks/` 用于测量和回归，不承载产品功能；基准专用组件不要从 `src/` 反向引用。
- `scripts/` 只放命令行入口或测试编排；可复用的业务逻辑应下沉到 `shared/` 或可测试的 Electron 模块。

## 新功能放置规则

| 要增加的内容 | 放置位置 | 备注 |
| --- | --- | --- |
| 新的 UI 页面、面板、交互 | `src/` 或 `src/components/` | 通过现有 `window.electronApi` 调用桌面能力；节点属性面板不直接读取 ADB |
| ADB 命令、XML/PNG 采集 | `electron/adb.ts` 或相邻 Electron 模块 | 主进程执行并校验参数 |
| 主进程与 renderer 共用的类型/算法 | `shared/` | 保持纯 TypeScript；相机数学和 bounds 度量放这里 |
| 解析边界或回归样本 | `tests/`、`tests/fixtures/` | 样本必须脱敏并配套断言 |
| 性能、坐标和真实 DOM 检查 | `benchmarks/`、`scripts/` | 输出统一进入 `.benchmarks/` |
| 安装包、权限和构建钩子 | `build/`、`scripts/` | 不把生成文件写回源码目录 |
| 使用说明、验收结论、设计决策 | `docs/` | README 只保留入口和高频操作 |

## 构建产物约定

当前脚本沿用 Electron/Vite/electron-builder 的常见根目录输出：

- `bun run build` 清理并生成 `dist/` 和 `dist-electron/`。
- `bun run package:win` 生成 `release/`，Windows hook 只对 `release/win-unpacked` 做运行时权限准备。
- 测试和基准统一写入 `.benchmarks/`，每次真实设备冒烟测试使用独立的用户数据目录。
- 不要手动编辑 `dist/`、`dist-electron/` 或 `release/`；需要修改时回到 `src/`、`electron/`、`shared/` 或构建脚本。

保留这些输出路径是有意的：现有启动脚本、Windows 权限 hook、打包配置和验收文档都依赖它们，同时它们不会进入正式源码包。

## 历史 Tauri 原型

`src-tauri/` 是早期技术路线留下的 Rust/Tauri 工程，目前不参与 `bun run dev`、`bun run build` 或 electron-builder。除非重新决定切换桌面运行时，否则不要在其中开发新功能；其 `target/` 和生成的 schema 已单独忽略。
