# 产品级风险验收：2026-10-19

本轮针对当前 Android UI Inspector 源码做隔离验收，重点检查来源身份、Electron 导航与 IPC、历史快照数据、采集事实和长期使用边界。候选工作树：`/Users/zhaojiaxiang/.codex/worktrees/product-risk-acceptance-20261019/开源项目2`；由主目录当前已跟踪和未跟踪源码建立本地快照（`2075dd0020f318ca8ec724b21e3ea1e4d13963fb`），保留主目录原分支和未提交文件。

**最新整合状态（2026-10-19）**：导航限制、主 Frame IPC 核对、快照库 200 MiB 总容量门禁、单份删除与列表入口已按文件核对后合入主目录的未提交源码；原有工作区改动保留。超过容量上限时明确拒绝新保存并保留旧文件；仍沿用最多 30 份的原有计数策略。全部 30 份均可在历史面板滚动查看并按份确认删除。整合前备份在 `.benchmarks/product-risk-integration-20261019/`。

## 实际结论

| 门禁 | 本轮证据 | 状态 |
| --- | --- | --- |
| P0 · 主窗口导航与弹窗 | 新增 `will-navigate` 文档身份校验和 `setWindowOpenHandler` 拒绝新窗口；沙箱、contextIsolation 及原有 IPC 主 Frame 核对继续保留。独立 Electron fixture 实际发起外部导航和 `window.open`，均未离开原文档 | **本地通过，尚未装包验证** |
| P0 · 本地历史 IPC | 保存、加载、清空、单份删除都要求桌面当前主 Frame；原生 fixture 检查单份保存、删除和非法 ID 拒绝 | **本地通过，尚未装包验证** |
| P0 · 版本与协议身份 | 本机 `release/mac-arm64/Android UI Inspector.app` 的 `app.asar` SHA-256 是 `15d22923f2413147f6d5bdc01d0844612a18ba53cf868ec9b4fbf734e43b23bc`，和[交付文档](DELIVERY.md)里仍写的 `d6341d0afd3a979cc9ac2e6c9f3e71d387dbc65747d6f48f4a27a522c6850692` **不同**。实际候选包的 `CFBundleShortVersionString` 和源码 `package.json` 都为 `0.1.0`，版本号不能确认代码身份。包内 CLI 和 MCP 文件存在且各有摘要；设备 Helper 为 `1.2.0-inspector-manual-pairing-v1`，源码仅能静态识别 Helper 协议 v1 | **不通过：缺少一致的交付来源证明** |
| P1 · 快照库总容量与单份删除 | 旧实现限制单份 50 MiB、最多 30 份，却无总量限制，隔离测试目录中新文件此前实测权限为 `0644`。候选新增总历史配额 200 MiB；超出配额时明确拒绝写入且原文件不变，沿用原有最多 30 份的计数策略。历史列表可访问全部记录并单独确认删除，写入改用排他新建临时文件和 `0600` 权限、保持原子重命名；已做原生 fixture 往返 | **新写入路径本地通过** |
| P1 · 动态页面的采集一致性 | 源码校验前台窗口、PID 和几何，也已区分原生图、本地组图、缺图与来源未知；[状态页](PROJECT_STATUS.md)明确截图、树和各图层不保证同帧。未测实际动画页面跨阶段的时间偏差率 | **已有保护，缺少动态场景验收** |
| P1 · 长期资源与任务级延迟 | 当前性能数据主要来自固定样例；多机型、长期 GPU / ADB / 本地磁盘增长、冷启动与新版本升级仍未形成可迁移门禁 | **未完成长期真机验收** |

## 可复验范围

- `bun test tests/window-navigation.test.ts tests/snapshot-retention.test.ts tests/snapshot-history-list.test.tsx tests/snapshot-file.test.ts tests/desktop-services.test.ts tests/desktop-lifecycle.test.ts`：主目录整合后 27 项通过，0 失败。
- `bun run build`：主目录整合后 TypeScript、Renderer、Electron Main/Preload、MCP、CLI 全部完成。
- `node --experimental-websocket scripts/app-smoke.mjs --fixture --home-only --check-snapshot-delete --check-navigation-guard`：隔离候选和整合后的主目录均实际执行通过。主目录回执：`.benchmarks/app-smoke/2026-10-19T11-47-26-967Z/result.json`；确认外部导航、弹窗被拒，快照写入/删除、非法 ID 拒绝及历史文件权限 `0600`，共 7 项成功。没有访问手机。
- 主目录 `bun run test` 全量回归已尝试，但运行约 3 分钟仍未生成最终汇总，主动中断（退出码 130）；**不得写为全量通过或全量失败**。该进程已退出。上述 27 项定向测试及 7 项原生隔离检查有独立成功结果。
- 更完整的工作台冒烟在进入历史删除检查之前，触发旧脚本对 `.zoom-preset-select option` 的 `7` 项断言；当前页面实际为 `0` 项。该旧用例与新快照逻辑没有已证明的因果关系，**不能据首页冒烟称全部工作台回归通过**。

## 需要继续执行的门禁

1. 在升级本机安装版前，冻结准确源码与依赖锁文件，生成 Mac App / CLI / MCP / Helper 四者的构建摘要清单，并复核正式桌面应用的对应关系；避免仅依据 `0.1.0` 断言相同版本。安装版替换、正式签名及多平台交付另行验收。
2. 使用离线动态界面样例和自有 Android Debug App，分别验证滚动、切页、动画下树和图像的不同时刻结果会得到明确来源或未知提示；不要把图像源标记当成逐像素一致结论。
3. 在独立配置下做长时的采集/取消/切换/重开验收，记录进程 RSS、GPU 资源、ADB 转发、任务级可用时延和本地报告/快照增长；不能借一次 fixture 结果推算 30–60 分钟稳定性。
4. 对旧版用户数据先备份再设计权限修复与超过新容量上限的兼容处理。候选的 `0600` 仅覆盖新写入，**不会自动迁移旧文件权限**；历史超过 200 MiB 时，新保存会提示用户先导出或删除旧快照，不会按新配额静默淘汰。原有最多 30 份的计数策略保持不变。
5. 原生完整工作台回归需更新过时的缩放控件断言，证明测试期待值对应当前 UI 后再复跑。当前 D24 扫描诊断与真实业务三轮仍按[原记录](AUTOMATION_BUSINESS_REGRESSION_D24.md)单独验收，不能合并为产品通过结论。

上述修复已经整合到主目录未提交源码，独立候选保留供追溯；**没有替换当前安装的 Mac App**、没有重装 Android Helper、没有触发设备输入。完整安装包、旧历史大文件兼容、正式签名与多平台/长期运行仍需另外验收；本记录不能替代版本发布或 D24 完整业务验收证明。
