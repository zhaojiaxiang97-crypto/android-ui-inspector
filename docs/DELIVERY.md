# Mac arm64 本机交付

本次交付是 Mac arm64 本机候选，含桌面、包内 CLI/MCP 和可选 Helper 只读采集。普通启动无需 Helper；CLI/MCP 的 `fast` 默认使用 UIAutomator，桌面手动深度采集保持原 Debug View/QML 流程。

先前已测基线为 `diagnosis-handoff-20261011-4a57e895`：真实候选窗口、只读 Helper、真实响应体取消和固定样例 30 分钟验证通过，详见[验收范围](CORE_ACCEPTANCE.md#helper-body-window-stability-acceptance)。本机临时签名不代表正式签名、公证或 Windows/Linux 交付；12/10 节点差异、多设备、多日和端侧任务停止等限制保留。

## 本机更新（2026-10-12）

当前候选为`diagnosis-handoff-20261012-746e1dc0`，asar SHA-256为`d6341d0afd3a979cc9ac2e6c9f3e71d387dbc65747d6f48f4a27a522c6850692`。冻结657份公开源码，8份产品产物与已验证构建逐项对应，完整App严格ad-hoc签名通过。已替换`release/mac-arm64/Android UI Inspector.app`并普通启动；原5份历史保留，另保存本轮更新前的16节点样例。已恢复该样例的3D页面及`UPDATED CHILD`选择；视角和倍率随重新打开恢复默认，没有宣称保存完整相机状态。

本次新增水平旋转、长文本阅读和树/画布快捷复制，见[操作说明](FIRST_USE.md#lookin-operation-details)及[验收](CORE_ACCEPTANCE.md#lookin-operation-details-acceptance)。实际窗口已确认自由/仅水平旋转选项，以及按节点数据生成的复制菜单；没有新增手机采集。完整旧App和停机userData备份、冻结候选、签名/8份产物检查、包内菜单/CLI-MCP和独立空配置启动结果见`.benchmarks/maintenance/lookin-operability-20261012-zy1r3j7s/`。

前一次深层父子展示更新保留于`.benchmarks/maintenance/deep-tree-hierarchy-20261012-ow2yioai/`，更早的默认测距更新在`.benchmarks/maintenance/explicit-measurement-20261012-nk1agbvn/`，首次2026-10-12更新在`.benchmarks/maintenance/lookin-delivery-20261012-06rjaae3/`；以下记录保留当时范围。

## 此前交付记录（2026-10-11）

| 项目 | 结果 |
| --- | --- |
| 最终候选 identity / asar SHA-256 | `diagnosis-handoff-20261011-de87a543` / `e1454b09201b112c66fad113b73f623f4915bff866bfd7bc4a2b70c4f37daa22` |
| 实际 App 路径 | `release/mac-arm64/Android UI Inspector.app`，已恢复新版普通启动 |
| 冻结构建源码 / 安装ZIP | `.benchmarks/desktop-candidates/diagnosis-handoff-20261011-de87a543-uqcf0Q/source/` / 同目录`Android UI Inspector-mac-arm64.zip` |
| 升级前版本 | `diagnosis-handoff-20261010-71c58c37` |
| 完整旧 App / 停机 userData 备份 | `.benchmarks/maintenance/delivery-20261011-rlnm_sgn/previous-installed.app` / 同目录`profile-backup/`，清单见`backup.json` |
| 升级与回退 | 新版、实际旧版回退均通过普通配置启动、5份历史/103节点工作台及正常退出；已恢复新版，历史/旧报告摘要不变 |
| 采集与CLI/MCP | 安装版固定自有样例的真实preload/IPC只读采集通过；包内CLI/MCP单独通过离线读取/撤销检查，见[验收](CORE_ACCEPTANCE.md#local-delivery-acceptance) |

包信息仍为`0.1.0`，以候选identity及摘要区分交付。改动按产品/协议、测试/工装、文档/归档、构建/CI归类；完整含新增文件的审查差异和清单见本机记录中的`reviewable-changes.patch`、`change-inventory.json`，真实Git暂存区保留，尚未提交或推送。最终完整公开源码及文档另存`full-source.tar.gz`；产品构建仍以冻结目录及`candidate.json`为准。

新增逐步报告和固定任务接口已在独立候选`diagnosis-handoff-20261011-ab4c3840`完成936项测试、构建/严格签名、自有样例一次点击验收及报告重开，见[验收](CORE_ACCEPTANCE.md#task-sample-flow-acceptance)。App保留于`.benchmarks/maintenance/task-sample-flow-20261011-jqnwez1e/build-final/package/mac-arm64/Android UI Inspector.app`；尚未替换上表安装版。需要这些新接口时使用该候选或新源码，使用步骤见[固定样例任务](FIRST_USE.md#7-可选完成一次固定样例任务)。

## 构建与固定候选

在 Mac arm64 主机、源码目录执行。依赖准备见[快速开始](../README.md#快速开始)。

```sh
bun install --frozen-lockfile
bun scripts/freeze-desktop-candidate.mjs
bun run build
node_modules/.bin/electron-builder --mac --arm64 --dir --publish never \
  --config.directories.output='<独立候选目录>' \
  --config.extraMetadata.inspectorCandidate='<固定入口输出的 identity>'
```

[固定入口](../scripts/freeze-desktop-candidate.mjs)输出 identity、`candidate.json` 和公开源码快照，包含CI、测试及独立实验的公开源码/元数据，记录当前未提交改动及旧包/配置摘要；实验依赖和本机产物仍排除，实验不进入根测试或桌面打包。冻结后保持产品源码不变，核对构建产物、候选 App 和签名，再填写上表。重建时使用冻结源码、锁文件及记录的环境版本。完整 App/userData 备份按下节执行。

常规打包入口为 `bun run package:mac`，输出到 `release/`；本轮使用独立候选目录，避免构建覆盖正在使用的交付路径。

## 升级与回退

1. 在旧桌面点击“立即停止”（若有会话），用 `⌘Q` 退出，确认主进程及自有子进程结束。
2. 备份**完整旧 `.app`**及停机后的**整个 userData 目录**，保留权限、符号链接和扩展属性。默认 userData 为 `~/Library/Application Support/android-ui-inspector`；自定义配置以实际路径为准。保留外部原报告目录及图片，userData 中的索引不能替代这些文件。
3. 将已核验候选的完整 `.app` 替换到上表实际路径；继续使用原 userData，不清空历史或设置。不要混用旧 asar 与新 CLI/MCP 文件。
4. 正常打开桌面，核对历史、偏好与候选 identity。包内 CLI 为 `Contents/Resources/cli/android-ui.cjs`，MCP 为 `Contents/Resources/mcp/server.cjs`；按[CLI](CLI.md#启动)检查 `--help`，从“文件 → MCP → 复制 MCP 配置”核对实际路径并重启客户端连接。调试授权需要重新确认。

需要回退时，先退出新版，另存新版 App和userData，恢复上表完整旧 App，再启动并核对历史。本轮保留当前userData实际回退通过；只有配置不兼容且确认已备份新数据时，再恢复对应停机userData。重新复制 MCP 配置、重连客户端并重新授权。恢复旧配置会撤回升级后的新增历史，因此保留新版数据与外部报告原目录。

## 可选 Helper：安装、启用与配对

Helper 单独安装在 Android 上，桌面不会代为安装、启用或配对。下列手机步骤仅在明确选定设备并授权后执行；不使用 Helper 时可直接按[普通 CLI/MCP 流程](MCP.md#使用)工作。

1. 准备 Java 17、Android SDK 36、Gradle及 `ANDROID_HOME` / `JAVA_HOME`，运行[固定源码准备入口](../scripts/prepare-recognition-helper.ts)：

   ```sh
   bun scripts/prepare-recognition-helper.ts
   gradle -p '<上条输出的 output>' :app:assembleDebug --console=plain
   adb -s '<设备序列号>' install -r '<output>/app/build/outputs/apk/debug/app-debug.apk'
   ```

   入口核验固定上游源码并保留 Apache-2.0 许可证，使用独立包 `com.androiduiinspector.a11yhelper`、名称 `Inspector Layout Helper`。安装前核对 APK 摘要与签名；安装被手机拒绝时由用户处理手机确认，再决定是否重试。

2. 在手机“设置 → 无障碍”中手动启用 **Inspector Layout Helper**，确认服务已运行。系统名称和确认位置因机型而异，保持其他服务设置。

3. 在本机私有目录新建令牌文件并配对；下例不覆盖已有文件，令牌不写入文档或报告：

   ```sh
   inspector_helper_token_file='/本机私有目录/helper-session.token'
   node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })' "$inspector_helper_token_file"
   adb -s '<设备序列号>' shell am broadcast \
     -n com.androiduiinspector.a11yhelper/com.artemis.helper.TokenReceiver \
     -a com.artemis.helper.SET_TOKEN --es token "$(cat "$inspector_helper_token_file")"
   ```

   令牌仅在 Helper 进程内存中保存。服务进程结束或重建后须显式重新配对；HTTP 401 不会触发自动配对或重试。

## 桌面配置与只读使用

先退出桌面，再从终端启动实际交付 App，将令牌文件路径传给**桌面主进程**：

```sh
ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE="$inspector_helper_token_file" \
  '<实际 App 路径>/Contents/MacOS/Android UI Inspector'
```

文件须为当前用户所有的普通文件、绝对路径、权限 `0600`、≤1KiB，令牌为 16–256 个字母、数字、`_` 或 `-`；符号链接拒绝。只给 CLI/MCP 客户端设置环境，或对已运行桌面设置环境，都不会生效。

在桌面授权指定 Debug App，按[CLI 入口说明](CLI.md#启动)使用 `android-ui`，或换为实际包内 Node 入口：

```sh
android-ui attach --pretty
android-ui capture --session '<会话ID>' --mode fast --backend accessibility-helper
android-ui tree --snapshot '<新快照ID>' --pretty
android-ui capture --session '<会话ID>' --mode fast --backend uiautomator
```

Helper 仅提供语义树及整屏截图，独立返回 `hint / error / stateDescription`；不能操作或等待验证。需要点击、滚动、返回或 `wait` 时，先显式采集 UIAutomator 并重新定位。切换来源即撤销旧 ID，失败不换源。完整字段、权限和限制见[MCP](MCP.md#可选-helper源码已接入仅只读)及[CLI](CLI.md#可选-helper-只读采集)。

## 停止与移除 Helper

1. 在桌面点击“立即停止”，或运行 `android-ui stop --session '<会话ID>'`。授权会话撤销，桌面收回自有转发；这不会关闭手机无障碍服务，也不证明端侧读树任务立即停止。
2. 清除配对（不传 token extra），在手机无障碍设置中手动关闭本 Helper；需要移除时卸载其独立包：

   ```sh
   adb -s '<设备序列号>' shell am broadcast \
     -n com.androiduiinspector.a11yhelper/com.artemis.helper.TokenReceiver \
     -a com.artemis.helper.SET_TOKEN
   adb -s '<设备序列号>' uninstall com.androiduiinspector.a11yhelper
   ```

3. 退出以 Helper 环境启动的桌面，删除自己的令牌文件，移除该启动环境配置，再普通启动。保留其他应用、无障碍服务和转发；停止前已返回给客户端的数据仍由客户端保留。
