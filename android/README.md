# Android Debug SDK 样例（P0 与混合验证）

这里包含截图能力验证和一个混合采集试验：SDK 提供真实 View 树与属性，桌面现有 Debug View/JDWP 通道提供独立画面及混合快照的单控件刷新。样例 App 通过 `debugImplementation` 引入 `inspector-sdk`；Release 使用无操作的 `ProbeRunner`，不包含 SDK。Android 14 样例已取得父控件自身图，但桌面产品仍沿用原有抓图通道。

构建环境：JDK 17+、Gradle 9.6+、Android Platform 36 与 Build Tools 36。设备首轮目标为 Android 14。取得许可并安装官方 SDK 后，可在本目录执行：

```sh
gradle :sample-app:assembleDebug :sample-app:assembleRelease
```

启动 Debug 样例后，报告位于其私有目录 `files/isolation-probe/result.json`，图像包括 `parent-group.png`、`child-own.png` 和 `parent-own.png`。可用 `adb exec-out run-as com.androiduiinspector.sample cat files/isolation-probe/result.json | jq -e '.isolationPassed == true and .opaqueChildClipped == true'` 复核父子隔离。

父自身图仅在 Debug SDK 中定向调用 Android 内部的 `createSnapshot(skipChildren=true)`；普通反射在此机型会返回 `NoSuchMethodException`，现在通过 `HiddenApiBypass` 调用，没有改动设备全局隐藏 API 策略。2026-09-28 小米 Android 14 真机：父整组图含 3732 个红色子文字像素、19125 个不透明绿色子项像素；父自身图两者均为 0，自己绘制的黄色标记仍在；透明文字叶子含 4872 个红色像素，角落 alpha 为 0。绿色子项越出父边界且被裁剪，`isolationPassed=true`。同一父对象尺寸由 731×506 改到 816×591 后，自身图尺寸同步更新，仍无子文字。Surface/Texture 暂不走此内部接口，Release APK 无 SDK 或绕过库。详见 [改造方案](../docs/LOOKIN_ALIGNMENT_PLAN.md)。

Debug Provider 除 `capture` 树外，还可按 `ref` 调用 `capture-own`；返回尺寸、进程实例和 PNG 的 SHA-256，图片放在 App 私有 `no_backup/inspector-own-image.png`。请求只接受 shell UID、`android.permission.DUMP` 和可调试包。未知对象返回错误，不会把整组图冒充自身图。此入口尚未接入桌面 UI；其他系统版本、自绘类型和性能仍需单独验证。

混合模式的 Debug Provider 使用 `android.permission.DUMP` 和 shell UID 校验，没有开放网络端口。桌面从 App 私有目录读取按需生成的树，仅在进程、窗口、节点身份和几何全部匹配时与独立画面合并；失败就保留旧快照并提示。加入不透明子项后，样例真机上 14/14 个 View 匹配（另有 1 个合成根）、9 张独立图，无警告。

Debug 构建中可调用 `DebugNames.set(view, "业务名称")` 为没有文本/ID 的控件加显示名；Release 构建请沿用样例的无操作包装，不引入 SDK。混合快照保留真实类名、ID、文本，同时读取 `LayoutParams` 类型、宽高和真实 margin；没有 margin 的参数类型不伪造 0。Android 14 真机样例已验证两处名称及负 margin；Release APK 无 SDK 类或 Provider。

SDK 还按实际 Java 父类返回去重的类继承表；属性栏仅在查看选中控件时展示。Android 14 的 20×20 样例中，435 个真实 View 均有继承链，SDK 树约 231 KB；旧 SDK 快照无此字段时仍可读取。

交互卡读取 View 的可长按、上下文点击、标准点击监听器、按下与激活标志。动态样例已验证长按和标准点击监听器可分别识别；未安装标准监听器不代表控件或子项不能响应自定义手势。旧 SDK 无此数据时不会显示该卡。

原生布局规则目前只读取系统 `FrameLayout.LayoutParams.gravity` 与 `LinearLayout.LayoutParams.gravity/weight`。样例真机已验证居中、右下及非零权重；其他布局不按控件位置猜测约束。

样例支持 `--es mode stress`（10×10 控件网格）、`--es mode stress-large`（20×20）、`--es mode dynamic`（点击红色文字后修改文本并新增控件）、`--es mode resize`（点击后只改变父子尺寸和文字，保持对象及树结构）和 `--es mode surface`（绘制一块纯绿色 SurfaceView，验证独立缓冲层）。Android 14 真机上分别验证了 125 节点/108 张图、435 节点/408 张图，以及动态模式从 14 到 15 节点的重新匹配。若在旧画面与 SDK 树采集之间改变页面，桌面会拒绝合并并提示；下一轮可恢复。435 节点三轮中位耗时：旧通道约 24.7 秒，混合通道约 25.5 秒，尚无速度收益。

局部刷新回归已在同一 Android 14 真机验证：`resize` 模式刷新后父子尺寸与文字同步更新；`surface` 模式分支刷新得到三张互不串色的独立图（父蓝底、Surface 绿色缓冲、透明红字）。Surface 色值相对绘制值存在小幅色彩转换，不能用逐通道完全相等作为画面正确性的断言。物理拔线和其他系统版本仍待验证。

当前只验证单进程、单 Activity 的原生 View 样例。业务 App 需自行添加 Debug 专用 SDK 依赖并重新构建；SDK 尚未发布到 Maven。多窗口、视频动画页、其他 Android 版本和更大树未验证。
