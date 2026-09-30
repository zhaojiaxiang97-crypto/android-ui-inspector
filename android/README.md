# Android Debug SDK 样例（P0 与混合验证）

这里包含 Debug SDK 和画面验证样例。SDK 提供真实 View 树、属性和独立图；接入 SDK 且至少 200 节点的页面默认尝试 `capture-visible`，DDMS/JDWP 保留兼容采集、局部刷新及缺图/特殊缓冲补采。样例通过 `debugImplementation` 引入 SDK；Release 使用无操作的 `ProbeRunner`，不包含 SDK。当前能力与下一步见 [Lookin 对齐计划](../docs/LOOKIN_ALIGNMENT_PLAN.md)。

新版 SDK 的 `capture-visible` 可携带 16 位十六进制请求标识，写入私有临时文件头并回显；树中用 `visibleStreamVersion=1` 标明能力。桌面仅对匹配本轮标识、当前进程/窗口、对象及尺寸且 PNG 校验通过的完整记录提前预览，最多三批；最终仍核对完整文件 SHA-256。旧 SDK 不轮询，照原路径等整包。取消后不交付迟到批次。

构建环境：JDK 17+、Gradle 9.6+、Android Platform 36 与 Build Tools 36。SDK 可集成到最低 Android 5 的 Debug App，但自身图仅对 Android 8+ 开放；目前只在 Android 14 真机验过。取得许可并安装官方 SDK 后，可在本目录执行：

```sh
gradle :sample-app:assembleDebug :sample-app:assembleRelease
```

启动 Debug 样例后，报告位于其私有目录 `files/isolation-probe/result.json`，图像包括 `parent-group.png`、`child-own.png` 和 `parent-own.png`。可用 `adb exec-out run-as com.androiduiinspector.sample cat files/isolation-probe/result.json | jq -e '.isolationPassed == true and .opaqueChildClipped == true'` 复核父子隔离。

样例和 `capture-own` 在 Debug SDK 中定向调用 Android 内部的 `createSnapshot(skipChildren=true)`（全页 `capture-visible` 使用 `ViewDebug.performViewCapture`）；普通反射在此机型会返回 `NoSuchMethodException`，现在通过 `HiddenApiBypass` 调用，没有改动设备全局隐藏 API 策略。2026-09-28 小米 Android 14 真机：父整组图含 3732 个红色子文字像素、19125 个不透明绿色子项像素；父自身图两者均为 0，自己绘制的黄色标记仍在；透明文字叶子含 4872 个红色像素，角落 alpha 为 0。绿色子项越出父边界且被裁剪，`isolationPassed=true`。同一父对象尺寸由 731×506 改到 816×591 后，自身图尺寸同步更新，仍无子文字。Surface/Texture 暂不走此内部接口，Release APK 无 SDK 或绕过库。详见 [改造方案](../docs/LOOKIN_ALIGNMENT_PLAN.md)。

Debug Provider 除 `capture` 树外，还可按 `ref` 调用 `capture-own`；返回尺寸、进程实例和 PNG 的 SHA-256，图片放在 App 私有 `no_backup/inspector-own-image.png`。请求只接受 shell UID、`android.permission.DUMP` 和可调试包。未知对象返回错误，不会把整组图冒充自身图。此入口尚未接入桌面 UI；其他系统版本、自绘类型和性能仍需单独验证。

在线混合快照收起父层时可按需调用 `capture-group(ref)`，在 App 内用 `View.draw` 取得整组图。桌面在抓取前后核对进程、窗口、对象、分支结构与尺寸，并核对 PNG 摘要；失败或分支含 SurfaceView/TextureView 时沿用本地合成图，展开仍只显示各层自身图。`View.draw` 不保留圆角轮廓裁剪，因此新版 SDK 遇到非完整矩形轮廓会拒绝失真整组图；可读圆角用独立图在本机裁剪合成，自定义路径无法读取时只提示，不伪造画面。运行 `adb shell am start -S -n com.androiduiinspector.sample/.MainActivity --es mode visual` 后可用 `adb exec-out run-as com.androiduiinspector.sample cat files/isolation-probe/visual-result.json | jq -e '.visualPassed == true'` 复验。Android 14 样例与本机像素回归已通过；业务 App 已升级 SDK，但当前首页没有可验的圆角父层，仍需在合适页面复验。

实验入口 `capture-own-batch` 一次接受逗号分隔的 1–10 个 `ref`，仅抓每个控件自身、单张最多 100 万像素、整批最多 200 万像素、每张最多 1 MB PNG，批处理预算 5 秒（单张等待超时可能使最终返回略晚）。图片及带 SHA-256 的清单位于私有 `no_backup/inspector-own-batch-*.png` 和 `inspector-own-batch.json`；读取者必须核对返回的清单摘要、进程实例、页面根节点、每张图片摘要与尺寸，并自行验证前台窗口。Android 14 样例同 10 个小文字控件的批量图与逐张图完全一致，三轮约 2.3–2.4 秒，逐张约 13.0 秒。运行样例回归：先用 `adb shell am start -n com.androiduiinspector.sample/.MainActivity --es mode stress` 打开页面，再执行 `bun scripts/sdk-batch-probe.ts DEVICE_SERIAL`。此接口尚未接入桌面默认采集，不能代替全量采集。

同一 Android 14 真机，动态样例新增子项后父自身图保持不变、变化的文字和新控件均各有自身图。业务 Debug App 的 10 个文字层也通过逐张/批量图片摘要对照；运行 `bun scripts/sdk-batch-probe.ts DEVICE_SERIAL com.smile.gifmaker` 可复测。业务页批量三轮调用约 2.3/4.4/3.2 秒，逐张 10 次约 17.8 秒；读图还需约 1–1.3 秒。当前只验证 10 张，尚未替代桌面 170+ 张图的完整采集。

混合模式的 Debug Provider 使用 `android.permission.DUMP` 和 shell UID 校验，没有开放网络端口。桌面从 App 私有目录读取按需生成的树，仅在进程、窗口、节点身份和几何全部匹配时与独立画面合并；失败就保留旧快照并提示。加入不透明子项后，样例真机上 14/14 个 View 匹配（另有 1 个合成根）、9 张独立图，无警告。

Debug 构建中可调用 `DebugNames.set(view, "业务名称")` 为没有文本/ID 的控件加显示名；Release 构建请沿用样例的无操作包装，不引入 SDK。混合快照保留真实类名、ID、文本，同时读取 `LayoutParams` 类型、宽高和真实 margin；没有 margin 的参数类型不伪造 0。Android 14 真机样例已验证两处名称及负 margin；Release APK 无 SDK 类或 Provider。

SDK 还按实际 Java 父类返回去重的类继承表；属性栏仅在查看选中控件时展示。Android 14 的 20×20 样例中，435 个真实 View 均有继承链，SDK 树约 231 KB；旧 SDK 快照无此字段时仍可读取。

交互卡读取 View 的可长按、上下文点击、标准点击监听器、按下与激活标志。动态样例已验证长按和标准点击监听器可分别识别；未安装标准监听器不代表控件或子项不能响应自定义手势。旧 SDK 无此数据时不会显示该卡。

原生布局规则目前只读取系统 `FrameLayout.LayoutParams.gravity` 与 `LinearLayout.LayoutParams.gravity/weight`。样例真机已验证居中、右下及非零权重；其他布局不按控件位置猜测约束。

新版 Debug SDK 的 `capture-style(ref)` 只按需读取一个控件的背景 Drawable 类型、可确定的纯色源色，以及 TextView 当前文字色和 px 字号；桌面属性栏点击“读取实时样式”后才调用。Android 14 样例已验纯色父层和文字层。渐变、自绘或 tint 不推断最终显示色；业务 App 需重新构建并接入新版 SDK 才能使用。

样例支持 `--es mode stress`（10×10 控件网格）、`--es mode stress-large`（20×20）、`--es mode dynamic`（点击红色文字后修改文本并新增控件）、`--es mode resize`（点击后只改变父子尺寸和文字，保持对象及树结构）、`--es mode surface`（纯绿色 SurfaceView）及 `--es mode partial-failure`（单层超出 400 万像素预算）。Android 14 真机上分别验证了 125 节点/108 张图、435 节点/408 张图，以及动态模式从 14 到 15 节点的重新匹配。`partial-failure` 验证超预算层明确失败、其余层继续采集，不再整批回退。若在旧画面与 SDK 树采集之间改变页面，桌面会拒绝合并并提示；下一轮可恢复。435 节点三轮中位耗时：旧通道约 24.7 秒，混合通道约 25.5 秒，尚无速度收益。

局部刷新回归已在同一 Android 14 真机验证：`resize` 模式刷新后父子尺寸与文字同步更新；`surface` 模式分支刷新得到三张互不串色的独立图（父蓝底、Surface 绿色缓冲、透明红字）。Surface 色值相对绘制值存在小幅色彩转换，不能用逐通道完全相等作为画面正确性的断言。单控件刷新与完整采集的物理拔线/重连已在当前 Android 14 设备验证；其他系统和更多断线时点仍待验。

当前已验证原生 View 样例及一款接入 SDK 的业务 Debug App；其他 App 仍需添加 Debug 专用依赖并重新构建，SDK 尚未发布到 Maven。多窗口、更多 Android/OEM、复杂自绘及长期内存未通用验收；上述历史小样例耗时不代表最新全页路径。
