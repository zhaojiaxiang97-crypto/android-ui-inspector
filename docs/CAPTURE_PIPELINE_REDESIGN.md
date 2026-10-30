# 采集链路改造方案

日期：2026-10-15。目标是同时改善首屏等待和完整 3D 交付时间，两者分别测量、分别验收。

## 已确认的问题

快速采集先返回控件树和整屏截图，独立图标记为 `deferred`。这能提前开放查看和选择，但没有让全部独立图更快生成。
用户提前切换 3D 时，待加载节点曾被当成缺图层，占据层距并绘制密集空框；这与默认隐藏空层的体验不一致。

完整标准采集的主要瓶颈仍在设备返回整批图片之前：同一 432 节点、407 张图样例，DDMS 首包等待 **12,471ms**，收包不足 1ms，解析 3ms。
现有正常路径已经只发一次整树图片请求，不能把“改为批量”或电脑端收包并发当作新方案。
依据：[测量记录](CORE_ACCEPTANCE.md)、[整树请求与分段计时](../electron/capture/view-debug.ts#L103)。

## ARTEMIS 能借鉴什么

核对版本固定为 `google/artemis@351ca8422f7b5b54e80a9c1ce03a222e02415b6b`。

| 能力 | 源码事实 | 本项目适用范围 |
| --- | --- | --- |
| 常驻服务 | AccessibilityService 启动前台通知及本地 HTTP 服务，主机经 ADB forward 访问 | 复用观察通道，减少每次建立连接的开销 |
| `/snapshot?fields=xml` | 先异步请求整屏截图，同时遍历语义树，再等待截图并压缩为 JPEG 80 | 一次响应取得语义树和预览图；不保证同帧 |
| 语义节点 | 来源为 AccessibilityNodeInfo，包含文本、bounds、drawingOrder、windowLayer 等 | 供定位和只读观察；不证明真实 View 全覆盖 |
| 独立图层 | 上述节点模型与截图接口没有逐 View 独立像素、独立 alpha 或真实 View Z 数据 | 无法替代原生透明图层采集，不能用整屏裁图冒充 3D 层 |

官方固定源码：[服务与 HTTP 启动](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/ArtemisAccessibilityService.java#L83-L120)、[snapshot 并行读取与 JPEG 80](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/HierarchyDumper.java#L258-L316)、[节点字段](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/A11yNode.java#L21-L66)、[AccessibilityNodeInfo 遍历](https://github.com/google/artemis/blob/351ca8422f7b5b54e80a9c1ce03a222e02415b6b/packages/artemis-accessibility-helper/app/src/main/java/com/artemis/helper/HierarchyDumper.java#L613-L758)。

上游函数名虽然包含 `Atomic`，实现没有冻结页面或匹配树与截图的帧标识，不能据此声明同帧事务。

## 现有能力：继续复用

| 本项目已有能力 | 证据 | 真正的增量 |
| --- | --- | --- |
| 引入同一固定版本 helper，并启用 `INCLUDE_NOT_IMPORTANT_VIEWS` | [准备脚本](../scripts/prepare-recognition-helper.ts#L6)、[布局标记补丁](../scripts/prepare-recognition-helper.ts#L40) | 不重复引入 helper；保留语义覆盖差异 |
| `GET /dump?fields=xml`；每次建立自有 forward 后关闭 | [读取接口](../electron/capture/accessibility-helper.ts#L20)、[连接生命周期](../electron/capture/accessibility-helper.ts#L101) | 验证按会话复用自有 forward |
| helper 读树后，再单独执行 ADB PNG 截图 | [观察链路](../electron/automation/device-actions.ts#L32) | 可增加组合 snapshot 预览路径 |
| 每 2 秒更新整屏预览，已有取消、最新帧和忙时让路 | [周期](../shared/live-preview.ts#L3)、[预览控制器](../electron/device/live-preview.ts#L89) | 可替换取帧后端，不新建另一套流或调度器 |
| SDK 两个编码线程、深度 4 的有界队列、顺序写出 | [CapturePipeline](../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/CapturePipeline.java#L13) | 复用算法与验证方法；不能假定无 SDK 目标进程可直接调用 |
| SDK 分离记录 `renderMs`、`encodeMs`，主机已有 provider 会话池 | [端侧计时](../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyCapture.java#L423)、[主机会话池](../electron/sdk/provider-session.ts#L70) | 补标准采集通道的对应证据，不重复建设 SDK 流水线 |

## P0：修正当前使用流程

本轮产品行为：快速采集继续提供树和截图；实时快速快照点击 3D 时自动发起完整采集，等待期间保留 2D，完成后再进入 3D。
离线快照不能请求设备补图，应使用已保存画面，并明确说明尚未读取的部分。

- 待加载是未取得像素，不是透明，也不是终态采集失败；不得改写为 `empty`。
- 默认视图在布局、层数上限和 fit 计算前排除无画面的待加载平面，同时排除其绘制和点击区域。
- 已采集子层及有效整组图继续显示；真正的失败、匹配歧义和未知缺图保留诊断。
- 完整结构仍可手动查看布局边界；没有可展示内容时保留截图或准备提示，避免空白 WebGL 场景。
- 折叠组图请求独立于可见平面，防止隐藏待加载平面后永远无法取得第一张组图。

验收：提前切 3D、部分到图、完整到图、取消、切换快照、离线快照、手动完整结构，以及迟到回包隔离。
检查可见层、层距、fit 和实际点击结果；待加载状态不得污染透明度事实。
该阶段解决展示与采集完整性的一致性，**不宣称完整 3D 采集提速**。

## P1：先验证无 SDK 的原生独立图通道

要验证的问题是：能否在目标进程中取得真实 View 独立画面，并在全部图片生成完成前交付第一张。
先在固定、可调试样例上做最小实验，沿用现有[JDWP 传输](../electron/capture/jdwp-transport.ts)和标准采集身份校验，比较可行的调试附加/JDWP 路径与当前 DDMS 整批路径。

“通过调试附加运行分层取帧”“复用 SDK 的取帧、编码和背压算法”“逐层流式交付”目前都是待验证假设。
现有单层读取或 SDK 内的成功，不足以证明无 SDK 整页流式采集可行；独立无障碍 APK 也不持有目标 App 的 View 对象。

实验按三个检查点推进：

1. **取图正确性**：节点身份与原生树对齐，确认独立 RGBA、透明空层、半透明文字、Overlay、SurfaceView、TextureView、裁剪和变换。
2. **交付能力**：分别测端侧 View 绘制、编码、排队、首包等待、传输、解析、首图到达、全部完成和首次可用 3D；证明首图确实早于整批结束。
3. **稳定性与边界**：冷启动、连续热采、后台恢复、旋转、取消、断连和迟到结果；验证有界内存、资源释放及取消后可再次采集。

继续条件：在相同设备、页面、节点与图片覆盖下，正确性通过，并有可复现的首图或全部完成收益；报告两项指标，不能互相替代。
停止条件：无法获得真实独立像素，或只能等待同一整批响应。记录限制后停止该方向，不以截图裁剪降低验收标准。
通过实验后再设计正式传输协议、调度和迁移；当前不承诺具体速度或所有 App 的支持范围。

## P2：优化现有 helper 的 2D 观察链路

这是独立收益，不作为解决 DDMS 12 秒等待的依据。

- 先补端到端分段计时：目标检查、显示几何、forward 建立/复用、HTTP、端侧遍历与截图、编码、主机解析、清理；保留端侧 `elapsed_ms` 等返回统计。
- 在现有归属管理内按会话复用自有 forward，断连失效、退出回收；复用[现有连接管理](../electron/platform/owned-debug-forward.ts)，不重复建立另一套资源管理。
- 评估 `/snapshot?fields=xml` 作为语义树加整屏预览的组合请求；树与截图仍需分别校验目标、方向和尺寸，不承诺同帧。
- 上游 JPEG 80 只用于明确标识的预览。精确像素、取色和图像对比继续使用现有 PNG，或先给 helper 增加并验证无损格式；不能静默替换。
- 整屏预览继续用现有 `LivePreviewController`。若替换 helper 后端，应提供截图专用请求，避免每两秒为了截图重复遍历树。

验收分别报告首次连接、会话复用、后台恢复和断连重建的端到端分布、失败率、图片格式与语义覆盖；保留首采和失败样本。

## 测量口径与交付顺序

历史 helper 观察流程约 1.2–1.4 秒，后台恢复首采曾为 3.419 秒。它们包含 PNG 截图、身份/几何校验和分析，**不含 forward 建立**，不是纯读树耗时，也不能直接与完整原生图层采集比较。
详见[既有比较口径与原始结果](LOOKIN_ALIGNMENT_PLAN.md)；样例还存在 helper 10 节点与 fast 12 节点的覆盖差异，不能用少采内容换取表面速度。

交付顺序：P0 完成体验修正 → P1 提交可行性结论和原始证据 → 通过后实施原生通道改造；P2 可独立推进并单独记账。
每次对照固定设备、系统、App 版本和页面，记录节点/图片数、失败数及冷暖状态；首图到达时间和 GPU 首次呈现时间分别报告。
