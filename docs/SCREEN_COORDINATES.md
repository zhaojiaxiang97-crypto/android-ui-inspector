# 截图坐标与横竖屏验收

更新：2026-09-12。此轮实现针对 Windows Electron 桌面端；不修改手机分辨率、旋转设置，也不向手机发送触摸。

## 实现规则

- 使用 PNG 解码后的像素宽高，以及图片自身的 `getBoundingClientRect()` 换算。图片和高亮容器共用同一像素区域；装饰边线不占布局空间，预览等比缩放到可用宽度和最高 400 CSS px。
- 鼠标坐标与 DOM 矩形都采用 CSS 像素，不再乘 Windows DPR、Electron 缩放或 Android density。使用主指针的 `pointerup` 保留小数坐标；兼容 `click` 事件在本机 Chromium 中会截断小数，测试曾复现共享边界选错相邻节点。
- bounds 按左/上包含、右/下不包含判断，符合 [Android Rect 的点包含规则](https://developer.android.com/reference/android/graphics/Rect.html)。框先与截图取交集，再投影，修正负坐标、右下越界和一像素控件边框膨胀。
- 忽略不可见、空、倒置和非有限 bounds；父节点缺 bounds 不阻断合法子节点。迭代查找最小可见矩形；同面积优先更深层，再取 XML 后序兄弟。XML 顺序不代表真实绘制层级，遮挡和重叠仍需在树中确认。
- 截图原点始终是完整图片左上角，不能拿根节点 bounds 当屏幕尺寸。状态栏、导航栏、挖孔和应用留边不应引起整体平移。
- 更换图片重新建立解码状态；未加载、解码失败时不允许反查，也不沿用上一张图的高亮。节点树不依赖图片解码。

## 方向与尺寸核对

[AOSP UIAutomator 导出器](https://android.googlesource.com/platform/frameworks/testing/+/master/uiautomator/library/core-src/com/android/uiautomator/core/AccessibilityNodeInfoDumper.java) 将当前 display rotation 写入 `hierarchy`，节点 bounds 来自屏幕坐标。应用保留该字段，不因横屏再次旋转节点坐标。

XML 拉取后，在 `screencap -p` 前后各读取一次 `dumpsys input`。只识别明确的默认内置屏幕、零原点 `logicalFrame` 和 0/1/2/3 方向，不用 `wm size` 的物理尺寸猜测，也不读取任意外接屏数据替代。

快照新增可选 `captureGeometry`：XML 方向、截图前后的 display frame、PNG IHDR 尺寸。主进程和预览共用核对规则，预览额外核对实际解码尺寸；本地保存与读取校验该可选结构。

| 状态 | 条件 | 界面行为 |
| --- | --- | --- |
| `checked` | XML 方向、前后 frame 方向一致，frame 与 PNG 尺寸一致 | 显示“方向/尺寸已核对”，允许反查和高亮 |
| `unverified` | 旧快照缺 metadata，或设备诊断信息缺失/不受支持，且没有已知冲突 | 明确提示未核对，仍可尝试定位 |
| `mismatch` | 已知方向或尺寸冲突，或 metadata 格式无效 | 隐藏高亮、暂停反查，提示保持页面静止后刷新；保留树和原图 |

`dumpsys` 是尽力解析的诊断文本，不是稳定公共 API。重复 viewport 冲突时不采信该次读数；未知格式、命令失败或单次超过 5 秒均回退为缺失信息，不能称为核对通过。两次诊断额外耗时最多约 10 秒；没有自动重试、强制旋转或分辨率改写。

“已核对”只说明采样到的方向/尺寸相符，不保证 XML 与截图原子一致：动画、滚动、页面切换、采样间转走又转回仍可能造成内容错位。多屏、分屏归属、折叠屏切换、辅助功能放大及各厂商诊断格式尚未完整覆盖。PNG 头检查不是完整解码校验；实际解码失败由预览提示。

## 自动回归

```powershell
bun run test
bun run test:coordinates
bun run test:tree-ui
```

- 总计 44 项单元测试通过：原有树工具 15 项，坐标换算/裁剪/命中 17 项，display/PNG/XML 解析 4 项，fixture/深度兼容 8 项。
- 实际 `ScreenshotPreview` + 生产 CSS，在 sandboxed Electron 中运行 24 组检查 × 100%/125%/150% 页面缩放，合计 72 组通过。
- 尺寸矩阵：720×1280、1080×2400、1440×3200 及各自横屏；2560×1600、1600×2560、1000×1000。每种尺寸分别使用 240/680 CSS px 面板宽度。
- 覆盖等比尺寸、图片/高亮像素区域一致、共享边界、状态栏留白、负坐标和屏外节点、一像素框、页面滚动、四种 rotation、方向冲突、解码尺寸冲突、旧快照、坏图、迟到事件及横竖屏/缓存图片切换。
- 测试图片由本地 Canvas 生成；DOM 使用保留小数的主指针事件。高亮预期值独立按原始 bounds 投影，不调用生产坐标工具生成答案。容许 DOM 布局取整误差 0.08 CSS px。
- 这不是 9 台实机验收，也不是 Windows 系统 DPI 验收。页面缩放与 OS DPI 分开记录。
- 树 UI 回归继续通过：8 类旧基线，加 10 组虚拟树检查 × 2 种页面缩放。

报告：`.benchmarks/screen-coordinates.json`、`.benchmarks/tree-behavior.json`。基准页 CSP 阻止远程字体，采用本地/系统回退字体；应用代码与测试代码分别打包。

### 解析兼容性 fixture

测试夹具放在 `tests/fixtures/`，不会打包进应用。横屏 fixture 的节点数量、`View$VirtualChild`、稀疏 `index`、倒置空 bounds 和缺少 `visible-to-user` 属性来自真实设备 dump 的结构；敏感 package、文本、资源 ID 和描述全部换成合成值。另有完整属性的横/竖屏样本、无 XML 声明的旧式样本、数字布尔值、XML entity、格式错误 bounds 和超出安全整数范围的 bounds。

这组回归当前验证：`rotation` 0/1/3 保留，节点 preorder/id 与原始 child 数组顺序稳定，`index=0` 保留为数字 0，缺失属性按现有兼容默认值处理，额外的 `long-clickable`/`password` 等字段不会破坏解析，非法 bounds 返回 `null` 而不会污染相邻节点。它不是所有厂商和 Android 版本的完整协议规范。

### hierarchy 完整性与属性保留

采集默认执行完整 `uiautomator dump`，只有完整模式失败时才回退 `--compressed`，并把模式写入快照。当前设备同一页面对比为：压缩模式 29 个节点，完整模式 36 个节点，完整模式多出 7 个系统结构节点。

每个新采集节点保留原始 XML 属性 map，详情面板可展开查看全部属性；旧快照没有该字段时仍可读取，但需要重新刷新 UI 才能获得完整属性。若节点 class 包含 `View$VirtualChild`，界面会提示这是 Accessibility 虚拟节点，不代表被测应用内部完整的 QML/Compose/WebView/Canvas 渲染树。

## 本轮实机记录

设备：24094RAD4C；授权 USB ADB。所有原始 XML、PNG、快照和日志仅保存在忽略目录 `.benchmarks/`，请勿直接发布含私人页面的文件。

| 检查 | 画面 | 结果 | 本地报告目录 |
| --- | --- | --- | --- |
| 主进程直接采集 | 2400×1080 横屏 | 18 节点、7,472 字节 XML，XML/前后 frame rotation 均为 1，无 error/warning | `capture-coordinates/2026-09-12T08-19-13-452Z/` |
| 构建版真实桌面 | 2400×1080 横屏 | 8 项通过，包括鼠标反查、独立高亮投影和树联动 | `app-smoke/2026-09-12T08-22-01-683Z/` |
| 打包 EXE | 2400×1080 横屏 | 同样 8 项通过，方向/尺寸已核对，无 renderer 错误 | `app-smoke/2026-09-12T08-24-53-500Z/` |
| 打包 EXE，增加持久化检查 | 2400×1080 横屏 | 9 项通过，保存/重新读取/历史预览均保留方向 metadata | `app-smoke/2026-09-12T08-27-40-880Z/` |
| 同一打包 EXE，切回竖屏 | 1080×2400 竖屏 | 29 节点、约 11.8 KB XML，9 项通过，rotation 均为 0 | `app-smoke/2026-09-12T08-30-02-403Z/` |
| 构建版，切回竖屏 | 1080×2400 竖屏 | 29 节点、约 11.8 KB XML，9 项通过，方向/尺寸已核对 | `app-smoke/2026-09-12T08-30-11-524Z/` |
| 最新解析兼容性打包版 | 1080×2400 竖屏 | 77 节点、约 26.2 KB XML，9 项通过，方向/尺寸已核对 | `app-smoke/2026-09-12T08-57-27-979Z/` |
| 完整 hierarchy 与属性表打包版 | 1080×2400 竖屏 | 36 节点、约 14.2 KB XML，10 项通过；完整 dump、VirtualChild 提示、原始属性表和方向/尺寸均已核对 | `app-smoke/2026-09-12T09-49-26-830Z/` |
| 最终完整 hierarchy 打包版 | 1080×2400 竖屏 | 36 节点、约 14.2 KB XML，10 项通过；`package:win` 脚本复跑后再次通过全部检查 | `app-smoke/2026-09-12T10-13-49-966Z/` |

两个桌面版本都验证 sandbox/contextIsolation 开启、Node 未暴露。实机应用根节点为 `[104,0][2400,1080]`，屏幕有左侧留边；未把该偏移误当作截图原点。已查看真实窗口截图，高亮与留边符合原始 bounds。

验收命令：

```powershell
# 手机由用户自行切到横屏页面
bun scripts/capture-coordinate-smoke.ts --expect-landscape
bun run smoke:app --require-device --expect-landscape
node scripts/app-smoke.mjs --packaged --require-device --expect-landscape
```

冒烟脚本新增 metadata 保存/重新读取/历史预览检查，构建版和打包版均已通过，使用隔离用户数据目录，不改用户原有历史。本轮在同一台手机完成横屏、竖屏实机回归；用户手动旋转后重新采集，没有强制改写手机设置，也未实机复现采集中途旋转。没有实机时不得把合成测试计为实机通过。

## 交付与后续

本轮 NSIS：`release/Android UI Inspector Setup 0.1.0.exe`，112,306,932 字节；SHA-256 `2D57C01E85502336DA7ACF7FD3CB737025DCCC9FE9F0066ACE975F5C18340F2B`。未代码签名，未执行全新安装/升级/卸载向导。

ASAR 中 227 个条目，5 个 JS/CSS/HTML 构建文件与本地生成文件逐字节一致；包含新坐标逻辑，未包含基准或冒烟脚本。

fixture 和解析异常回归已加入；下一步扩展到更多 Android 版本/厂商设备，并继续补硬件清单中的其他分辨率设备、Windows 系统 DPI、折叠屏与多显示器。安装/跨系统验收见 [Windows 启动记录](WINDOWS_STARTUP.md)。
