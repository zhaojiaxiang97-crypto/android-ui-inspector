# Debug App 深度控件树改造计划

状态：已实施第一阶段
日期：2026-09-15

## 目标

只支持可调试的 Android App。当前已接入原生 View 树和 Qt/QML Debug 对象树；Release App 直接提示不支持。

目标 App 不要求修改业务代码。Qt/QML APK 必须自带 QML Debug 插件，程序首次采集时会以 QML Debug 参数重启目标 App。

## 基本规则

| App 状态 | 处理方式 | 页面提示 |
| --- | --- | --- |
| Debug 原生 View | `dumpsys activity top` 真实 View 树 | View Debug |
| Debug Qt/QML | QmlDebugger 真实对象树 | QML Debug |
| Debug 但深度工具不可用 | 停止采集 | 深度检查工具不可用 |
| Release | 停止采集 | 仅支持 Debug App |

不再使用 UIAutomator 的 `VirtualChild` 作为产品控件树。只有深度采集返回的 View / Compose 节点才进入界面。

## 实施步骤

### 1. 先做最小技术验证

1. 自动读取当前前台包名。
2. 使用 `run-as <package> id` 判断 App 是否可调试。
3. 已验证官方 `android layout --full` 仍依赖设备端自动化服务，不用于本项目的深度树。
4. 已验证当前 Debug APK 是 Qt/QML App，并成功读取 `QmlDebugger` 真实对象树。

这一阶段必须先证明能消除 `View$VirtualChild`，再进入正式接入。

### 2. 替换采集源

保留现有 `inspectDevice` 入口，但只允许 `debug-layout` 深度控件树。发现 Release App 或连接失败时返回明确错误，不再回退到 UIAutomator。

截图、设备方向和历史快照继续复用现有逻辑，不再建立第二套界面流程。

### 3. 统一节点数据

在现有 `UiNode` 上补充可选字段：

- 节点来源：View、Compose、WebView 或 Accessibility；
- 稳定节点 ID、父子关系和真实类名；
- alpha、visibility、elevation / Z、transform；
- padding、margin、background 等深度属性；
- QML 的源文件、行号、对象 ID、几何区域、visible、opacity 和 z。

现有树、属性栏和 WebGL 3D 展开继续读取同一个 `UiNode`，避免重写整套前端。

### 4. 调整界面提示

- 顶部显示“Debug 深度模式”；
- Release App 显示“仅支持 Debug App”；
- 深度连接失败时显示具体原因；
- 删除 VirtualChild 和 Accessibility 兼容提示。

### 5. 适配 3D 层级

- 使用深度树提供的真实父子关系和 Z / elevation；
- 展开的父节点只显示结构轮廓；
- 真正绘制内容的子节点承载颜色；
- 收起父节点时恢复该分支的合成画面；
- 无独立位图的控件只显示结构轮廓，不使用整屏截图裁切，避免混入其他层内容。

## 验收标准

1. 原生 View Debug App 显示真实类名，不出现成片 VirtualChild。
2. Qt/QML Debug App 显示真实 QML 类名、父子关系和几何属性。
3. Release App 无法开始采集，并获得明确提示。
4. 截图坐标、选中和 3D 高亮与深度控件树一致。
5. 深度工具缺失、连接失败或版本不兼容时不会导致程序崩溃。

## 暂不包含

- 支持或绕过 Release App 的调试限制；
- 对目标进程做 Hook；
- Compose、Flutter 和 WebView 内部树；
- 修改目标 App 的运行数据。

## 推荐实施顺序

先保证当前 Qt/QML Debug App 和原生 View Debug App 稳定，需要 Compose 时再接 AOSP App Inspection 通道。
