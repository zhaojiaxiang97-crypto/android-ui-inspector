# 产品级风险验收：2026-10-19

本轮针对当前 Android UI Inspector 源码做隔离验收，重点检查来源身份、Electron 导航与 IPC、历史快照数据、采集事实和长期使用边界。候选工作树：`/Users/zhaojiaxiang/.codex/worktrees/product-risk-acceptance-20261019/开源项目2`；由主目录当前已跟踪和未跟踪源码建立本地快照（`2075dd0020f318ca8ec724b21e3ea1e4d13963fb`），保留主目录原分支和未提交文件。

**最新整合状态（2026-10-19）**：导航限制、主 Frame IPC 核对、快照库 200 MiB 总容量门禁、单份删除与列表入口已按文件核对后合入主目录的未提交源码；原有工作区改动保留。超过容量上限时明确拒绝新保存并保留旧文件；仍沿用最多 30 份的原有计数策略。全部 30 份均可在历史面板滚动查看并按份确认删除。整合前备份在 `.benchmarks/product-risk-integration-20261019/`。

## 实际结论

| 门禁 | 本轮证据 | 状态 |
| --- | --- | --- |
| P0 · 主窗口导航与弹窗 | 新增 `will-navigate` 文档身份校验和 `setWindowOpenHandler` 拒绝新窗口；沙箱、contextIsolation 及原有 IPC 主 Frame 核对继续保留。独立 Electron fixture 实际发起外部导航和 `window.open`，均未离开原文档 | **本地通过，尚未装包验证** |
| P0 · 本地历史 IPC | 保存、加载、清空、单份删除都要求桌面当前主 Frame；原生 fixture 检查单份保存、删除和非法 ID 拒绝 | **本地通过，尚未装包验证** |
| P0 · 版本与协议身份 | 本机旧 `app.asar` SHA-256 为 `15d22923…`，与 2026-10-12 交付记载的 `d6341d0a…` 不同；均不可依据 `0.1.0` 判定相同源码。新候选 `diagnosis-handoff-20261019-eacd168e` 已内嵌身份，冻结 1314 份源码，两层源码摘要及包内 8 项构建资源逐项通过；CLI/MCP、手机 Helper 分别匹配实际 SHA-256 | **冻结候选通过；旧安装版仍未对应新源码** |
| P1 · 快照库总容量与单份删除 | 新源码限制最多 30 份、单份 50 MiB、整体 200 MiB；超限明确拒绝新写入。新增单份确认删除、排他临时文件及 `0600` 权限。对旧版 `0644` 普通文件，在首次读取时经文件句柄收紧权限，拒绝符号链接。使用真实 22 份、473853241 字节的旧历史副本完成读取与超限拒写，原文件内容保持不变 | **真实历史副本兼容通过；实际用户文件未迁移** |
| P1 · 动态页面的采集一致性 | 源码校验前台窗口、PID 和几何，也已区分原生图、本地组图、缺图与来源未知；[状态页](PROJECT_STATUS.md)明确截图、树和各图层不保证同帧。未测实际动画页面跨阶段的时间偏差率 | **已有保护，缺少动态场景验收** |
| P1 · 长期资源与任务级延迟 | 当前性能数据主要来自固定样例；多机型、长期 GPU / ADB / 本地磁盘增长、冷启动与新版本升级仍未形成可迁移门禁 | **未完成长期真机验收** |

## 可复验范围

- `bun test tests/window-navigation.test.ts tests/snapshot-retention.test.ts tests/snapshot-history-list.test.tsx tests/snapshot-file.test.ts tests/desktop-services.test.ts tests/desktop-lifecycle.test.ts`：主目录整合后 27 项通过，0 失败。
- `bun run build`：主目录整合后 TypeScript、Renderer、Electron Main/Preload、MCP、CLI 全部完成。
- `node --experimental-websocket scripts/app-smoke.mjs --fixture --home-only --check-snapshot-delete --check-navigation-guard`：隔离候选和整合后的主目录均实际执行通过。主目录回执：`.benchmarks/app-smoke/2026-10-19T11-47-26-967Z/result.json`；确认外部导航、弹窗被拒，快照写入/删除、非法 ID 拒绝及历史文件权限 `0600`，共 7 项成功。没有访问手机。
- 主目录 `bun run test` 全量回归已尝试，但运行约 3 分钟仍未生成最终汇总，主动中断（退出码 130）；**不得写为全量通过或全量失败**。该进程已退出。上述 27 项定向测试及 7 项原生隔离检查有独立成功结果。
- 更完整的工作台冒烟在进入历史删除检查之前，触发旧脚本对 `.zoom-preset-select option` 的 `7` 项断言；当前页面实际为 `0` 项。该旧用例与新快照逻辑没有已证明的因果关系，**不能据首页冒烟称全部工作台回归通过**。

## 2026-10-19 冻结候选与旧历史兼容补验

本轮在独立工作树 `/Users/zhaojiaxiang/.codex/worktrees/product-release-identity-20261019/开源项目2` 进行，新候选 `diagnosis-handoff-20261019-eacd168e` 不覆盖主目录原有 `release/`。完整可机读清单位于该工作树的 `.benchmarks/desktop-candidates/diagnosis-handoff-20261019-eacd168e-CCPz3R/release-identity.json`，冻结清单为同目录 `candidate.json`。

| 核验对象 | 实际值及门禁 |
| --- | --- |
| 原始源码和冻结构建 | 共 1314 份源文件；原始 `sourceDigest=eacd168ec490eea86aab05a30ac9d2837780e8ad6c6562e04d9a13553623c9d4`，冻结包单独记录写入候选 ID 后的 `buildSourceDigest=56013fc0f7ed7c3d1f50cb77f91bacd0dcc0d8f1a3dee3ed790538d156cb8131`，两组逐文件校验通过；`bun.lock` SHA-256 为 `0a33063ae3f82eca799908f387845b26ebde546a3847be12f925ed631089c7be` |
| Mac arm64 新候选 | 内嵌 `inspectorCandidate=diagnosis-handoff-20261019-eacd168e`，`app.asar` SHA-256 为 `6f5472efe5e0345f3edfa74544165c24faf94bb0db4ec36b943a18b66c557c24`；8 项编译/打包资源一致，24 项文件/原生库摘要已登记。仅本机未签名 `--dir` 构建，未安装 |
| 包内 CLI / MCP | CLI SHA-256 `b4a186dce98621d89d8e05ed051db3bf339ce7dc35df09ac7c9ece490cc5651f`；MCP SHA-256 `800649866925e536a433c27d69f7b1da7e8555f51a573af3f5c10871f8dee003`。共 23 个工具与当前协议匹配，合成快照的读取、撤销和失败拒绝验收通过；菜单/原生交互夹具完成 |
| 实装 Android Helper | `com.androiduiinspector.a11yhelper` 为 `1.2.0-inspector-manual-pairing-v1`，现装 APK SHA-256 `b0206b11c21c0b180b429afe1fbae2bebaef9b2588f0a4e89d3fc8a273877064`，与 D24 的手动配对候选一致；仅静态对应协议 v1，**本轮未验证认证连接** |
| 旧历史副本 | 当前原文件 22 条、473853241 字节、权限 `0644`；受保护的只读原件备份在主目录 `.benchmarks/legacy-profile-validation-20261019/snapshots-original.json`，SHA-256 `8ae0978c895fd0d6f41aef5c3cd04660d75456ea0d6d47902974b523c360269f`。真实副本和 2 条合成旧数据均在 Electron 原生 fixture 中完整读取；副本首次读取后权限为 `0600`，超出 200 MiB 的新保存被拒绝，副本哈希不变，原用户文件未写入 |

完整候选 `bun run build` 和本地 macOS `electron-builder --dir` 均成功；`packaged-readonly-check`、`native-menu-checks` 通过。直接执行打包 App 的启动/沙箱/preload 检查返回 `success: true`、0 项渲染错误；**启动测试退出时未自动回收测试 App 进程**，已按独立候选路径确认并单独停止 3 个测试进程。不能据此宣称完整退出生命周期已通过。

补充主目录整合后复验：27 项定向测试全部通过，`bun run build` 完成（包含 TypeScript、Renderer、Electron、MCP、CLI）。直接用主目录刚构建的 Electron 对已备份的真实旧历史副本进行测试，22 条全部读取成功，首次读取修复副本权限，200 MiB 超限保存被拒绝且副本内容不变；证据保存在 `.benchmarks/legacy-snapshot-acceptance/profile-Is1dp9/acceptance.json`。另用两条合成记录验证容量内保存成功，并通过符号链接替换测试确认读取与保存均拒绝跟随链接，链接目标内容保持不变；证据在 `.benchmarks/legacy-snapshot-acceptance/profile-gRoTIO/acceptance.json`。这些测试均采用独立配置目录。

修订后的 `scripts/freeze-desktop-candidate.mjs` 仅给冻结源码中的 `package.json` 写入候选 ID，主源码 `package.json` 保持 `0.1.0`；原始源码哈希和候选标记后的构建哈希分别登记。原先包内协议检查工具清单过时，已同步 23 个现有 MCP 工具。上述源码与脚本改动在另一隔离工作树验证并整合回主目录，保留主目录既有未提交改动。此次身份比对只支持离线候选与现有安装的区别，**不代表旧已安装 App 自动升级到当前源码**。

## 2026-10-19 历史库恢复与回归补验

基于主目录当前未提交源码另建 snapshot-recovery-20261019 隔离工作树，验证后将 11 个相关文件逐一核对并整合回主目录，整合备份位于 .benchmarks/snapshot-recovery-integration-20261019/。新增历史库每份独立完整导出入口、首页与工作台单份删除、清空前确认、真实磁盘占用提示。保存超限后的错误不会隐藏历史列表；实际文件大小与按紧凑 JSON 计算的 200 MiB 保存配额分别说明。

主目录整合后，29 项定向测试通过，TypeScript、Renderer、Electron Main/Preload、MCP、CLI 均构建成功。原生隔离首页冒烟 7 项通过。旧用户历史原件仍是 22 份、473853241 字节；使用其备份副本通过全部读取、权限收紧、超限拒写且不改字节的检查，见 .benchmarks/legacy-snapshot-acceptance/profile-upMnnN/acceptance.json。逐份运行完整快照序列化和图片校验，22/22 格式与图片均有效。两份合成旧记录验证正常追加及符号链接拒绝，见 .benchmarks/legacy-snapshot-acceptance/profile-EPvPe4/acceptance.json。

打包启动测试已改为只终止自己创建的隔离进程组；独立候选验证成功，回执含 cleanupComplete=true、应用启动成功和 0 项 Renderer 错误。完整工作台冒烟已越过旧缩放下拉框、设置弹层、属性搜索及 3D 悬停测试，仍在后续“按 M 固定测距”步骤超时；该测试尚未全绿，不能视作完整工作台回归完成。

本轮未替换已安装的桌面 App、未修改用户真实历史、未执行 Android 输入或 Helper 安装，也未更新旧候选的代码摘要。新源码需要重新冻结并完成签名和升级/回退验收后才能正式交付。

## 需要继续执行的门禁

1. 已完成当前候选的源码冻结、构建、Mac App / CLI / MCP / Helper 的 SHA-256 对应。仍需正式签名、公证、候选安装/升级与回退验收，特别是旧安装版与历史文档摘要不一致的情况下，不能直接覆盖并宣称版本身份已修复。
2. 使用离线动态界面样例和自有 Android Debug App，分别验证滚动、切页、动画下树和图像的不同时刻结果会得到明确来源或未知提示；不要把图像源标记当成逐像素一致结论。
3. 在独立配置下做长时的采集/取消/切换/重开验收，记录进程 RSS、GPU 资源、ADB 转发、任务级可用时延和本地报告/快照增长；不能借一次 fixture 结果推算 30–60 分钟稳定性。
4. 旧历史已经备份并在独立副本上通过真实 22 条的兼容验证；主目录新代码将在**首次读取旧普通文件时收紧权限**，而真实用户文件的 `0644` 权限尚未变化。部署前仍须保留原件备份，并验证生产应用实际升级后的恢复路径；超过 200 MiB 时需用户先导出或删除快照，不能静默淘汰旧记录。
5. 原生完整工作台回归需更新过时的缩放控件断言，证明测试期待值对应当前 UI 后再复跑。当前 D24 扫描诊断与真实业务三轮仍按[原记录](AUTOMATION_BUSINESS_REGRESSION_D24.md)单独验收，不能合并为产品通过结论。

上述修复已整合到主目录未提交源码；独立候选和冻结身份清单保留供追溯。**没有替换当前安装的 Mac App**，没有重装 Android Helper，也没有触发手机输入。新候选未签名，旧用户数据未迁移；多平台/长期运行及实际升级验收仍需另行执行。本记录不能替代正式发布或 D24 完整业务验收证明。
