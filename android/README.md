# Android Debug SDK（可选增强）

桌面当前源码默认标准采集，无需接入 SDK，也不探测 App 中的 SDK。需要额外树、属性、独立图或业务信息时，再接入本项目 SDK，并在 **偏好设置 → 采集 → 启用 SDK 增强** 中开启；安装 SDK 不会自动启用。切换与重新采集要求见[使用说明](../docs/FIRST_USE.md#sdk-enhancement)。

增强模式按 SDK 能力及身份、窗口、几何证据选择路径，SDK 不可用时保留基础采集；接入不保证任意 App 都有完整或精确图层。源码、安装版和设备验证分别记录。

- [接入与构建](#integration)
- [能力和限制](#capabilities)
- [保留数据更新业务 SDK](#business-sdk-update)
- [业务名称与分组信息](#business-debug-metadata)
- [样例与专项验证](#verification)

当前职责见 [开发结构](../docs/DEVELOPMENT_STRUCTURE.md)，已完成的架构工作见 [架构收尾](../docs/ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout)，设备和产物验证范围见 [验收记录](../docs/CORE_ACCEPTANCE.md)。历次部署播报、耗时对照、协议细节和失败证据已集中到 [SDK 专项历史参考](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md)，不作为当前部署状态或待办。

<a id="integration"></a>

## 接入与构建

本项目已验构建环境为 Java 17、Gradle 9.6 及 Android Build Tools 36；需要 Android Platform 30（SDK）和 36（样例）。配置 `JAVA_HOME`、`ANDROID_HOME` 后，在仓库根目录执行：

```sh
gradle -p android :inspector-sdk:assembleDebug :inspector-sdk:assembleRelease \
  :sample-app:assembleDebug :sample-app:assembleRelease --console=plain
```

SDK AAR 位于 `android/inspector-sdk/build/outputs/aar/`，样例 APK 位于 `android/sample-app/build/outputs/apk/`。只构建样例不保证重新生成供外部业务工程使用的 AAR；业务更新必须显式构建 SDK，并固定要引用的产物。

SDK 尚未发布到 Maven。同一 Gradle 工程可参考 [样例依赖](sample-app/build.gradle.kts) 使用 `debugImplementation(project(":inspector-sdk"))`。外部工程可引用核验后的本地 AAR：

```kotlin
dependencies {
    debugImplementation(files("libs/inspector-sdk-debug.aar"))
    debugImplementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.0")
}
```

本地 AAR 不携带 Maven 传递依赖声明，需同时配置上述兼容版本的绕过库。业务工程沿用自己的已验证 Gradle 和 Java 工具链，不为接入擅自升级依赖或切换构建参数。

依赖和业务调用均放在 Debug 源集中；Release 使用 [样例无操作包装](sample-app/src/release/java/com/androiduiinspector/sample/ProbeRunner.java)，不引入 SDK 或绕过库。Provider 由 SDK Manifest 合并，authority 为 `${applicationId}.inspector`，受 `android.permission.DUMP`、调用 UID 和可调试包校验保护，不开放网络端口。

<a id="capabilities"></a>

## 能力和限制

- **范围**：SDK 最低 API 21，自身图接口要求 API 26+；样例最低 API 26。现有真机证据主要来自一台 Android 14 设备，不能扩大为所有 Android/OEM、自绘、多窗口或长期内存验收。
- **画面来源**：普通 View 抓自身图；SurfaceView／TextureView 走专用缓冲路径。受保护内容明确失败，不绕过保护；空画面与采集失败分别表示。折叠整组图按需读取，无法忠实取得时保留有来源说明的本地合成。
- **一致性**：保留请求 nonce、进程实例、根窗口、控件身份、尺寸、图片摘要及几何核对。单控件绘制前后校验不保证整页同帧；完整父链、矩阵和裁剪证据不足时不能假装精确放置。
- **资源与发布**：`CapturePipeline` 共用 2 个编码线程、在途深度 4；`RefCaptureSelection` 管未提交及迟到位图，`CaptureOutput.LayerFile` 管图片流与原子发布。图片流的原子发布不等于图片和几何文件的跨文件事务。
- **调试隔离**：`DebugCaptureProbe` 仅位于 SDK 的 `src/debug`，不进入 SDK Release AAR；样例 Release 不包含 SDK 和故障探针。样例实验及新增源码不会自动更新已安装业务包。
- **模式与实验**：只有开启 SDK 增强后才进入 SDK 路径；单节点取图、排队和短父链等实验开关不能越过模式选择。增强模式内，小页面是否采用 SDK 图片仍取决于已声明能力和证据，不以旧文档中的单一节点阈值概括。

<a id="business-sdk-update"></a>

## 业务 SDK 保留数据更新

以下是每次更新的核对流程，不是安装指令或当前授权。源码构建、安装产物、运行身份、成功采集、冷启动问题、像素一致性及性能分别验收，不能互相替代。

1. **固定输入。** 保留旧业务 APK、SDK AAR、来源指纹、二进制 SHA-256 和签名基线；构建输出会覆盖旧文件，先保存独立副本。缺少来源资产或身份查询能力的旧 APK 不能充当新 AAR 的配对 APK，不伪造资产补过门禁。
2. **准备 SDK。** 显式构建 `:inspector-sdk:assembleDebug`，核对当前源码指纹、编译类和身份查询实现。AAR 复制到独立目录并记录完整 SHA；业务构建引用该固定副本，不跟随可变输出。仅有“构建成功／任务跳过”不能证明 SDK 已更新。
3. **构建业务 Debug 包。** 沿用业务已核验的工具链、Debug 任务、内存预算及依赖配置。已有业务接入可用 `-PinspectorSdkAar=/absolute/frozen/inspector-sdk-debug.aar` 指向固定 AAR；这是业务工程提供的参数，不是通用 Gradle 功能。依赖仅放 `debugImplementation`，保留兼容的 HiddenApiBypass 6.0。
4. **安装前核验。** 包名正确、Debug 为真、版本不低于设备版本、新旧签名一致。`verifyLocalQueueBuild` 核对 APK/AAR 完整 SHA 和唯一来源资产；另外核对实际 DEX 的身份查询校验、BuildConfig 指纹和会话路由，不只搜字符串。不得混入 sample／hold 组件，固定 AAR 的 SHA 在构建前后必须一致；任一不符即停。
5. **明确范围后安装。** 安装前重新读取设备包路径和完整 SHA；设备字节变化则重新取得安装包并验签，不继承旧证明。仅用 `adb -s SERIAL install -r -t --no-streaming /absolute/verified/app.apk` 保留数据覆盖；不自动卸载、降级、清数据或重装。失败保留原错误；覆盖安装可能结束 App 进程，不能继承安装前状态。
6. **安装后核验。** 重新检查实际安装路径、包名、Debug、版本和完整 SHA，必须与可信新 APK 一致；split APK 另做完整分包核对。APK、AAR、源码指纹、签名、新旧进程证据分别留存，不继承旧 PID、实例、样例结果或性能数字。
7. **业务观察另定范围。** 冷启动观察只在明确授权后执行：有界读取新主进程 PID／startTicks，再发一次诊断请求。PID 出现不等于 UI／SDK 就绪；只读进程观察最多 1 秒／10 次，不扩大入口 15 秒、250ms 通知或 32 帧预算。不预读树、不人工 hold，不在失败后重复启动或补跑到成功。恢复验证另定范围。

`sdk-source-v1` 是 SDK 源码和构建配置的关联指纹，写入 BuildConfig 与 AAR/APK 的 `assets/inspector-sdk-build.json`；它**不是二进制摘要或安全认证**。签名校验器的未保护 ZIP 条目警告必须保留，设备包与可信 APK 的完整 SHA 仍单独核对。

业务诊断还要求实际进程、实例和可信安装包匹配。Provider 尚未发布时，锁外 SDK 标量查询不能替代系统侧早期观察。单次身份引导、启动取证的限制见 [排队与身份协议](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#queue-identity) 和 [启动失败复盘](../docs/archive/STARTUP_FAILURE_REVIEW.md)。旧安装与冷启动失败记录见 [业务更新历史](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#business-update-history)，不得回填或覆盖。

<a id="business-debug-metadata"></a>

## 业务名称与分组信息

Debug 构建可用 `DebugNames.set(view, "业务名称")` 给没有文本或 ID 的控件加显示名。分组业务信息通过 `DebugMetadata` 在主线程登记；桌面启用 SDK 增强并重新采集后读取。属性栏支持按组展示、搜索和复制，快照、历史及调试报告保留采集时的值，关闭增强不删除已有数据。App 在状态变化时重新登记，控件复用前清除；它不会持续监听业务状态。

```java
import com.androiduiinspector.sdk.DebugMetadata;

DebugMetadata.setGroup(card, "component", "组件信息",
    DebugMetadata.text("name", "组件名", "SampleCard"),
    DebugMetadata.text("owner", "归属", "Feed"));
DebugMetadata.setGroup(card, "state", "页面状态",
    DebugMetadata.flag("loading", "加载中", false),
    DebugMetadata.number("retryCount", "重试次数", 0),
    DebugMetadata.text("error", "错误信息", ""));
// 再登记同一组会整体替换该组；清理时按需使用：
DebugMetadata.removeGroup(card, "state");
DebugMetadata.clear(card);
```

分层值使用 `tree()` 和 `treeText()`／`treeNumber()`／`treeFlag()`／`treeNull()`；标量空值使用 `nullValue()`。例如：

```java
DebugMetadata.setGroup(card, "state", "页面状态",
    DebugMetadata.nullValue("pending", "未获取"),
    DebugMetadata.tree("detail", "业务详情",
        DebugMetadata.treeNull("request", "请求",
            DebugMetadata.treeFlag("loading", "加载中", false),
            DebugMetadata.treeNumber("retryCount", "重试次数", 0),
            DebugMetadata.treeText("error", "错误信息", ""))));
```

- 文字、数字、布尔值保留协议 v1；树或 null 使用 v2。桌面兼容两版，快照只有含 v2 信息才写 v2；`false`、`0`、空字符串与 null 含义不同。
- 组／字段 key 为字母开头的 ASCII 标识，后续可含数字、下划线、点、短横线，最多 64 字符；显示名最多 64 字符、文字值最多 512 字符。数字必须有限，绝对值不超过 `9,007,199,254,740,991`。
- 每控件最多 4 组、每组 16 项、序列化预算 16KiB；每树字段最多 128 节点、8 层，根节点计第 1 层。同级 key 不重复，跨父节点可重复；路径用 `/` 分隔，key 不含斜杠。
- 登记保存数组副本；无效或超限登记抛出异常并保留原登记。每次整树业务值预算 256KiB，超出返回明确未保存标记，原控件树仍可用。
- SDK 只读控件私有 tag 中显式登记的值，不保留控件全局引用、不反射任意业务对象或执行回调。未登记、已清除或旧 SDK 缺项时不显示卡片。

更多展示说明见 [分层业务信息](../docs/FIRST_USE.md#structured-values)，实现与构建证据见 [业务信息验收](../docs/archive/ACCEPTANCE_HISTORY_2026-10-15.md#business-debug-metadata-acceptance)。接入新接口需要重新构建业务 Debug 包，不能把本地源码验收当成设备版本已更新。

<a id="verification"></a>

## 样例与专项验证

| 模块 | 用途 | 约束 |
| --- | --- | --- |
| `sample-app` | 自身图、动态几何、Surface／Texture、取消与失败恢复 | Debug 引入当前 SDK，Release 无 SDK |
| `sdk-free-sample` | 完全无 SDK 的兼容采集 | 不依赖 SDK／绕过库 |
| `legacy-window-sample` | 固定旧 SDK 的硬件／软件窗口兼容 | Debug 构建必须传 `-PlegacySdkAar=<核验过的旧AAR绝对路径>`，不引用当前 SDK 项目 |
| `recognition-sample` | fast／Helper 控件识别对照 | 最低 API 30，无 SDK／绕过库／网络权限 |

本地回归入口、设备范围和隔离约定见 [测试计划](../docs/TEST_PLAN.md)。调用整页或局部采集 API 的 SDK 专项探针显式选择 `sdk-enhanced`；小页面探针的 `--default-route` 指增强模式内的自动图片路由，不是应用默认标准模式。设备采集探针必须串行：现有图片路径由请求共享，并行会覆盖或清理彼此文件。安装、重启、导航和故障注入须符合本轮已明确的对象和范围，历史记录不构成重复操作授权。

计时必须区分 SDK 内部累计值、主机往返、文件与像素核验和物理上屏。嵌套阶段及并行线程累计值不能直接相加；未执行或未知字段不补零。失败保留原报告，只清理本次资源；后续成功不覆盖先前失败。详细命令、模式互斥和证据按主题查阅：

- [会话建立与计时](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#session-timing)
- [父分支恢复与模式互斥](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#branch-recovery)
- [超时、晚到结果和失败清理](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#timeout-diagnostics)
- [轻量几何与输出流水线](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#immutable-geometry)
- [性能实验及反例](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#timing-experiments)
- [矩形放置、图片流与会话协议](../docs/archive/SDK_REFERENCE_HISTORY_2026-10-15.md#geometry-contracts)
