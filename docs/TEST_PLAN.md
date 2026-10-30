# 测试与验收计划

更新：2026-10-13。Mac arm64本机升级、回退和一次原样例只读采集已验，见[交付说明](DELIVERY.md)及[验收](CORE_ACCEPTANCE.md#local-delivery-acceptance)。原U系列后续及手机复核暂停；控件识别、Helper真机响应体取消、原生候选窗口和30分钟固定样例验证已完成，完整布局门槛仍未通过，见[补验](CORE_ACCEPTANCE.md#helper-body-window-stability-acceptance)。安排见[计划](LOOKIN_ALIGNMENT_PLAN.md#下一步)；旧参数、预算和故障契约见[专项参考](archive/TEST_PLAN_2026-10-09.md)，不自动执行旧待办。

## 范围与数据

- 源码替身、真实IPC、候选代码、实际安装窗口、手机与目标平台分别留证，不能互相替代。
- 手机采集/输入/故障/更新、模型发送和发布按当前授权范围执行；单次只读不自动追加恢复重采。
- 保持sandbox、contextIsolation、preload白名单与主进程校验；不因失败跳断言、关闭安全项或扩产品期限。
- fixture合成脱敏；业务XML/PNG/APK/日志只在忽略目录，不用旧图猜当前节点。

## 验证入口

2026-10-13新增第五轮2D菜单、分组就地管理、预览输出、局部刷新菜单及准确输入展示参数检查，范围见[第五轮验收](CORE_ACCEPTANCE.md#lookin-ui-round5-acceptance)。前四轮入口继续保留。

| 范围 | 入口 | 边界 |
| --- | --- | --- |
| 逻辑与构建 | `bun run test`；`bun run build`；`git diff --check` | 根测试只运行`tests/`，实验子项目单独验证；不当设备或安装窗口通过 |
| 树/场景 | `bun run test:tree-ui` | 虚拟树、授权/历史交接、聚焦、取消/迟到 |
| UI第五轮组合 | 构建后执行 `node_modules/.bin/electron scripts/native-menu-checks.cjs --lookin-round5` | 真实main/preload/renderer，100% / 125% / 150%；2D原生右键命中、分组隐藏/恢复与焦点、预览原像素复制/保存及取消、相机参数/草稿Esc、此层/分支刷新。隔离配置、自有离线数据，菜单选择、文件框、剪贴板和在线采集/刷新替身；实际手机操作0 |
| UI第五轮分工 | `bun scripts/canvas-round4-checks.mjs --round5`；`bun scripts/inspector-groups-round5-checks.mjs`；`bun scripts/image-round3-checks.mjs`；`bun scripts/tree-round3-checks.mjs` | 2D留白/坐标异常/拖动/键盘；参数边界/输入法；七组显隐、全隐藏、搜索/保存失败、旧来源；预览同一已准备PNG、阅读点/失败/取消/来源；同根换设备、同快照换请求、旧菜单和旧直接刷新回调。分别使用自己的工作树和输出目录 |
| UI第四轮组合 | 构建后执行 `node_modules/.bin/electron scripts/native-menu-checks.cjs --lookin-round4` | 真实main/preload/renderer，100% / 125% / 150%页面缩放；工具互斥、模态/Esc与焦点、仅边框、隐藏项恢复/定位、完整属性分页/复制/定位、节点换页重置、只读结构阅读及颜色原值。自有离线样例、隔离配置，菜单选择/打开框/剪贴板替身，手机操作0 |
| UI第四轮分工 | `bun scripts/canvas-round4-checks.mjs`；`bun scripts/hidden-layers-checks.mjs`；`bun scripts/properties-round4-checks.mjs`；`bun scripts/tree-round3-checks.mjs` | 浮层外点/失焦/输入法、实际GPU边缘/空白命中、相机/测距/纹理身份；隐藏父子、30项分页、旧来源/繁忙；属性0/1/30/31/1000项、typed原值、色值精度、窄栏/主题与真实工作区回调。每个管理工作树使用自己的输出目录 |
| UI第三轮菜单与交互 | 构建后执行 `node_modules/.bin/electron scripts/native-menu-checks.cjs --lookin-round3`；沿用树/场景及工作台入口 | 真实main/preload/renderer，三档页面缩放；单项恢复、分支、巡览快捷键、属性栏关闭时的图片输出、偏好定位/重开及旧菜单隔离。自有离线样例与隔离配置，菜单选择/保存框/剪贴板替身，手机操作0 |
| 默认折叠 | `bun test tests/tree-collapse.test.ts tests/visible-tree.test.ts`；`bun run test:tree-ui`；`bun run test:diagnosis-handoff` | 精确类名/层级、坏设置降级、完整树保留；渐进/刷新保留手动状态与View身份、冻结当轮规则；搜索/定位/聚焦/离线重开、保存与应用分开。复用原有工装，不连接手机 |
| 快捷展开与状态说明 | `bun test tests/tree-collapse.test.ts tests/node-presentation-status.test.ts`；沿用树与坐标入口 | 2/4层按当前根计算，深选中路径与聚焦退出恢复，筛选/采集禁用，偏好不变；手动单层隐藏、设备不可见、等待、空图、缺图、失败和折叠来源分开，fast不等待独立图，状态变化后属性搜索可定位 |
| 离线快照文件 | `bun test tests/snapshot-file.test.ts tests/desktop-capture-handoff.test.ts tests/workbench-commands.test.ts`；树/场景工装及原生菜单工装 | 完整文件/旧树JSON、原始像素/采集信息/缺图、版本/大小/节点/真实图片拒绝；保存已有分支图、展开再折叠、坏文件/取消保留页面、迟到与卸载；原生main/preload/renderer文件往返及同配置窗口重开均核零设备请求 |
| 按需图层加载 | `bun test tests/layer-demand.test.ts tests/desktop-capture-handoff.test.ts`；`bun run test:tree-ui`；`bun run test:coordinates` | 选中/投影视口优先、进行中去重、动态优先级与失败不循环；同源缓存/2D-3D重挂载、刷新/迟到隔离。真实WebGL验证移入视口补图、平移复用、隐藏释放、图片身份变化、迟到ImageBitmap关闭，以及合成图扫描中展开再收起后的补图、父层级像素和命中；沿用原own/group像素、透明度、测距及坐标断言，不连接手机 |
| 坐标/DPI | `bun run test:coordinates`；`bun run test:dpi` | 三档缩放/DPR代理，不是物理DPI |
| 3D轮廓与强调 | 沿用`bun run test:coordinates`及`bun run test:tree-ui` | 实际WebGL验证native/trimmed/composite/legacy轮廓显隐、三级强调和悬停，点击及原图不变、零新增纹理上传；缺图/解码失败与折叠缺图分支保留轮廓。现有组件检查设置保存、换快照/重挂载、恢复默认及坏配置恢复，不新增benchmark入口 |
| Lookin 式测距结果面板 | `bun test tests/measurement-card.test.ts tests/node-metrics.test.ts tests/preview-viewport.test.ts tests/node-image-export.test.ts`；沿用`bun run test:coordinates`及`bun run test:tree-ui` | 工具栏开启、选中 A/悬停 B、树/画布联动、已有控件图片与蓝/橙尺寸线；包含/部分重叠/对齐/相接的原始边缘距离。Option 松开/失焦/保持、M/Esc、明确重选、同节点与繁忙/旧会话清理；宽窄和 150% 缩放下替换属性栏并留出画布，面板滚轮/指针隔离，零新设备读取和零主画布测距线/端点 |
| 控件图片输出 | `bun test tests/node-image-export.test.ts tests/desktop-capture-handoff.test.ts`；沿用`bun run test:coordinates`、`bun run test:tree-ui`及`bun run test:layer-images` | 自身/原生整组/本地重建来源、缺图/样式/可见性、PNG与WebP透明度、JPEG转换、坏图/超限/尺寸不符在输出前拒绝；真实浏览器合成像素、窄面板、取消/异步失败/重复点击、换控件/会话关闭位图并隔离迟到；实际App缓存/离线输出零额外设备请求。真实Electron ClipboardItem校验PNG内容，不写系统剪贴板；复用现有入口，sharp沿用产品外置依赖加载 |
| 属性分组显隐 | `bun test tests/inspector-groups.test.ts`；沿用`bun run test:tree-ui` | 七组设置即时生效、本机保存/重挂载、坏/未来/超长/读取失败回退、写入失败诚实提示；隐藏名称/值搜索临时展开，清除/Esc恢复显隐与手动折叠。完整复制/文件/历史保留业务和原始数据；全部隐藏可恢复，不存在的业务/交互不计可见项；300/248px入口和勾选可操作，设置零额外图层/刷新/样式请求。实际App工装使用合成桥接，存储与替身在finally恢复，不新增入口 |
| 树/画布悬停 | `bun test tests/node-hover.test.ts`；沿用树及坐标入口 | 实际App双向指向、直接父子引导、来源交接及Space/Shift/失焦取消待处理帧；25k虚拟回收、过滤/聚焦/换根清理。真实WebGL核折叠搜索路径的父层回退、隐藏、固定测距保持、零额外纹理上传/选择 |
| 层级路径导航 | 沿用`bun run test:tree-ui`，检查保存在`benchmarks/node-navigation-checks.tsx` | 实际App父级/根定位；200层完整名称和深度、300/248px及有界列表；筛选/虚拟树所需路径展开；聚焦定位优先及普通退出恢复滚动；隐藏保留、同对象重开/同ID新树/旧菜单/外来节点拒绝、采集/刷新禁用，零自动手机请求 |
| 不可见控件边界 | `bun test tests/layer-layout.test.ts tests/layer-appearance.test.ts tests/quick-select.test.ts`；沿用`bun run test:coordinates`及`bun run test:tree-ui` | 默认关闭及旧偏好兼容；不可见祖先、透明度0、隐藏placement与有效边界；虚线GPU绘制、边缘命中及内部穿透，聚焦/折叠/手动隐藏、原测距配对保留；实际App设置与宽窄窗口，零不可见图片上传/补采及原快照不变 |
| 折叠内部快速选择 | `bun test tests/quick-select.test.ts`；沿用`bun run test:coordinates`、`bun run test:tree-ui` | Command / Ctrl直接点选、松键后完成点击、Mac右键及平移/旋转保留；测距期间候选关闭后恢复原结果；当前绘制帧的透视回算/alpha裁剪，实际折叠分支、隐藏/聚焦/祖先裁剪及不可映射变换；每页30项及真实总数，SVG预览零纹理上传/树展开/补图/测距变化；真实工具点击保留中间动画帧，拖动中断、旧会话/失焦/Esc/繁忙清理，512层上限与原折叠像素回归 |
| 布局关系定位 | `bun test tests/layout-relations.test.ts`；沿用`bun run test:tree-ui` | 确认父布局、同父直接子节点完整ID唯一匹配、两个不同目标及真实parent；缺失/重复/不完整ID有原因，原值和目标名可搜索，300/248px；导航复用旧会话/筛选/聚焦/隐藏保护，零额外设备读取 |
| 分层业务信息 | `bun test tests/structured-values.test.ts tests/debug-metadata.test.ts tests/sdk-debug-metadata.test.ts tests/snapshot-file.test.ts`；沿用`bun run test:tree-ui`；SDK离线构建 | null/tree和真实路径，8层/128节点/16KiB/256KiB边界，同级重key/循环/非法值拒绝，v1/v2协议及文件兼容；实际SDK注册副本、历史/报告保留；折叠仍索引、临时展开恢复、精确叶行定位、完整复制、248/300px与换会话清理 |
| 连续图层动画 | `bun test tests/layer-motion.test.ts`；沿用坐标入口 | GPU实际首帧、展开/收起/快速反向、父层像素交接、alpha扫描打断后重入、512层/纹理额度及1.2秒失败兜底释放；重置相机可中断、快速2D/3D切换、运行中减少动态效果与会话清理 |
| 属性精确搜索 | `bun test tests/inspector-search.test.ts`；沿用树入口 | 真实行/深层祖先、只滚动属性栏、输入不抢焦点、Tab/Enter/Esc、30项上限与真实总数；完整长值/空白/0/false/空字符串及源圆角/时间/颜色复制，隐藏折叠恢复、300/248px、计时器和旧目标隔离、零额外设备请求 |
| 工作台与首页 | `bun run test:diagnosis-handoff` | 实际App/样式、合成桥接；三尺寸布局、树/画布/属性、报告生命周期、首页/偏好及真实键盘 |
| 候选UI | `bun run test:packaged-handoff --app-resources="<Resources绝对路径>" --candidate=<编号>` | 候选HTML/JS/CSS与worker，外置测试main/preload，不重新打App bundle |
| 候选菜单/报告 | Electron运行`scripts/native-menu-checks.cjs`或`scripts/test-report-checks.cjs`，加上述资源/候选参数 | 产品main/preload/renderer，隔离配置、空设备、选择器替身 |
| 候选只读命令 | `bun run test:packaged-readonly "<Resources绝对路径>" --candidate=<编号>` | 候选摘要、私有合成共享/撤销，每轮新目录 |
| 图片与报告边界 | `bun test tests/webp-alpha.test.ts tests/test-report.test.ts tests/test-report-diagnosis.test.ts`；`bun run test:layer-images` | 实际解码线程、坏图/超限/取消；路径/SHA/异常定位 |
| 调试逐步证据 | `bun test tests/debug-session.test.ts tests/debug-evidence.test.ts tests/debug-report.test.ts tests/debug-report-integration.test.ts tests/debug-report-view.test.ts` | 成功/失败/停止留证、最新100步及不同图片淘汰、分阶段错误、缺图/坏图/链接/身份拒绝；新报告与旧e2e分开验证，不把动作完成当任务通过 |
| 底栏点击与滚动容器 | `bun test tests/debug-session.test.ts` | 三层纯滚动边界包住底栏的直接/父控件点击；同App、严格包含范围；可点击容器/其子按钮、局部/同尺寸覆盖、跨App和滚动手势继续拒绝；MCP一次输入、sent不冒充verified、拒绝not_sent及原证据保留 |
| Artemis诊断、日志、预览与进度 | `bun test tests/connection-diagnostics.test.ts tests/connection-diagnostics-integration.test.ts tests/debug-step-logs.test.ts tests/debug-progress.test.ts tests/live-preview.test.ts`；构建后Electron运行`scripts/native-menu-checks.cjs --artemis`；`node scripts/live-preview-checks.mjs` | 只读诊断必需/可选/未知、超时及身份变更；目标主进程与时间归属、脱敏/额度/保存重开及停止取消；预览单请求/让路、pending关闭/迟到、刷新列表不误停、树和帧独立；授权/动作/Checker分开，旧事件拒绝。桌面使用隔离合成设备，不连接手机或更新安装版 |
| 步骤差异、任务模板与证据导出 | `bun test tests/debug-snapshot-diff.test.ts tests/debug-report-diff-view.test.ts tests/debug-task-templates.test.ts tests/debug-task-editor-model.test.ts tests/debug-report-export.test.ts tests/desktop-debug-task.test.ts tests/desktop-debug-report-export.test.ts`；构建后Electron运行`scripts/native-menu-checks.cjs --artemis-evidence`；`node scripts/debug-step-diff-checks.mjs`、`node scripts/debug-task-editor-checks.mjs`、`bun scripts/debug-report-export-ui-checks.ts` | 同一页面实例/窗口与唯一资源匹配，位置 ID/重复节点/旧观察不猜身份；模板有界校验、完整阶段复用、坏文件和外部改写保留；真实授权与两次新树验收；来源句柄/摘要/路径/链接/选择阶段导航/取消/资源清理；当前/全部步骤与三类附件选择，排除证据不能继承通过，完整导出后再导入。仅离线替身及隔离真实桌面IPC |
| 模板共享、匹配诊断与运行对比 | `bun test tests/debug-task-template-sharing.test.ts tests/debug-task-fragment-insertion.test.ts tests/selector-match-diagnostics.test.ts tests/selector-match-diagnostics-view.test.tsx tests/debug-task-comparison.test.ts tests/desktop-artemis-reuse.test.ts tests/task-match-navigation.test.ts`；构建后Electron运行`scripts/native-menu-checks.cjs --artemis-reuse`；`node scripts/template-sharing-checks.mjs`、`node scripts/selector-match-diagnostics-checks.mjs`、`bun scripts/debug-task-comparison-ui-checks.ts` | 兼容旧库、同名跳过/额度整批拒绝、文件身份/链接/取消与退出、插入独立编号；精确属性/参考隔离、20k树与展示预算、当前快照定位和草稿保留；完整定义对齐、加载器复核、缺树/重复证据/未验收和耗时范围、迟到/换主报告清理及主导出来源保留。仅离线替身和隔离产品IPC |
| 固定任务验收 | `bun test tests/debug-task-checker.test.ts tests/debug-task-session.test.ts tests/debug-task-api.test.ts tests/debug-task-report.test.ts tests/debug-task-view.test.ts` | 目标不可替换/输入前定义、顺序/复验清后续、两次新观察、取消/Helper拒绝、歧义/缺范围、留证与滚动、导入重新验树及CLI/MCP结果；v1/旧e2e兼容，缺树不能显示通过 |
| SDK业务信息 | `bun test tests/debug-metadata.test.ts tests/sdk-debug-metadata.test.ts tests/debug-report-integration.test.ts`；`bun run test:tree-ui` | 显式登记、原始类型/零/false/空串、替换/清除/复用、协议及Unicode/字节额度；SDK合并/刷新、离线文件与报告保留；窄面板搜索/复制/折叠与未登记/超限状态。JVM检查用真实JSON库及View/tag/线程替身，不当手机实测；缺JSON库时明确跳过，可用`SDK_TEST_JSON_JAR`指定已核验的org.json JAR |
| 结构与SDK | `bun test tests/architecture.test.ts tests/sdk-architecture.test.ts` | 依赖/循环、目录入口、Java职责与反射 |
| 桌面合成冒烟 | 构建后`node --experimental-websocket scripts/app-smoke.mjs --fixture --reduced-motion` | 正式IPC/工作台/WebGL，独立配置、不连接手机 |
| 固定视觉基线 | `bun run visual:baseline`；`bun run visual:home`；`bun run visual:home:states` | 共用脚本，工作台3尺寸、首页3尺寸、5种首页状态各3尺寸；原输出目录兼容 |
| e2e离线 | [实验目录](../scripts/experiments/tester-e2e/README.md)的`npm run check`、`npm run check:report` | 不连接手机、不调用模型 |
| 控件识别评估 | `bun test tests/recognition-comparison.test.ts tests/recognition-helper.test.ts tests/owned-debug-forward.test.ts`；构建、真机入口及配置见[对比计划](LOOKIN_ALIGNMENT_PLAN.md#recognition-comparison) | 核固定源码/补丁、唯一目标语义和完整布局；离线不当实测，全部失败保留；安装/手动启用、冷启动、后台、移除另留证 |
| 可选Helper后端 | `bun test tests/accessibility-helper.test.ts tests/debug-session.test.ts tests/cli.test.ts tests/mcp.test.ts`；`bun run test:tree-ui` | 实际采集代码接本地ADB/HTTP替身；私有令牌、唯一本包窗口、语义分离、会话API及CLI/MCP等待响应取消、响应体未读完取消收回转发、切源旧ID撤销和只读操作拒绝；不当新真机或安装版通过 |
| Helper固定样例产品路径 | 冻结工装、全部失败和真机结果见[补验](CORE_ACCEPTANCE.md#helper-body-window-stability-acceptance)；复跑限定临时安装/手动启用、观察、取消、HOME/自有样例返回及移除范围 | 私有Node宿主核API/CLI/MCP部分响应体取消；真实候选main/preload/原生弹窗/包内CLI-MCP核窗口及30分钟6轮（含5分钟后台），自然授权到期清理；候选补验与本机升级分次留证，不当多设备/多日或端侧任务停止通过 |
| 本机升级/回退 | [交付说明](DELIVERY.md)及[本机验收](CORE_ACCEPTANCE.md#local-delivery-acceptance) | 完整App/停机userData备份，旧历史与103节点工作台、正常退出及实际回退；安装版一次固定App只读深度采集另记，CLI/MCP本轮仅包内私有合成共享/撤销 |
| 首次使用组合 | [第一次使用](FIRST_USE.md)及[组合验收](CORE_ACCEPTANCE.md#first-use-acceptance) | 固定完整源码/锁文件，独立依赖目录安装构建；空配置真实样例采集、2D/3D/属性、原生保存/正常退出/重开历史；该真实快照包内CLI/MCP同ID查询，原生停止后同一客户端旧ID拒读，原历史不变；不当干净系统安装通过 |

Electron工装先清除`ELECTRON_RUN_AS_NODE`/`ELECTRON_RENDERER_URL`。Node 20工装的WebSocket参数不可省略；启动失败不算界面通过。本地报告工装可加`--report=/本地/summary/index.json`只读核旧14步/3图，不运行e2e；加`--debug-report=/离线调试目录/report.json`核前后图、动作标记、搜索与属性，同时用产品fixture授权/CLI采集验证本轮读取和停止后查看。后者只用合成观察与隔离配置，不连接手机，不当真机验收。

同一报告工装可再加`--task-report=/离线任务目录/report.json`，核5步固定样例的阶段/最终及历史三态、两次观察、1440/960宽无横溢；`--missing-task-report=/缺树副本/report.json`核通过降为证据不足。与`--debug-report`合用时，还验证真实源码主进程及独立CLI定义/验收后进入当前记录。使用合成观察、选择器和授权替身，不操作手机或更新安装版。

## 核心通过标准

| 范围 | 必须保留的检查 |
| --- | --- |
| 树与搜索 | 命中/来源/计数正确，祖先路径不计匹配；清除恢复真实折叠，显式定位才展开，同ID图更新不重放定位 |
| 双击与聚焦 | 树/场景/菜单共用偏好；箭头双击只切一次；分支与单层分开；退出恢复选中/折叠/滚动/相机/缩放/模式，隐藏保留 |
| 继承图标与操作提示 | SDK真实继承链有界读取，真实类名及QML/旧树回退保留；每会话最多一条，未展示不消费，关闭本机记忆，重置等待新操作；退出撤掉不误记已了解，暂停保留行高，原生Esc优先级正确 |
| 控件图片预览 | 自身/原生整组/本地重建原尺寸和透明度，真实解码核尺寸，适应/100%/缩放、无输出IPC、窄/矮窗口；换范围/节点/组/会话及关闭/卸载清旧，decode/bitmap延期取消及迟到close；图片弹窗Esc保留原3D/测距 |
| 大树与图层 | 25k/深宽树、499/500边界在100%/125%下保持28px行高及有界DOM，512层提示；own/group/未知/透明/缺图/失败分开，折叠父层子图刷新不能读旧缓存 |
| 画布 | 图像/边线/命中共用可信几何；适应避开实际属性栏，2D整图/3D角点可见；快速松手、取消/失捕获/换根释放手势，不误选 |
| 属性 | 诊断定位打开/展开并移交焦点，普通选择尊重关闭；观察当前画布且拒绝零高度；搜索临时展开/恢复，完整复制/错误/迟到隔离，未知不当零，窄卡片可滚动/点击 |
| 首页与菜单 | 连接/加载/未授权/无设备/ADB缺失/离线/错误；长名称/错误不越界；刷新重复/迟到隔离、旧设备禁用、离线历史、共享偏好、可用条件和统一快捷键 |
| 报告与请求 | 文件坏格式/摘要/大小/路径越界拒绝且保留旧报告；同窗口单次导入，选择器异常释放；关闭/重开/卸载/Escape隔离旧成功/失败/finally，取消不丢选择 |
| 安全与生命周期 | 换设备/App/窗口/PID/快照、取消/超时/断连均拒绝迟到；CLI/MCP写入核授权及当前几何，未知投递结果不自动重试，不编造业务成功 |

颜色验证沿用 `test:tree-ui` 的 Android 实时读取和 `test:diagnosis-handoff` 的 QML 离线属性/偏好场景：ARGB/CSS透明度顺序、全透明RGB、非8位alpha精度及近似Hex、原值/格式复制/失败、别名即时生效/重挂载保存/重复校验/写盘失败/坏设置回退、搜索折叠恢复、296/248px可达及换节点/刷新清旧。未知或无来源属性不生成色块，原快照不变；不是新增手机采集。

不做全维度笛卡尔积；新增组合须对应实际风险，先补最小fixture。DPR代理覆盖1/1.25/1.5，另有横竖屏/四方向/小数/坏越界bounds；reduced-motion只停动画，渲染错误不得忽略。

工作台源码与候选UI在1440×900、960×700、650×760检查；650宽是离线压力尺寸，不改变产品最小窗口。候选桥接禁止网络/设备/历史写入，合成fixture最多一次显式采集；原生空格/Tab/Escape须实际执行。首页抽屉文字对比≥4.5、AI文本在按钮内、无横溢/遮挡且互斥。

菜单/报告工装保持产品fixture门禁；三种导出拦截保存框并取消，核写入0。仅MCP配置IPC临时模拟正式resources上下文后立即恢复，并明确记为模拟，不当正式安装启动通过。UI工装外层预算90秒、内部等待4秒，产品期限不变；失败和截图每轮新目录保留。

## 实际桌面与手机

交付前核旧历史完整，正常退出并备份整包/停机配置；核候选/产物、真实安装路径/包内页面、正常配置和沙箱。设备发现与新采集分开记账，查看旧历史不追加手机取图。

实际报告导入先激活窗口，用确定绝对路径并单击原生“打开”。等待用户权限确认时保留状态与提示，不把确认延迟判为卡死；确认后另核步骤/图片可见、取消/坏索引保留、关闭重开/Escape和正常退出。文件元数据、选择器替身或无障碍图像节点不替代真实图片。异常另存观察，不凭系统日志推定权限或事件循环根因；恢复仅针对已核身份的自有进程。

实时诊断固定App，`singleAttempt=true`、`allowAppRestart=false`，显式一次、30秒停止；忙碌、错App/设备或语义树拒绝节点诊断。图像状态分开，节点只定位本地快照，不输入/导航。取消须在未完成时送达，记阶段/次数，观察原期限后无回填、按钮恢复、旧数据不变；恢复另限定一轮。SDK连接默认空闲5分钟后回收，自有转发为空不证明全部远端任务/内存收尾，不清别人的会话。

## 图片、性能与发布

- 报告/索引各8MiB、最多5000步；最多100张PNG、单图10MiB、总16MiB，路径/大小/SHA逐项校验，不执行报告HTML。
- WebP真实解码后扫alpha，alpha=1仍有内容；单图10MB/400万像素、度量3秒，首次含加载2秒、后续1秒。失败/动画/超限标未知，取消拒绝迟到；收尾另计，不是整页3秒承诺。
- 严格像素按原尺寸RGBA零差异；软件/硬件/原生group/本地合成/WebGL分开报告，旧微差不靠放宽容差遮盖。
- 稳定页至少3次连续完整请求，各≤15秒、覆盖可比、0失败；全部尝试/重试/收尾计入。首图送达→GPU≤500ms是目标，不称物理上屏；冷启动/恢复、整页/局部及CPU/GPU口径分开。
- P0/P1主路径、安全或数据风险阻断发布；未验列缺口。发布还需目标平台包、真实窗口/手机、物理环境及正式签名/公证，旧版本结果不自动继承。

## 按改动选择回归

| 改动 | 最低验证 |
| --- | --- |
| 纯逻辑/协议 | 类型、相关测试、全量和构建 |
| 树/截图/相机/属性 | 上述+相关组件/窗口/坐标；布局看实际截图与命中 |
| ADB/SDK/IPC | 上述+身份/取消/资源；按授权范围另验真机/恢复；SDK追加Debug/Release与签名/来源 |
| 打包/安装器 | 同候选产物、目标OS启动/安全、安装升级、备份回退与历史一致 |
| 仅文档/脚本整理 | 链接/锚点、命令/文件入口、相关回归、diff及独有证据保留，不为整理采手机 |

报告至少记日期、候选/命令/环境、范围、全部尝试/错误、耗时口径、检查项和限制。详细专项见[测试参考](archive/TEST_PLAN_2026-10-09.md)、[SDK更新](../android/README.md#business-sdk-update)、[目录](DEVELOPMENT_STRUCTURE.md)、[坐标](SCREEN_COORDINATES.md)、[树性能](TREE_PERFORMANCE.md)及[Windows启动](WINDOWS_STARTUP.md)。
