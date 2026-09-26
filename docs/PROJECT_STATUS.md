# 项目当前状态

更新时间：2026-09-26

这是当前进度的唯一总览。专项方案和历史排查记录仍保留在 `docs/`，但其中的旧计划不代表当前实现。

## 已完成

### 采集与层级

- 只支持可调试的 Android App：通过 `run-as` 校验，不满足条件时直接提示“仅支持 Debug App”。
- 原生 Android 使用 Debug View 层级；Qt/QML 使用 QML Debug 对象树。
- UIAutomator 只用于 fast 观察和自动化操作，不作为深度 3D 层级来源。
- 截图后默认展开全部可见子层；左侧树收起父节点时，右侧同步收起整棵子树。
- 每个层只显示自己的独立画面；没有独立画面时显示边框，不用整屏截图冒充控件背景。
- 收起父节点时使用该分支的合成画面，重新展开后恢复子层。
- 3D 视图支持旋转、平移、滚轮缩放、悬停高亮、选中、隐藏、聚焦、测距和自动取景。
- 属性面板为可拖动悬浮 Tab；树、画布、属性和截图定位保持同步。

### 连续采集稳定性

- 原生深度采集使用 DDMS 的 `VULW / VURT / VUOP` 协议。
- 自动补采只对可见叶子控件发送 DDMS 定点截图请求。
- 正常采集链路不再发送 JDWP 类查找、断点、对象调用或 `Dispose`，避免污染 Android 14 后续的层级导出。
- 已增加窗口根身份、导出结束标记、截图尺寸和前台窗口校验；异常只保留已有结果，不把失败伪装成透明。

### 自动化调试

- CLI 支持设备诊断、授权会话、树、搜索、属性、截图、测距、点击、滚动、返回和等待验证。
- MCP 支持只读快照和受授权的自动 UI 调试，操作前后会校验 App、窗口、快照和屏幕几何。
- 点击、滚动、返回都有 `dispatchState` 和失败证据，不会对未知结果盲目重试。

## 当前验证结果

- `bun test`：103 项通过，0 失败。
- `bun run build`：类型检查、renderer、Electron、CLI、MCP 构建通过。
- Android 14 真机连续两轮完整采集：每轮约 20 秒，861 个节点、126 张独立画面；第二轮没有 `DdmViewDebug` 或 `TimeoutException`。
- macOS arm64 本地应用已重新打包并启动：`release/mac-arm64/Android UI Inspector.app`。

## 已知限制

- Release App 不支持；仅包名带 `debug` 不算调试包，必须允许 `run-as`。
- Compose、Flutter、WebView 内部绘制树尚未接入。
- SurfaceView、OpenGL 外部缓冲、DRM/受保护内容受系统返回结果限制；当前优先保证连续采集稳定，不用不稳定的 JDWP 方式强行补采真实外部缓冲，可能只显示 DDMS 可见结果或边框。
- QML 复杂自绘、任意变换、部分圆角裁剪和未暴露的绘制顺序不能保证逐像素一致。
- 控件树、屏幕截图和独立图层不是同一帧原子快照；视频、动画页面可能存在时间差。
- 当前完整深度采集仍约 20 秒，主要耗时在 Android 的完整属性导出和批量图层导出，不承诺毫秒级。
- Android 10–13、更多厂商机型、Windows 系统 DPI、多显示器和干净系统安装仍需真实环境验证。

## 下一步

1. 继续收集不同 Android 版本和厂商设备的 Debug View/QML 真机结果。
2. 优先优化 `VURT` 完整属性和 `VURT2` 批量图层的耗时，不牺牲连续采集稳定性。
3. 对 Surface/OpenGL 外部缓冲只在不影响下一轮层级导出的前提下做独立实验，不直接恢复旧 JDWP 自动路径。
4. 补齐跨平台安装、升级、卸载和系统 DPI 验收。

## 文档入口

- 详细采集历史：[INSPECTION_RELIABILITY.md](INSPECTION_RELIABILITY.md)
- CLI：[CLI.md](CLI.md)
- MCP 与自动调试：[MCP.md](MCP.md)
- 测试总计划：[TEST_PLAN.md](TEST_PLAN.md)
- 开发目录约定：[DEVELOPMENT_STRUCTURE.md](DEVELOPMENT_STRUCTURE.md)
