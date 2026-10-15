> 归档于2026-10-09。保留原方案和当时结果；旧“当前/下一步/已部署”不代表现在的状态，也不延用当时的授权。当前能力看[状态](../PROJECT_STATUS.md)，未完成项看[计划](../LOOKIN_ALIGNMENT_PLAN.md#下一步)。

# 阶段证据摘要

2026-10-07 批量元数据单轮：`.benchmarks/current-log-directory-batch-DoZseV/`，8命令/2.579秒；安装/进程初检及初次设备时间通过，目录264.885ms返回D及`X entry-check 66`，确认FD检查通过、遇到第33个条目触发32上限。总数unknown，批量stat未执行，没有文件名列表/末次身份/新锚点；不是超时、批量工具已验证或App根因。正文/SDK/重启/暂停/安装/清数据0，主机命令均关闭，远端退出失败标记收到但未另查shell退出状态。前四轮报告散列未变，离线断言与24组合成/本机验证通过。公共代码/SDK/运行包未改、全量/构建未重跑，未再操作手机；下一项建议另确认最多128条仅列名，不增其他上限，不自动补跑。

2026-10-07 固定FD所有权元数据单轮：`.benchmarks/current-log-directory-owner-wFr0Vo/`，8命令/4.394秒；安装/进程初检和初次设备时间通过，FD规范路径及初次目录stat通过，返回21条原始文件名记录后达到目录1500ms上限（实际1503.663ms）。无完整结尾/目录列表、末次身份或新时钟锚点，总文件数unknown；正文/SDK/重启/暂停/安装/清数据0。自有主机命令均关闭，不证明远端shell结束；前三轮报告散列不变，离线复核通过。当时脚本与报告另存，私有候选本地改为固定FD内一次批量非跟随stat，24组合成及实际本机shell/GNU多文件模式验证通过；不是Android兼容或提速验收。上限不变，未再操作手机、改公共代码/运行包或重跑全量；下一项另确认同范围批量检查。

2026-10-07 带步骤标记元数据单轮：`.benchmarks/current-log-directory-staged-tYTfsi/`，8命令/2.662秒，安装/进程初检及初次设备时钟通过，目录存在/非链接、规范路径及打开目录通过；远端`X fd-canonical 65`后解析停止。没有文件名、末次身份或完整新锚点；不是目录丢失或App根因。主机命令均关闭，正文/SDK/重启/暂停/安装/清数据0，前两轮报告散列不变，离线核对通过。当时脚本/报告保留；仅私有候选本地固定创建FD的shell路径，本机父子PID不同/传入FD路径一致验证先失败后通过，18组合成及根路径拒绝通过。Linux /proc解引用、手机继承/权限及目录列名仍未验，公共读取器同模式待验证后修正；未重跑手机/全量、改公共代码或更新运行包。

2026-10-07 新确认的当前元数据单轮：`.benchmarks/current-log-directory-once-weDkdn/`，8条命令/3.286秒且主机退出均确认。安装摘要/真实进程初检和初次设备bootId/墙钟/uptime解析通过；第8条目录命令143.38ms返回空stdout/空stderr/主机退出0，无首个目录帧，解析停止。没有有效文件名、末次身份或完整新锚点，不能当目录为空/不存在或App根因；正文/SDK/重启/暂停/安装/清数据0。原7命令引号失败SHA不变，新报告及当时脚本保留，离线复核通过。仅私有脚本本地补失败步骤/退出码标记，18组合成和真实本机根路径拒绝通过，未重跑手机/全量、改公共代码或更新运行包；下一项另确认相同范围的带步骤标记检查，不回填旧轮。

2026-10-07 当前日志目录元数据单轮：`.benchmarks/current-log-directory-2UaBlZ/`。用户只允许核对当前时间/安装/真实进程及指定目录的有限文件名。安装/进程初检通过，7条命令均关闭；第7条脚本重复加引号，远端stdout报错但ADB主机退出0，解析拒绝且停止。时钟锚点/目录/最终身份均未完成，正文/SDK/启动/暂停/安装/清数据0。原`device-report.json`与当时脚本副本保留，当前PID数值相同不当旧轮生命周期证明。本地修正公共读取器与私有探针的参数；3项新增回归先复现失败后通过，33项相关及私有16组合成通过，688项/100文件全量0失败（114.12秒）、完整构建及diff检查通过。没有重跑手机、回填旧失败或更新运行包，Android目录读取仍未通过。

2026-10-06 业务SDK正确性更新：产物`.benchmarks/business-own-group-psstGk/`（私有业务APK/日志均在忽略目录）。先显式assembleDebug生成AAR，classes.jar的IsolatedCapture逐字匹配编译class；业务工程仅沿用既有inspectorSdkAar Debug接入，未编辑其源码，既有kwai-dependencies.gradle改动保留。assembleGifmakerDebug成功3m52s/70任务7执行；APK签名与手机旧包一致、DEBUGGABLE，实际DEX own包含硬件判定及snapshot/软件分支，group调用snapshot而非旧软件draw，样例/复用类排除。adb install -r成功，完整983401608字节手机APK拉回摘要与verification.json的验证产物一致；installed-before.apk及installed-after.apk均保留，没有卸载/清数据。启动HomeActivity命令等待10142ms返回timeout，系统随后仅确认HomeActivity任务1163；pidof返回14952/16339，不把任意首个PID当主进程身份。没有调用Provider读树/抓图，没有新转发，没有重启主桌面；已请用户切到App内设置主页，真实页面验收尚未开始。完整桌面/CLI/MCP构建、73项定向SDK/树/调试回归通过；当前安装结果不代表修复冷启动或业务总耗时达标。

2026-10-06 硬件复用文字：新增Debug-only TextReuseProbe，复用既有ReusableHardwareCapture/HardwareReuseSafety，不改生产SDK。第一轮`.benchmarks/text-reuse/2026-10-06T09-52-03-122Z/`为样例更新后固定ABBAAB（该旧报告尚无captureOrder字段）；反序轮`2026-10-06T09-53-36-490Z/`明确BAABBA，仅force-stop独立样例新进程。两个591×225文字每条路径3次；两轮各4PNG主机独立解码与own严格一致、renderer均创建1次/取图6次，跨控件及销毁后旧图hash不变。7类故障/取消/迟到检查全部通过，未测饱和缓冲队列。

AB轮普通文字own368.557/10.382/15.439ms、候选10.973/4.648/11.239ms；软件layer own11.119/8.546/8.229ms、候选6.994/6.704/9.088ms。BA轮普通文字候选358.328/6.237/4.310ms、own9.360/7.037/8.753ms；软件layer候选6.679/9.611/6.510ms、own7.089/9.740/9.386ms。首个开销跟随先执行路径，不是复用消除了首图延迟；有限样本/窗口时段重叠，不作业务总耗时收益。故障在性能之后执行，不预热对照。Debug/Release构建、Release DEX诊断/SDK排除、类型/diff检查通过；314项测试/0失败（50.81秒）。样例两次同签名保留数据更新，旧包`/tmp/inspector-text-reuse-rbLZ63/old-sample.apk`，业务PID23357/原HomeActivity任务1135不变、无forward，业务SDK/主桌面未更新。候选不合入生产；下一项仅更新已验证的own/group正确性并有界验证稳定业务页面。

2026-10-06 新叶子文字路径：复用现有HardwareTextActivity/SoftwareTextActivity，增加仅leafProbeToken触发的Debug-only TextLeafProbe及有界主机入口。首次`.benchmarks/text-leaf/2026-10-06T09-42-48-773Z/`失败保留：反预乘RGB固定阈值误报50个边缘像素，own/匹配snapshot仍零差异；该轮没有PNG，不能补写成像素通过。改为预乘通道#222222的8位舍入检查，并先保存PNG再判隔离；图片严格相等门槛不变。

最终硬件轮`.benchmarks/text-leaf/2026-10-06T09-44-06-888Z/`、软件轮`2026-10-06T09-44-48-364Z/`各两种591×225文字、每条路径3次交替顺序，所有重复及own/独立匹配snapshot零差异，子图角落透明/无白底，父own逐像素全白无子字；每轮6PNG由主机独立解码复核。硬件普通文字own360.245/7.072/8.139ms、旧路0.727/1.000/0.603ms，RGBA差1085像素；硬件软件layer own13.077/12.423/14.454ms、旧路0.795/0.542/0.786ms，RGBA差1256像素。软件窗口own两控件0.55～0.78ms、旧路0.35～1.00ms，全零差异。保留首样，不把首张原因断言为初始化、不从软件layer推出软件窗口，不作传输/业务总成本或物理屏幕验收。Debug/Release构建、314项完整测试/0失败（50.50秒）、4项定向路由检查通过；样例同签名保留数据更新，旧APK备份`/tmp/inspector-text-leaf-N7YIZa/old-sample.apk`，业务PID23357/原HomeActivity任务1135未变、forward为空，业务包/桌面未更新。下一项复用已有硬件复用工装有限验证像素及局部成本，未证明收益不改生产。

2026-10-06 半透明位置/底色/精度诊断：首次硬件F16 ImageReader被设备拒绝（Invalid format specified 22），失败产物保留；已撤销ReusableHardwareCapture的试验格式参数，既有硬件工装不变。新增Debug-only AlphaPrecisionActivity及有界脚本，软件F16只作辅助控制，不进入生产SDK。最终`.benchmarks/alpha-precision/2026-10-06T09-39-05-798Z/`8组执行完成，32PNG独立解码/8份原始F16尺寸与SHA保留；所有group重复零差异，三种位置对齐后的SDK合成差异图完全相同（366/38400像素，max1/alpha0）。透明/黑底、纯色半透明、不透明渐变SDK合成零差异；白底305像素max1。排除本样例三个整数位置影响，不外推旋转/分数坐标。软件F16灰底854、其8位转换549像素max1，与彼此差305；软件量化叶子与SDK硬件叶子244像素max2，证明软件源不是匹配硬件源，不能宣称F16修复或硬件量化根因已证实。诊断validated=true而严格本地合成=false。先前09-38-23轮同结果保留，第二轮增加逐通道残差对齐验证。Debug/Release构建、314项测试/0失败（50.51秒）通过；仅同签名保留数据更新独立样例，旧APK备份`/tmp/inspector-alpha-precision-bGwxyq/old-sample.apk`，业务PID23357/原HomeActivity任务1135不变、无转发残留，业务SDK/主桌面未更新。下一项转到新叶子路径文字隔离/成本，停止同类颜色探针。

2026-10-06 叶子渐变/透明叠加：扩展8组样例，首次`.benchmarks/group-color/2026-10-06T09-22-07-927Z/`严格失败保留：硬件叶子渐变305、固有半透明渐变488、普通alpha2379、重叠3498像素差1色阶，alpha均一致。发现硬件叶子仍直绘，改为按实际硬件状态snapshot；软件无outline叶子仍直绘。参考透明度round(127.5)=128不符View.draw的整数截断，工装改为127，不改产品透明度。源码依据[AOSP View.draw](https://android.googlesource.com/platform/frameworks/base/+/8360153/core/java/android/view/View.java)，Android14标签网页读取失败，不当厂商源码验证。

修正硬件轮09-24-11严格失败保留：叶子不透明渐变、普通alpha及重叠已零差异，固有半透明渐变剩366/38400像素差1色阶；原生group/独立匹配snapshot全部零差异。软件轮`.benchmarks/group-color/2026-10-06T09-25-03-626Z/`8组全零差异通过。

GPU控制硬件轮`.benchmarks/group-color/2026-10-06T09-26-48-443Z/`仍严格失败，7/8组通过；同一批own位图用Picture→HARDWARE Bitmap合成，CPU/GPU逐字相同，但各自相对原生整组有366像素差1色阶、alpha差异0。新增GPU/leaf PNG仅补读取和独立解码，无再次采集：确认CPU==GPU，叶子中心alpha128未带父底色；不能断言具体量化/坐标根因，不能靠换GPU或放宽容差关闭问题。32张基础PNG以及补充2张诊断PNG已保留，原生/本地准入标记分开。3次仅样例同证书保留数据更新，旧APK备份`/tmp/inspector-leaf-color-6sqhD4/old-sample.apk`；业务PID23357未变，返回同一HomeActivity任务1135，转发为空，业务包/主桌面未更新。完整314项测试/0失败（50.67秒）、类型/diff检查通过；软件窗口报告执行成功不覆盖硬件失败。

2026-10-06 group最小修正：IsolatedCapture.group沿用原尺寸/Surface/Texture/outline检查，改调用按isHardwareAccelerated选择的snapshot(skipChildren=false)，反射失败明确抛出且不软件回退；保留无checked exception的公开签名。普通叶子own仍调用独立softwareOwn，未借group变更偷偷改变文字取图；其它既有dirty改动保留。Debug/Release构建、类型/diff检查通过；仅同证书保留数据更新样例，旧APK备份`/tmp/inspector-matched-group-hhMe4p/old-sample.apk`，没有更新业务包。

真机硬件轮`.benchmarks/group-color/2026-10-06T09-16-40-709Z/`、软件轮`2026-10-06T09-17-03-765Z/`：每轮4个240×160面板，own/生产group重复零差异；own合成/生产group/独立匹配snapshot两两零差异。硬件轮明确旧软件重绘仍有2278/2322/4914像素差1色阶；软件轮包括旧软件重绘也全零差异。32张PNG独立解码复核尺寸及5组统计，无缩放/容差；透明文字父own全透明、子与group可见且角落透明，SurfaceView/TextureView/圆角group拒绝均通过。文字结果是透明性/隔离断言而非任意字体/半透明逐像素证明。完整314项测试/0失败（51.15秒），16项定向测试通过；业务PID23357前后未变、返回原HomeActivity任务1135、无转发残留，主桌面未更新，业务SDK下一轮再更新。

2026-10-06 固定后端对照完成：新增Debug-only GroupColorActivity及` sdk-group-color-probe.ts`，样例Debug/Release构建通过（10秒）；Release DEX明确不含GroupColorActivity/SDK/HiddenApiBypass。首次Release扫描默认输出缓冲不足，扩大本机读文件缓冲后通过，不是APK失败。与已装样例证书一致后保留数据覆盖安装，旧样例APK备份`/tmp/inspector-group-color-gM9lIy/old-sample.apk`；业务APK未动。

唯一真机轮`.benchmarks/group-color/2026-10-06T09-10-56-211Z/`：4个240×160固定面板，所有取图在同一UI任务且无状态修改，硬件加速确认；own及软件group各重复一次均零差异。纯色全部零差异；灰色纵向/横向和彩色纵向的软件group相对own合成分别2278/2322/4914个像素差1色阶，alpha差异0。own合成相对私有createSnapshot(skipChildren=false)硬件group全都零差异；12张原始PNG通过ffmpeg独立解码确认尺寸及三组逐像素统计，不是缩放或14分钟页面变化导致的该样例差异。报告completed表示对照执行完成，不表示软件/硬件相同；强化后的控制断言仅离线复核已保存结果，不追加设备轮。它定位该渐变样例后端差异，不证明此前业务色差根因或复杂clip正确性。生产IsolatedCapture未改，业务PID23357前后不变，返回同一HomeActivity任务1135、无转发残留，主桌面未更新。

最终仅离线复核`.benchmarks/snapshot-clip/2026-10-06T09-06-20-240Z/`再次保留严格失败：缩小图1145/99844、原尺寸17280/2298240像素差1色阶，alpha均0差异。本地合成/平面基准零差异。通过条件现明确要求缩小图及原尺寸同时零差异，类型/两入口脚本语法/diff检查通过；没有追加手机请求。

2026-10-06 手机整组图对照：新增`live-group-probe.ts`复用正式captureViewGroupImage，25秒取消预算、单次高层调用、结束释放自身连接，不补全量采集。内部原有读树超时重试规则未改。输入08-43-21业务快照，分支`0/0/0/1/0/0/1/0/0/0/0/1/0/4/0/1/0`；产物`.benchmarks/live-group/2026-10-06T08-57-50-872Z/`，2927ms、1080×2128、13894字节PNG，SHA及前后实例/引用/几何检查通过。图像主要为浅色渐变背景，不代表丰富内容或复杂clip验收。own快照08:43:33与group08:57:53相隔约14分钟，引用/几何一致不保证像素状态相同。

离线严格比较保留失败：08-59-32输出99844像素中916个RGB差1色阶，09-00-44加入原尺寸检查后缩小图1145个差1；缩小结果不视为确定的源像素计数。原始2298240像素中17280个差1色阶、alpha差异0，本地合成与平面基准仍完全一致。own容器走私有硬件snapshot、group走软件View.draw，取整差异仅为待证假设，不排除采集时间变化。两种分辨率都必须零差异才通过，不用容差掩盖。错误分支0/1离线身份检查直接拒绝，未连接手机。16项定向测试、类型/diff检查通过；未改生产SDK/桌面交互，未安装/重启/清数据、未再次整组或全量采集，PID23357不变、无转发残留。

本轮最终桌面fixture`.benchmarks/app-smoke/2026-10-06T08-54-06-146Z/`通过27项、renderer errors=0，包含折叠后一级展开及显式全部展开恢复。较早08-51-47串行轮同样出现测距点击前悬停失效，排除“只因并行检查”的解释；工装现从画布外重新移入目标，避免重复同坐标CDP移动没有新pointermove的条件，最终通过，旧失败仍保留。类型/脚本语法/diff检查通过；完整业务流程修正后未补跑手机，不冒充真机复核。正式SDK/渲染/交互未改，只改验证工具、回归和文档。

2026-10-06 业务分支折叠及本地合成：唯一手机采集`.benchmarks/app-smoke/2026-10-06T08-43-21-096Z/`，1605节点、首图至GPU完成136ms、工作台完成观察11.868秒；交互前快照已保存，11项检查后在business child planes restore超时，renderer errors=0。虚拟树滚动定位确已找到refresh_layout，两个展示子层折叠移除、父层composite及截图保留。收起后代的既定语义意味着重新展开只打开一级，原全量恢复断言错误；现增加一级展开检查，显式“全部展开”后再核对原ID/mode，失败时提前保留folded/reopened标量。快照离线重建219→217→218→219符合该语义。14项可见树/分支逻辑通过；不能把旧工作台轮改写为成功。

该分支离线像素入口使用两张真实own图、截图1080×2400裁限，rect(0,345,1080,2055)，100k输出预算229×436。平面绘制参考独立于生产递归合成/树顺序，仅接受单位alpha、无复杂clip/transform/reorder的范围；与parent-only对照验证子图贡献。`.benchmarks/snapshot-clip/2026-10-06T08-51-09-059Z/`99844像素RGBA完全一致，98928像素相对parent-only改变，mismatch=0。较早08-48-31/08-49-09/08-49-46结果有924像素最大1色阶差异；参考canvas使用willReadFrequently选择CPU后端，生产默认后端，改为同一canvas后端后逐字通过，未放宽容差或改生产绘图。最早比较误用根bounds底2355而非截图2400，结果不替代最终尺寸修正。只证明本地合成，不证明live group/GPU采样/复杂嵌套裁剪。离线桌面08-47-02轮在测距点击前悬停失效而失败，发生于并行离线Electron检查期间，未确定因果，原记录保留，不称整体通过。本轮未再次采集手机、未重启/安装/清数据，PID23357不变，forward为空。

本轮完整离线桌面回归`.benchmarks/app-smoke/2026-10-06T08-40-49-065Z/`通过，renderer errors=0；分支候选逻辑17项通过、同份业务快照离线重建75候选。fixture不连接手机，未覆盖新增真实大树滚动查找路径；这项须下一轮业务单次工作台复核。

2026-10-06 真实圆角快照检查：唯一手机采集`.benchmarks/app-smoke/2026-10-06T08-37-00-237Z/`，交互前profile/snapshots.json已保存，1605节点/350个带独立图节点，219场景层（165 native），totalDuration11745ms、单次duration11414ms、工作台completion11895ms，1次尝试、无警告；307为预览更新数，非最终唯一图。首树3636ms、首图3962ms、GPU flush4082ms（差120ms），首批59项绘制。SDK merged几何307项aligned；阶段累计重叠，不相加。10项交互后因未找到small branch失败，renderer errors=0，不能算整个工作台通过。实际离线场景重建219层，75个小型native子层分支；工装原先只搜索虚拟树挂载行，现按场景筛选再有界滚动。手机PID23357前后一致，无遗留forward，无重启/安装/清数据，没有第二次手机采集。

新增快照圆角检查使用生产clipLayerImageToOutlines，预期独立采用圆角矩形signed-distance方程。首版08-38-45-016Z排除整个矩形边缘，导致outside=0，不能作外部裁剪证据；已收紧为距真实轮廓1.25px抗锯齿带。最终`.benchmarks/snapshot-clip/2026-10-06T08-40-33-132Z/`六个真实控件（radius6）通过：内部185616个像素alpha及不透明RGB保持，外部24个原本有色像素清零，mismatch=0；166/974/270×45，未含非等比复杂父链。本轮只证明保存own图按SDK声明outline裁剪，不证明设备视觉、嵌套/滚动边界、live group或所有350图。17项分支/层级逻辑及类型检查通过；真实工作台新滚动路径尚未复测。

上述分支工装最终离线结果：`.benchmarks/app-smoke/2026-10-06T08-34-53-624Z/`完整fixture通过，交互前快照已保存、renderer errors=0；测距真实点击、父层折叠/子层ID恢复及快照历史通过。点击前确认elementFromPoint是canvas且悬停仍为目标；点击后检查实际选中层，不强求变更旋转中心后旧坐标仍悬停。类型检查与diff检查通过。该fixture没有native独立图，不代替业务合成或裁剪像素验收；本轮未再次采集手机。

2026-10-06 业务环境恢复与分支工装修正：按用户授权强停后正常启动快手Debug App，PID9793→23357，不清数据、不更新APK；启动命令曾报timeout，随后焦点/导航恢复。个人主页仅一次工作台采集，产物`.benchmarks/app-smoke/2026-10-06T08-23-13-820Z/`；1605节点、221场景层、167 native表面，完成13.188秒。首树3781ms、首图4872ms、GPU flush5027ms（差155ms），首批87项可处理且绘制，0排除；307为累计预览更新数，不是最终唯一图片数。11项检查通过后fold断言失败，renderer errors=0；旧脚本未在交互前保存原始快照，最终唯一图数/尝试数及严格像素未获得。本轮未触发512层上限，不能用补位解释失败。修正为先筛选实际展示且有native子层的父节点，按子层ID消失验证；fixture缺独立图不强求合成；交互前保存快照。19项相关逻辑与树UI生命周期通过。离线完整桌面失败产物08-28-07-286Z（无独立图却要求composite）、08-29-45-343Z（静止指针要求selected悬停）、08-33-53-342Z（点击未选择）均保留；不作为业务成功证据。旧ANR最后记录仍16:13:52，未观察新ANR、ADB无遗留转发，根因未确认。

2026-10-06 无采集启动基线：`.benchmarks/startup-focus/2026-10-06T07-22-07-325Z/summary.json`。新增system-only模式，禁止first-dump，5个采样点0/6/12/18/24秒，30秒固定观察预算、每次查询不超过6秒且至少剩余1.5秒才发起；取消保存部分记录。唯一真机重启，不清数据、不更新App/SDK，不启动桌面或Provider会话；启动停止+命令合计354ms，时间原点为启动命令返回。实际观察24.238秒、15次系统查询累计约1.170秒，每组windows缺焦点字段才补displays。0秒组前台未确认，6秒/12秒组HomeActivity实例2dfd61e已确认但焦点为空，18秒组18.223秒首次观察到窗口d5ca503，24秒组相同实例/窗口。采样顺序非原子，不作为采集授权；有效焦点只可定位于12–18秒两组之间，不称窗口实际产生时刻，未取PID/图/树。手机仍装同版接入SDK的App，因此不排除SDK自动初始化、业务启动负载或系统观察扰动，也不是与有采集轮配对的因果/性能证据。300项测试及类型/桌面/CLI/MCP完整构建通过，覆盖稀疏命令白名单、displays按需回退、焦点/实例歧义、预算/超时与取消。源码初查HierarchyProvider初始化仅UUID/弱引用/常量及生命周期注册，onActivityResumed只更新弱引用，没有主动树/图/会话准备；不是设备SDK启动成本测量。停止追加同类探针，下一项首采状态反馈，不宣称启动耗时已解决。

2026-10-06 无焦点轻量等待：复用每轮已有前台检查，只读系统窗口；无焦点时不再重复run-as/第二次前台查询。候选出现后仍checkedDebugTarget完整校验，读树后完整复核，SDK准备仍在有效树之后。稳定页增加一次候选观察，未做普遍收益承诺；窗口解析和displays兼容路径共用原实现。294项测试及完整构建通过；新增候选出现后实例切换拒绝，原窗口切换/取消/预算保持。首次全量测试暴露预算末尾可能只完成前台读、不够时间观察窗口的断言问题，断言改为允许这一末尾读并检查每次窗口查询前只有一次前台读，未改变生产预算或逻辑。

新版唯一冷请求`.benchmarks/device-health-check/2026-10-06T07-14-35-292Z/`：18.015秒失败/1次尝试，无树图/未进入SDK；13.808秒确认HomeActivity实例68390c6/窗口f92ddbe，唯一读树13.808–18.003秒超时。窗口观察累计2.599秒/完整确认0.305秒/前台读1.193秒，不能与嵌套阶段相加，也不是配对因果提速证据。用户切设置后的唯一恢复`.benchmarks/device-health-check/2026-10-06T07-15-46-763Z/`：11.594秒、98节点/71图/74可见/0失败/1次尝试；首次确认0.622秒、读树0.622–0.745秒、就绪0.970秒。Settings实例a8c23f7/窗口b3b8fb，PID7110/SDK实例d163fe03-5ebf-4513-a9ea-de991118911b/根DecorView@37795db；首树2.198秒/首图6.443秒仅API送达，DDMS/JDWP兼容路径，71图无逐矩形证据、未验严格RGBA。失败后观察至恢复/proc样本PID7110/startTicks9222290一致，冷请求PID未知，原始stat与对照在冷目录readiness-recovery-comparison.json。只重启一次、不清数据、不更新手机SDK，隔离桌面退出、主桌面未重启。冷仍失败、恢复成功，无重试/补测；下一项是有限无采集启动基线，不继续优化取图猜原因。

2026-10-06 就绪诊断真机验收：隔离桌面预先就绪，唯一零等待冷请求`.benchmarks/device-health-check/2026-10-06T07-06-04-119Z/`，18.008秒失败/1次尝试/无树图/未进入SDK取图。新readiness保存首次有效焦点确认14.258秒、HomeActivity实例566f763/窗口ae16b86，唯一读树14.258–18.001秒，拒绝阶段tree；窗口确认累计4.061秒，包含多轮前台/run-as/窗口查询，不与嵌套阶段相加、不能直接推断可节省耗时或系统窗口实际产生时刻。用户切设置主页后唯一恢复`.benchmarks/device-health-check/2026-10-06T07-07-40-978Z/`：9.512秒，98节点/71图/74可见/0失败/1次尝试；窗口确认0.528秒，树读取0.528–0.634秒，就绪0.890秒。Settings实例323c344/窗口ea7b2e3，PID1466/SDK实例5266114c-615f-48a2-8960-a9b1f5845d91/根DecorView@818ed7d；首树1.842秒/首图4.864秒仅API送达。DDMS/JDWP兼容取图，71图无逐矩形证据，未做RGBA对照。失败后到恢复前后/proc样本PID1466/startTicks9171192相同，仅证明该区间连续性，冷请求PID未知；另一个pidof候选6039随后消失，不用于主进程身份。对照摘要在冷目录readiness-recovery-comparison.json。只重启业务App一次、不清数据、不更新手机SDK，隔离桌面正常退出、主桌面未重启。诊断通过，首采仍未修复；下一项是重复检查的轻量等待路径，不放宽18秒/45秒预算、不跳过读树前后严格校验。

本轮验证：293项测试通过、0失败，类型检查与桌面/CLI/MCP完整构建通过；改动空白检查通过。测试使用离线设备替身，不是业务真机首采验收。

2026-10-06 就绪诊断离线实现：`captureReadiness`及请求attempt保存首次有效焦点的相对时刻、确认过的component/ActivityRecord/windowId、读树总次数和最多8条起止记录、拒绝阶段/原因。只复制标量，不保留树/图片、不补造PID；就绪后冻结记录，不把后续取图失败重标为就绪失败。用户取消仍抛出原原因、不发布快照。窗口迟到、预算不足、树超时、窗口/同名实例切换、取消、旧快照和非法诊断均有回归；原有离线设备调用数量断言保持不变。未操作真机、未更新手机SDK或重启主桌面；首采耗时尚未修复。下一轮只验收新诊断，再决定最小修复。

整理：2026-10-06。本文只保存阶段结论、反例和报告入口，**不是待办清单**。当前执行顺序看 [计划](../LOOKIN_ALIGNMENT_PLAN.md#下一步)，能力看 [状态](../PROJECT_STATUS.md)。

2026-10-06 冷启动/恢复复核：经用户授权，只重启快手Debug App一次、不清数据；版本仍14.9.10.99999，未安装更新。隔离桌面先就绪，warm-ms=0、single-attempt，冷报告`.benchmarks/device-health-check/2026-10-06T06-48-14-859Z/`：18.008秒返回就绪失败、1次尝试，0节点/0独立图、未进入SDK取图。progress首次树读取15.734秒，读取耗时2.268秒耗尽剩余18秒预算；窗口等待阶段14.472秒是自1.261秒起的阶段时长，不是首次有效焦点的绝对时刻，报告未保留该时刻/窗口身份。首轮processId为空，不虚构身份。用户随后进入设置主页，唯一恢复报告`.benchmarks/device-health-check/2026-10-06T06-50-20-789Z/`：12.908秒、98节点/71图/74可见/0失败/1次尝试，DDMS/JDWP兼容取图，首树2.074秒、首图5.876秒送达，71图无逐矩形证据，无严格像素对照。失败后/恢复前/恢复后独立系统样本PID27192、startTicks9064321均一致，只证明该观察区间进程连续性；设置ActivityRecord3e6247c前后一致，首轮未返回SDK实例/根。对照摘要cold-recovery-comparison.json与各进程stat已保存。只读现有App日志出现一次140.530ms GC，不能解释14秒等待；厂商提示kernel日志无权限，未修改权限，未补采/重启。隔离桌面均关闭、主桌面未重启，手机保持设置页。冷启动仍失败，恢复通过，不声明首采修复或普遍提速；下一项仅补无额外查询的就绪诊断。

2026-10-06 正式业务稳态通过：用户确认进入App设置主页，截屏及前台SettingsActivity核实。单次报告`.benchmarks/device-health-check/2026-10-06T06-41-54-519Z/`：10.336秒、98节点/71图/74可见/0失败/1次尝试，首树1.773秒/首图5.282秒送达。随后同隔离桌面3轮`.benchmarks/device-health-check/2026-10-06T06-42-22-085Z/consecutive-summary.json`：10.938/10.311/10.440秒，覆盖量相同、全部0失败/1次尝试，PID14163、SDK实例a9e1882b-7625-4672-942a-ee180f4839b4及根DecorView@c150567一致，门控通过。3轮首树2.792/2.424/2.724秒、首图6.793/6.208/6.400秒；每轮1次图层批次，API送达不等于物理上屏。98节点低于现有默认200阈值，源码分流及timings确认DDMS/JDWP补图，不是SDK merged实验：DDMS批量2.345/2.516/2.428秒，补齐总段3.680/3.648/3.632秒，其中初始化1.398/1.364/1.389秒、定位1.281/1.263/1.193秒、位图生成0.528/0.533/0.565秒；嵌套/累计阶段不相加。71图均withoutEvidence，无本轮严格RGBA/裁剪对照。业务APK前后SHA一致，未更新/重启/清数据，手机仍设置页；隔离桌面正常关闭，用户主桌面未重启。最终单次/首轮门槛补齐totalAttempts严格为1，288项回归、类型及diff检查通过。不是普遍提速或冷启动验收。

2026-10-06 业务稳态准备：设备JNHA45FQBQEIRGEQ在线；前台com.smile.gifmaker/HomeActivity，14.9.10.99999、versionCode99999、DEBUGGABLE，lastUpdateTime=2026-10-06 10:26:40，手机base.apk SHA256=0ebcf676512d9eb8d8c18148faeceb944fb602b58f60c69f23061094623ef630。本机HEAD=544fd6f82923821da30b0becaf727d81317375f6，工作区存在未提交改动，HEAD不代表当前构建全部内容。截屏确认是视频首页，不据此做稳定页连续门控；已请用户切到App内设置主页，尚无本轮完整请求。修正device-health-check最终单次及首轮健康判定，复用canRefreshHealthCapture要求totalAttempts严格为数字1；内部重试/未知次数不通过，不改变正式采集重试策略。补0/字符串/小数反例，定向6项测试通过。未更新/重启/清除业务App，未重启主桌面。

2026-10-06 短栈定位收口：`.benchmarks/geometry-pipeline/2026-10-06-method-trace/`，token=snapshot-method-20261006-01，原路SDK不可变捕获一次、无预捕获/额外图/逐层调度读取，平台JSON、64KiB输出缓冲、两worker/在途4。整轮6.696550秒，407图/405几何及编码/解码像素/几何摘要与系统追踪和此前等待诊断相同；主机nonce/SHA/root/process校验通过。复用MethodWindow实际1.001812秒，启动39.885ms、停止5.239ms、2ms间隔、8MiB预算，实际127206字节/6298记录、无溢出；pipeline计时不含采样启动成本。主线程观察998684us/CPU224074us/非CPU774610us；前20近似等待栈中两个nCreateHardwareBitmap叶入口区间累计wall297182us/CPU63676us/差233506us、27个事件间区间，调用链确有SDK debugSnapshot→View.createSnapshot→HardwareCanvasProvider.createBitmap→Bitmap.createBitmap→HardwareRenderer入口。nativePollOnce区间wall466870us/CPU33906us/差432964us属于消息队列等新任务，不算GPU/取图阻塞，也不证明编码背压。两个编码线程观察约963ms，CPU616654/599014us。解析按前次Java采样栈近似归属，栈变化时间未知、native内部帧与锁/GPU仍未知，前20不是完整栈总量；单窗不能外推整页，也不能把6.697与前轮7.397差值归成收益。新增等待栈测试，288项回归、类型/桌面及样例Debug/Release构建通过，Release排除SDK/诊断；仅同签名保留数据更新样例，业务App未更新/重启/清数据，主桌面未重启，业务前台已恢复。旧样例APK备份`/tmp/inspector-method-trace-doK4Hc/installed-before.apk`。停止样例定位微实验，回到正式业务稳态门控。

2026-10-06 系统追踪：产物`.benchmarks/geometry-pipeline/2026-10-06-system-trace/`。首份20秒/32MiB记录未覆盖采集且达到容量上限，样例在Trace未开启时取图前停止，report.json/capture.pftrace保留。第二份30秒/64MiB，仅sched/gfx、启动追踪后立即启动样例；token=snapshot-trace-20261006-02，原路SDK不可变捕获一次，原编码/写出、两worker/在途4，无逐层/proc读取或额外图。整轮7.396660秒，407图/405几何、编码/像素及几何摘要与前次一致，主机完整nonce/SHA/root/process校验通过。pipeline标记7.396558秒，407个主线程非重叠捕获标记共6.193171秒；调度覆盖之和精确相等，睡眠2.941121秒、运行2.733124秒、可运行排队0.518880秒。RenderThread有407次allocateHelper（累计554ms）及407次eglSwapBuffersWithDamageKHR（430ms），嵌套阶段不能相加；主线程waitForever标记仅5.924ms，不能解释全部睡眠。记录1260个systrace_parse_failure，无报告data_loss；可见非标准厂商风格x/f标记，但不证明每个解析错误来源。blocked_function为空，exactBlockingCall=unknown、gpuDurationNanos=null、traceHealthPassed=false；标记/调度覆盖通过不能抹掉解析错误。AOSP Android14的[硬件位图实现](https://android.googlesource.com/platform/frameworks/base/+/android14-release/libs/hwui/jni/android_graphics_HardwareRenderer.cpp)逐调用创建ImageReader/RenderProxy并syncAndDrawFrame，支持反复资源建立的假设，不是当前小米二进制或全部2.941秒的因果证明。287项测试、类型/桌面及样例Debug/Release构建通过，Release排除SDK/诊断。仅同签名保留数据更新独立样例；正式SDK、业务App及主桌面不改，追踪关闭且业务前台恢复。备份在`/tmp/inspector-system-trace-uPjjaN/installed-before.apk`。无提速或冷启动达标结论。

2026-10-06 取图等待诊断：`.benchmarks/geometry-pipeline/2026-10-06-snapshot-waits/report.json`，token=snapshot-waits-20261006-01。复用GeometryPipelineProbe/PipelineWaitProbe，无预捕获/额外图/新取图器；SDK六参数captureFrameOnUiThread不可变证据，UiTaskBatch单帧调度、原编码/几何文件、64KiB图像缓冲，两worker/在途4，仅平台序列化。进程龄2.481/40秒开始，整轮6.814/5.706秒；draw墙钟4.061648/3.864385秒，主线程CPU1.298392/1.120911秒，差2.763256/2.743474秒；snapshotInvoke墙钟3.983717/3.807174秒，UI排队142.251/116.916ms。固定64层draw墙钟662.689/586.999ms、CPU186.466/164.102ms；UI捕获调度窗口（含上下文/验证/边界读取）1132.923/891.984ms，运行524.149/385.862ms、可运行队列等待95.003/23.956ms、未归属513.770/482.166ms；每轮64有效/0未知，但128次读取本身249.129/178.876ms，观察扰动不可忽视，不当精确GPU/锁/回读耗时或整页调度占比。两轮407图编码字节/CRC/尺寸/解码像素和405几何一致，主机校验所有文件nonce/SHA/root/process，几何摘要同ca62575e90227cc59943ae71f3d5d827e625da15c41fb3d6388182eac468ca26；285项测试及构建通过，Release Dex排除SDK/诊断。只更新独立样例，业务SDK及主桌面未更新，恢复业务前台；旧样例APK在`/tmp/inspector-snapshot-waits-MJJwsd/installed-before.apk`。本轮仅定位等待占比，不是提速或冷启动验收。

2026-10-06 缓存完整流水线：`.benchmarks/geometry-pipeline/2026-10-06-format-cache/report.json`，token=pipeline-cache-20261006-01。没有预捕获/额外像素门预热，实际五参数captureFrame不可变证据、原SDK编码/写出/几何文件、64KiB图像缓冲，两worker/在途4。平台/无缓存/缓存/缓存/无缓存/平台墙钟6.184/5.778/5.060/5.286/5.571/5.656秒，JSON构建+输出累计CPU3.935/2.858/1.601/1.506/1.436/1.401秒；前三轮结束进程龄<30秒，后三轮开始≥40秒。407张图片编码字节/CRC/尺寸/解码像素一致，405条几何原输出摘要仅归零started/ended后相同；主机解析所有文件并校验nonce/SHA/root/process，几何结构摘要均ca62575e90227cc59943ae71f3d5d827e625da15c41fb3d6388182eac468ca26。每worker最大740项/84378字节文本计量，约98.7%命中，每轮新缓存并清理，不代表RSS。后半组缓存CPU略差，墙钟变化混有取图/预热，收益不稳定，正式SDK保持原路，停止增加缓存对照。snapshotInvoke约3.5–3.9秒，含同步等待不能直接归因GPU。额外反射/摘要/样例静态页不同于业务流水线，不宣称冷启动或业务15秒门槛已达标。283项单测及构建通过；只更新独立样例，业务包和主桌面未更新，恢复业务前台。旧APK备份`/tmp/inspector-cache-pipeline-yM3dRy/installed-before.apk`。

真实业务代码、APK、控件文本、截图和日志只在本机忽略目录。以下证据路径不承诺随公开仓库提供。

2026-10-06 格式化缓存：`.benchmarks/geometry-serialization/2026-10-06-cache/report.json`，token=cache-20261006-immutable-01。一次实际 SDK 捕获 5.706 秒、405 条不可变记录，六轮平台/无缓存/缓存/缓存/无缓存/平台逐字一致、829406字节、SHA相同。整轮墙钟 2.473/1.696/0.993/0.811/1.290/1.089 秒；输出累计CPU 4.068/2.636/1.278/0.990/1.871/1.628 秒。平台与候选遍历器混比不能单独归因缓存，因此有同输出器无缓存对照；固定顺序仍有预热/负载影响，不称普遍因果提速。缓存六种数值类型和值/原字符串，调用原平台格式函数；负零/极值/2048随机数/转义/超大字符串自测通过。两 worker/在途4，每 worker 每轮1024项/262144字节文本保留计量上限；实际最高878项/100902字节，约98.7%命中；不缓存View、几何或图片，每轮新缓存、结束清空。保留整批不可变证据、反射和无图像编码负载不同于生产，只证明微测局部收益；完整流水线/快慢态/像素及长期内存未验收。仅同签名保留数据更新样例，旧APK临时备份，业务包不改、已恢复原前台。281项测试、类型/桌面与样例Debug/Release构建通过，Release Dex排除缓存/测量器/SDK。

2026-10-06 不可变 JSON 拆分：`.benchmarks/geometry-serialization/2026-10-06-split/report.json`，token=split-20261006-immutable-01。一次实际 SDK 捕获耗时 5.418 秒，405 条不可变记录；两遍原算法、两线程/在途4，逐字一致及 SHA 相同、829,406 字节。整遍墙钟 3.206/1.563 秒；累计构建 0.600/0.462 秒、输出 5.715/2.543 秒；构建 CPU 0.592/0.454 秒、输出 CPU 5.613/2.486 秒。数字 88,875 个、字符串/键 24,558 个；独立格式化 1.158/0.618 秒、转义 1.204/0.650 秒，微测不与流水线累计值相加或相减。两遍顺序固定且标量微测间插，预热/负载未隔离；证据额外保留、反射调用和无编码路径也不同于生产流水线。不称提速、跨版本协议或严格像素验收。只更新独立 Debug 样例，同签名保留数据，旧包在本机临时目录备份；恢复业务前台。280 项测试、类型/桌面及样例 Debug 构建通过。

2026-10-06 固定样例定位：`.benchmarks/static-preview/2026-10-06T02-44-41-017Z/summary.json`。计划 ABBA 只改变中途图层前缀轮询，树/整屏及最终取图保留；首轮 15.338 秒超过门槛停止，后面三轮未执行、原前台已恢复。407 项合并几何对齐，无请求错误/重试；原始报告因先判断门槛未保存编码工作量指纹，不是严格配对验收，工装已修正未补跑。JSON 累计 5594ms/CPU 5190ms、截图调用 4646ms、UI 排队 197ms、编码 CPU 832ms；预览 8 次/1,109,033 字节/681ms，解析 6ms。阶段重叠不相加，无生产提速结论；手机 SDK 未改。

2026-10-06 预览 I/O 定位：`.benchmarks/device-health-check/2026-10-06T02-39-30-986Z/health-1791254371664.json`。同进程首页单次 11.759 秒、1232 节点/266 图/464 可见/0 失败/无重试；235 项几何对齐，31 项上下文不支持、235 图无逐矩形证据。预览读取 5 次/10,757,578 字节/895ms、解析 9ms；大小查询 4 次/259ms、无跳过收益，已撤掉。不同工作量/启动年龄不能对照此前 24.625 秒归因提速；最终仅保留统计与前缀上限停止，276 项测试/类型/构建通过，未追加真机轮、未改手机 SDK。

## 1. 初始目标完成到哪里

| 目标 | 已有结果 | 不能外推的结论 |
| --- | --- | --- |
| 真实控件树 | 原生 Debug View / SDK 树与 Qt/QML 专项已接入 | 并非所有 Debug 框架内部树都可读 |
| WebGL 全量展开 | 默认展开、树折叠同步、稳定 Z、高亮/属性与相机已实现 | 展开 Z 不是 Android 物理深度 |
| 自身图/折叠图 | 样例父背景/装饰保留、子项像素隔离，折叠恢复整体 | 不是任意自绘/裁剪逐像素通用支持 |
| 进程内 SDK | Debug 依赖、Provider、批量/会话、样例与业务接入 | iOS LookinServer 不能直接移植；手机并非始终最新 SDK |
| 自动化 | CLI/MCP 授权检查/操作/留证、安全拒绝已有实现 | 不承诺任意 App 自动操作成功 |

初始专项见 [深度树](LAYER_UI_HISTORY.md#debug-tree)、[3D 总览](LAYER_UI_HISTORY.md#3d-overview)、[折叠合成](LAYER_UI_HISTORY.md#parent-composite)、[UI 精简记录](LAYER_UI_HISTORY.md#ui-layout)。

## 2. 已采用的改进与保留的反例

- 树/整屏先交付、独立图分段补齐、选中层优先；有界 2 编码线程/4 在途，长期会话与空闲回收已接入。
- SDK 合并树请求、前后字段核对、主线程轻量不可变几何、后台 JSON 构建已接入；排队位图收尾归属明确，不提前释放正在编码的图片。
- SDK 超时不再重复启动长整页/补图回退；协议不支持的兼容仍保留。部分预览不等于通过最终摘要的完整成功。
- 就绪耗尽后不再重复进入完整等待；隔离模拟原 54.199 秒/3 次尝试，新 16.504 秒/1 次，无图片/转发。不是业务提速证明。
- 进程选择按前台 Activity 所属 PID，并核对 cmdline；同请求合并树采用严格绑定身份，不继承旧供体属性/像素。
- 有界分支恢复双读/补图/复核，成功后原子替换几何/图片；预览 bounds 变化先重锚，不把新图短暂放旧坐标。
- 样例分支恢复 3 层及失败后恢复通过；业务有成功恢复小分支的记录，但首采/后续采集整组仍曾失败，不能称业务全通过。
- 已补失败阶段、排队分布和全部尝试历史。诊断改进不等于绘制/GPU 根因已确定或提速已完成。

## 3. 性能口径与业务未完成项

| 记录 | 结果 | 限制 |
| --- | --- | --- |
| 早期 DDMS 业务页 | 约 35–46 秒，等待首包占大部分 | 页面不同，不能用于最新路径的严格因果对照 |
| 会话/通道收敛 | 多次业务稳态约 8–12 秒、0 失败 | 不是连续运行或冷启动保证 |
| 正式轻量几何样例 | 新进程首次约 4.685–4.793 秒，空闲组约 7.149–7.278 秒；407 图/405 几何通过 | SDK 处理耗时，不是桌面可操作/物理上屏 |
| 连续样例慢尾 | 几何组有 10.204 秒，无几何也有 10–11 秒慢轮 | 首次收益不能证明连续慢尾消失 |
| 业务冷启动/动态页 | 有 30–90 秒以上失败/慢请求，复采可能恢复也可能失败 | 首轮必须保留，不能只报恢复成功；不同覆盖不可直接相减 |
| 业务几何覆盖 | 曾出现可信矩形覆盖为 0，截断父链和自定义祖先回退 | 回退不等于缺图，也不是复杂裁剪验收 |

业务文字早期对照的 12 次 RGBA/几何一致，完整请求约 12.137/12.111/10.896/10.489 秒；第一候选期间另有主机测试并发，启动年龄也未严格匹配，不计算提速比例。记录见 .benchmarks/business-text-fixed-20261005-poRb2d/README.md。安装后的慢采集/读树失败与授权重启恢复仍保留，不被后续成功覆盖。

## 4. 不重复推进的试验

| 试验 | 结论/处置 |
| --- | --- |
| 通用软件画布替代硬件文字 | 第一张严格 RGBA 就不同，停止，不放宽像素容差 |
| 复用固定尺寸硬件资源 | 64 个简单文字局部取图/回读约快 27%/31%；真实编码流水线无稳定整页收益，不通用上线 |
| 硬件位图图集/批量 Picture | 有圆角边缘像素反例，只保留受限样例，不通用上线 |
| 方法缓存/自定义整数 JSON | 无稳定整页收益，正式路径撤回 |
| 逐层串行 | 约 10.28–10.44 秒，慢于并行，不采用 |
| 分块探针哈希 | 减少核验器开销，不算产品取图提速 |
| 批量 UI 投递/异步 Handler/预热 | 像素门禁或人工屏障通过不等于业务整体收益；无明确业务反例不重开 |

关键试验目录：.benchmarks/software-canvas-20261005-s9QZDW/、.benchmarks/hardware-comparison-20261005-tNSYOw/、.benchmarks/hardware-pipeline-20261005-pi2A8e/。

## 5. 最近完成的安全与版本门禁

| 证据目录（均位于 .benchmarks/） | 结果与范围 |
| --- | --- |
| desktop-text-cancel-20261005-C6VrIv/ | 真实 SDK/正式 IPC 取消、超时、两次迟到丢弃、清理/恢复通过；前两次代理截断失败保留，不是 React 画布验收 |
| workbench-refresh-20261005-kfUBFh/ | 新采集/首页/历史取消、旧结果/finally 不覆盖新状态；真实工作台鼠标流程补验 |
| text-admission/2026-10-05T13-02-47-288Z/ | 新样例硬件 12 次、软件 6 次刷新严格 RGBA/几何/路由；6 次整页 10 节点/6 图/0 失败，约 3.439–3.676 秒 |
| ui-wake/2026-10-05T13-17-31-710Z/ | 真实安全唤醒取消/3 秒超时/迟到/恢复，SDK 入口不可用时拒绝危险路径；不是完全无 SDK APK |
| sdk-free/2026-10-05T13-46-54-624Z/ | 完全无 SDK APK 硬件 6 次刷新通过、均 JDWP，整页 2.153/2.175 秒；软件安全拒绝，PID/输入保持 |
| legacy-sdk/2026-10-05T13-40-38-452Z/ | 固定旧提交 544fd6f 真 AAR/APK，缺新能力/接口；隔离构建，不改旧 SDK |
| legacy-device/2026-10-05T13-50-30-598Z/ | 真旧 SDK 硬件 6 次刷新，整页 15 节点/9 图/0 失败，3.575/3.703 秒；结束恢复原新版样例摘要 |
| legacy-software/2026-10-05T14-05-52-007Z/ | 独立旧 SDK 软件壳树可读、危险刷新拒绝、输入/PID 不变、后续树可读；Release 无 SDK/绕过库 |
| text-admission/2026-10-05T14-04-12-615Z/ | 新软件窗口回归两档 6 次严格刷新，整页 10 节点/6 图/0 失败，3.237/3.339 秒 |
| business-admission/2026-10-05T14-15-43-193Z/ | 设置页只读准入拒绝：缺 uiWakeVersion 和目标 hardwareAccelerated；不是旧路径故障，不是业务性能验收 |
| business-admission/2026-10-05T14-53-32-383Z/ | 新包同签名保留数据覆盖后，设备摘要一致；设置页三项 SDK 能力均为 1，目标硬件加速，准入通过 |
| business-text/2026-10-05T14-53-34-704Z/ | 同进程 ABBA 共 12 次 RGBA/几何/实际路由一致；局部中位原路 3.78 秒、候选 2.45 秒，完整采集 11.294/10.071/9.890/9.949 秒；非启动年龄匹配的普遍提速证据 |
| business-text/2026-10-05T14-48-39-578Z/ | 探针将同名多进程误认为非法，取图前停止；已复用 Activity 所属 PID/cmdline 校验并补回归，失败记录保留 |
| device-health-check/2026-10-05T15-01-05-922Z/ | 同一桌面会话连续 3 次 10.752/9.891/9.702 秒，各 157 节点/71 图/0 失败/无重试，PID/实例/窗口及覆盖数量一致；未重启，不是冷启动或慢尾根因修复 |
| device-health-check/2026-10-05T15-04-50-593Z/ | 授权零等待冷启动首页：首次尝试 24.280 秒窗口失配，内部重试 38.177 秒几何失配，完整请求 64.464 秒失败；未发探针恢复请求 |
| device-health-check/2026-10-05T15-11-12-464Z/ | 剩余重试预算修复后冷启动复测：首次 24.258 秒窗口失配，第二次 18.835 秒预算取消，完整请求 45.098 秒失败；同请求 PID 不变。不是成功采集/普遍提速，局部预览不作为最终成功 |
| visible-tree-guard/2026-10-05T15-27-49-854Z/ | 新样例静态成功；动态合并请求 1.772 秒 stale-tree 拒绝，输出 0/29；实际采集入口 2.274 秒返回无树/无图、1 次尝试并保留 tree-guard 诊断；静态恢复成功。不证明业务或严格像素 |
| visible-tree-pixels/2026-10-05T15-37-37-913Z/ | 同一样例进程静态 ABBA 共 4 次、9 层，nonce/完整摘要/覆盖数量通过；逐 ref 的位置、尺寸、解码 RGBA 完全一致。证明本页新检查未改变像素，不证明业务提速 |
| device-health-check/2026-10-05T15-46-22-683Z/ | 新业务包零等待冷启动：完整请求 45.136 秒失败，2 次内部尝试，首次窗口失配、第二次预算退出；无最终独立图。预览树约 41.543 秒到达，不算成功。没有探针自动复采 |
| device-health-check/2026-10-05T15-49-11-921Z/ | 用户切到设置主页后同 PID 恢复：9.796 秒、98 节点/71 图/74 可见/0 失败、1 次尝试。恢复前后 PID/startTicks/SDK 实例/根一致，实际新树能力为 1；DDMS/补图路径，不是 SDK 合并路径或原冷启动首页恢复验收 |
| device-health-check/2026-10-05T15-57-42-591Z/ | 就绪去重后的零等待冷启动约 17.055 秒失败、1 次尝试，无树/无图；首次 dump 约 5.057 秒，随后焦点确认未通过。原始报告早于新增具体窗口错误文案，不据此猜测焦点失败的具体原因；失败较早不等于成功提速 |
| device-health-check/2026-10-05T16-01-02-396Z/ | 用户切设置主页后恢复 10.291 秒、98 节点/71 图/74 可见/0 失败/1 次尝试；恢复前后 OS PID/startTicks 一致。首轮无 PID，不冒充跨首轮同进程证明，亦非 SDK 合并路径验收 |
| startup-focus/2026-10-05T16-05-47-967Z/ | 有界系统窗口观察 + 一次 App dump：约 5/6/10/14 秒焦点明确为 null，18/22 秒主显示器焦点属于目标 App；首次 dump 同时含旧的停止实例与当前运行实例，当前实例报系统 dump 超时。不是无查询干扰的自然启动对照，不证明性能 |
| device-health-check/2026-10-05T16-11-58-388Z/ | 前台实例选择修复版冷启动约 18.005 秒就绪失败、1 次尝试、无树/图；后段窗口可确认，树读取耗时约 3.216 秒后预算退出。最终细化树错误文案在此轮之后补充，不能说本报告已验证其真机显示 |
| device-health-check/2026-10-06T02-00-00-334Z/ | 最终新版设置页恢复 7.814 秒、98 节点/71 图/74 可见/0 失败/1 次尝试、无告警；前后 ActivityRecord/窗口/PID/startTicks 一致。DDMS/补图路径，71 图无逐矩形几何证据，不称严格像素、SDK 合并路径或冷启动成功验收 |
| startup-focus/2026-10-06T02-02-45-596Z/ 与 2026-10-06T02-04-55-406Z/ | 同 APK 串行启动观察：无 App dump 组目标焦点在 10.264–14.282 秒间出现；立即 dump 组在 18.216–22.224 秒间出现。后组 0.272–0.362 秒 dump 只有停止运行记录，没有树读取，不能证明查询干扰；每组一次且固定顺序。保留全部记录，不改变生产流程，不追加压力采集 |
| startup-focus/2026-10-06T02-08-25-884Z/ 与 2026-10-06T02-09-06-132Z/ | 修正触发后反向顺序各一次，同 APK、目标前台实例/进程只读门控一致。读取组唯一 dump 在 0.521–5.567 秒执行，当前运行实例系统超时，无树；前后 PID/startTicks/ActivityRecord 一致。读取组有效焦点区间 14.258–18.213 秒，无读取组 14.205–18.263 秒，未证明查询干扰。后段多 PID 查询拒绝，未伪造连续身份；不再补跑，不作采集成功或性能收益结论 |
| device-health-check/2026-10-06T02-13-23-364Z/ | 窗口先行版零等待冷启动：18.008 秒就绪预算失败，1 次尝试；约 14.325 秒才开始唯一树读取，读取约 3.677 秒后剩余预算耗尽，无树/图，无 SDK 取图阶段。保留首轮，不称提速成功 |
| device-health-check/2026-10-06T02-14-04-487Z/ | 未重启/导航的当前首页恢复请求 8.489 秒失败，1 次尝试；前台树 124ms 返回，SDK tree-guard 在文字控件变化时拒绝，完成 28 项后停止。旧统一文案称“绘制前”，但无差值/before/after 证据，不能据此确定边界。树预览约 5.897 秒送达，无最终树/图、无兼容补采/重试；首轮无 PID，不宣称跨首轮完整身份验证。停止真机补跑 |
| device-health-check/2026-10-06T02-28-16-707Z/ | 差值诊断版经授权同签名保留数据更新，手机摘要匹配；安装后首页唯一请求成功但超时门槛：24.625 秒、1173 节点/255 图/448 可见/0 失败/1 次尝试。SDK merged 224 项几何对齐，旧文字失配未复现；30 项上下文不支持、225 图无逐矩形证据，未做业务严格像素对照。SDK 合并调用 18.845 秒，排队/绘制/编码为累计重叠阶段，不相加推断总耗时。首树/首图 7.579/10.122 秒送达，不称物理上屏，未补跑 |
| visible-tree-guard/2026-10-06T02-29-47-284Z/ | 新样例静态 2.149 秒成功；动态 2.052 秒、0/29 即拒绝，诊断 before/position、XY (+3,-3)、WH 不变、状态正常、guardAge 505ms。实际采集入口 3.459 秒拒绝且保存独立差值 (-5,-2,0,0)/guardAge 39ms，1 次尝试无最终树/补采/重试；静态恢复 2.369 秒成功。只验证诊断/拒绝/恢复，不证明业务根因、像素或性能 |

旧软件窗口发现了两个危险入口：JDWP 的旧硬件唤醒，以及旧 SDK 固定硬件画布取图。明确软件证据且无新版能力时两者都应拒绝。未知状态仍走兼容，不称全面安全保证。安全拒绝不是已支持软件独立图。

本轮 SDK Debug/样例 Release、业务 Debug 和桌面构建通过；样例 Release 不含 SDK/绕过库/Debug 窗口。最终 250 项单测与类型检查通过。业务安装前旧 APK 已备份；未卸载、未清数据、未重启主桌面。签名/摘要/构建日志留本机私有临时目录，不提交。

随后连续门控工装回归：251 项单测、类型检查通过，新增身份/覆盖变化与失败停止测试。只改测试工装和文档，没有将稳态成功当作产品性能修复。

启动预算修复回归：254 项单测、类型检查及桌面构建通过。剩余预算覆盖重试中的 ADB/SDK/绘制调用，及时释放计时器；真实采集 fixture 验证预算失败返回无树、无图且保留诊断，用户取消仍抛出。首次尝试限时保持原规则，SDK/业务 APK 未更改，主桌面未重启。

随后新增 SDK 绘制前后树失配检查，仅用本次发布的不可变几何，不在后台读活 View。样例同签名保留数据安装（旧 APK 本机备份）；业务包未重建。只变动拒绝时机，不放宽像素/几何、并行度或预算；绘制后拒绝的位图仍按原所有权回收。早一轮无绘制后检查的样例报告也保留，不混入最终结果。

最新回归：255 项单测、类型检查、桌面及 SDK Debug/样例 Debug/Release 构建通过；Release DEX 不含 SDK/绕过库/VisibleTreeGuard。样例恢复原业务前台，未遗留转发；主桌面未重启，未提交推送。

随后通过静态像素门禁，重建业务 Debug（3 分 41 秒）并同签名覆盖安装，未卸载或清数据；旧包备份、证书和设备完整字节/摘要核对留本机私有目录 `/tmp/inspector-business-tree-guard-KQWXfb/`。刚启动的只读树请求超时，残留旧文件未用于准入；设置页成功请求才确认 `visibleTreeGuardVersion=1`。冷启动失败及随后设置页恢复均保留，不声明新检查已解决首采耗时。最新 255 项测试、类型检查和桌面构建通过；主桌面未重启，未提交推送。

2026-10-06 就绪去重：有效 dump 在读取前后核对同一授权焦点窗口后复用，取消/18 秒就绪及 45 秒重试预算不变，不跨尝试缓存。真实入口新增稳定焦点、窗口更换和 Activity 切换三项 fixture；保留窗口失败原因。最终 258 项测试、类型检查和桌面构建通过，初次断言预期文案不准确的失败日志保留在 `/tmp/inspector-readiness-dedup-Ru2EkO/`。只更新桌面源码/构建，未改 SDK、安装业务包或重启主桌面；隔离桌面已退出，无遗留转发。冷启动仍未成功，后续定位焦点就绪的具体原因。

随后按前台 ActivityRecord 实例选唯一段落，拒绝旧的停止运行/重复/缺失实例；真实 dump 的离线选择及真机前台实例/多进程归属读取通过，不等于独立图验收。焦点状态及树系统超时诊断细化。263 项测试、类型检查与桌面构建通过；测试中不兼容旧目标库的 replaceAll 写法已改为等价正则，失败构建日志保留在 `/tmp/inspector-cold-focus-JZSfEq/`。随后新版设置页恢复通过，身份前后核对留 `/tmp/inspector-instance-recovery-Gc1oyf/`；未重启手机 App、未清数据、未改 SDK/业务 APK、未重启主桌面，无遗留转发。首轮无 PID 证据，不外推跨首轮身份。

## 6. 历史与原文去向

2026-10-06 启动源码只读复核：业务本机HEAD94f80eb1b，只读Application/页面创建/启动调度及已有SDK入口字节码，原Gradle接入修改保留。SDK入口仅UUID/弱引用/Debug生命周期注册，无主动读树/绘图/等待；没有运行时类加载成本证据，不排除SDK影响。本地业务源码存在初始化先置位、可抛异常调用后才通知完成、等待方无超时的条件风险；后台submit的Future未读取，执行异常不由提交处catch接住。独立通用JVM模型2项通过（正常返回/异常后通知不释放且等待不返回），200ms观察、中断/线程池有界清理，仅证明控制流风险，不是业务运行时复现。另有Application启动屏障转入外部依赖实现，本地无法追溯具体任务；页面setContentView前多个同步入口未测耗时。异步布局单次50/80/90ms、启动完成后的调试sleep不作为17秒首要解释；网络主体异步但有主线程参数准备，不误判全部同步或无主线程成本。私有源码路径/详细结论及模型留`.benchmarks/startup-analysis/2026-10-06-source-review/`，结果`/tmp/inspector-startup-latch-model.log`；公开文档只保留摘要，不复制业务实现。本轮没有手机命令、业务/SDK源码改动、安装、重启、采集或推送，diff检查通过。下一项须另获一次冷启动/有界主线程栈观测同意，先证明实际等待点；不先吞错释放通知或移除SDK作未经验证的修复。

2026-10-06 获授权唯一冷启动留证：设备在线/run-as通过，只执行一次force-stop/start、不清数据/导航/安装，warm-ms=0/single-attempt，无自动复采或恢复。首个私有观察包装器因模块模式在adb devices前失败，尚未执行设备重启；修正私有commonjs后才开始唯一实际启动，失败日志保留`/tmp/inspector-cold-single-wrapper-failed.log`。观察器透明转发原有ADB调用，仅保存系统activities/windows/displays原文，不发额外轮询；其Node进程/文件开销属于本轮测量，不能与旧轮做因果性能对照。正式产物`.benchmarks/device-health-check/2026-10-06T11-54-39-840Z/`，force-stop321ms/start289ms（stdout Starting Intent/exit0）、首采主机时间11:54:41.222Z。API17121ms/采集17113ms/请求诊断17114ms/1尝试，focus-before/firstFocusedWindow=null/treeReadCount0/0图；窗口等待16203ms含轮询10521/窗口观察3743/前台读取1932ms，不重复相加，18秒预算未延长。原文`.benchmarks/startup-analysis/2026-10-06-single-cold-with-raw/system-reads.jsonl`：65次系统读（23activities/21windows/21displays），全部exit0/无截断；每次displays主焦点null，末次目标仅Splash Screen APPLICATION_STARTING/HAS_DRAWN/有surface/可显示，没有主BASE_APPLICATION窗口，Activity reportedDrawn=false。Activity实例e8dd58b、关联owner PID5219在有效观察中一致，首次owner观察距请求660ms；不是请求开始时原子身份或/proc startTicks证明。证明系统真实窗口未就绪而非焦点解析误读，未进入SDK取树/抓图，但App启动延迟具体原因和SDK初始化因果影响仍未知。收尾只读pidof仍5219、debug_app目标App/wait_for_debugger=0（未修改），较晚400条App日志和processes保存于`/tmp/inspector-cold-single-app-logcat.log`及`inspector-cold-single-processes.log`，不当首采启动因果证据；转发为空、隔离桌面已退出，用户主桌面未重启。结构摘要summary.json/离线分析脚本同原文目录；本轮类型/完整桌面CLI/MCP构建及diff检查通过，未改产品源码/预算/门禁、未提交推送。下一项只读业务主窗口建立路径，不重复采集；安装/重启/SDK对照另需授权。

2026-10-06 冷启动既有证据复核：首采10-57-09报告16546ms API/16541ms采集，前置677ms+窗口等待15864ms；其中11542ms轮询间隔、2941ms窗口观察、1374ms前台读取为等待阶段子段，不再叠加。余1459ms小于现有1500ms查询门槛，提前停止符合规则；phase=focus-before/firstFocusedWindow=null/0树读取/0图/1尝试，不能归因WebGL或SDK绘图。独立恢复10-58-57为10914ms，首次确认焦点668ms、就绪1078ms、1次树读取/71图/0失败；恢复不证明首轮PID和真实焦点缺失原因。旧脚本仅存149ms启动命令+等待，没有命令原文/退出状态，窗口原文及首轮PID也缺。本轮只改startup-probe工装：原有两条启动命令响应（含成功stderr、失败及超时）先落startup-commands.json，首采主机时间存startup-condition.json；保持15秒命令上限，不加请求/等待/重试，不把exit0当就绪。离线摘要`.benchmarks/startup-analysis/2026-10-06-evidence-review/summary.json`；新增记录器回归包含真实本地子进程500ms超时，首轮13项及扩大就绪/预算/重试回归34项均0失败（后者39.88秒）、类型/diff检查通过，日志`/tmp/inspector-startup-evidence-tests.log`、`inspector-startup-evidence-regression.log`及`inspector-startup-evidence-types.log`。没有执行手机命令、重启App或更新产品构建。真实冷启动未修复，下一次真机首采须另获重启同意并留原始窗口/进程证据。

2026-10-06 macOS包隔离验收：新产物留`.benchmarks/mac-package/2026-10-06-isolated/adhoc/`，没有覆盖release或用户主程序。Electron44.3.0、arm64、0.1.0；首个禁用签名包严格校验失败，保留失败产物，改为显式`mac.identity=-`本地临时签名后DMG/ZIP和`codesign --verify --deep --strict`通过。包中3278条目，不含项目tests/scripts/docs/electron/android/.benchmarks/.git根目录；HTML、main/preload及包外CLI/MCP五入口SHA与当前构建一致。隔离profile、isPackaged=true、sandbox/contextIsolation=true/fixture=false，资源/渲染错误0，CLI帮助/版本、MCP13工具及未授权快照拒读通过；调用app.quit正常退出code0，原快照文件元数据未变。ADB使用私有空设备替身，不访问手机。工装首次误以为CLI在asar内、页面必须有旧标题，以及调试器未断开阻碍退出，均修正后重验；不是产品失败。结果`result.json`、`entry-hashes.json`及工装/日志在上述父目录；构建/打包/完整性日志位于`/tmp/inspector-mac-*`。仅临时签名，未公证/无TeamIdentifier，不称干净系统安装、升级或真机包级验收。未改产品源码、未重启主程序/业务App、未安装手机包或提交推送。下一项转冷启动证据，不外推正式发布成功。

2026-10-06 最终离线回归/文档收口：333项测试/0失败、55文件、67.06秒；完整桌面/CLI/MCP构建通过，树UI/生命周期、页面缩放100/125/150各46组及DPR代理1/1.25/1.5各46组通过。隔离fixture工作台27项、success=true/fixture=true/rendererErrors=[]，产物`.benchmarks/app-smoke/2026-10-06T11-32-09-268Z/result.json`；通用real-device输出标签不当真机证据，首图计时为空不补造。树工装有1条ResizeObserver通知及Canvas readback建议，未阻断断言，日志保留，不声称所有控制台通知清零。合成512层CPU提交中位0.5ms/p95约0.8ms只属工装，不当物理上屏或业务性能。日志`/tmp/inspector-stage-final-tests.log`、`inspector-stage-final-build.log`、`inspector-stage-final-tree-ui.log`、`inspector-stage-final-coordinates.log`、`inspector-stage-final-dpi.log`、`inspector-stage-final-fixture.log`。计划215→77行、状态49→43行，移除重复逐轮描述及多个旧“下一项”；冷启动失败、366/149像素未通过、实验默认关闭、安全/退出规则和旧锚点均保留，测试入口补配对离线工具并修正旧步骤链接/PNG数量与alpha规则说明。整理前原文在忽略目录`.benchmarks/docs-cleanup/2026-10-06-final-regression/`可恢复，既有失败报告未删除。下一项macOS安装包隔离验收尚未执行；本轮无手机调用、安装/重启、主桌面更新、生产改动或提交推送。

2026-10-06 折叠来源/精度提示收口：shared/layer-image-provenance新增纯展示文案，保留既有来源及请求状态协议。Layer3DPreview选中折叠节点的状态提示和悬停卡片显示本地重建/原生整组/仅边框；本地明确不保证与原生整组图逐像素一致，原生明确来源不代表逐像素验收且不保证与原快照同帧。pending暂用本地、unavailable原因未返回、not-live当前无法请求、hidden-descendants排除隐藏项分别说明；没有可展示画面不当透明。全局pending/unavailable只检查当前collapsedRecords，展开/隐藏后不沿用旧请求状态。没有新增请求、自动重试、纹理/透明度/合成策略或像素容差。4项来源单元测试通过；扩展真实Layer3DPreview离线组件3种成功/null/无请求能力场景，检查可见精度说明、隐藏子项不再请求、不使用含隐藏项整组图、重新展开恢复DDMS own及消除旧提示。树UI/生命周期检查和完整桌面/CLI/MCP构建通过，日志`/tmp/inspector-reconstruction-hints-tests.log`、`inspector-reconstruction-hints-tree-ui.log`、`inspector-reconstruction-hints-final-build.log`。本轮无手机操作/安装/重启/主桌面更新/提交推送；不是已修复366色差或旧业务像素验收。下一项最终回归及压缩重复计划记录，不继续无限微探针。

2026-10-06 保存配对PNG桌面重建：新增离线paired-color-check（不调用ADB），复用生产composeSubtreeImage及pixelDifferenceSummary；输入必须8组固定场景、来源/单调时间/身份/几何通过，父子/原生/手机合成/独立snapshot文件的PNG头、尺寸、唯一SHA记录严格核对。独立平面Canvas不调用生产树/opacity逻辑，按实测相对位置和原始alpha直接绘制；另设trunc(alpha*255)/255诊断控制，不当Android正确性基准。原尺寸240×160×16组：生产桌面对手机composed、独立原始alpha平面参考均零差异；手机composed对group的4项差异统计与Android保存指标一致。软件8组对原生group零差异，报告`.benchmarks/paired-color-offline/2026-10-06T11-24-19-064Z/result.json`、退出0；硬件7组零差异，固有半透明渐变仍366个RGB差1/alpha0差异，与手机既有统计一致，报告`.benchmarks/paired-color-offline/2026-10-06T11-24-18-368Z/result.json`、diagnosticCompleted=true/success=false/退出1。全部group对独立snapshot一致。8位截断alpha控制在两种窗口的普通view-alpha/重叠场景分别引入2379/3498差异像素，生产原始alpha仍0，因此不修改产品透明度；控制不是改容差。首次输出将该控制命名androidAlphaReference，已更名truncatedAlphaControl以避免暗示它是Android正确基准；旧报告11-22-34/11-22-46保留。新PNG admission测试覆盖篡改摘要、头/尺寸/短数据/超预算、无输入变更；10项定向测试和完整构建通过。日志`/tmp/inspector-paired-color-offline-hardware-final.log`、`inspector-paired-color-offline-software-final.log`、`inspector-paired-color-offline-final-build.log`。结论只是保存样例原尺寸Canvas重建没有额外色差，不是PNG无任何精度损失证明、WebGL/缩放/旧业务或硬件量化根因验收。本轮没有手机调用、安装、重启、生产渲染/取图/容差改动或提交推送；下一项收口本地回退的精度提示，不无限新增探针。

2026-10-06 固定sample配对来源验证：复用GroupColorActivity已有8组，新增父own/所有子own文件及captures记录；每项包括file/backend、elapsedRealtimeNanos起止、View身份/边界/alpha/attached、ARGB_8888尺寸、预乘/alpha/density/colorSpace。固定View同一UI任务顺序取图，不称同时原子帧；主机拒绝缺来源、错路径、时间倒序、父身份/尺寸/子位置变化。父own和group重复零差异；PNG分别SHA并经ffmpeg独立RGBA解码，原有Android差异统计全部一致。硬件报告`.benchmarks/group-color/2026-10-06T11-17-40-593Z/result.json`：8组7组零差异，leaf-intrinsic-alpha-gradient仍366差异像素、alpha0差异、max1、R:-1=183/G:-1=122/B:-1=61，范围[31,92)×[46,80)，366个均有子图贡献、父独有0。该组captureSpan21.306539ms，其他硬件组23.2–37.6ms，首组507.895693ms；不作采集性能收益，跨度含顺序执行的控制/合成步骤。CPU/GPU同批位图合成一致，均保留366；所有production group与独立snapshot一致，strict localCompositionVerified=false，退出1/failure.json保留。软件报告`.benchmarks/group-color/2026-10-06T11-18-43-689Z/result.json`：8组全零差异、退出0，各组跨度3.96–7.06ms。全部图均ARGB_8888预乘、sRGB、density450；硬件来源HardwareCanvasProvider/createSnapshot，软件父/group用SoftwareCanvasProvider、软件叶子用View.draw。两轮sample PID31055一致，各自Activity身份及token保存，不外推相同Activity。9项定向测试、Gradle离线sample Debug构建及完整桌面/CLI/MCP构建通过，日志`/tmp/inspector-paired-color-build.log`、`inspector-paired-color-desktop-build.log`、`inspector-paired-color-hardware.log`、`inspector-paired-color-software.log`。只保留数据更新sample，证书一致、安装APK SHA=c043b02c32ef9b4d2e4ab9a583da52b93efe76adb7e306240c2ced1c95f2b787与构建一致；未更新/重启/清数据/采集业务App，结束回到原PrivateSettingsActivity实例bc34bf0，转发为空。差异已在PNG保存前Android合成指标出现，排除PNG/网页是此样例差异的唯一原因，不证明原业务149像素或硬件量化根因。下一步仅用保存父子图离线检查桌面重建是否增加差异。

2026-10-06 保存图片RGB差异离线定位：输入own为app-smoke/2026-10-06T10-10-01-991Z/profile/snapshots.json，原生group为live-group/2026-10-06T10-12-54-842Z/group.png；工具核对manifest中的source/nodeId/SHA，未重新采集。新增测试专用pixelDifferenceSummary，保留精确相等门禁，输出符号直方图、半开坐标范围、alpha差异、最多8个样本，以及参考合成相对parent-only是否有子图贡献；此分类不是具体控件/后端的因果归属。报告`.benchmarks/snapshot-clip/2026-10-06T11-10-45-260Z/result.json`：原尺寸1080×124共133920像素，149个差异全部RGB±1、alpha一致，其中110个RGB均-1、39个均+1；group局部范围[63,580)×[43,92)，withChildContribution=149/withoutChildContribution=0。本地99831像素零差异、2204子贡献像素；缩放group225个差1。localCompositionVerified=true/nativeGroupVerified=false/success=false、退出1，严格失败保留；5组人工RGBA共2000像素通过。own/group时间为10:10:15.107Z/10:12:58.348Z，相隔163.241秒，旧own逐图来源未保存，不能补推通道或认定抗锯齿/舍入原因。7项定向测试及完整构建通过，日志`/tmp/inspector-pixel-localization-build.log`；仅own离线对照另通过，日志`/tmp/inspector-pixel-local-only.log`。本轮只改离线诊断和文档，无手机调用、安装、重启、生产渲染/捕获/容差改动。下一项用现有sample固定内容和来源做配对证据，不以旧非同时业务图片直接修后端。

2026-10-06 阶段完整离线回归：bun test全量326项/0失败（68.36秒），完整桌面/CLI/MCP构建、树UI/生命周期通过，坐标page zoom100/125/150各46组，DPI代理devicePixelRatio1/1.25/1.5各46组。初次DPI失败actual15/expected12；核对生产坐标工装已有边框、遮挡与内容边界等15项pixel检查后，只修scripts/dpi-checks-main.cjs的严格数量12→15，非产品渲染/像素容差改动。修正后三档通过，失败日志保留`/tmp/inspector-delivery-dpi.log`，成功留`/tmp/inspector-delivery-dpi-fixed.log`。隔离app-smoke --fixture --reduced-motion 27项/0渲染错误，产物`.benchmarks/app-smoke/2026-10-06T11-05-39-132Z/`；其中工装打印real-device通用标签但fixture=true，不当真机证据。其余日志`/tmp/inspector-delivery-offline-tests.log`、`inspector-delivery-offline-build.log`、`inspector-delivery-tree-ui.log`、`inspector-delivery-coordinates.log`、`inspector-delivery-fixture.log`。树12项各页面缩放及生命周期18项可读输出通过；合成WebGL512层/32纹理/120样本CPU中位0.4ms、p95 0.7ms，只提交链路不当物理显示或业务性能。PROJECT_STATUS压缩为当前能力/最新验证/未通过项，整理前原文保留`.benchmarks/docs-cleanup/2026-10-06-before-delivery/PROJECT_STATUS.md`；既有失败/业务报告不删除。无设备调用/安装/重启/主桌面更新/提交推送；不外推冷启动、复杂业务像素、其他平台安装包/长期内存通过。下一项复用已保存图像证据收口正确性。

2026-10-06 冷启动焦点/预算离线检查：parseFocusedWindowState明确区分主显示器mCurrentFocus=null、字段缺失/重复、非主显示器及格式错误；readDebugFocus仅windows无字段时再查displays。首轮记录只保留“系统焦点为空”分支而无原始dump，不能重建焦点持续为空的真实原因；源码不支持断言解析器误读或SDK致启动阻塞。APP_READY_TIMEOUT_MS=18000/APP_READY_MIN_READ_MS=1500，剩余不足最小预算提前停，16.546秒退出符合规则。仅在此退出场景追加“剩余就绪预算不足1.5秒，提前停止避免打断系统查询”错误说明，保留既有错误前缀/重试判断/身份门禁/实际elapsed，没改等待或请求。新增focus-null隔离ADB模式及多显示器主屏null测试；读取失败和持续null各模拟约16.8–17秒、1次尝试/0App读树/0SDK/0抓图，无预算重启，窗口变化/延迟/取消回归通过。主回归28项（39.36秒）及新增实际16.54秒反馈7项（其中6项重复），唯一用例29项通过，完整构建/diff通过。本轮无手机查询/重启/安装/清数据/主桌面更新/推送；只修诊断说明，不声称冷启动修复或性能收益。下一项完整离线交付回归，真实启动根因需另定有界对照而非追加微探针。

2026-10-06 冷启动失败后恢复：用户确认进入设置主页后，device-health-check --reuse-app --single-attempt，仅一次请求；产物`.benchmarks/device-health-check/2026-10-06T10-58-57-979Z/`。API往返10914ms、诊断总10878ms、尝试10598ms，98节点/74可见/71图/0失败、error/warning=null，1次内部尝试。恢复前后只读PID26284及startTicks10557728一致，也与首轮失败后的观察一致；首轮捕获报告PID为空，因此不补证明整个冷启动失败身份。SettingsActivity实例a7024dc/窗口b6c5801，首次dump139ms/1次；属性协议129ms（V2读取58/解码13）、2窗口探测/1导出。DDMS3013ms、JDWP补齐4247ms（初始化1904/定位1317/补图986），64候选/1补图/2跳过/3字段请求；同前进程的数值变化不是受控因果对照。首树2054/首图6281ms仅IPC送达，无GPU/物理显示或逐像素证据，71图withoutEvidence。恢复前后未再次重启/安装/清数据/导航，用户手动切页；结束仍设置主页、转发为空，主桌面未更新。保留10-57-09首轮16.546秒失败，不用恢复成功覆盖冷启动缺口；下一项仅离线分析焦点就绪路径。

2026-10-06 冷启动单次首采：用户同意重启后，device-health-check --startup-probe --warm-ms=0 --single-attempt，桌面先就绪再force-stop/start HomeActivity，不清数据/不导航/不预热抓图。产物`.benchmarks/device-health-check/2026-10-06T10-57-09-734Z/`，startup-comparison.followup=null。API往返16546ms、诊断总16542ms、1次尝试、0节点/0图，readiness预算18000ms/elapsed16541ms、focus-before、focus=null/treeReadCount=0，错误系统焦点为空。等待窗口15864ms含轮询间隔11542/窗口观察2941/前台读取1374ms；不重复相加。未执行V2/SDK/DDMS/JDWP图像捕获，不归因渲染或取图失败。失败后只读PID26284与/proc/stat的startTicks10557728，转发为空；首轮报告PID=null，后续进程观察不能补证明首轮完整身份。无自动恢复/重试或第二次重启，主桌面未更新；已请用户切设置主页，恢复验收待确认。

2026-10-06 新版连续健康门控：现有device-health-check --reuse-app --single-attempt --consecutive=3，同隔离桌面正式IPC串行三轮，无导航/预热抓图/刷新/折叠/补跑。产物`.benchmarks/device-health-check/2026-10-06T10-55-18-980Z/`及consecutive-summary.json，passed=true/3轮。API往返13354/12748/12793ms，总请求诊断13316/12709/12752ms（含内部收尾），每轮1次尝试，无error/warning；98节点/74可见/71独立图/0失败。PID14952、SDK实例58c8dca3…cdd5、DecorView@bd1ec94、SettingsActivity实例44a46be/窗口c9932e9一致。每轮首次dump1次、窗口探测2/V2导出1；64补图候选/1实际补图/2跳过/3字段请求一致。DDMS3840/3442/3692ms、JDWP补齐3367/3253/3289ms；嵌套阶段不重复相加。只验证稳态健康与数量覆盖，geometryCoverage均71图withoutEvidence，不当逐像素/复杂裁剪验收；无工作台绘制测量，不冒充GPU/上屏计时。结束仍设置页，转发为空，无安装/重启/清数据/主桌面更新/提交推送。不外推所有页面、冷启动或因果提速；下一项冷启动首采及恢复需新的重启同意。

2026-10-06 方法表延迟读取真机单轮：隔离app-smoke --require-device --workbench-only --viewport=1280x880，唯一完整请求；产物`.benchmarks/app-smoke/2026-10-06T10-53-22-775Z/`。总请求13154ms、桌面完成观察13235ms、98节点/71图、1次尝试、无警告/错误，23项检查/rendererErrors为空。与10-46-23修改前71张独立图dataURL逐项全同、bounds一致、来源70DDMS/1JDWP；PID14952/Activity实例44a46be/窗口c9932e9保持一致。候选64/实际补图1/跳过2、字段3次不变，首次dump1299ms且1次；属性协议1536ms含V2读取1473ms/解码11ms，2探测/1导出无重读。DDMS3708ms其中首包等待3626ms；JDWP补齐3481ms，初始化1026/定位1384/补图1040ms，包含段不重复相加。前轮总13233ms/定位1511ms/补齐3697ms，减少79/127/216ms但未控制顺序/负载，不能归因明显提速。折叠groupRequest完整保存elapsed1538ms/settled=true/live-group/ready，展开恢复通过；首图9279/GPU9425ms，链路146ms非物理上屏。结束手机仍设置主页，ADB转发为空；无导航/安装/重启/清数据/主桌面更新/提交推送。本轮收口正确性验证，后续走已有连续健康门控，不补压力轮或微探针。

2026-10-06 兼容补图方法表按需读取：离线核对captureDebugViewImages/onViewTreeReady，98节点低于200默认策略，所以树经SDK核对后仍选DDMS；fallback64候选并非64张重复图，真实类型确认后3项读取flags/overlay，2项跳过、1项补图。captureViewBitmaps.kindFor原先每个首次遇到的自定义类都查dispatchDraw方法表，即使captureOwn=false；改为同连接保留真实类继承链/缓冲类型，仅captureOwn且own时检查方法表，不跨会话缓存，不省findView/窗口/字段/像素校验。新fixture在旧实现失败2!==0；修正后已有图分类0次自定义方法表，后续同类缺图仍保留继承dispatchDraw，坏方法表首项失败但不污染第二项，Surface/Texture子类识别与清理回归通过。70项定向测试（5.74秒）、完整桌面/CLI/MCP构建和diff检查通过；初次类型检查报残留未用key，删除后通过。无手机调用/安装/重启/主桌面更新/提交推送，无真实毫秒收益或200门槛改动；下一项单轮正常业务验证。

2026-10-06 属性协议真机结算：隔离app-smoke --require-device --workbench-only --viewport=1280x880，仅一次完整请求；产物`.benchmarks/app-smoke/2026-10-06T10-46-23-352Z/`。总请求13233ms、尝试12904ms、桌面完成观察13381ms，98节点/71图、无警告/错误、1次尝试；23项检查/rendererErrors为空。属性阶段1706ms，协议合计1532ms（connect6/windows22/probe19/export1470/decode15），2次探测/1次V2读取，无重读；四字段随root和CaptureAttempt保留。DDMS3676ms其中首包等待3584ms，JDWP补齐3697ms含初始化1102/定位1511/补图1053；不重复相加累计段。groupRequest完整保存elapsed1557ms/settled=true/timedOut=false/live-group/ready，展开恢复ddms；仅观察轮询计时，不当接口自身精确耗时。首图9152ms/GPU9338ms，链路186ms非物理上屏。与10-28-34报告71张图片dataURL全同、节点bounds全同，70DDMS/1JDWP、批量198257字节/93图及字段3次/补图1项/跳过2项一致。前后SettingsActivity实例44a46be/窗口c9932e9，记录PID14952，结束ADB转发为空；无导航/安装/重启/清数据或主桌面更新。首次dump1180ms，一次读取；低于15秒仅单轮，不能归因诊断改动提速、证明连续健康或像素oracle。下一步离线核对兼容批量/补齐重复工作，不追加压力轮。

2026-10-06 属性协议分段诊断：captureViewLayers在既有请求外记录connect/windows/probe/export/decode墙钟时间及协议合计，标记探测数（最多32）、V2导出数（最多2）、成功与结束阶段；在预览/SDK回调前结算。失败/取消也结算，诊断回调异常不改变协议；清除失败树及外层重编号后保留四项标量，拒绝坏计数、未知阶段、额外字段，不存图片/私有对象。70项view-debug/capture-attempts测试通过（5.77秒）、完整桌面/CLI/MCP构建与diff检查通过。合计不含PID查询/ADB转发/后续回调，解码为墙钟而非CPU计数；旧快照允许缺字段。不改变命令顺序、一次坏V2重读或身份校验，无设备调用/安装/重启/推送，尚无新增真机计时或提速证据。

2026-10-06 快慢采集离线对照：复用app-smoke/10-10-01与10-28-34两份快照，不调用设备。PID14952/SettingsActivity实例44a46be/窗口c9932e9相同，98节点id/class/ref/bounds/可见/图片状态尺寸/子ID指纹均17cfcaa4…5212d6，71张独立图dataURL逐项相同；DDMS198257字节/93层/93图、JDWP字段3次/补图1项/跳过2项一致。总请求11851→16618ms，首次dump347→4237ms且各1次；树阶段695→4509ms包含dump，属性453→1646ms、SDK核对964→1126ms、DDMS3352→4011ms、补齐4662→3770ms。不能把首次dump与树阶段相加。源码首次就绪成功dump按同窗口前后夹持并复用，没有多一次完整Activity读取；captureViewLayers的VULW/各窗口根探测/V2完整属性是不同用途，最多一次坏V2重读，但报告不含实际探测数和V2重读次数。属性阶段还包含singleAppPid、转发/握手与主机解码，未证明解析或UI排队为慢因。旧PID9793的9.720/10.931秒两轮仅背景参考，不混作同版本对照；当前两轮桌面来源标记不同、负载/启动年龄/顺序未受控，不声明因果退化或提速。保留全部快慢报告，不补压力采集；下一步补现有协议子段计时/次数而非删校验。

2026-10-06 真机折叠来源结算：手机仍SettingsActivity主页，同实例44a46be/窗口c9932e9/PID14952；隔离桌面单次正式请求16618ms（采集16268ms、工作台完成观察16748ms）、98节点/71图、1次尝试、无警告。来源70图ddms/1图jdwp；标题栏0/0/0/0/1/0/0折叠live-group/ready、展开ddms/not-applicable，23项检查通过、rendererErrors为空。首图12425ms/GPU12599ms，链路174ms，不是物理上屏或严格像素。工装实际以30秒上限观察ready/unavailable，但最终重建businessBranch覆盖groupRequest对象，故已保存报告没有等待耗时/settled统计，不补造；已修spread保留旧字段，node语法检查及7项来源/分支测试通过，没有为了计时重新采集。首次App树读取4237ms、完整属性1646ms，阶段可能包含/重叠；总请求超过15秒门槛，保留慢轮并停止复采，不算健康/普遍提速通过。产物`.benchmarks/app-smoke/2026-10-06T10-28-34-401Z/`，日志`/tmp/inspector-group-settlement-smoke.log`。结束焦点/实例未变、转发为空；未导航/安装/重启/清数据或更新主桌面。下一步离线分析已有慢轮。

2026-10-06 来源核对：旧业务快照71图中70图缺逐图通道，1图只有通用补图描述；root包含DDMS批量及JDWP补图记录，但不能据此替每张旧图补标签。旧composite同时用于live-group和本地合成、折叠只等600ms，原报告无法证明当时请求已结算。新增逐层来源及group请求状态，SDK/DDMS批量与初次补图实际来源随LayerImageUpdate传递；旧值unknown、未返回失败原因不猜。64项定向测试通过（5.77秒）、类型与完整构建通过。离线app-smoke fixture26项/0渲染错误，产物`.benchmarks/app-smoke/2026-10-06T10-24-19-215Z/`；该fixture分支无独立图，source=none/not-live，不冒充原生整图成功。另隔离真实Layer3DPreview组件模拟pending→成功/null，验证local/live来源、只请求一次、展开恢复DDMS own，tree UI/lifecycle通过。初版误用fixture+workbench-only被参数门禁拒绝，日志留/tmp/inspector-provenance-smoke.log；初版测试将Activity根当可附图节点失败，改子节点后通过；测试origin字段x/y类型失败，改left/top后通过。没有手机调用/安装/重启、没有改图片捕获路径或容差；色差根因仍未证明，新版真机状态待验收。

2026-10-06 矩形分支裁剪离线核验：新增测试专用rectangular-branch-reference，以祖先边界交集计算平面绘制；padding必须四边实测，未知透明分组/变换/排序/outline拒绝。5组人工RGBA2000像素、8项定向测试、类型与完整构建通过。业务标题栏保存own本地合成99831像素零差异，2204像素来自子图；报告`.benchmarks/snapshot-clip/2026-10-06T10-18-06-393Z/`。原生group原尺寸133920像素中149个RGB差1、alpha零差异，缩放225像素差1；报告`.benchmarks/snapshot-clip/2026-10-06T10-18-05-768Z/`明确localCompositionVerified=true/nativeGroupVerified=false并退出1。先前无人工fixture和缺字段报告留10-16-44/10-17-30目录，未删除失败。初版bun:test类型声明和属性联合类型导致类型检查失败，已改node:test及显式Record后通过。只有测试工具/文档改动，无手机调用、安装、重启、生产取图/渲染改动；图片非同时捕获且own来源仍有DDMS/JDWP，不能断言色差根因或称业务整体像素通过。

2026-10-06 新业务SDK单次设置页验收：正常打开SettingsActivity主页，未修改设置/重启/清数据；隔离桌面正式IPC单次请求11851ms（采集11481ms、工作台观察完成11972ms），98节点/71独立图、1次尝试、无警告。23项检查通过，包括父子折叠、一级重开、全部展开恢复原ID；rendererErrors为空。首树2437ms/首图6749ms，GPU完成6913ms，展示链路164ms，不是物理上屏。整页DDMS/JDWP补图，总补齐4662ms（包含初始化1984ms、定位1379ms、补图1252ms，不相加外推）。产物`.benchmarks/app-smoke/2026-10-06T10-10-01-991Z/`。随后仅一次生产group请求，标题栏分支1080×124、3574ms成功，产物`.benchmarks/live-group/2026-10-06T10-12-54-842Z/`；离线像素核验因clip-children/clip-to-padding超出平面基准范围退出1，失败留`.benchmarks/snapshot-clip/2026-10-06T10-13-20-012Z/`，未放宽门禁或补采。PID14952、SettingsActivity实例44a46be/窗口c9932e9绑定记录保留，无转发残留；本轮未安装/重启业务或主桌面。新版单轮通过不等于连续健康、冷启动、严格像素或因果提速。

圆角修正最终回归：309项测试/0失败（50.55秒），完整构建、树UI/lifecycle、坐标100%/125%/150%各46组、diff检查通过。新像素oracle先失败后通过；业务真机验收仍受ANR阻断，不用离线结果覆盖该缺口。

2026-10-06 非等比圆角裁剪：检查clipLayerImageToOutlines发现radius=min(radius×scaleX,radius×scaleY)，对应200×60图片/100×60区域时应为40×20椭圆而非20圆。先增加独立椭圆方程oracle（非调用生产算法生成期望），旧实现明确失败`14,0: alpha=21, expected=0`，随后改为roundRect的X/Y半径；超过1万个避开抗锯齿边界的像素通过。已有嵌套圆角/折叠group合成、三档坐标各46组、树UI/lifecycle及完整构建通过；不外推真实业务裁剪或旋转自定义轮廓支持。本轮无完整设备采集，返回首页后两次导航点击未响应，16:13:52系统lastanr记录HomeActivity输入DOWN等待5000ms超时，PID9793仍在、无ADB转发；/data/anr及厂商栈正文读取被权限拒绝，不能判断SDK/调试断开是根因。已停止设备交互，未安装/重启/清数据/改设置或主桌面；请求用户确认是否重启恢复。诊断留`/tmp/inspector-clip-lastanr.txt`、`/tmp/inspector-clip-anr-logcat.txt`及页面PNG，均私有不提交。

本轮最终回归：309项测试/0失败（50.33秒）、完整桌面/CLI/MCP构建、树UI/lifecycle、三档坐标各46组和diff检查通过。末尾加强的workbench首图缺证据断言未追加设备轮；本轮已保存的成功报告含5913ms GPU完成证据，符合该断言。

2026-10-06 首图GPU计时修正：Layer3DPreview仅在准备图层变化后保存已提交native层的ID/图像版本/outline身份及drawn标量，不携带图片字节、不在生产调用gl.finish；相机旋转不重新序列化身份。app-smoke按当前目标匹配，排除不入场景的更新，不再要求textureCount≥imageCount；15秒无证据明确报告。3项纯函数测试、三批40图旧版本拒绝/新提交通过、三档坐标各46组、树UI与完整构建通过。唯一真机完整采集总请求9720ms（采集9433ms/桌面完成观察9802ms）、98节点/71图/1次尝试/无警告，23项交互及rendererErrors=0。首树2229ms/首图5762ms，gl.finish5913ms，展示链路151ms；68项目标处理、67项绘制、2项排除，不外推物理上屏、严格裁剪或普遍提速。产物`.benchmarks/app-smoke/2026-10-06T08-09-03-050Z/`。业务SettingsActivity/窗口eb18482/PID9793保持不变、无转发残留；未安装/重启/清数据/改设置或更新主桌面。保存快照中只有根DecorView的矩形outline（radius=0），没有复杂圆角业务分支，因此该验收仍保留未完成。

2026-10-06 实际工作台：`app-smoke --require-device --workbench-only --viewport=1280x880`，隔离profile、正式IPC、23项检查通过，产物`.benchmarks/app-smoke/2026-10-06T07-58-25-876Z/`。唯一完整采集总请求10931ms（采集10620ms/桌面完成观察10993ms），98节点/71图、1次尝试、无警告；首树2502ms/首图6589ms送达，GPU flush为空。67场景纹理与70首批图片更新不相等，旧数量门槛不能证明绘制送达延迟；未宣称≤500ms。标题栏分支0/0/0/0/1/0/0折叠71→69层、父层composite，展开71层，保存证据精确核对图层ID/模式一致；截图提示本地合成，不视为原生group通过或逐像素正确证明。悬停实际指针、旋转/缩放/适配、浮动属性、2D几何、搜索/键盘和历史恢复通过，rendererErrors为空。离线坐标100%/125%/150%各46组通过、树UI/lifecycle通过；已知fixture裁剪通过不外推业务复杂裁剪。手机SettingsActivity/窗口eb18482/PID9793前后相同、无转发残留；未安装、重启、清数据、改变业务设置，主桌面未更新。新增workbench-only工装，后续加强的composite/恢复断言亦在本次保存证据复核通过；未因此重跑手机。下一项先修计时，再补业务复杂裁剪像素证据。

2026-10-06 字段去重业务复测：实际截图先确认手机在视频首页，使用菜单进入SettingsActivity主页（不修改设置），然后唯一完整请求。11.362秒、98节点/71图/74可见/0失败/1次尝试，debug-hybrid且补图来源jdwp；候选64、字段请求3/合并3、SKIP_DRAW跳过2、实际补图1。初始化2021ms、定位1250ms、位图补图931ms，总补齐4242ms（阶段包含，不相加）。首树2627ms/首图6630ms送达；无逐矩形证据71图，不当严格几何/裁剪验收。就绪1308ms、804ms确认SettingsActivity实例fd6c2d2/窗口eb18482、804–959ms读树一次，采集后窗口身份一致。业务PID9793、APK SHA0ebcf676…3ef630前后相同，无转发残留；不安装/重启/清数据，无后续压力轮，手机仍在设置主页。产物`.benchmarks/device-health-check/2026-10-06T07-50-26-151Z/`，私有页面截图及日志`/tmp/inspector-jdwp-business-XJn2Bv/`。旧三轮不是配对基线，本轮未显示明显时间收益，不宣称提速或退化；后续转工作台/复杂裁剪验收。

2026-10-06 字段去重真机样例：手机已安装com.androiduiinspector.sdkfree，APK SHA与本地样例一致（8dc6b4d9…02ae0d0）；普通am start临时打开HardwareTextActivity，无安装/强停。新版隔离桌面单次完整采集3.434秒、10节点/6图/9可见/0失败/1次尝试，JDWP字段请求2次、合并2次、SKIP_DRAW跳过2项，补齐472ms（初始化392ms/定位48ms/无额外位图）。3次文字刷新1.560/1.371/1.298秒、均JDWP、同对象及当前bounds一致，591×225解码RGBA SHA21a693f0…7cb37f一致；也与旧SDK-free报告摘要相同，但旧坐标不同，不称整体几何或新旧性能验收。产物`.benchmarks/device-health-check/2026-10-06T07-45-55-168Z/`及`/tmp/inspector-jdwp-field-sample.log`。结束切回快手现有任务，PID9793前后相同、转发为空；未重启主桌面/业务App，业务设置页单次复测待确认。

本轮字段去重最终验证：306项测试/0失败（50.56秒）、完整桌面/CLI/MCP构建及diff检查通过；完整日志`/tmp/inspector-jdwp-fields-all-tests.log`和`/tmp/inspector-jdwp-fields-build.log`。测试包含协议模拟，不代表已安装运行版本或真机收益。

2026-10-06 JDWP字段读取去重：复用旧三轮设置页报告，初始化1364–1398ms、定位1193–1281ms、生成/传输/编码所在补图966–1014ms，总补齐3632–3680ms；不把包含阶段相加。本轮将同一View的mPrivateFlags/mOverlay合并为一次9/2请求，空容器判断从2次往返减为1次，不跨对象/连接缓存。字段返回数量、顺序标签、完整长度均严格校验；缺overlay仍按旧行为，坏响应无补重试/无虚假透明。61项定向测试通过，协议fixture覆盖继承自绘、叠加层、视频独立缓冲、单字段像素一致、错误清理及连接恢复；定向日志`/tmp/inspector-jdwp-fields-test.log`。没有真机对照，不推算毫秒收益或宣称业务提速；未改SDK/APK、未操作手机/主桌面、未提交推送。

2026-10-06 首采状态反馈：复用captureReadiness，不增加设备请求/重试/预算；窗口未就绪、树超时、窗口复核失败和后续失败分别提示。会话保留最多8条无树/像素的失败标量，成功及历史切换不抹除；手动重采、取消/旧结果隔离通过真实App组件的隔离Electron测试。306项单元/离线测试、完整构建及1280/960宽度截图检查通过，截图留`.benchmarks/capture-feedback-*.png`，交互日志`/tmp/inspector-capture-feedback-ui-final.log`。初次截图钩子返回函数导致不可克隆，已改为不返回值；窄栏提示截断及标题低对比度已修正。SDK初始化源码只注册生命周期和更新弱引用，未见主动读树/绘制/反射预热，未测其设备运行成本。本轮不操作手机、不更新SDK/APK、不重启主桌面，冷启动仍未通过。

2026-10-06 授权单次运行时观测：只force-stop/start一次，不清数据、不安装、不自动再启动。启动命令12:12:00.381Z开始、118ms返回；立即activity查询目标app=null，因此初轮工具退出，原始失败留`.benchmarks/startup-analysis/2026-10-06-runtime-stack/result.json`。同一次启动后只读复核约11秒时owner PID11482、Activity41d4b3f且控制目标仍Splash；后续12:12:24.163Z窗口查询确认HomeActivity/BASE_APPLICATION，focus为HomeActivity，因此既有进程观测工具在调试前停止，留`existing-process-result.json`。两次工具调用不等于两次启动；未连接JDWP、未暂停、无栈/取图，转发前后为空。后续证据仅证明查询时窗口存在，不是实际建立耗时或18秒内成功；早期app=null未做有界等待导致漏采，未宣称根因/修复。私有工具只通过node语法检查，未执行模拟协议测试；下一步先完善离线工装，不以继续实机重启掩盖缺口。业务/SDK/桌面生产代码未改。

2026-10-06 启动观测工装离线修正：新增scripts/lib/startup-stack-observer.cjs与16项tests/startup-stack-observer.test.cjs，纯模拟时钟与本机TCP假JDWP服务，不调用ADB。覆盖app=null后进程建立/3秒预算耗尽/迟到进程拒绝，准确Activity与主进程关联、主窗口头归属，握手/命令超时/坏包/断线/迟到回复，取栈失败及丢失Suspend回复后的Resume+计数核验，既有暂停不修改、Resume回复丢失仅一次Dispose回退、清理失败明确留证，握手/观测失败仅删除自有端口，以及TCP取栈失败后恢复和端口清理整链。node运行16项/0失败；私有旧probe接入这些公共诊断辅助函数，输出新增带时间戳文件不覆盖旧失败，暂停前再次核对Activity与窗口，连接阶段12秒上限；--check-only确认导入/语法且不触设备。断线恢复无法核验仍报告未知，不将Dispose回退或模拟通过外推真机安全。无生产SDK/采集改动，无设备查询、重启、安装、取图或推送。

本轮最终定向回归：bun执行startup-stack-observer/startup-command-evidence/startup-focus-validation三文件24项/0失败（0.905秒），node独立执行新增16项亦通过；私有入口check-only无设备调用，diff检查通过。未重跑完整生产构建/全量测试，本轮不改生产路径。

2026-10-06 新工装单次授权真机取栈：`result-2026-10-06T12-19-54-850Z.json`留私有runtime-stack目录。只force-stop/start一次，启动命令12:19:55.004Z开始/134ms返回，进程归属有界观察9次（前8次null、第9次PID15503/Activity c939e9f），cmdline及前后startTicks一致。初次和暂停前无BASE_APPLICATION且focus=null。12:19:57.063Z开始暂停，6ms内Resume应答+SuspendCount=0；29帧完整栈为ActivityThread.handleBindApplication→ContextImpl.createAppContext→LoadedApk.getResources/getClassLoader→ApplicationLoaders→DexPathList→DexFile.openDexFileNative，未见业务初始化等待/SDK方法。解析类名在恢复之后；自有tcp52043已删除、转发列表为空。只是启动开始约2.06秒的单点栈，不证明DEX持续耗时/异常，也不能排除后续业务等待或SDK成本。随后12:20:54.900Z只读复核留post-observation同轮文件，PID/startTicks/Activity一致，HomeActivity主窗口及焦点已建立，无残留转发；该后续观察不是实际窗口建立时刻。没有取树/图、安装/清数据/再次重启或业务代码改动；旧17.121秒失败不覆盖。下一步离线补约12秒仍未就绪才取一次栈的触发规则，实机再次重启另需同意。

2026-10-06 延迟触发离线实现：waitForStackWindow以启动命令开始的performance.now单调时钟为基准，默认12秒触发/15秒窗口观察预算/1秒间隔，记录每次读起止及状态；必须12秒后开始的新查询仍无主窗口且focus=null，才返回sample-due。提前或阈值时就绪返回window-ready；未知/其他焦点/查询错误/预算耗尽/取消拒绝。read受剩余预算约束，真实休眠可取消。新增10项假时钟/取消测试，工具合计26项；相关三文件34项通过，node独立工具回归亦通过。私有probe已接入，窗口/显示读取按剩余预算限时，进入连接前才开自有端口；暂停前复核Activity/PID/startTicks和窗口，启动18秒后不开始暂停。--observe-existing禁用（没有可信启动时间），--check-only只验证导入/语法，无设备调用；旧结果不覆盖。不是整次诊断18秒结束承诺，恢复/清理仍按原有界命令执行；不改变生产预算。本轮未调用ADB、重启/安装/取图或修改业务/SDK/桌面生产逻辑，新延迟路径待授权实机验证。

2026-10-06 延迟入口授权真机验证：私有runtime-stack目录`result-2026-10-06T12-25-52-070Z.json`，启动12:25:52.524Z开始，11次窗口观察0.717–12.271秒均无主窗口/focus=null，最后查询12.008秒开始，未复用阈值前旧状态；13.065秒申请取栈，主线程32帧（达到截断上限）命中首页创建回调中的ANR防护动态代理生成。PID17508/Activity a44dc21，前后startTicks一致；暂停10ms、Resume应答/SuspendCount=0、自有tcp54446已删、转发为空。未见本次观测时的初始化完成等待，但不能排除之前等待，也不能将单点栈解释为该方法耗时13秒。12:27:45.554Z同轮post-observation只读复核同进程/Activity主窗口存在、HomeActivity焦点，无转发残留；不当实际窗口就绪时刻。只读源码只找到防护接入及依赖声明，代理实现未在仓库检索到，详细业务路径留私有delayed-stack-review.md；没有确认源码/缓存与已安装依赖字节一致。本轮只启动一次，不安装/清数据/取树/图/改SDK或业务代码；未宣称旧17.121秒失败根因或冷启动采集修复。下一步转连续阶段耗时方案，不再盲补单点栈，新的启动/跟踪另需同意。

2026-10-06 连续阶段取证准备：只读perfetto --help/atrace --list_categories确认手机命令及am/wm/view/dalvik/res类别存在，不录制、改设置或重启。本机复用/tmp/inspector-system-trace-uPjjaN/trace_processor_shell，--version为v58.2。新增startup-phase-trace.cjs/sql：只渲染固定25秒/32MiB DISCARD候选配置（调度/线程生命周期、进程映射及目标App/框架标记；不日志/堆/方法采样/上传），SQL按唯一PID选进程并导出main原始slice/parent_id、thread_state、未结束状态及error/data_loss。4项输入/配置测试通过，相关四文件38项通过。用旧capture-02.pftrace/PID20923离线执行所有SQL成功，旧记录1260条systrace_parse_failure明确健康失败，另有1条未结束main状态；不用于业务启动耗时或完整覆盖。私有prepare-phase-trace.cjs保存两次不同启动已有时间线/栈位置与phaseDuration=null，不能拼接成同轮连续时序，候选config、SQL、原始CSV/日志及phase-trace-preparation.json留runtime-stack目录。新配置设备解析/事件可读性、业务框架阶段标记、收尾/取证流程仍待单轮授权录制；工具存在不代表权限/健康通过。无手机采集/安装/重启/业务或SDK生产代码改动。依据[ATrace文档](https://perfetto.dev/docs/data-sources/atrace)及[CPU调度文档](https://perfetto.dev/docs/data-sources/cpu-scheduling)，未标记业务方法不自动获得持续耗时；跟踪有扰动，不能当无跟踪性能基线。

2026-10-06 单轮授权连续跟踪：私有产物`.benchmarks/startup-analysis/trace-2026-10-06T12-36-30-367Z/`含配置、原始17,408,768字节trace、命令/身份/收尾report.json及两组SQL/CSV/日志。先确认无其他会话，自有数据源就绪才force-stop/start一次；25秒自然结束，末次查询会话0、转发为空。PID25458/Activity/startTicks前后一致；约2/6/12/18秒窗口查询均未见主窗口、focus=null，不当精确窗口建立时间。分析器v58.2：同主线程闭合DEX阶段10,203,547,155ns，Running9,776,059,166ns/S229,035,692ns/D99,312,148ns/R86,918,919ns/R+12,221,230ns，合计等于阶段。随后闭合makeApplication10,182,066,078ns，Running5,866,039,690ns/S4,134,069,307ns/D137,577,769ns/R35,150,927ns/R+9,228,385ns，合计亦一致。两段相隔64,312,307ns、非嵌套；DEX内部提取/校验事件不累计到父阶段。bindApplication dur=-1，未获得完整启动/第一帧。systrace_parse_failure=76，非标准厂商print亦76条，仅数量吻合，未逐条归因；无data_loss记录不判整体健康。此次仅系统阶段证据，不证明业务具体方法/SDK成本，不外推旧17.121秒失败或无跟踪性能；未安装/清数据/调试暂停/改生产代码，不自动补录。下一步只读安装包与编译状态核对，定向优化须再提出受控方案。

2026-10-06 已安装DEX只读核对：私有`.benchmarks/startup-analysis/dex-metadata-2026-10-06T12-43-35-154Z/`保存ADB命令原文/report、完整package.txt、installed.apk、zip目录和dex-summary.json。手机唯一在线设备可读；pm path前后不变、设备sha256sum前后及本机SHA一致（6c3fc64f…434c089）。路径与上一轮trace一致，但trace时未取SHA，不外推过去字节身份。主包DEBUGGABLE、minSdk21/targetSdk30；arm64 dexopt为run-from-apk/reason=unknown/location is error，base odex大小null。ZIP主包90个DEX全DEFLATE：展开688,283,528字节、压缩264,401,862字节。与trace提取/校验事件相符，但无变更对照，不能证明压缩/预校验各自造成多少耗时。只读业务构建配置可见定制插件及dev默认minSdk21，所检索配置没有显式DEX不压缩设置；不能保证定制插件等同官方AGP或穷尽全部构建逻辑。下一步授权后先单变量预校验对照，失败再评估Debug打包实验；无手机编译、重启、安装、清数据、取树/图或生产代码修改。

2026-10-06 授权同APK预校验与一次重启：私有verify-2026-10-06T12-47-02-829Z保存命令及前后状态。cmd package compile -m verify --primary-dex只提交一次，45,003ms本机ADB超时、无响应；随后ps确认目标包dex2oat仍运行，不杀系统进程、不重提交。12:48:49只读确认后台结束，主包verify/reason=cmdline、base.odex4209Kb/base.vdex683343Kb；前后主包SHA6c3fc64f…434c089一致。不能称原命令正常通过，restart-gate记录超时及后续实际状态。新trace目录trace-2026-10-06T12-49-27-183Z：配置与旧轮cmp一致，25秒/32MiB，启动一次、PID29687/Activity/startTicks一致，33,450,547字节。已闭合DEX17,833,231ns（调度合计相同）、makeApplication3,954,890,385ns（Running1,174,508,145/S2,547,459,926/D179,584,218/R42,704,237/R+10,633,859ns，合计相同），bindApplication6,056,811,308ns；读到up-to-date/filter=verify/reason=cmdline校验产物标记。6.001–6.204秒窗口查询未就绪，12.000–12.226秒主窗口和首页焦点存在，18秒仍存在；不当第一帧或精确建立时刻。新trace systrace_parse_failure342，厂商非标准print亦342但未逐条对应；DISCARD缓冲写满33,554,432字节、chunks_discarded578、patches_failed570，原文保留，不判健康完整性能验收、不自动补录。单轮正向对照仍混有缓存/调度及解析丢失缺口，旧轮未采SHA，不称全部根因、稳定收益或首采成功。离线SQL/日志及comparison-context、post-trace-apk-identity保存；重启后SHA一致，跟踪会话0/转发空，未安装/清数据/调试暂停/改生产代码。手机保留verify状态，不擅自reset。4项既有跟踪配置测试及私有脚本语法检查通过，不是完整产品回归。

2026-10-06 跟踪容量/健康离线修正：25秒不变，调度DISCARD缓冲32改64MiB，进程映射单独1MiB/target_buffer1；不是流式或环形覆盖，不保证新容量实机不丢失。新增startup-phase-trace-health.sql单查询与严格CSV解析；error/data_loss、info级discard/overwrite、patch失败、写入达到容量均拒绝；PID零/歧义、容量或写入统计缺失返回unknown。主SQL保留原始缓冲计数；完整性pass仅表示列出检查通过，不当完整启动/第一帧/性能验收。私有录制工装接入独立health查询，query成功但健康失败不再返回待健康分析；仅语法验证，未实机重跑。7项配置/输入/解析测试及相关四文件41项通过；私有health-offline-2026-10-06T12-55-18-591Z保存2份旧trace复核和9组CTE边界SQL/CSV/日志，两份真实旧trace均fail，正常fixture pass、丢失/满/错误fail、缺统计/缺PID/歧义unknown。无ADB/重启/录制/编译状态变化/生产SDK或业务修改；未跑全量产品构建。

2026-10-06 新配置授权首采：完整桌面/CLI/MCP构建通过，私有机械复制device-health-check仅增加跟踪生命周期，隔离桌面先就绪、数据源确认后启动一次；预运行shebang位置语法错误在任何设备调用前停止，修正后只执行一次实机流程。capture-trace-2026-10-06T13-01-27-830Z与device-health-check/2026-10-06T13-01-27-001Z保留全部记录。启动命令13:01:30.779–30.952Z，身份观察后13:01:32.370Z请求，无额外预热/页面导航，但不称零时刻请求。PID1273/Activity/startTicks一致，APK SHA前后不变、主包仍verify；一次外层inspectDevice请求32.025秒失败，内部实际2次尝试：首轮22.399秒/SDK树连续超时（核对树13.454秒），第24.400秒第二轮开始、7.619秒后因视频TextureView移动/隐藏失败。首轮就绪3.336秒、首次焦点2.164秒/树读取1次，次轮就绪1.477秒；不外推实际窗口/第一帧时间。第二轮已处理58项但最终快照0节点/0完整图，28.720秒树预览、30.739秒首图预览不是采集成功。64MiB调度缓冲写62,062,592字节/1MiB身份缓冲写131,072字节，丢弃/覆盖/patch失败均0；1555条systrace解析错误与非标准厂商print数量吻合但未逐条归因，健康门控fail，未宣称性能验收。已闭合DEX14.149ms/Application589.129ms/bindApplication1.739秒仅保留观察，不与trace-only不同工作量配置拼作因果收益；25秒trace不覆盖32秒请求结束。会话自然结束/转发空，隔离桌面退出，未安装/清数据/额外取栈/再次重启或发请求。源码复核探针单次未传IPC、inspectPreferredDevice内循环仍可重试，违反本轮不自动重试预期；不能将其解释为严格单次。下一步先离线贯穿单次契约，不为掩盖失败追加真机请求。生产代码未改。

2026-10-06 单次契约本地修正：device-health-check将--single-attempt作为第四参数传preload/inspect-device IPC，主进程在撤销分享/取消旧请求之前严格检查布尔值，传InspectionOptions.singleAttempt；inspectPreferredDevice首个快照错误后true直接finish，不入整页重试等待，默认/false不变。保留首次有界就绪查询、身份和几何门禁、底层有界读取策略，不宣称所有子查询一次。真实入口隔离ADB fixture验证single首错/尝试1/无第二树或图片请求，省略和false尝试2，首次取消原因保留；新增重试等待取消fixture最初暴露AbortError通用消息，修正为先抛signal.reason后该项通过。7项新增测试、四文件28项回归通过（44.09秒），完整桌面/CLI/MCP构建及diff检查通过，日志/tmp/inspector-single-attempt-tests.log、regression.log、build.log。真实Electron --visual-fixture隔离配置7组IPC检查：省略/false/true样例快照成功，null/字符串/数字/对象拒绝；私有ipc-single-2026-10-06T13-09-49-657Z保存报告/日志，无设备调用，退出通过。生产采集主进程路径已修改，但未重启用户主桌面/手机、未编译手机包/安装/清数据/录制/发真实采集请求，不覆盖旧首采失败，不证明SDK树连续超时或动态页面已修复。下一步先离线定位首轮核对SDK树13.454秒，不自动补跑。

2026-10-06 SDK树超时离线复核：readSdkCapture收到View tree timed out后立即再调用capture，第二次同错才生成“连续超时”；writeTreeFile每次ready.await为3秒。按当前代码路径两次等待至少6秒，但核对SDK树13.454秒还覆盖包检查、窗口/进程核对、会话建立/传输，现有stdout/stderr没有每次调用耗时，不能精确分配剩余7.454秒或认定13.454秒都在主线程。SDK将captureTree投递到主线程；3秒超时没有撤销Runnable/失效标记，也未检查post返回值，可能晚到继续遍历；遍历的1000ms预算在逐节点边界检查，不是强制抢占。已确认代码风险，未证明本轮发生晚到、主线程具体阻塞位置或其耗时；25秒trace无请求级标记且有1555解析错误，不补称完整因果证据。仅更新计划/状态/证据，未改生产代码、调用设备、重启、安装、录制、采集或清数据；后续先补分段证据与超时失效保护，并将严格单次传到读树，不全局删除刷新重试。

2026-10-06 SDK读树超时本地修正：requestSdkTree继承inspectionContext.singleAttempt/取消信号，true首个UI超时即失败，默认/false仍最多2次；其它SDK错误或传输异常不自动重试，取消前后保留原因。上下游超时分类同时识别单次/连续文案，防止新错误被吞掉转成兼容补采。每次capture使用UUID arg，旧SDK仍可忽略，新SDK记录编号/PID；桌面记录包、窗口、PID核对/会话就绪/调用/文件读取耗时，SDK记录任务投递/进入/结束/等待收敛与编码至发布，嵌套耗时不能相加。writeTreeFile改FutureTask.get(3秒)，finally cancel(false)/removeCallbacks：未执行不遍历，已执行晚到结果丢弃且不写文件，不强制中断主线程；post=false明确失败，InterruptedException保留中断位。SDK原方法提取后用JVM队列/View替身编译运行，覆盖排队晚到、执行中晚到、投递失败、中断和失败后新任务恢复；不是Android Looper实机验收。真实inspectHybridDevice入口隔离ADB覆盖single/default/false与UUID、超时不读取旧文件或图片；策略/会话/启动预算相关9文件42项通过。最初桌面类型检查发现CommandResult.code可为null，修正；SDK构建先因默认JVM11、错误SDK路径失败，使用现有JDK21和/opt/homebrew/share/android-commandlinetools后离线构建通过；原方法测试最初Bun默认5秒限制失败，明确20秒测试预算且保持生产3秒等待不变后通过。桌面/CLI/MCP完整构建与SDK assembleDebug通过，日志/tmp/inspector-tree-timeout-{regression,build,sdk-build}.log。无设备调用、业务包构建/安装、用户桌面重启、录制、采集、清数据或提交推送；13.454秒旧证据不能追溯拆分，尚未证明整页速度收益。下一步获授权后更新业务包内SDK并有限真机验证。

2026-10-06 授权部署读树超时修正：设备JNHA45FQBQEIRGEQ在线，业务仓库只保留既有kwai-dependencies.gradle改动，未新增业务源码修改。用现有SDK AAR构建assembleGifmakerDebug，4分12秒成功；私有tree-timeout-device-JYdv9m保留构建、核对、安装日志。新旧签名均d31fddcb…d3e0eb8，Debug标记通过，AAR HierarchyProvider.class与本次编译一致，APK classes59.dex确认FutureTask.get/cancel、Handler.removeCallbacks及新日志标记；新APK SHA9ad31543…05f7a5b，旧6c3fc64f…434c089。adb install -r -t成功，设备实际base.apk摘要与新包一致，未卸载/清数据/手动reset编译状态。新版桌面打包成功，原release/mac-arm64/Android UI Inspector.app移动到私有desktop-before.app可恢复；新app.asar确认分段计时和单次超时代码，桌面主进程59842已打开。启动业务App一次用于进入稳定页，已请求用户切设置主页；稳定页和严格单次冷启动采集尚未执行，不当真机验收。安装自然更换APK可能改变编译/缓存状态，不称与旧verify轮是相同APK单变量对照。私有run-health.mjs准备单次采集与仅InspectorTree日志收集，不自动追加采集、导航或清日志。

2026-10-06 新版有限真机验证：先只读确认仍在播放视频首页，再按可见菜单导航到SettingsActivity设置主页，截图私有保存；未修改设置/账号数据。tree-timeout-device-JYdv9m的stable/cold日志、run记录与validation-summary.json关联两个隔离采集目录。稳定轮device-health-check/2026-10-06T13-40-21-469Z：一次外层请求/一次内部尝试，12.650秒、98节点/71图/0失败、debug-hybrid，PID8896；核对SDK树1.184秒，其中包检查259ms/前窗口334ms/PID62ms/capture66ms/文件81ms/后窗口305ms/PID70ms，会话就绪0ms（嵌套于capture，不相加）。UUID68aec71e-6118-4d70-a63f-04b75c0ea046两端对应，SDK投递至进入6ms/遍历25ms/编码至发布29ms、89195字节，总60ms；说明本轮SDK正常读树很短，不证明冷启动根因/像素正确性或稳定提速，71张画面几何覆盖withoutEvidence仍保留。冷启动轮device-health-check/2026-10-06T13-41-00-262Z：隔离桌面就绪后force-stop/start一次，warm=0/no导航、严格单次；16.705秒失败，一次内部尝试、readiness elapsed16.702秒/phase focus-before、首次观察焦点16.701秒，剩余预算不足1.5秒而停止；0树读取/0图/无预览，SDK日志0字节、未进入SDK，不能验证超时撤销实机故障路径。就绪轮询等待11.019秒、窗口观察3.200秒，缺逐次焦点观测记录，不认定等待全无效或真实窗口在16.7秒才创建。冷轮无桌面stdout文件，汇总标记desktopLogPresent=false，不将缺文件当完整日志证据；初次离线汇总因缺文件失败，修正后两轮断言通过，未追加设备请求。跟踪/日志收集子进程与隔离桌面退出、ADB转发空，未自动补跑/恢复/清数据/改编译状态；主桌面仍打开。下一步先离线审视就绪观测契约并补记录，不自动再次启动采集。

2026-10-06 就绪观测本地收敛：源码确认firstFocusedWindowMs由readiness.focused(beforeFocus)记录，位于checkedDebugTarget完成之后；前轮16.701秒应解释为首次严格核对完成，不能认定首次候选观测或真实窗口创建。未改旧原始记录，当前计划/状态纠正用语。新增可选CaptureReadiness.observations，记录foreground/focus-candidate/focus-confirm-before/after/poll-wait/budget-stop起止、结果、剩余预算、有限component/windowId字段，显式首条+最新63条/总数/丢弃数；未知字段/原始异常/树图/活对象不复制，老快照缺该字段仍接受。候选观察只入诊断，不设置授权focus/放宽读树；循环中原4个最小预算停止点记budget-stop，未读树失败提示改为“尚未开始读取控件树”，不改18秒/500ms/1.5秒规则或增加设备命令。虚拟时钟覆盖候选1000ms但严格核对16701ms、预算1299ms/0读树；错误与取消原对象传播、100条截为64条并记36丢弃、不可变复制/旧记录兼容、非法区间/预算/计数/枚举拒绝。真实inspectDevice隔离ADB fixture检查候选不可用/前后核对/等待记录，保持原查询次数、窗口/Activity变化拒绝和无SDK提前准备。5文件39项回归44.19秒通过；最终校验补强后9项诊断测试再次通过，完整桌面/CLI/MCP构建通过，日志/tmp/inspector-readiness-observation-{regression,tests,build}.log。无手机调用、安装、重启、采集、打包主桌面、提交或推送；主桌面仍上一部署包，不称11.019秒旧等待已分解或新记录真机验收。下一项授权后部署桌面并一次单次冷启动观察。

2026-10-06 授权部署就绪观察并单次实测：readiness-observation-device-36o7OQ保存完整构建/打包、desktop-verification、run、health、SDK日志和summary。旧主桌面PID59842以TERM退出，旧包移动至该私有目录desktop-before.app可恢复；新版app.asar主进程字节与dist-electron/main.cjs完全一致且含focus-candidate/budget-stop，重启主桌面PID73796；完整桌面/CLI/MCP构建与打包通过，未新增生产代码修改。未安装/清数据/改手机编译状态，pm path仍与上轮安装核对路径一致，本轮未重新做APK SHA核对。隔离桌面就绪后一次force-stop/start、warm0/无导航、singleAttempt；一次外层请求/一次内部尝试16.791秒失败，readiness elapsed16.783秒/focus-before，0树/0图/无预览。70条观察保留64条/丢弃6条；保留20次unavailable，最后一次15.531–15.693秒；候选查询16.257–16.457秒match，严格核对16.457–16.783秒match（326ms），budget-stop剩余1217ms，不足1500ms而停止。总timings轮询11035ms/前台1427ms/窗口观察3296ms/核对326ms；保留区间对应10035/1326/3078/326ms，受6条丢弃影响仅部分记录，不能拼作完整总和。SDK日志0字节、0树读取；桌面stdout不存在，汇总明确标记，不将缺文件当充分零调用证据。一次离线汇总校验诊断格式/尝试数通过；日志子进程/隔离桌面已退出，转发空，无自动复测，主桌面仍打开。源码复核unavailable来源包含非主显示、缺字段、不唯一、空焦点、格式错误，现有记录未区分，故不能认定窗口物理创建到16秒才完成或直接修业务初始化；下一步先离线补白名单原因码，不加等待/加快轮询/放宽门禁、不自动再次采集。

2026-10-06 焦点原因分类本地完成：parseFocusedWindowState在原判定分支增加null-focus/non-primary-display/missing-primary-display/missing-focus-field/ambiguous-focus-field/unrecognized-focus-format；成功reasonCode=null。readDebugFocus以类型化FocusUnavailableError保留原中文提示与拒绝规则，候选及前后严格核对记录可选focusReason；传输/其他异常仍为error，不靠字符串前缀分类。诊断仅复制白名单标量，不保存原始dump/异常；旧unavailable无原因仍接受且不推断null。解析六分支、保存JSON往返、原异常对象、非法原因/类型/观察类别与结果错配，以及真实入口fixture空焦点分类和原命令次数回归通过：6文件46项，44.80秒；完整桌面/CLI/MCP构建通过，日志/tmp/inspector-focus-reason-{tests,build}.log。未操作手机、安装、重启、采集、替换主桌面或提交推送。500ms轮询/18秒预算/1.5秒最小查询及身份门禁不变；旧16.791秒记录无法追溯补原因，诊断完善不是启动耗时修复。下一项另获同意后部署桌面并一次严格单次冷启动分类取证。

2026-10-06 焦点原因码授权部署/单次实机：私有目录.benchmarks/focus-reason-device-t1EBJ2保存构建/打包日志、desktop-verification、run、health、sdk.log及summary。旧主桌面PID73796以TERM退出，旧包移动至desktop-before.app可恢复；新包主进程字节等于当前构建且含原因码标记，主桌面PID83087保持打开。macOS签名/公证未做，不是正式发布验收。一次force-stop/start、warm0、singleAttempt，1外层/1内部尝试16.968秒失败（capture16.960秒）；70条保留64/丢弃6，保留21次候选均null-focus，首条保留候选2.087–2.178秒，末条16.292–16.459秒；无match候选或严格核对、firstFocusedWindowMs=null、0树/0图、SDK日志0字节。16.459–16.960秒轮询后剩余1040ms，最小预算1500ms门禁停止，未开始树/SDK。总轮询11520ms/窗口3229ms/前台1452ms；保留区间10520/3034/1370ms，不拼作全量。只证明保留查询的系统焦点为空，不认定窗口物理创建/主线程具体阻塞或SDK初始化成本，丢弃部分未知。pm path仍与上轮一致，本轮未重新核对APK SHA；未安装/清数据/编译reset/补跑。离线诊断格式/尝试数校验通过；自有日志及隔离进程退出、转发空。健康报告.benchmarks/device-health-check/2026-10-06T14-08-47-386Z。下一步离线收敛已有启动阶段/栈及源码，提出最小验证方案，不再重复同类焦点轮询。

2026-10-06 启动源码/证据离线收敛：私有startup-analysis/2026-10-06-source-review/followup-review.md保存完整版本矩阵/路径和最小验证方案。业务HEAD94f80eb1b且只有既有Gradle改动。复核网络init/wait均static synchronized：等待可能先在监视器，失败置位后也可能在未释放latch；submit未读Future，仍仅静态风险。启动屏障委托外部依赖；HomeActivity super在setContentView前，旧13.065秒栈命中代理生成但32帧截断/无持续耗时；SDK生命周期无主动取树，不排除初始化成本。旧13:01 trace（6c3旧包）DEX14.149ms/makeApplication589.129ms/bindApplication1.739秒、1555解析错误，不能将各轮失败都归为DEX/Application。新包本机SHA仍9ad31543…f7a5b；90个DEX全defN，展开688284792/压缩264402491字节，与旧包不同。仅复用13:36安装SHA核对和后续路径记录，本轮无设备SHA/dexopt查询；旧verify状态不能外推新安装包。未修改业务/SDK/桌面逻辑，无ADB/重启/安装/采集/取栈/录制。下一项只读核对当前设备身份及编译状态，不compile/reset或追加相同冷启动轮询。

2026-10-06 当前包身份与dexopt只读核对：私有.benchmarks/package-state-yjorXm保存check.mjs、含查询起止/原文的report.json、package.txt及summary.json。设备在线；pm path/SHA各查前后一次，路径稳定、设备SHA前后及本机SHA均9ad315439dccf8daa77cd301df71ec722bb04ec227a85083fd82ce98605f7a5b，与13:36安装核对/构建产物一致。versionCode99999/versionName14.9.10.99999，flags含DEBUGGABLE。package.txt第4156–4166行主包arm64 status=run-from-apk/reason=unknown/primary-abi，location is error、base APK odex file size=null；次级ks_webview为verify/bg-dexopt但不混作主包状态。保存诊断的身份/主包状态断言通过，原文与提取结果人工对齐；本轮未重新拉APK，不声称旧采集时SHA已核验。时间2026-10-06T14:17:32.857Z，观察不是启动耗时或因果证据。未重启、安装、清数据、采集、compile/reset、调试暂停或改生产代码。本轮核对确认旧verify结论不适用于当前包，下一项另获同意后一次同包verify、实际完成/身份门控及单次冷启动对照，超时保留且不重提交。

2026-10-06 当前同包verify授权对照：私有.benchmarks/current-verify-UCVnEO保存verify-report原文/起止、run、health、SDK日志与summary。前查SHA9ad31543…f7a5b、主包run-from-apk/unknown；compile -m verify --primary-dex只提交一次，14:19:55.262Z至14:20:40.266Z本机45秒超时（SIGTERM为ADB子进程，不杀设备dex2oat）。14:20:54只读确认目标dex2oat64仍运行，未重提交；14:22:15.606Z确认无目标编译进程、主包verify/cmdline、无location error、base.odex4209Kb/base.vdex683344Kb、SHA不变，才允许14:22:40.394Z一次冷采。首次状态摘要的odex空值误跨行读成Compiler stats已修私有解析（不覆盖旧原文），空字段/文字null/正常大小3项本地断言通过。采集输出.benchmarks/device-health-check/2026-10-06T14-22-40-482Z。1外层/1整页尝试22.087秒失败/capture22.080秒；37条观察无丢弃，11次null-focus，候选8.582–8.744秒、严格核对8.744–9.032秒，系统树9.033–10.128秒一次、复核10.132–10.484秒相同窗口，ready10.485秒。随后核对SDK11329ms失败，0有效树/0图，PID26114仅SDK日志可见，失败快照debugProcessId为null不能补称已完整绑定。SDK日志两条posted/settled差3021/3001ms且entered/ended=-1；后一条capture UUID=dcdc9ed4-1a97-4cba-a02f-ab0453b9b81c，前条无UUID，不能补称同一请求或已证明回退归属。源码显示capture-visible withTree调用writeTreeFile异常仅tree=failed，missing回调可进入classic取树；为下步本机fixture验证对象，不立即修改或称主线程阻塞原因已证。14:23:54后查包SHA/verify状态仍一致，保存诊断及1次compile/1整页尝试校验通过；日志/隔离进程退出、转发空。无安装/清数据/reset/录trace/调试暂停/自动补跑，主桌面未重启。窗口较早可用仅单轮线索，缓存/调度未控制，整页仍失败且总耗时更长，不称稳定性能或因果收益。下一步离线收敛合并失败/classic回退的超时契约，不增加UI等待或继续压力轮。

2026-10-06 合并树失败回退本地修正：新增测试先在旧settleSdkMergedTree失败（缺少reject，仍read/classic），日志/tmp/inspector-merged-tree-before.log。生产settle新增完成回复检查，captureSdkVisibleLayers在缺失文件/onMissing之前拒绝已知UI中断和新SDK绑定nonce/已知实例的treeFailure；树阶段错误不再伪装missing，错误释放treeReady并停止classic，外层保留UI失败，不落到DDMS补采。旧SDK缺合并能力/非UI失败兼容保留；晚到正常树仍采用原身份/几何校验，不放宽。新SDKcaptureVisible合并树3秒超时/队列不可用/中断直接返回treeFailure及nonce/实例，不再选层/绘图，并增加merged-tree请求nonce起止日志；writeTreeFile取消/晚到丢弃和预算不变。75项5文件相关测试通过12.92秒，31项6文件回归通过45.05秒，完整桌面/CLI/MCP与SDK离线assembleDebug构建通过（JDK21）。Java生产前缀替身6组检查、实际读树方法替身5组不等于AndroidLooper/完整IPC验收；没有确认旧真机无nonce首条任务归属，不把本机复现当设备因果证据。日志/tmp/inspector-merged-tree-{tests,regression,build,sdk-build}.log。未操作手机、重启、安装、取图、compile/reset、修改业务、更新运行桌面或提交推送；SDK AAR仅本机构建更新。下一项先新版独立样例可控排队超时/同进程恢复，业务包部署另需同意，不宣称业务主线程繁忙或冷启动采集已解决。

2026-10-06 合并树故障样例与部署：增加Debug-only单次MergedTreeFailureProbe及主机脚本，不给正式SDK增加故障开关。样例同签名b580ff94…527b保留数据覆盖成功；一次真实主线程闩锁阻塞、内部captureVisible(withTree)在3002ms返回ui-timeout/nonce/实例，日志仅一个entered=-1任务；释放后同PID30901/同实例恢复tree=ok/result=ok/count=9。失败Bundle重建为桌面解析输入，生产settle/check guard树文件读取0、classic回退0；不是完整IPC故障注入，未实测队列不可用/中断。原文.benchmarks/merged-tree-device-DZReQK。随后正式工作台IPC隔离入口reuse-app/single-attempt通过5.142秒、capture4.826秒、15节点/9图/0失败、1次尝试、PID30901不变；小树实际DDMS/JDWP取图，不冒称SDK图片链路。报告.benchmarks/device-health-check/2026-10-06T14-40-57-053Z，自有隔离进程结束/转发为空。66项2文件定向测试、完整桌面/CLI/MCP构建及sample assembleDebug通过。主桌面已重包打开PID6817，asar主入口与当前构建字节一致；旧桌面可从.benchmarks/merged-desktop-eS4YcR/desktop-before.app恢复。签名关闭的目录包不是正式发布验收。业务仅只读状态，既有Gradle改动不变；无业务安装/重启/compile/reset/清数据，未提交推送。下一项业务同签名更新及稳定页验证另获同意，22.087秒冷采失败仍保留。

2026-10-06 授权业务部署合并树失败修正：沿用既有Debug-only inspectorSdkAar接入，无新增业务源码改动。第一轮构建5m8s因GC overhead limit exceeded失败，保留business-build.log；独立进程16GB/G1/4-worker命令参数重试4m32s成功，不改工程内存配置。私有.benchmarks/merged-tree-install保存旧业务APK、构建/核验/安装日志和脚本；AAR HierarchyProvider.class逐字匹配编译class，APK classes59.dex含treeFailure/ui-timeout/ui-unavailable/interrupted/merged-tree日志，Debug且无样例类。新旧签名d31fddcb…d3e0eb8一致；新APK SHA c2785d0719fdfd4a82099fce2ec86b39d1400d4e3d36ed511790b2d7d29acfd0，与安装后实际base.apk摘要相同；旧9ad31543…f7a5b已保留。adb install -r -t成功，无卸载/清数据/compile/reset。打开HomeActivity一次，查询已为该Activity主窗口；未测启动用时，也不能继承旧包verify状态。等待用户进入设置主页后一次正式稳定采集，未调用Provider或开始采集，不当验收完成。业务git仅原kwai-dependencies.gradle改动，未提交推送。

2026-10-06 新业务包稳定设置页验收：开始时当前focus=null，复查KwaiRnActivity，截图为“我的钱包”；仅发送一次返回后截图确认设置主页，生产窗口门禁匹配SettingsActivity，未操作钱包功能或设置值。一次reuse-app/single-attempt正式入口成功，健康总耗时11466ms/capture11063ms，98节点/74可见/71图/0失败，1整页尝试/无警告/无内部重试；SDK日志与采集PID1845一致，进程cmdline仍主包。SDK树任务posted120240467/entered120240468/ended120240494/settled120240495，后发布89186字节；不是合并树故障注入。小树图片走DDMS/JDWP，DDMS首包3253ms/批量3342ms、JDWP初始化2357ms、补齐4264ms，嵌套不相加；不是全SDK取图或严格像素验收。完整报告.benchmarks/device-health-check/2026-10-06T15-01-30-254Z，配对SDK日志/请求参数/摘要在.benchmarks/merged-tree-install/business-stable-*。退出code0、自有日志及隔离进程结束、ADB转发空。无重启/安装/清数据/compile/reset/连续补跑，未改业务源码或推送；没有本轮APK再查SHA，不补称采集时字节重新核对。下一项只读复核兼容等待与补图范围，旧22.087秒冷采失败保留，单轮稳定成功不能外推冷启动修复或因果提速。

2026-10-06 兼容取图初始化分段：源码未发现固定sleep；原setupMs覆盖握手、ID、主线程、安全断点、元信息和窗口核对，不能称连接耗时。生产captureViewBitmaps增加6个计时及本连接初始化/线程名称请求计数，adb转存标量；不改JDWP命令顺序/暂停恢复、15秒截止或身份/软件安全门禁。65项view-debug测试及完整构建通过。一次reuse-app/single-attempt正式设置页成功，输出.benchmarks/device-health-check/2026-10-06T15-05-53-274Z（主机日志/tmp/inspector-jdwp-setup-device.log），10418ms/capture10023ms、98节点/74可见/71图/0失败、无警告、PID1845/1次尝试；初始化1259ms，握手2/ID15/主线程8/安全边界216/类方法992/窗口27ms，未四舍五入部分和本地函数建立时间不能强称严格和相等；DDMS首包2084ms。原轮11.466秒不是受控AB，不宣称提速。线程/初始化请求计数未被当前探针白名单输出，本轮不补猜数字。无重启/安装/清数据/compile或额外补跑，自有隔离退出且forward空，主桌面未重包。后续计数阶段用独立完成标记而非rounded setupMs==0，防亚毫秒初始化误计入后续命令；该计数微修正只离线回归，不额外压力复测。下一项本机验证元信息查询往返的可优化性，不跳安全边界、不跨进程缓存JDWP ID。

2026-10-06 JDWP只读元信息有界批量：依据Oracle JDWP规范异步请求/编号匹配，仅5个已加载类查询及3个方法表查询分别合并一次发送；原ClassLoader歧义判定、方法解析和本连接缓存不变。新增requestJdwpMetadataBatch单读取器/最多8个唯一编号，只白名单1/2、2/5；按ID恢复请求顺序、保留事件，错误回复全部读完再抛出，以便原Dispose收尾。未批量暂停/恢复/绘图/对象pin，不跨进程缓存，无新增等待预算。4项协议fixture加65项原补图回归全部通过5.62秒，完整构建通过。一次设置页reuse-app/single-attempt正式入口10.464秒/capture10.038秒、98节点/74可见/71图/0失败/无警告/1次尝试/PID1845；元信息754ms、初始化1025ms、安全边界231ms、握手3ms；DDMS首包2662ms/批量2751ms。原诊断轮10.418秒、元信息992ms，未控调度/顺序/缓存，不称整体或稳定因果提速。输出.benchmarks/device-health-check/2026-10-06T15-11-06-044Z；/tmp/inspector-jdwp-batch-{tests,build,device}.log保留。采集仅证明覆盖量，不是逐像素对照。隔离进程结束/转发空，无重启/安装/清数据/compile/补跑，主桌面未重包。下一项固定条件原路径/批量对照和取消恢复验收后再决定部署。规范：https://docs.oracle.com/en/java/javase/21/docs/specs/jdwp/jdwp-spec.html。

2026-10-06 JDWP元信息ABBA与取消恢复：新增scripts/jdwp-metadata-compare.ts仅稳定设置页/3个原生文字叶节点，后台树前后PID/startTicks/实例/根/对象/几何门控，已授权页面无导航/重启/安装/清数据。每轮新连接，target.metadataBatch false/true/true/false；元信息770.410/739.429/746.133/785.253ms，初始化2186/2135/2161/2212ms，每轮24初始化请求。A均值元信息777.832ms/初始化2199ms/完整后端2970.075ms，B742.781/2148/2944.961ms，仅两轮每模式，设备调度/缓存未隔离，不称稳定或整页因果收益。12图及恢复3图尺寸、类型、空值与解压无滤波RGBA摘要精确一致；范围不含整页DDMS图。一次300ms定时取消在1424.698ms返回原用户原因，具体请求阶段未建立，不冒称metadata-inflight真机覆盖；随后SDK树可读、相同PID/实例/对象/几何，3图恢复精确一致，初始化请求24。原文/PNG.benchmarks/jdwp-metadata-compare-H5wEko/report.json，主机日志/tmp/inspector-jdwp-abba-device.log。协议fixture另加在批已发送/回复未完成时取消并保留原因、新读取器恢复；正式补图模拟明确对照true与false的图片/失败/请求数相等。收益小，决定产品默认恢复串行，批量仅显式测试入口，不更换主桌面或业务APK；原先仅开发默认批量的历史不抹掉。自有forward已清理。下一项不追加小收益微测，转查整页DDMS首包及实际候选请求范围。

2026-10-06 DDMS首包与补图候选：AOSP Android14 DdmHandleViewDebug.captureLayers先写ByteArrayOutputStream再返回Chunk，ViewDebug逐层performViewCapture/PNG压缩；“等待首包”混合设备调度/绘图/编码，不能只归因网络或细拆设备CPU。新增健康报告白名单DDMS批字节/层/图、JDWP初始化请求和SDK类型避免数。第一轮只增加继承链筛选，实际10.156秒/capture9.817秒、98节点/71图/0失败/1次尝试，候选仍64/避免0，首包2589ms、定位1376ms；.benchmarks/device-health-check/2026-10-06T15-26-30-967Z，/tmp/inspector-sdk-type-device.log。随后发现小树SDK核对虽成功，但只提前复制唤醒/窗口能力，完整继承链取图结束才合并；在成功join之后按同ref/类复制类型/实例证据，不改树/图片/flags，最终join身份与几何复核仍保留。只有captured非SKIP_DRAW普通继承链才免类型识别；SurfaceView/TextureView及子类、缺图/错误/缺失链保留原查找。最终同PID1845设置页单轮9.246秒/capture8.881秒、98节点/74可见/71图/0失败/无警告/1次尝试；候选3/避免61/实际补图1/跳过2，初始化24请求，定位108ms、补齐1999ms、首包3039ms；DDMS93图/198257字节（最终屏内有效图71，两个数含义不同），接收包体取整0ms。输出.benchmarks/device-health-check/2026-10-06T15-28-52-157Z，/tmp/inspector-sdk-type-device-final.log。74项3文件回归5.64秒及完整构建/diff检查通过。两个完整采集之间修正数据接入，非受控AB，不宣称稳定因果/逐像素/跨机型收益；未重启/安装/清数据/compile，PID仍1845、自有forward空，主桌面未重包。下一项用现有显式选项比较小树SDK渐进路径与DDMS，再决定门槛，不直接默认切换。

2026-10-06 小树DDMS/SDK路线：新增small-page-route-probe.ts固定业务设置主页，前后Activity所属PID/startTicks核对，生产inspectPreferredDevice preferVisibleSdk false/true各一次、singleAttempt/startupRetry关闭/allowAppRestart关闭/30秒外层上限，超过15秒或失败/缺图/回退停止。输出.benchmarks/small-page-routes-hxEYtJ，原始快照/报告及/tmp/inspector-small-page-routes.log。DDMS9507ms、树2337ms/首图7047ms(70图)，SDK5245ms、树3185ms/首批3600ms(47图)/下一批4231ms(70图)，最终均98节点/71图/0失败/1次尝试，同PID1845/SDK实例/根、无兼容回退。DDMS首包3427ms/补齐2025ms；SDK设备绘制743ms/编码716ms/设备总1434ms/补齐276ms，阶段有包含和并行关系，不相加作总耗时。按ref核对无对象/几何/尺寸缺失，71张编码摘要全部不同（PNG与无损WebP格式不同，不能直接当像素差）。离线small-page-route-pixels.ts ffprobe/ffmpeg解码71对：48对RGBA精确一致，23对合计210像素RGB差1、alpha全一致；保存pixel-comparison.json及/tmp/inspector-small-page-pixels.log。第一次离线工具只接受PNG拒绝WebP，未产生合格报告；修正支持两个已知格式后完成，无额外手机采集。SwipeLayout全透明父层RGBA相同但DDMS/JDWP empty=true、SDK补图empty=false，标记语义需核对。75项4文件回归/完整构建通过；只各一路一次、不宣称稳定性能或同帧精度，未调整200节点门槛，未继续取消/恢复压力验证。无导航/重启/安装/清数据/主桌面更新，provider会话收尾/自有forward空，PID1845保持。下一项独立样例同位图编码对照及empty来源，之后才补取消恢复与换序准入。

2026-10-06 编码/空图根因：isEmptyBitmap原先>100万像素直接false，实际业务SwipeLayout1080×2400超限，解释全透明图标非空。修正至现有400万像素预算逐行检查，硬件图CPU副本及时回收，超限/不可读明确异常而非false；capture-refs逐控件捕获该异常、释放原图/删除该图geometry并记录失败，不中断其他成功图。实际函数JVM替身覆盖大图/末像素alpha1/400万边界/超限/硬件CPU副本/失败回收/空copy/不可读。样例SnapshotEncodingProbe增加token和实际扫描验证，已有同位图编码前后getPixels精确一致门禁；新增sdk-encoding-alpha-probe.ts使用新token读报告，9组原RGBA及PNG/WebP由ffmpeg解码核对。仅sample-app保留数据install-r-t成功，业务未重建/安装/重启，完成后回设置主页，业务PID1845保持。第一次主机断言误要求色板immutable=true，实际色板为可变创建但编码前后相同，保留失败.benchmarks/encoding-alpha-OShk71及/tmp/inspector-encoding-alpha-device.log；修正只对文字CPU副本要求immutable，按同token只读已生成文件，不再次绘图，合格报告.benchmarks/encoding-alpha-AVBrDT和/tmp/inspector-encoding-alpha-existing.log。9组WebP与原RGBA全部相同，PNG文字/软件文字每轮19像素差1、色板8像素差1，alpha和8位预乘RGB均同；样例空白扫描64ms、blank=true、faintLastPixelEmpty=false。离线原业务71对再次计算预乘RGB，210个straight RGB差异全部8位预乘相同，报告原目录pixel-comparison.json及/tmp/inspector-route-premultiplied.log；支持编码解释、不证明同帧或全部业务绘制一致，不人为改色。76项5文件回归/SDK及样例构建/完整桌面构建通过，日志/tmp/inspector-alpha-tests-final.log、/tmp/inspector-encoding-alpha-build-final.log、/tmp/inspector-alpha-build-final.log。最后逐控件失败收尾仅本地构建，未故障注入真机；业务SDK/主桌面仍旧版，门槛不变，无追加业务采集/取消压力循环。下一步业务同签名保留数据更新后复核empty，再做SDK小树取消恢复和换序准入。

2026-10-07 业务新版空图与取消恢复：业务包4分27秒构建，Debug/相同签名、AAR类与实际classes59.dex的400万扫描/未知失败分支核对通过；install-r-t保留数据成功，设备与本机APK SHA一致。私有验证在.benchmarks/alpha-business-update/，不提交业务APK/DEX/图片。用户进入设置主页后，第一轮8.807秒/98节点/71图，大SwipeLayout empty和解码alpha通过，但探针把正常复用的provider转发误判为泄漏，.benchmarks/sdk-small-recovery-AuMtY3和/tmp/inspector-sdk-small-recovery-device.log保留，未进入取消。改为显式关闭后核对、7项只读/会话回归通过。第二轮基线6.124秒、恢复5.571秒，取消20ms返回，三次main count0、同PID/实例/根/图像与几何一致，报告passed=true但进程exit1：首图预览回调取消后仍启动并行finalScreen，后续补图在取消处抛错，使截图Promise没有被等待，产生未处理拒绝。该轮不算完整通过，.benchmarks/sdk-small-recovery-xtAWZi与/tmp/inspector-sdk-small-recovery-device-corrected.log保留。

生产修正：预览回调后立即检查取消、不启动新截图；并行finalScreen立即注册拒绝观察，但原Promise仍向最终await返回原错误，不吞取消。tests/capture-preview-cancel.test.ts转译执行实际生产边界，覆盖预览取消不调截图及并行拒绝保留原因；76项5文件相关回归通过。第一次构建发现测试使用未配置Bun类型，改用既有TypeScript转译后两项测试与完整构建通过，日志/tmp/inspector-preview-cancel-{tests,build}.log。最终仅再验证一次完整基线→取消→恢复，.benchmarks/sdk-small-recovery-GfkvdB与/tmp/inspector-sdk-small-recovery-device-final.log：基线5870ms/恢复5868ms，均98节点/71图/0失败/1次尝试/无警告与SDK回退；大父层1080×2400 empty=true且所有解码alpha0，同PID17287/startTicks12342613/SDK实例/根，恢复ref/几何/状态/编码摘要一致。首图预览4976.36ms到达，取消13ms返回、后续预览0，前/取消后/恢复后主线程暂停计数均0；仅只读JDWP命令、不暂停取栈。报告passed=true、exit0，自有转发空。取消发生在预览回调，不宣称SDK设备绘图inflight。测试未重启/清数据/导航业务App，未改默认200节点门槛或重包主桌面；单页结果不外推冷启动或稳定性能。下一项换序路线对照，旧失败全部保留。

2026-10-07 小树整页ABBA：small-page-route-probe增加显式--order=ddms-first/sdk-first/abba，默认两轮保留；所有轮次独立编号保存，报告passed仅覆盖/健康、pixelAcceptance明确待离线。失败/警告/15秒健康上限、30秒外层、整页一次尝试/禁止重启、Activity所属PID/startTicks/SDK实例/根、结构与空图状态、DDMS实际批层及SDK无回退门禁；每轮显式关闭provider再核对自有转发，不将有意复用称泄漏。新增摘要边界测试第一次发现bounds/size引用使原地修改污染基线，失败保留于该轮工具输出；已改复制标量对象，9项4文件定向测试通过（/tmp/inspector-route-abba-tests.log），完整构建通过（/tmp/inspector-route-abba-build-final.log）。不改生产默认路线/预算。

手机原有设置主页只读确认后一次四轮，.benchmarks/small-page-routes-59DO3L/report.json及逐轮完整快照，/tmp/inspector-route-abba-device.log：DDMS7732ms→SDK4955ms→SDK5030ms→DDMS7365ms；树预览2077/3531/3607/2161ms，首图5357/4127/4177/5034ms（每次70图），最终各98节点/71图/0失败/无警告/1次尝试、同PID17287/startTicks12342613/SDK实例/根，SDK没有回退，DDMS有批量记录。每轮连接显式关闭、进程exit0，最终forward空。DDMS/SDK完整均值7548.5/4992.5ms，本轮SDK少33.86%；首图均值5195.5/4152ms、少20.08%，但树预览2119/3569ms晚1450ms。样本各2次，缓存/调度/模式效应未彻底分离，不称稳定因果或跨机型提速；日志阶段包含/并行不相加。

只用已存快照两组离线ffprobe/ffmpeg（pair-1为轮1/2，pair-2为轮4/3），报告各pair目录pixel-comparison.json，日志/tmp/inspector-route-abba-pixels-{1,2}.log；两组各71对、48对RGBA完全一致，另23对共210像素RGB差1，alpha差0、8位预乘RGB差0、尺寸/empty差0。按ref核对同路线轮1/4、2/3的编码摘要/对象/几何/状态全部无差；不称不同时间同帧或严格RGBA无差。采集无导航/重启/安装/清数据/compile/业务故障注入，未额外追加手机压力测试或更新主桌面。结论：SDK完整和首图有优势，但先解决树预览变晚；下一项只读核对合并树发布/轮询/身份核对与预览顺序，再用已校验树提前显示，不通过更密轮询/加预算/放宽校验获得假提速。200节点默认门槛保持。

2026-10-07 SDK树预览重复核对：源码确认acceptMergedTree先checkedDebugTarget并与捕获开始的组件/windowId/PID比较，随后prefetched采用又重复checkedDebugTarget/singleAppPid。改为内部CheckedSdkTreeIdentity仅同一调用传递serial/package/PID/component/windowId，采用前仍核对与捕获root绑定并检查取消；无证据保留旧查询，后续最终join/前台/几何校验不变。sdk-tree-identity-reused仅诊断，不缓存、不作为后续授权。tests/sdk-tree-identity-reuse转译执行真实接受/采用分支，覆盖匹配证据无重复查询、缺证据旧检查、跨设备/包/PID/组件/空窗口拒绝、取消原原因、创建证据前窗口/PID变化不调用采用；与view-debug/sdk-hybrid/preview-cancel共75项通过，完整构建通过（/tmp/inspector-tree-preview-{tests-final,build-final}.log）。未修改SDK或业务包，不提高轮询频率、放宽几何门禁或改预算。

同一设置主页单次SDK→DDMS生产路线，.benchmarks/small-page-routes-trw1H2，/tmp/inspector-tree-preview-device.log：SDK4845ms/树3349ms/首图4008ms，DDMS7119ms/树2126ms/首图4746ms，均98节点/71图/0失败/无警告/整页1次尝试，SDK身份复用标记true、无回退，同PID17287/startTicks12342613/实例/根，每轮会话清理、exit0。相对旧SDK ABBA树均值3569ms只有220ms小变化，不是受控新旧因果收益，SDK树仍较晚。只读离线71对PNG/WebP解码：48对全RGBA一致、23对共210像素RGB差1，alpha/8位预乘RGB/empty均无差，/tmp/inspector-tree-preview-pixels.log及目录pixel-comparison.json；没有追加手机取图以筛选像素结果。

随后一次完整基线→首图预览取消→恢复，.benchmarks/sdk-small-recovery-XmDdtu、/tmp/inspector-tree-preview-recovery.log：基线4891ms、恢复4982ms，均98节点/71图，大父层empty=true且alpha全0，复用标记true；同PID/startTicks/实例/根和恢复编码摘要/几何/状态一致。首图预览3658.80ms，取消13ms返回、后续预览0，三次只读主线程暂停计数0，exit0/forward空。没有重启、导航、安装、清数据或故障注入，不称设备绘图中取消、冷启动或稳定跨机型验收。主桌面未替换。原始活动dump只有有限几何，不能提前当完整SDK几何显示；下步计划现有会话可选tree-ready通知按nonce/实例绑定，事件与最终回复分流、晚到取消保护、原树/窗口校验及旧SDK轮询兼容先fixture后部署。该通知尚未实现，树先显示目标仅部分改善，不宣称已解决全部等待。

2026-10-07 可选tree-ready会话通知：SDK socket dispatch只在capture-visible且withTree/treeReadyEvents均true时设置线程局部writer，finally remove；原子树发布和VisibleTreeGuard创建成功后发Event行（nonce/UUID实例/PID），再选层/绘制，最终Result格式不变。通知写失败只记录、不误标已发布树失败，非socket/content和旧客户端无事件。桌面request waiter分流Event，最多处理8条/1024字符/1次有效通知，校验method/扩展/nonce/正整数PID/UUID；事件不移除最终waiter，不重置期限，取消/迟到/重复/错误忽略。capture-visible只接受本进程事件，通知唤醒原600ms循环内的树读取，仍读nonce文件/核对树实例/原窗口与PID；实例不符SdkMergedTreeFailure停止兼容重抓。旧SDK无事件照常轮询，不改变阈值、预算或SDK树最终join。

真实TCP/模拟ADB夹具增加事件分片、错误nonce、重复和延后最终回复；请求单测覆盖过期/超限、无事件旧回复、超时不延长、取消晚到；实际accept/采用分支验证实例错配不得回退。Java替身执行生产notifyTreeReady及socket dispatch片段，检查旧请求/content行为边界、通知身份、成功/异常释放writer、通知IO失败；合并前缀真实方法另验证未发布树不通知。84项7文件通过，/tmp/inspector-tree-ready-tests-final.log；完整桌面构建通过/tmp/inspector-tree-ready-build-final.log。首次Android构建因环境默认JDK11被Gradle17+要求拒绝，失败/tmp/inspector-tree-ready-android.log保留；改用本机已有JDK21（未安装依赖），SDK AAR与sample Debug构建7秒通过/tmp/inspector-tree-ready-android-final.log。构建/夹具不是Android新通知真机验收。

业务包不重建/安装/启动、不更换主桌面，只用仍在设置主页的旧SDK验证兼容：.benchmarks/sdk-small-recovery-AWEdXO，/tmp/inspector-tree-ready-legacy-device.log，基线5192ms/恢复4973ms，均98节点/71图/0失败/1次尝试/无回退，大父层empty与alpha全0一致，恢复编码摘要/对象/几何/状态一致。同PID17287/startTicks12342613/实例/根；首图回调4037.32ms、取消19ms返回、后续预览0，三次main只读暂停计数0；exit0/forward空。sdk-tree-ready-event均缺失，是旧SDK预期，不能据此宣称新通知有效或树变快。下一项同签名保留数据更新业务SDK后验证通知实际收到、树/首图/完整耗时与取消恢复；不自动卸载/清数据，不用旧记录替代新部署验收。

2026-10-07 tree-ready 新 SDK 部署：业务 Debug 构建4分4秒成功；安装前核对 Debug 标志、同一签名、当前 AAR 与实际 APK DEX 中的通知代码，保留旧包备份。通过覆盖安装保留数据，安装后手机 APK 摘要与核验的新包一致。没有卸载、清数据或替换主桌面程序。私有部署证据在忽略目录 .benchmarks/tree-ready-business-update-eG7IHL/，不提交业务 APK、DEX 或截图。

本轮相关回归89项通过，增加通知接收耗时和实际唤醒诊断后13项定向回归与完整构建通过。恢复探针新增 --require-tree-ready：要求基线和恢复都收到并采用经过身份核验的通知，记录树/首图预览时间；收到通知与实际唤醒分开记录，不以标记代替因果提速证明。安装后只打开首页，尚未完成新版稳定页面验收；旧 SDK 的5.192/4.973秒不能作为新版结果。下一步只在设置主页做一次基线→首图取消→恢复，失败保存后停止，不重复施压。最新只读检查显示实际前台为 HomeActivity；窗口列表另有旧 SettingsActivity 记录，不能仅凭其中一条窗口记录误判页面已就绪。

2026-10-07 新通知真机验收：按用户继续指令直接打开 SettingsActivity，核对实际 resumed Activity 和焦点均为设置主页后，仅执行一次 --require-tree-ready 基线→首图预览取消→恢复。报告 .benchmarks/sdk-small-recovery-mhpKlS/report.json、完整快照及 /tmp/inspector-tree-ready-new-device.log，passed=true/exit0。基线8362ms，树4990ms、首图6772ms（47图），下一预览7413ms（70图）；恢复5907ms，树3759ms、首图5010ms（70图）。两次98节点/71图/0失败/1次尝试/无警告或SDK回退，sdk-tree-ready-event/wake均true；通知相对合并调用起点1735/979ms，不能与整页起点的树预览直接相减。

首图取消发生于4907.35ms的真实预览回调，22ms返回，后续预览0；不是设备绘制inflight取消。三次只读JDWP主线程暂停计数0，同PID15788/startTicks15919466/SDK实例/根，恢复对象/几何/状态/编码摘要一致；1080×2400 SwipeLayout empty=true且解码alpha全0，不冒称全部图跨版本像素对照。会话显式关闭，最终forward空。无重启、清数据、安装或追加压力测试，主桌面未替换。本轮证明通知和取消恢复有效，不证明稳定性能收益或冷启动修复；下一项只读拆分通知到树预览之间的剩余等待。

2026-10-07 通知后等待拆分：生产代码只增加固定标量计时，不加设备查询、不改控制流/预算/身份或最终几何门禁。记录合并树文件读取累计（含通知前空轮询）、身份核对、采用回调、同调用起点通知/采用时刻，以及采用后截图等待与预览前台核验。转译执行实际 accept 分支验证实例错配不产生成功计时、正常标量合法；17项6文件回归、完整构建通过，/tmp/inspector-tree-wait-timing-{tests,build}.log。

确认仍在设置主页后，仅一次30秒外层/15秒健康上限/严格单次采集，报告 .benchmarks/tree-wait-timing-r5DToA/report.json、日志 /tmp/inspector-tree-wait-timing-device.log：exit0、5.296秒、98节点/无错误警告/1次尝试，通知收到且wake=true。树预览3.300秒、首图4.439秒；合并调用内通知880ms、采用完成1250ms，差370ms；身份核对290ms、采用回调7ms，树文件累计148ms不能全归通知后。采用后截图等待0ms，预览前台核验53ms。显式关闭连接、forward空，无安装/重启/清数据或追加循环，主桌面未替换。该单次不重复做像素/取消恢复验收，也不与上轮拼作提速。源码发现多进程 singleAppPid 可复用本次刚核验的 target 避免重复窗口查询，尚未实施；通知前发布/前置读树仍占较大时间，不能归因于通知失效。

2026-10-07 合并树多进程核对去重：acceptMergedTree 在本次 checkedDebugTarget 成功且窗口/组件仍匹配后，将同一个 current 传给 singleAppPid；不缓存、不改其他入口。仍查询 pidof，多进程按当前 Activity 实例选择所属PID，最终 join/窗口/几何校验不变。实际查询夹具多进程复用5→2次，缺证据仍5次，错包0查询、切换实例拒绝；生产accept片段验证传入的是本次对象、窗口/组件变化不查询PID、PID变化拒绝、查询中取消保持原原因且不采用/不写成功计时。88项8文件通过、完整构建通过，/tmp/inspector-merged-target-reuse-{tests,build}.log。

保持设置页后仅一次 --require-tree-ready 基线→真实首图回调取消→恢复，.benchmarks/sdk-small-recovery-UlxIUl/report.json、完整快照及 /tmp/inspector-merged-target-reuse-device.log：passed=true/exit0，5.442/5.039秒、98节点/71图/0失败/无警告回退/1次尝试，通知收到且唤醒。树3.353/3.290秒、首图4.501/3.606秒（恢复首包37图），身份核对316/302ms，通知至采用406/371ms；不与前轮290ms拼作提速。取消4398.90ms真实首图回调、21ms返回、后续预览0，三次只读main暂停计数0，同PID15788/实例/根/恢复图像摘要与几何，透明大父层empty和alpha全0一致；最终forward空。没有导航、安装、重启、清数据或追加循环，主桌面未替换。去重收益已由多进程夹具确认，不能据此认定真机走了多PID分支或稳定提速；下一项拆分通知前主机准备/设备树发布。

2026-10-07 通知前等待：只补固定主机计时（进程准备、转发、窗口识别、调用前核对、同调用起点会话就绪）及nonce/PID诊断日志；不改SDK/手机包，不加设备查询、不放宽权限/身份或预算。providerCall可选计时随signal递归传递，实际TCP夹具验证取消上下文下正常事件仍在会话就绪之后、最终回复不被消费；87项8文件回归与最终传输夹具通过，完整构建通过，/tmp/inspector-pre-notice-{tests,transport-final,build}.log。

设置页只执行一次严格单次采集（30秒外层、15秒健康上限），.benchmarks/pre-notice-bb7Nyq/report.json 与 /tmp/inspector-pre-notice-device.log：exit0、5.311秒、98节点/无错误警告/1次尝试/通知唤醒，树3219ms、首图4386ms。进程准备137ms、转发15ms、窗口识别40ms、可见调用前核对267ms，调用内会话就绪684ms、通知809ms、采用1189ms；通知前主要剩余等待是会话准备。只读读取SDK既有 InspectorTree 日志（同PID15788、同nonce e0437f472ad443d8），保存在目录device-tree.log：started/posted160115303，entered160115309，ended/encodingStarted160115345，published160115423，settled160115425；排队6ms、UI取树36ms、编码/写文件/发布78ms、阶段122ms。主机发起后通知125ms与设备阶段122ms相近，但不同绝对时钟不能相减，不能精确将差值3ms当网络开销。684ms只是请求处等待未完成会话的剩余时间，不是整个open-session耗时。

显式关闭连接后forward空，无安装/导航/重启/清数据或额外取图循环，主桌面未替换。不重复宣称像素/取消验收或稳定提速。源码确认SDK Session服务在客户端断开后保留、主机新连接仍先content open-session；下一步有界socket快路可作为候选，需先覆盖未启动/旧SDK/取消/失败清理，不直接跳过服务启动或权限检查。

2026-10-07 已有Session快路：主机先建立ADB转发并连接，连接500ms、无UI session-probe请求500ms上限；SDK旧handler对未知方法的固定拒绝回复用于可用性探测，不授权树/像素。失败销毁socket并幂等清理本次转发，保留原content open-session及不支持会话时的content数据请求兼容。实际树/图片请求失败或取消不重放。就绪前drop不删除正在准备/回退的共享opening，成功后断连释放自有转发。新增当前连接建立耗时与是否启动服务标量，记录该连接历史建立成本，不当成每次请求耗时。

真实TCP/模拟ADB新增未启动、探测超时、错误回复、旧SDK断连、探测期间取消及新会话恢复；已有服务断言无open-session、回退只启动一次且实际数据请求一次、两次转发均清理。首轮24通过/4失败：旧启动fixture把核验完成后服务探测的forward也当提前抓图；失败原文/tmp/inspector-session-fast-tests.log保留。修正断言为完整焦点/树门禁后只允许一条准确SDK转发，未就绪/变化/取消仍禁止；98项8文件通过，最终传输夹具1项/8场景与构建通过，/tmp/inspector-session-fast-{tests-final,transport-final,build-final}.log。

同设置页一次 --require-tree-ready 基线→首图取消→恢复，.benchmarks/sdk-small-recovery-hVFLyl/report.json及快照、/tmp/inspector-session-fast-device.log：passed=true/exit0，4.668/4.842秒，树2.638/2.745秒，首图3.789/3.889秒（各70图），最终98节点/71图/0失败/无警告回退/1次尝试。两连接启动服务标量0、建立26/49ms，在可见调用前已完成，因此调用内等待0ms；通知93/142ms收到且唤醒，身份核对248/261ms。取消真实首图回调2969.20ms、74ms返回、后续预览0；三次只读main暂停计数0，同PID15788/实例/根/恢复摘要与几何，透明大父层empty与alpha全0一致，最终forward空。无导航/安装/重启/清数据或追加循环，主桌面未替换。相对前轮5.311秒只有有限改善线索，非受控稳定收益；未验证业务服务不存在时的冷连接，下一项仅独立样例验证该路径。

2026-10-07 独立样例冷服务：新增固定sample包探针，先确认已安装Debug样例和授权前台，再正常打开静态样例页；只content close-session样例服务，不触碰业务服务。首次capture→关闭主机连接→暖重连capture→同连接capture，健康上限每次5秒/请求15秒信号；核对同PID/窗口/SDK实例和整树root摘要，不做图片绘制。报告 .benchmarks/session-connection-nOVHIu/report.json 与 /tmp/inspector-session-cold-probe-device.log：passed=true/exit0，树请求1333/69/39ms，首次会话建立1263ms/启动标量1，暖建立21ms/标量0，复用连接等待0ms且历史建立仍21ms。PID25712/SDK实例/整树摘要三次一致，冷轮和最终转发均清理。外部最终核对返回原SettingsActivity记录5e9ccc4与forward空；无安装、重启、清数据或业务服务控制。样例服务冷态不是App进程冷启动，首次总建立尚未拆出失败探测/兼容启动，不宣称快路额外成本具体数值。

真机结束后加强探针记账：passed须等最终连接清理、转发和原窗口恢复核验完成才写；原错误保留，不让收尾错误掩盖。转译执行实际收尾的两项本地测试覆盖成功顺序及清理/转发/恢复拒绝；初次替身遗漏serial导致1项失败，日志/tmp/inspector-session-cold-probe-tests-final.log保留，补齐替身后10项3文件/构建通过，/tmp/inspector-session-cold-probe-{tests-verified,build-final-verified}.log。没有为该收尾改动再跑手机循环；其本地覆盖与此前外部恢复核对分开记录。

2026-10-07 首次连接三段：主机增加首次探测（含转发/失败清理）、兼容content启动、启动后连接核验固定计时，共用连接保存历史标量，不增加设备查询、不改变控制流/权限/预算/重放策略。真实TCP夹具验证暖服务后两段0、缺服务/错误/超时回退计时合法、三段合计与总建立成本取整一致；模拟启动固定60ms归启动阶段，超时归探测阶段，旧SDK回退仍无成功计时。18项5文件/0失败及完整构建通过，日志 /tmp/inspector-session-open-phases-tests.log、/tmp/inspector-session-open-phases-build.log。本轮未操作手机、未替换主桌面；此前1263ms真机记录没有这些分段，不能追认或宣称提速。下一项仅现有独立样例探针的单次分段验证。

2026-10-07 独立样例分段单轮：探针增加三段非负/有限/合计核对、暖服务后两段0、同连接历史计时不变；实际片段本地测试覆盖错误值拒绝，11项3文件/构建通过（/tmp/inspector-session-phase-device-tests.log、/tmp/inspector-session-phase-build.log）。唯一真机报告 .benchmarks/session-connection-dAuo1e/report.json、日志 /tmp/inspector-session-phase-device.log：首次capture1253ms/建立1190ms，探测26ms、content open-session1144ms、后核验19ms（1ms取整差）；暖重连79ms/建立17ms，同连接34ms/调用等待0ms、历史建立17ms。PID25712/实例449f4ab9-fef7-4418-aeb4-d221f1444ecb/整树root摘要三次一致，无图片绘制。

报告passed=false/exit1：最终恢复原页面后即时getDebugTarget遇null-focus，保留失败未重跑。之后只读dumpsys确认原业务SettingsActivity记录5e9ccc4/窗口4032a06恢复，forward为空，设备Awake；后查不覆盖报告、不声称收尾验收通过。仅关闭样例服务，不控制业务服务、不安装/重启/清数据、主桌面未替换。SDK源码openSession仅建LocalServerSocket/启动线程，不读UI；1144ms包含主机命令、Android content/Provider调用及SDK执行，不能归为SDK内部耗时或稳定性能结论。下一项先有界处理恢复焦点延迟，本轮失败保留。

2026-10-07 探针恢复焦点等待：新增session-probe-restoration，只在FocusUnavailableError/null-focus时100ms后只读重查，默认3秒共用总信号贯穿查询/等待。一次导航不重发，错包/组件/窗口、非主显示器、断线、预取消及晚到成功均拒绝。执行实际finally验证瞬时失焦后恢复仅一次切页、两次观察，保存发生于恢复后；原采集错误仍优先。本轮未操作手机、不更新SDK/主桌面、不重写此前失败报告。初次构建发现previous闭包类型未收窄，日志/tmp/inspector-session-restoration-build.log保留；捕获original后完整构建通过，/tmp/inspector-session-restoration-build-final.log。最终回归见/tmp/inspector-session-restoration-tests-verified.log。源码只读确认call/dispatch共用monitor，openSession建socket/线程；锁等待与命令/Provider前置成本尚未测，不能将1144ms认作SDK内部耗时。下一项仅本地SDK启动固定计时验证，真机更新另确认。

2026-10-07 SDK open-session内部计时：call由方法级synchronized改成同对象显式synchronized块，授权/dispatch和返回仍在同一monitor；只有open-session/sessionTiming=true在入锁前读设备单调时钟。授权通过才返回sessionTimingVersion=1、sessionLockWaitNs/sessionDispatchNs/sessionCallNs，dispatch中计openSession的sessionOpenNs。默认无时钟读取、旧result/socket回复不变，不加日志/自启动/重试/权限变化。call/dispatch/openSession为嵌套时长，入口前成本和回复编码/传输不在内；openSession异常仍失败，不解释成成功。

实际Java片段夹具覆盖新建/复用/创建异常、shell/Debug/未知方法拒绝、普通采集不启用、无开关兼容，并用真实对象monitor阻塞请求40ms，检查锁等待≥30ms及嵌套范围。19项7文件/0失败（10.89秒），完整桌面/CLI/MCP构建和SDK Debug/Release构建通过，日志/tmp/inspector-sdk-session-timing-{tests,build,android-build}.log。本轮未操作手机或替换主桌面/业务包；无Android Binder成本或真机内部测量，不能从该夹具认定锁等待导致此前1144ms。下一项主机显式诊断接入，本地覆盖后再确认独立样例保留数据更新。

2026-10-07 主机启动计时接入：providerCall可选diagnostic.requestSessionTiming，仅本次opening走兼容启动才在content open-session附sessionTiming:b:true，默认参数及数据请求不变；当前连接保存历史sessionTiming，复用不再请求，暖服务记not-started，不请求记not-requested。纯解析器限制版本1/唯一完整字段/非负安全整数/嵌套范围，缺能力unsupported、坏值invalid，无时长推断、不给树/像素授权。启动失败仍走原兼容处理，不因诊断修饰其成功；未知/无会话不伪造历史诊断。

固定sample探针新增--session-timing，行报告保存内部状态，冷轮available/unsupported可继续（后者仅兼容非计时验收），invalid拒绝；暖/同连接应not-started，不关闭业务服务取数。真实TCP新增新SDK/旧SDK/坏值/拒绝四场景，核对单次开关/历史复用/不重放/转发清理；默认不发送，暖服务即使请求也不bootstrap。初轮30通过/1失败为新fixture数据回复仍套旧nonce分支，日志/tmp/inspector-session-timing-host-tests.log保留；修正fixture后31项6文件/0失败（42.59秒），/tmp/inspector-session-timing-host-tests-final.log；暖服务额外断言后19项5文件定向通过，/tmp/inspector-session-timing-host-focused-final.log。完整构建/tmp/inspector-session-timing-host-build-final.log通过，diff检查通过。本轮未操作手机、不部署SDK/桌面；此前1144ms仍无内部实测，下一项仅获确认后同签名保留数据更新独立样例并单次验证。

2026-10-07 独立样例内部计时实机：用户确认后构建sample Debug（/tmp/inspector-session-timing-sample-build.log，2秒成功），旧APK备份/tmp/inspector-session-timing-update-fX54jp/old-sample.apk；新旧签名SHA256均b580ff94ff43411974383522506383c5b74785709b04596ab821c2e30667527b。核查包名/Debug和全部DEX新字段，install-r-t成功，新APK本机/设备SHA256均b77b2b79c8b2d25856b7607486fbb48a64843927a82040c91ad25398c0428bbf；仅替换独立样例保留数据，未动业务包/主桌面。

唯一--session-timing运行报告 .benchmarks/session-connection-zNSYzX/report.json、日志/tmp/inspector-session-timing-device.log：passed=true/exit0；冷服务读树1380ms/连接1325ms，探测42ms/content启动1255ms/后核验25ms（合计与总段相差3ms，含解析等非分段开销）。SDK status=available/version1：call2877846ns、lockWait1616ns、dispatch2792000ns、open2705000ns，嵌套关系通过。暖重连85ms/建立22ms，同连接38ms/等待0ms，后两轮status=not-started，无服务重复启动。PID28982/实例88508a1d-a630-45cc-ad81-adbe7a163cd1/整树摘要1fccb5376d2e05d271dc55d7374faeed9d8b5607aeeb70eda2ceaa0a1af41df8三次一致。

收尾核验成功，外部只读复核原SettingsActivity记录5e9ccc4/窗口4032a06，业务PID15788不变，forward为空。没有额外采集/force-stop/清数据或业务服务控制；安装更新会替换独立样例进程，不冒称其跨安装PID不变。恢复等待未记录重查次数，不断言本轮实机触发失焦重查；旧dAuo1e失败仍保留。此次1255ms整段而SDK call2.878ms只支持该轮主要成本在call范围外，不能直接将差值归命令启动，亦非业务冷启动/像素/稳定性能验收。停止同类探针，下一项正式采集入口定向回归。

2026-10-07 完整采集编排本地回归：新增capture-session-flow.test.ts，读取/转译实际readDeviceSnapshot完整函数及同源会话准备/providerCall/收尾，复用生产readiness/前台解析/树解析/取消/请求协议；本机net TCP服务配设备观察/绘图/屏幕替身，不调用真实adb，测试空闲扫描禁用。6模式：warm两采复用1连接、cold一次兼容启动、图请求内取消保持reason/迟到发送尝试后新连接恢复、完整属性阶段取消不发取图/屏幕、末尾Activity实例变化丢弃整结果、错包零图请求。转发只能在两次树前后焦点确认之后准备；默认不附内部计时，数据请求数保持一次每采，finally实际关闭并核对forward/remove配对。返回fixture-no-pixels为明确替身，未做真实PNG/Android绘图或SDK合并文件验收，也未验证UI事件。

初始6项通过，/tmp/inspector-capture-session-flow-tests.log；增加连接复用与恢复后连同传输/计时/预览取消/合并身份/混合/失败/启动门禁共40项9文件/0失败（42.35秒），/tmp/inspector-capture-session-regression.log，完整构建/tmp/inspector-capture-session-build-final.log通过，diff检查通过。没有生产采集逻辑修改、没有操作手机/更新SDK或主桌面。下一项仅现有正式采集API工装一次稳定设置页显式SDK基线→首图取消→恢复，先确认页面，无导航/重启/清数据/额外循环；不当默认小树路线或桌面UI验收。

2026-10-07 正式采集API单轮回归：先只读确认原业务SettingsActivity记录5e9ccc4/窗口4032a06，唯一`bun scripts/sdk-small-page-recovery-probe.ts JNHA45FQBQEIRGEQ --require-tree-ready`，报告 .benchmarks/sdk-small-recovery-dfMjem/report.json/两份快照、日志/tmp/inspector-capture-session-device-regression.log：passed=true/exit0。明确preferVisibleSdk=true、singleAttempt=true、每次30秒外层/15秒健康上限；基线4001ms/恢复3796ms，各98节点/71图/0失败/无警告/1尝试，树2122/2037ms、首图3118/2349ms（70图/37图）。通知100/88ms收到且wake=true，当前连接建立30/29ms、启动标量0，调用内等待1/0ms；没有开启启动内部诊断。

取消3130.908ms真实首图预览回调，16ms返回，后续预览0；三次只读main暂停计数0。同PID15788/startTicks/实例f7445a04-00e5-405a-ab28-c1beb87d1632/根DecorView@7c2068e、恢复对象/几何/状态/编码摘要一致；1080×2400 SwipeLayout empty=true且独立解码alpha全0，不冒称所有控件跨路径严格RGBA验收。70个SDK可见层几何aligned/缺失歧义变化均0；另1项通过既有SDK补齐，不称完全无补采。最终forward空，原设置Activity/窗口/PID未变；无导航、安装、重启、清数据或追加循环，主桌面未替换。不是桌面UI、默认小树路线或稳定性能证明。下一项新SDK小页面默认路由本地门禁，不再重复显式SDK这一工装。

2026-10-07 小页面默认 SDK 取图门禁：新增 sdk-capture-route，在本次 SDK 树身份/几何校验及采用成功后选择路线；默认小树要求 visible-stream=2、ui-wake=1、硬件/软件窗口状态已知。旧 SDK、能力缺失和显式关闭保持兼容；显式开启/大树既有规则仍要求验证成功。不修改调用者 options，不增加读树或能力查询，初始小树候选仍保守；保留 DDMS 属性导出，通过现有树回调启用 SDK 后跳过 DDMS 批量图片。不能直接继承此前显式 SDK 的 4 秒结果或合并树通知验收。

5 项门禁/实际路由片段测试覆盖新旧能力、失败身份、显式关闭、原参数不变、初始候选及现有回调一次交接到 skipImages。初次补充交接测试遗漏替身 packageName，96 通过/1 失败，日志 /tmp/inspector-small-sdk-default-tests-final.log 保留；补齐后最终 97 项/9 文件/0 失败（8.99 秒），/tmp/inspector-small-sdk-default-tests-verified.log；完整桌面/CLI/MCP 构建通过，/tmp/inspector-small-sdk-default-build-verified.log。本轮未操作手机、未更新 SDK 或重启主桌面。下一项给现有工装增加真正不传 preferVisibleSdk 的模式，本地断言后做一次默认小页基线→首图取消→恢复；按真实取图来源验收，不用显式开启结果代替。

2026-10-07 默认小页单轮实机：工装增加互斥的`--default-route`，基线/取消均通过空对象展开真正省略preferVisibleSdk；增加阶段/来源/SDK批次/小树/无DDMS批次断言，保留失败报告，不用合并通知作为classic树要求。3项新测试覆盖实际两处调用参数展开及错误来源/参数/回退拒绝，初轮定向10项通过；初构建因测试Object.hasOwn不在当前TS库范围失败，/tmp/inspector-default-recovery-build.log保留，改用hasOwnProperty.call后最终100项10文件/0失败（9.58秒），/tmp/inspector-default-recovery-regression.log；完整构建/tmp/inspector-default-recovery-build-verified.log通过。

唯一真机`bun scripts/sdk-small-page-recovery-probe.ts JNHA45FQBQEIRGEQ --default-route`，报告 .benchmarks/sdk-small-recovery-8uPIVy/report.json/两份快照，日志/tmp/inspector-default-recovery-device.log，passed=true/exit0。基线5756ms/恢复5331ms，各98节点/71图/0失败/无警告/1次尝试；树1877/1984ms，首图4315ms（37张）/4570ms（70张）。均70张SDK独立批量图加1张原SDK补图，stage包含SDK抓图、不含DDMS抓图，ddms-batch三字段均缺失，无SDK回退；属性导出保留，classic树无merged通知，不当缺能力。

真实首图取消4011.293ms，58ms返回、后续预览0；三次只读main暂停计数0。同PID15788/startTicks15919466/SDK实例f7445a04-00e5-405a-ab28-c1beb87d1632/根DecorView@7c2068e，恢复对象/几何/状态/编码摘要一致；两次几何aligned70、缺失/歧义/位置/尺寸变化0。大1080×2400 SwipeLayout empty=true、独立解码alpha全0，非所有跨路线严格像素验收。收尾及外部复核forward空、原设置记录5e9ccc4/窗口4032a06/PID不变。无导航/安装/重启/清数据/额外手机循环，主桌面未更新；5.756/5.331秒不是稳定性能，也不与上轮显式SDK的4秒直接作因果对照。下一项默认桌面入口/预览取消恢复的本地交接回归。

2026-10-07 默认桌面交接本地回归：新增desktop-capture-handoff.test.ts，AST提取/转译执行实际主进程inspect-device/cancel-inspection处理器、preload对象和App采集/预览/取消回调，复用生产图像baseline/diff/merge和请求策略；sender/设备返回/React setter为本机替身，图片字符串明确fixture，不是PNG像素或真正Electron IPC/React挂载。普通入口确实省略preferVisibleSdk；5场景核查SDK来源和captured/empty、不重复批次、树形重建的当前图片、取消清空部分状态、迟到图/进度/结果拒绝、恢复等待旧done、旧finally不删除新请求、错frame/过期取消/销毁清理及preload参数/监听卸载。

发现主进程onProgress仅检查sender未销毁，取消后仍可外发迟到进度；加controller.signal.aborted门禁，renderer原requestId隔离保持不变，不改变采集路线/权限/设备时限。初轮117项通过，但构建指出夹具ready/pending不是实际层图状态、状态断言导致TS窄化，/tmp/inspector-desktop-default-handoff-build.log保留；改captured/undefined及恢复后显式类型，最终117项12文件/0失败（9.44秒），/tmp/inspector-desktop-default-handoff-regression-verified.log；完整构建/tmp/inspector-desktop-default-handoff-build-verified.log通过。本轮未操作手机、未更新/重启主桌面，不追认真实UI通过。下一项在现有独立profile fixture烟测增加异步预览/取消/恢复并验实际渲染，不再追加手机采集。

2026-10-07 隔离桌面生命周期端到端：新增visual-capture-fixture（开发专用、有界树/独立PNG/完成、取消后故意尝试迟到回调），main只在未打包且双fixture开关时接入，共用生产captureOptions/预览/取消门禁，不接adb；普通路线/SDK权限不变。app-smoke新增互斥--fixture-capture-lifecycle，真实独立profile窗口/CDP驱动实际按钮，验证树/场景取消清空、立即恢复新requestId、旧请求无后续IPC、来源明确测试夹具、透明captured状态可见、透明图只边框/可见图提交原生纹理，记录gl.finish后的renderVersion/committed。2项本地fixture测试证明树预览克隆不被后来图改写及取消reason保留/迟到尝试；与桌面交接/树/路由/会话等最终119项13文件/0失败（12.59秒），/tmp/inspector-fixture-lifecycle-regression-final.log，完整构建/tmp/inspector-fixture-lifecycle-build-final.log通过。

首次实际窗口 .benchmarks/app-smoke/2026-10-07T03-08-48-682Z/result.json 失败保留，原因烟测只查第一条inspector-image-note（为点击监听说明，不是图片来源），并非来源未传递；改为所有说明匹配后03-09-17-765Z通过。补取消时事件边界/GPU提交断言后03-09-56-477Z通过，再将画面卡滚入可视区域并核查状态在viewport内，最终 .benchmarks/app-smoke/2026-10-07T03-10-41-366Z/result.json success=true/exit0、6项检查/rendererErrors=[]；日志/tmp/inspector-fixture-lifecycle-smoke-visible.log，lifecycle-preview.png/lifecycle-recovery.png及app.png保留并人工查看恢复截图。取消的IPC AbortError记于主进程日志，是预期取消，非renderer错误。每次独立profile测试进程由工装收尾，不替换主桌面；无手机查询/采集/更新/重启/清数据。真实桌面渲染通过只适用于合成fixture，不当业务SDK、严格像素、默认门禁或提速证据；下一项主桌面版本交付，实际更新重启前确认。

2026-10-07 主桌面交付：用户确认后完整构建/tmp/inspector-desktop-delivery-build.log及119项13文件/0失败（12.60秒）/tmp/inspector-desktop-delivery-regression.log通过。electron-builder --mac --dir --arm64 --publish never输出 .benchmarks/desktop-delivery-2026-10-07/mac-arm64，自动使用本机Apple Development证书，逐资源签名约数分钟；打包exit0，严格codesign --verify --deep --strict通过，未公证。主入口/preload/所有dist与dist-electron实际归档文件及外置cli/android-ui.cjs、mcp/server.cjs字节匹配，归档无.benchmarks/android/tests/docs；app.asar SHA256=1c0ccd606c7fe2fc36cb8d6a8ed3ff57964eb5c4698d3ad752d0f45fae7e6086。签名未结束时一次临时核验无资源失败不当最终结果；后一次检查误从asar读取外置CLI报缺文件，改为extraResources路径核对通过，非CLI丢失。

工装增加macOS打包可执行路径与--device-capture-lifecycle独立入口，真实普通UI按钮一次基线→首图回调取消→恢复，没有SDK偏好注入或额外手机循环。首次脚本语法检查发现mac路径模板引号错误，修正后检查通过、运行前未采集。唯一实机桌面报告 .benchmarks/app-smoke/2026-10-07T03-20-01-452Z/result.json，success=true/exit0、5项检查/rendererErrors=[]；日志/tmp/inspector-desktop-delivery-device.log，恢复截图保留。两次完成stage elapsed5543/5220ms是主采集进度时钟，不含最终测图/用户等待，非稳定或总耗时证明；SDK图片来源、无DDMS抓图stage、真实按钮取消清树/场景、旧事件拒绝及恢复GPU renderVersion12/committed69通过。预览PID均15788，最终只读原SettingsActivity记录5e9ccc4/窗口4032a06/PID不变、forward空；不当所有图片严格像素/摘要一致/内部单尝试验收。

原release/mac-arm64运行App先复制备份/tmp/android-inspector-desktop-backup.mRzfN6/Android UI Inspector.app，授权退出后旧live bundle移至同目录Previous live Android UI Inspector.app（可恢复，不删除用户数据），新包ditto至原路径、严格签名和双份asar摘要一致后重新打开。实际主窗口观察Android14/24094RAD4C设备已连接、开始检查，启动文件为原release的asar路径；未更改用户profile、手机包/SDK，未导航/重启/清手机数据。此为本机测试交付，非苹果公证/正式分发；下一项全量本地与打包CLI/MCP只读入口回归，不再次手机采集。

2026-10-07 交付后回归：首次完整测试/tmp/inspector-delivery-full-tests.log为448通过/5失败/453项，均在inspection-single-attempt.test.ts错误禁止SDK会话探测forward。隔离模拟adb日志/tmp/inspector-policy-diagnostic/calls.jsonl确认唯一forward为localabstract:com.example.startup.inspector.session，无截图/capture-visible/JDWP；修正断言允许准确的探测目标，仍禁止抓图和其他转发。完整重跑/tmp/inspector-delivery-full-tests-rerun.log为453通过/0失败/78文件/86.31秒；新增普通fixture打包门禁与重试定向/tmp/inspector-delivery-fixes.log为8通过/0失败，构建/tmp/inspector-delivery-post-build.log通过。实际交付Resources CLI/MCP由scripts/packaged-readonly-check.ts检查，私有合成共享、13工具、缺共享/实时未授权拒绝、撤销拒绝通过，报告.benchmarks/packaged-readonly-2026-10-07/result.json；没有手机命令。主程序PID99283仍运行原release包；新普通fixture禁用仅源码，尚未重新打包/部署，原包仅禁异步fixture，不能把源码门禁当已安装包验收。未重启主桌面或手机、未清数据、未提交推送。下一项只读冷启动失败证据分类及具体阻塞点本地复现。

2026-10-07 冷启动只读复核：重读device-health-check下13:41、13:56、14:08、14:22四轮health原文及current-verify-UCVnEO/sdk.log和summary.json，未调用adb。前三轮0树/0图：两轮窗口确认后预算不足，一轮保留21次null-focus；13:56/14:08各丢6条，缺失不推断。最后一轮22.087秒/整页尝试1，窗口9.032秒确认、系统树读1次、就绪10.485秒，SDK核对11.329秒失败；SDK日志两条posted任务3021/3001ms均entered/ended=-1，后一条带request编号，前一条不强行关联。定位到SDK任务尚未进入遍历，但没有当轮主线程栈/方法区间，具体业务根因仍未知；旧DEX/代理栈和健康失败trace不拼接为因果。新增docs/STARTUP_FAILURE_REVIEW.md脱敏汇总。capture-feedback实际最小测试先复现7通过/1失败（/tmp/inspector-startup-feedback-before.log），修正ready后明确SDK树超时优先于泛“独立画面”文字，图像/旧记录/取消仍隔离；29项5文件/0失败（/tmp/inspector-startup-review-tests.log）与完整构建（/tmp/inspector-startup-review-build.log）通过。未改变预算/重试/采集路线，未改业务/SDK、未操作手机或更新主桌面，提示新补丁仅源码。下一项先本地设计排队区间身份/主线程观察及恢复清理工装，不自动启动业务或补跑。

2026-10-07 SDK排队取证设计：复核现有startup-stack-observer及SDK writeTreeFile，确认旧窗口观察门禁在mainWindow=true时退出、SDK posted/entered日志在finally才打印，不能及时触发SDK树排队观察。方案并入STARTUP_FAILURE_REVIEW.md，不再另建重复计划。新增scripts/sdk-queue-stack-policy.ts纯门禁及5项本地测试：包/SDK/PID/startTicks/实例/请求绑定，设备排队500–2499ms、主机通知年龄≤250ms、任务未执行/结束、请求有效才预留一次；失败不再次预留，收尾采样保守设备时间范围严格位于任务区间，恢复/自有转发清理均需成功。无设备调用/日志订阅/SDK变化，提前通知和非UI状态接口及真实连接尚未实现。40项4文件（含旧JDWP网络替身、实际SDK任务方法Java替身与提示回归）通过，日志/tmp/inspector-queue-stack-regression.log；加强事后通知状态/时间检查后5项policy复测/tmp/inspector-queue-stack-policy-final.log通过。规则尚未真机验证，不能保证命中或暂停成本；不把暂停后的请求当性能验收。未启动/更新手机App或主程序、未改业务、不取栈/图、不提交推送。下一项先补默认关闭的SDK提前通知和非UI状态读取，本地验证后再提出受控真机方案。

2026-10-07 SDK排队诊断入口：新增TreeQueueDiagnostics，只有显式treeQueueDiagnostics且实例正确的classic capture或withTree合并请求才创建单次500ms诊断定时线程；普通请求仅ThreadLocal空读取，不创建诊断线程。任务进入/结束/settle及仍排队通知绑定请求/kind/PID/实例/设备时间，取消或结束取消定时任务、只保留最近标量；迟到运行任务不能改写已settled的ended。通知可能已经发送/在途，仍需状态核验。Provider call增加read-tree-task早期分支，在本Provider capture监视器外先检查shell UID/Debug/实例再读取绑定请求，不排UI、不走串行capture socket；未开启/错请求拒绝，已结束返回结束状态。protocol tree-queue-v1仅是协议标识，不伪装SDK构建摘要；主机观察未接。门禁另兼容16位merged nonce，classic UUID不混淆。

本地最终43项7文件/0失败/14.01秒，日志/tmp/inspector-sdk-queue-regression.log；实际类+Provider wrapper/query Java替身验证采集持监视器时独立查询返回、权限/default-off/classic/merged/单次通知/快速完成/异常中断清理；实际writeTreeFile任务替身另启用诊断，排队3秒失败前通知一次、0遍历/无文件，正常及迟到丢弃保留。非Android Binder/Looper/实机安全验收。第一次SDK构建因未指定ANDROID_HOME失败，日志/tmp/inspector-sdk-queue-build.log；指定现有SDK与JDK17后离线assembleDebug成功（682ms、4任务执行），日志/tmp/inspector-sdk-queue-build-final.log。AAR SHA256=6362f5bfd7b03b132faf5604f8135eea5a257508565dfaf53ee73c45e4a4c1a7，编译输出含新诊断类；未下载依赖/安装/重启手机/采集/暂停取栈/更新主桌面/修改业务或提交推送。下一项先补主机事件解析/独立状态查询和本地观察工装，构建/包/进程证据缺失不得取栈。

2026-10-07 主机观察适配：新增scripts/sdk-queue-observer.ts，严格固定tree-queue-v1 JSON/Bundle、有界字段/大小/时间与classic UUID/merged nonce；readQueueState为独立content read-tree-task，750ms/4096字节/无重试，仅显式调用才执行。createQueueObserver只做单次准备，身份由调用者实际核验提供，变化在读状态前拒绝；1000ms总准备上限，取消/超时阻止迟到结果，查询开始时记新鲜度，不以回复到达时间消除传输延迟。APK/SDK构建/startTicks不从日志伪造，协议不当构建标识。没有日志订阅/真实身份读取/诊断连接/取栈/手机命令或更新。新增10项observer测试，实际Java SDK query状态输出送主机parser验证classic/merged互通。51项6文件/0失败/8.05秒（/tmp/inspector-queue-observer-final.log），最后16项policy/observer复测通过；完整构建/tmp/inspector-queue-observer-build.log通过。SDK源码未变、手机SDK/桌面未部署，不称真实Binder/设备或业务根因验证。下一项先补有界观察入口与真实身份核验、日志订阅清理，传输替身端到端后再申请受控实机。

2026-10-07 有界日志监听：新增sdk-queue-log，显式订阅自身logcat子进程，固定JSON/PID/请求/实例筛选，默认3秒等待、64KiB/128行/2048字节行限制；命中/失败/超时/取消后终止自身进程并等待close，100ms升级终止、500ms未确认关闭拒绝。保持原接收时间传入prepare，关闭延迟不刷新250ms门禁。新增10项测试，包含真实本机子进程管道到prepare以及取消/错误/超限/清理失败；不是adb真机、实际身份核验或主线程栈。相关61项7文件/0失败（8.94秒），完整构建通过；清理异常保护补丁再做定向复测。未操作手机、安装/重启业务或桌面，不提交推送。下一项仍为真实包/SDK/进程核验及安全取栈连接。

2026-10-07 包/进程复核及单次取栈原语：新增sdk-queue-identity（单APK已知摘要/前后安装路径，run-as stat/cmdline/stat）和sdk-queue-jdwp（预读main与ID，最多32帧，单次消费）；已知摘要仍需外部可信来源，split安装不默认为单APK，协议号不当SDK构建。withSuspendedMain增加可选beforeSuspend钩子，在零暂停计数确认后、拥有暂停前拒绝过期/结束/取消，不误Resume；真正请求暂停后的失败保留恢复/验证/Dispose。66项6文件/0失败/1.82秒，包含本机真实TCP与进程/observer/帧/转发替身串联。没有实际adb/手机暂停、安装或重启；构建通过。不把原始帧当符号栈/根因；SDK构建来源、设备时钟夹取及最终状态/身份闭环仍未完成。

2026-10-07 SDK来源与收尾原语：Gradle生成sdk-source-v1源码/配置来源指纹，同步写BuildConfig和AAR/APK资产；read-sdk-build仅shell/Debug/同实例，在采集监视器外返回来源/PID/实例。host实际本机APK/AAR摘要和来源资产核验、运行时Bundle严格解析；指纹不等价二进制摘要/编译器与依赖全集证明或安全认证，要求可信同次业务构建产物。新增SDK单调状态保守夹取/1ms上界余量、最终settled及恢复后身份/恢复/清理检查；resolveFrames仅本次成功恢复后查类/方法，2秒检查/有界内容，原始位置不可变。

78项11文件/0失败/12.49秒及完整桌面构建通过，含实际Provider分支Java查询到host Bundle解析；仍非Android Binder实机。SDK/sample离线构建先有两次配置失败（MessageDigest名称冲突、AGP sourceSet类型不兼容），改用导入及variant生成资产接口后成功（1秒、14执行/49复用）。实际产物只读预检及编译Provider/APK DEX含来源指纹通过：sourceSha256=9d8861502e35f076461a35f54d6d35bddd39feaab3c8d4e497813a7335af074d；AAR SHA256=db64d6d6934bf8be69824ceec43e600eff34514825d1198bf62897ed30f8a894；sample APK SHA256=c0c2b7c33fa0f4c8c1af0c86155172e65384a26308b6aab7eaae6b9d3110a35f。未安装/操作手机、更新主桌面、改业务或提交推送。完整一次入口仍未接，不称真实排队命中、根因或性能验收。

2026-10-07 完整单次库入口：新增scripts/sdk-queue-observation.ts，串联可信产物/安装包/运行实例、预备main、订阅后一次请求、暂停前复核、帧恢复、立即后状态、原回复/最终状态与身份、连接收尾及判定。默认15秒观察，取消不竞速跳过恢复；日志关闭/原请求回复不确认明确失败，迟到回复不能改返回报告。withOwnedForward在close异常时仍尝试删除自有转发；导入/创建不运行设备，生产capture/forward适配尚未接，资源适配必须自带命令上限且失败开转发自行回收。

新增15项入口测试，含实际本机JDWP TCP及日志子进程管道；设备产物/状态/身份/绘图及forward仍是替身。补进程错PID回归先复现误报queue-covered：合并process/runtime字段让后者PID覆盖前者。改为各自明确匹配后再返回已核验身份，预检/暂停前/收尾三个阶段均拒绝。原请求SDK超时仍保留failed，不把排队命中当UI采集成功；符号失败保留原始帧、不二次暂停。101项14文件/0失败（16.78秒）及完整构建通过；最终清理抛非Error异常仍回收转发的补丁复核41项2文件/0失败（1.44秒）。未执行adb/操作手机/安装/启动业务、更新或重启桌面、提交推送。下一项仅接生产请求/转发适配并本地验证，真实部署和一次观察另确认；冷启动根因未证明，旧失败不覆盖。

2026-10-07 生产请求/资源适配：新增sdk-queue-device，显式构造/运行，不自动联系设备或接入默认桌面流程。一次open-session预备后，复用既有dispatcher发送绑定classic UUID/merged nonce和SDK实例的唯一请求；无重放、content取图回退或生成替代编号。SDK/JDWP分别持已知端口+唯一marker，--no-rebind预约，750ms资源命令不随取消失效，丢回复后只核对已知端口；观察到映射变化拒绝删除，SDK连接收尾不确认也使库报告失败。ADB查询/修改非原子，不能证明任意外部重绑定竞态；受控验证禁止其他工具修改选定端口。主机取消/关socket不宣称安卓任务已结束。

生产SDK Session的Java TCP替身先复现首客户端空闲时第二probe超时。修正为最多两条客户端、第三条拒绝，保持数据dispatch原监视器串行及ThreadLocal事件输出，close-session关闭已接入连接。新增11项生产适配测试、1项库资源生命周期测试与1项实际Session类网络测试；包含真实本机SDK/JDWP TCP及完整库成功/取消/SDK清理失败联测，ADB和设备/绘图仍为替身，不是Android LocalSocket/凭据/Binder/活View安全验收。扩展首次回归122通过/1失败，原因是旧会话计时测试未补新增只读查询分支替身；补齐后123项19文件/0失败（18.94秒）。桌面/CLI/MCP完整构建及SDK/sample离线assembleDebug成功（63任务、14执行/49复用）。

实际AAR/APK资产、编译Provider和sample DEX的指纹/客户端worker一致性核对通过：sourceSha256=5e27699294a871fba3116d73a75a76ba4eee2060aa34ba2732cdb065536470ee；AAR SHA256=4865db2a15d642186f547388914cd50215ff02aee1d330e298a4964c8a9e7484；sample APK SHA256=614c4515d0670ea83e38c67121842467470e7bcb01cfa3d6fc7baaebfbe7a59d。只读编译检查先后遇到unzip标准输入不可seek与默认输出缓冲不足，改用构建已生成的实际jar和8MiB有界读取后通过，不改产物。未安装/操作手机、重启业务App/桌面、提交或推送。下一项另确认样例部署与一次受控观察；未证明冷启动根因或提速，旧失败保留。

后续全量本地回归533项90文件/0失败（94.73秒），日志`/tmp/inspector-queue-adapters-full-tests.log`；未执行手机命令或更新运行程序。

2026-10-07 受控样例部署及预检：新增sample src/debug的QueueHoldProvider和静态QueueObservationActivity，shell UID/Debug/固定样例包/PID/UUID限定，arm每进程仅一次，主线程等待固定1800ms、进入确认500ms、失败撤销晚到回调；导入host入口无设备副作用。显式`sdk-queue-sample-probe.ts SERIAL --run`计划一次预备树、一次hold、一次诊断请求，另留原窗口、实际次数与清理/最终任务状态；不安装或重启业务。实际生产Provider源码的Java替身验证授权/单次/释放/自动结束/失败撤销，不是Android Binder/Looper安全证明。

Debug/Release离线构建通过，实际Release DEX/manifest无hold、测试Activity、HierarchyProvider或queue-hold。旧样例备份`/tmp/inspector-queue-sample-byG9S0/installed-sample.apk`，新旧签名SHA256一致（b580ff94ff43411974383522506383c5b74785709b04596ab821c2e30667527b）；保留数据覆盖成功、安装摘要匹配。新sample APK SHA256=8669e12ac72231942eac7c69232d79da9b3675e78c65ce4f539d157cfbcc57ba，SDK AAR=4865db2a15d642186f547388914cd50215ff02aee1d330e298a4964c8a9e7484，sourceSha256=5e27699294a871fba3116d73a75a76ba4eee2060aa34ba2732cdb065536470ee；本轮SDK源码未改，业务包/主桌面未更新。

仅执行实机入口一次，`.benchmarks/queue-sample-T9Lx1Q/report.json`保持passed=false：Android返回`sample/.QueueObservationActivity`而脚本只接受完整名，前台预检和自动恢复核对均失败，timings为空、idlePrepared=false。实际0预备树/hold/诊断/日志订阅/调试转发/暂停，不把scope中的计划次数当执行次数。核对确切样例Activity后只发一次BACK；后续只读确认原业务设置组件、PID15788、转发空，补记`preflight-cleanup.json`。旧报告未保存原windowId，不能补称原窗口身份或SDK恢复通过。业务未重启/清数据，本轮不补跑。

名称回归先复现3通过/1失败，修正预检/收尾仅接受同一样例的完整或缩写名，并拒绝相似/外来类；新报告保存原窗口和实际次数。39项5文件/0失败（5.33秒）、完整桌面/CLI/MCP构建通过，最终全量537项91文件/0失败（97.05秒），日志`/tmp/inspector-queue-sample-full-tests-final.log`；此前536项通过不覆盖本次预检失败。下一项只做一次受控样例观察，不重复安装、不放宽新鲜度或更新业务。未证明真实排队命中、冷启动根因或提速，未提交/推送。

2026-10-07 新授权受控样例入口仅一次，报告`.benchmarks/queue-sample-dCnwQC/report.json`保持passed/safetyPassed=false：预备树1次（1362ms），自身idle首连接和诊断第二连接均就绪，JDWP main预备成功；hold arm命令1002ms超时，diagnosticCapture=0、frames=0，未执行Suspend，不是通知未命中或SDK捕获失败。SDK运行来源/PID/startTicks及本机/安装APK摘要前后通过；样例PID15693/实例绑定。三条自有转发59912/59950/59964均移除，自有SDK/JDWP客户端、logcat清理确认，业务原窗口4032a06、组件和PID15788恢复；没有安装、重启业务/桌面或清数据。

release命令也1001ms超时，原程序跳过read，不能把超时当安卓没有执行。失败后只独立读一次同PID/请求hold状态（1125ms），entered=172072290/ended=172073363，证明等待已结束、设备区间1073ms；不推断自动1800ms结束或谁释放。后续前台/转发只读确认正常，补记`post-run-readonly.json`；不重发arm/release、无第二采集或取栈，原失败不覆盖。该轮runtime read-sdk-build命令1125ms、系统进程复核243ms；只证明命令整段成本，不当SDK内部成本，未进入通知后准备所以250ms门禁失败尚未实机复现。

本地最小回归先4通过/1失败，复现hold命令1000ms限时不覆盖实机约1125ms总调用。仅样例控制deadline改2000ms，SDK树/prepare/诊断状态读取/500ms进入确认/1800mshold/250ms新鲜度均不变；释放失去回复也独立read一次并保留原错，active/未知仍失败，诊断未发出则不查不存在的任务。42项5文件/0失败（5.33秒）及桌面/CLI/MCP构建通过；全量540项91文件/0失败（97.32秒），日志`/tmp/inspector-queue-sample-control-full-tests.log`。本轮SDK与Android产物未改或再安装，修正未补跑实机。下一项先缩短非UI诊断查询链路、保留实际系统身份核对；当前样例arm已消费，后续明确更新/新样例进程范围，不重放旧请求，不动业务。冷启动根因和真实排队取栈仍未完成；未提交推送。

2026-10-07 快速诊断读取本地完成（无设备操作）：先在实际SDK Session源码的Java网络替身复现read-sdk-build不支持，修正后采集持监视器时两种标量读均返回，数据dispatch仍串行、最多两客户端、普通root数据兼容但root诊断拒绝。Binder/Session共用非同步标量授权/读取方法；Debug/实例/请求授权由实际方法替身验证。主机readRuntime/readState复用已有独立连接，读/采集角色不混用，不并排读；失败关闭自身socket/forward，取消/超时/坏/重复/超大回复不复用迟到行、不重试/content回退。系统/proc stat→cmdline→stat由一次250ms run-as cat获取，严查LF/NUL边界、实际包/PID和两次startTicks，拒绝截断/额外参数/身份变化。它仍是系统独立证据，不以App自报替代。

样例入口已绑定第一条客户端快速读、第二条只采集，最终状态和运行身份读完才清理第一条；本机实际SDK/JDWP TCP完整编排、取消时恢复、自己的三条转发收尾验证通过。新增过期通知与已进入任务测试仍拒绝暂停，250ms新鲜度/1000ms准备/750ms读取/1800mshold不变。一次测试状态名称误写为already-entered，按现有task-not-queued契约修正，未改门禁。69项/10文件相关回归0失败（12.21秒），全量545项/91文件0失败（98.98秒）；日志`/tmp/inspector-queue-fast-read-full-tests.log`。完整桌面/CLI/MCP构建及Android SDK/sample Debug/Release离线构建通过，Release DEX无SDK/hold/测试Activity。

本机新Debug APK SHA256=a39bf349cd1ca82b2ebe4b358faabc98c22d04af80feaf650597e7029e7a4673；SDK AAR=e58ce3a1c5ddfd95461601977204ec87adb45b614bde58b41cbad6843e89a02e；两产物来源资产一致sourceSha256=eb923afd9a34ca930a1427c54f382bbba9df8ca174c088884657ef0325e2298f。新包未安装，当前手机旧样例/业务与主桌面未更新或重启；不能把本机TCP速度当Android耗时、250ms门禁通过或冷启动修复。旧实机失败保持false，下一项明确只更新独立样例后单轮观察；本轮未提交推送。

2026-10-07 新授权独立样例更新与单轮观察通过：旧安装样例备份`/tmp/inspector-queue-fast-update-lkmDVU/installed-sample.apk`，SHA256=8669e12ac72231942eac7c69232d79da9b3675e78c65ce4f539d157cfbcc57ba；新旧签名均b580ff94ff43411974383522506383c5b74785709b04596ab821c2e30667527b。仅`install -r --no-streaming`保留数据覆盖样例，安装摘要匹配上一段a39bf349新APK，APK/AAR来源仍eb923afd。更新前后业务原设置窗口4032a06、PID15788相同；没有卸载/清数据、替换业务SDK、重启业务或主桌面。

只运行一次`sdk-queue-sample-probe.ts`，报告`.benchmarks/queue-sample-RZYXlh/report.json`保持原文passed/safetyPassed=true、status=queue-covered，实际preparatoryTree/sampleHold/diagnosticCapture各1。样例PID21313/startTicks17364947、SDK实例e3956e14-073f-4454-985f-0fa652b8f2c5、请求4963541b-3ad4-4ac6-9f5a-d299e4622054绑定。第一条SDK连接标量读取，第二条仅诊断采集；构建查询3/5/3ms、系统身份64/73/68ms、状态5/4/3ms（主机整数毫秒计时）。通知receivedHostMs6793，前置系统6795–6868/构建6868–6873/状态6873–6878；三读83ms、通知到状态结束85ms，单轮符合250ms原门禁。前轮1125/243ms是不同进程/运行的旧命令整段，不作稳定AB对照或整页提速比例。

真实15帧包含QueueHoldProvider.lambda$call$0→CountDownLatch.await，未达32帧截断上限。主线程暂停12ms，resumeAcknowledged/resumeVerified均true；设备保守夹取173655959–173655979（20ms，含1ms取整上界）在同任务排队期间。hold 173654507–173656307，实际1800ms；SDK posted173655370/entered173656322/ended=settled173656330，排队952ms后完成。源码门禁及本机/安装摘要、系统和运行来源前后匹配，capture completed、日志关闭、三条自有转发62594/62622/62636移除；最终任务settled、hold结束、原业务组件/窗口/PID恢复均确认。报告后独立只读复核同窗口/PID、forward列表为空；安装记录和派生计时另存`update-record.json`，未改原报告。无第二次请求/取栈或补跑，旧失败原样保留。

此轮证明样例上的真实并发标量读取、250ms准入、命中预期人为等待和恢复/清理，不证明业务冷启动因果、图片/像素、整页速度、长期稳定性或所有Android权限边界。运行代码未改，前轮545项/构建结果保留、不冒称本轮重跑。下一项先本地解决processInstance依赖成功预备树的前置问题，再规划业务显式单请求；不直接更新/重启业务。未提交推送。

### 2026-10-07：无UI诊断身份引导，本地通过、未安装

SDK新增`read-diagnostic-identity`，在原采集监视器外读取固定标量；Binder和已有Session均可路由，shell UID2000/Debug/预期PID字符串/64位小写十六进制nonce限定。返回六项result/protocol/nonce/pid/processInstance/sourceSha256，无树遍历、绘图、UI任务或Session创建；原实例绑定的构建/任务读取不放宽。

`scripts/sdk-queue-bootstrap.ts`导入/构造无设备副作用；显式单次入口先核可信本机APK/AAR及安装摘要、实际系统stat/cmdline/stat，再发一次2000ms标量查询，随后复核安装摘要/路径和系统PID/startTicks。主机内部生成32字节随机nonce、严格匹配回复；每入口只执行一次，失败/取消也消费，拒绝旧回复、并发重放、旧SDK、错来源/进程复用/换包和迟到。SDK不保存nonce历史；查询码是关联而非认证，不宣称服务端全历史防重放。无SDK客户端/转发/采集/暂停资源，预检在250ms通知门禁外，不增加原预算；不发启动/重启/安装命令。

75项/11文件定向回归通过（9.63秒），包括编译实际SDK查询/Session Java源码，无预备树且持采集锁仍可读；生产本地文件摘要、系统/安装解析器与实际单命令格式联测。全量555项/92文件/0失败（100.22秒），日志`/tmp/inspector-queue-bootstrap-full-tests.log`；桌面/CLI/MCP和SDK Debug、sample Debug/Release离线构建通过。Release只有classes.dex，未检出HierarchyProvider、QueueHoldProvider、QueueObservationActivity、SDK类路径或新诊断方法；apkanalyzer解析Manifest仅有MainActivity，无Provider/测试Activity。Release APK SHA256=cb0043207e6c4f24b9530fdb0c4982d31ab0106bcda543995d3b06f543ebee9b。

本机新Debug APK SHA256=913b327e2f901c0472b505249c2a6c7fd5c310e7eeeb1cb2e768b8d78669b487；SDK Debug AAR=9b600ebe0e4e269890eeb91a0edf9648f6b60858402801937d952a531c3fcf69；产物内来源标记一致sourceSha256=7e80ca0daaec128ec4cafc77ff4e1cb29399b89111498baf9bbc6037a854ef34。使用生产本地验证器实际摘要前后匹配；不是安装包或设备运行身份验证。

本轮未执行任何手机命令、安装、重启或桌面运行包替换，未提交推送。Java UID/锁和设备命令边界仍是替身，不外推Android Binder或业务冷启动结果；手机仍为上轮源码/安装状态，新构建不继承旧样例通过。下一项只本地串联业务显式单请求入口，不要求预备树，验证失败留证/取消/唯一请求与收尾；业务SDK更新及一次冷启动取证另明确范围，根因未解决。

### 2026-10-07：业务显式单请求入口串联，本地通过、未调用手机

`scripts/sdk-queue-business-probe.ts`新增单次`createQueueBusinessProbe(target).run(signal)`及仅显式`--run`的独立脚本入口，要求已观察的主进程PID/startTicks和可信APK/AAR绝对路径。构造/导入不执行设备或产物留证操作；先无UI引导身份，再生成新UUID、准备独立标量读取器，观察库校验与引导相同的APK/AAR摘要/源码和安装路径，再预备第二条采集连接/JDWP、订阅日志、发一次classic诊断请求。预备树固定0，没有样例hold、启动/重启、取图、导航或重试；未增加桌面/打包CLI默认行为。

统一15秒操作期限涵盖身份/准备/观察，原250ms新鲜度、32帧上限和恢复门禁不变；纯身份读取消有界返回，迟到不建立连接；资源准备不抢先返回而漏收尾，暂停后先恢复，再核状态/身份和结束原请求，最后关闭读取连接。自有SDK关闭为幂等，任何读取/采集/JDWP清理未确认均不报告成功；原观察结果、捕获失败及各清理结果分别保留，捕获失败不冒充UI采集成功。SDK满员则停止，不关闭外来客户端/共享服务器。CLI先创建可写留证目录，再运行；SIGINT/SIGTERM请求取消且保留必需恢复/收尾，结束后保存本次JSON，不覆写旧报告。强杀或断电不保证报告落盘。

新增13项入口回归：无树/唯一请求/顺序与独立客户端、旧SDK/错来源/进程或产物替换、前置取消/20ms替身期限/迟到、准备阶段取消等待收尾、满旧通知/已进入拒绝、暂停期间取消先恢复、读取/采集/JDWP清理失败拒绝。两条实际本机SDK TCP用生产适配，最大客户端2、只1个capture、三条自有转发清空、Socket全部关闭；该联测JDWP请求、ADB/安装/系统进程为替身，没有安卓命令。原观察/JDWP/日志的本机TCP和子进程回归继续通过。

首次定向99项通过/1失败，是新测试把“forwardRemoved未确认(undefined)”误要求为显式false；实际代码已返回失败并保留forwardError。改为仅true才确认清理，没有放宽成功门禁或补发remove。修正后100项/10文件/0失败（5.09秒），日志`/tmp/inspector-queue-business-focused-tests.log`；全量568项/93文件/0失败（99.51秒），日志`/tmp/inspector-queue-business-full-tests.log`。桌面/CLI/MCP构建通过；测试类型签名已修正且tsc通过。

本轮SDK/Android源码与产物未改或重建，未安装/重启/导航手机App、未更新运行桌面、未提交推送。旧设备结果/失败报告不变，本地链路不是业务冷启动实测或根因修复。下一项只读核对业务工程、新SDK与可信Debug包来源/签名/接入位置，准备同签名保留数据覆盖方案；实际更新与一次冷启动取证另明确范围，不重复样例hold。

### 2026-10-07：业务 SDK 更新只读准备完成，未构建/安装

本机证据`.benchmarks/queue-business-update-dcN7l4/preparation.json`记录业务工程修订、Debug专用AAR接入、构建任务/Java版本、签名基线和设备前后核对；源码/原始设备信息只留本机。当前可信旧业务APK SHA256=2d8b33793c993eaee55e439164e1684e12441d34793cde8139202f4de8a328d1，与手机同一base.apk前后完整摘要一致，因此可绑定该APK的实际验签结果，未使用样例签名代替。签名校验成功但有9条META-INF未保护条目警告，原文保留，不称所有ZIP条目已签名。

旧包资产列表没有`assets/inspector-sdk-build.json`，实际Provider位于classes59.dex，没有`read-diagnostic-identity`；新诊断入口的本地可信产物准入正确拒绝旧包，未发设备/SDK请求，不给旧包追加假资产。新版AAR SHA256=9b600ebe0e4e269890eeb91a0edf9648f6b60858402801937d952a531c3fcf69，sourceSha256=7e80ca0daaec128ec4cafc77ff4e1cb29399b89111498baf9bbc6037a854ef34，与当前源码/配置重新计算值相同；Provider、Session、BuildConfig与当前编译类逐字节一致，实际Provider身份协议/来源代码存在。只读核对期间本机APK/AAR摘要再次一致；来源关联不是密码学认证，新业务产物未构建、其签名/DEX/资产仍待核对。

26项/3文件本地回归0失败（270ms）：`sdk-queue-build`、`sdk-queue-bootstrap`和`sdk-queue-business-probe`。只验证本地准入、唯一请求与清理边界，不当真机SDK/冷启动测试；上轮568项全量及构建未在本轮重跑。步骤写入[SDK更新](../../android/README.md#business-sdk-update)：固定输入→业务构建→签名/来源/代码门禁→授权覆盖→设备完整SHA→另明确一次冷启动观察。未构建/安装/启动/重启App、改compile/reset、执行SDK查询/树/图/暂停或替换主桌面，未提交推送。根因未知，旧报告/失败原样保留。

### 2026-10-07：业务 SDK 同签名更新完成，首轮在主进程读取前置阶段结束

本机`.benchmarks/queue-business-deploy-5s01p2/`留存冻结输入、旧业务APK备份、构建/实际代码校验、安装/冷启动原始报告及后续只读记录。业务构建3分50秒；新APK SHA256=caff6c4cb7150db67c126e6a0f7426e00ad3080e29b0bc3c1e8f33fd50e4b573，新旧实际签名一致。复用已核对的固定AAR（9b600ebe…，source=7e80ca0d…），SDK源码/Android AAR没有再改或重建。新包90个DEX全部检查无sample/hold代码；classes59.dex的实际Provider身份方法包含shell/Debug/PID/nonce限制与正确来源，Binder锁外调用和Session合成桥的实际目标已核对，BuildConfig/资产一致。初次本机校验误要求Session直接dispatch，Java8实际为合成桥；保留`verification-first.log`，按桥实际目标补严校验后通过，未改SDK或放宽授权。

安装前再次核对当前手机旧包完整SHA和签名基线，只执行一次`install -r -t --no-streaming`，48.14秒返回Success；`install-report.json`保留passed=true与前后包路径/SHA、新Debug/版本字段。手机新APK完整SHA等于可信新包，未卸载/清数据、compile/reset或替换主桌面；不继承旧verify/性能状态。签名未保护条目警告原文保留，来源资产不当安全认证。

授权一次`am start -S -n`冷启动，启动命令399.56ms返回；随后首次pidof没有取得主进程，本次`cold-report.json`passed=false，launch=1、diagnostic=0，整个驱动2.559秒（包含产物预检，不是App启动耗时）。首次命令退出码/信号未保存，不能认定具体退出原因，也不能记为SDK排队或身份引导失败。未调用引导/SDK/树/图/JDWP暂停，失败结束后不补跑。后续只读确认主进程/首页Activity已出现，不能作为首采/第一帧或阻塞栈证据。

修正只读`observeQueueMainProcess`：固定1秒/10次pidof，空回复或退出1且stdout/stderr都是空Buffer才继续；一旦发现PID，单读系统stat→cmdline→stat确认真实主进程/startTicks，错误/复用/歧义/迟到/超时/取消拒绝。不取树、建SDK连接、调用诊断或发启动命令；显式入口仍要求已观察身份，15秒/250ms/32帧门禁不变。原驱动保存为`driver-before-main-observation.ts`，修正驱动未重跑；新驱动另保存错误退出信息，不给旧报告补写未知字段。

33项/3文件定向0失败（235ms），全量572项/93文件0失败（98.97秒），桌面/CLI/MCP构建通过；冷启动缺PID路径和权限/迟到/取消为本地替身，不当真机故障验收。`post-cold-readonly.json`仅验证已运行主进程路径，pidReads=1、131.60ms，系统身份与安装新SHA确认、转发空，SDK/采集调用均0；不将此元信息耗时当启动或整页收益。无再次安装/启动或恢复采集、无主桌面替换、无提交推送。下一项另授权仅再一轮冷启动取证，根因及业务栈尚未完成。

### 2026-10-07：新一轮主进程观察通过，SDK身份命令失败，停止且补本地错误留证

本机独立`.benchmarks/queue-business-cold-zuBWyi/`引用上轮冻结可信APK/AAR与安装证明，不复制或改写旧`cold-report.json`。本轮未构建/安装、清数据、compile/reset或替换运行桌面；前后手机完整APK摘要与可信caff6c4c…新包匹配。只授权并执行一次启动，不调用预备树或样例hold。

启动命令525.81ms返回；固定1秒/10次观察实际3次PID检查、431.32ms取得真实主进程及stat→cmdline→stat身份。新报告launch=1、diagnostic=1，主机约启动命令起算1.006秒进入业务入口，5.096秒返回identity-failed；引导1次、身份content命令发起1次，captureCalls=0、树/图片/暂停均0，无SDK/JDWP连接或排队观察。不把4.091秒整个引导阶段当单条查询耗时，也不把8.058秒驱动总时长当App启动耗时。

原失败仅有命令错误文本，缺退出码/信号/输出，不能认定超时、权限或Provider未就绪；主机发命令不证明App方法执行。后续只读`postcheck.json`确认同一主进程/startTicks与新安装SHA、转发空；日志不属于启动区间，不作为阻塞根因。旧首次缺PID报告和本轮identity-failed都保持false，不补跑、恢复采集或再次SDK查询。

两项新回归先复现业务入口丢失命令错误字段。随后只修改主机错误留证：保存code/killed/signal及字符串/Buffer输出，各4096字符并标截断，空值保留、非法/缺字段不猜，原错误和状态不变。测试覆盖真实本机子进程退出7与有界超时，以及输出/未知类型/单次消费/报告不受晚改影响；不调用adb，不将本地超时当手机命令原因。原SDK及2000ms身份查询、15秒操作、250ms通知、32帧门禁不变，旧报告不追加伪造字段。

35项/3文件定向0失败（447ms）；全量574项/93文件0失败（98.51秒），桌面/CLI/MCP构建通过。最后补保留真实null退出码后，再跑35项定向（460ms）和完整构建通过，未再跑全量；原始日志在本轮独立目录。没有第二次启动或诊断、SDK/Android重建、默认桌面替换、提交推送。下一项只本地复核早期SDK前置依赖与现有系统/JDWP候选；业务栈、根因和冷启动成功仍未完成。

### 2026-10-07：启动前置依赖本地复核，修正退出0的身份错误输出留证

本轮仅源码/历史证据读取与本地回归，目录`.benchmarks/startup-prerequisites-NuLDT7/`；没有任何手机ADB调用、启动/安装/SDK查询/树/图/暂停或compile/reset。上轮缺PID与身份命令失败报告未改，没有恢复采集或追加实机尝试。

核对本仓库Provider的初始化/锁外读取、身份执行器及现有启动原语和旧一次性驱动。查阅Android 14 AOSP固定标签的ActivityThread、ContentProviderHelper、Content命令：SDK标量方法不排UI任务，仍须Provider已发布；PID不是发布证明，外部获取也可能等待或触发系统拉起进程。此为源码机制，不是上次真机失败原因，厂商差异未验。具体来源与分工见[失败复核](STARTUP_FAILURE_REVIEW.md#启动前置依赖与取证分工)。

发现主机执行器原先只留成功退出的stdout，content访问异常可在stderr记录后退出0。新增4项回归先失败（25通过/4失败），随后保留两个输出流：各4096字节准入；无效/未授权/错nonce回复或AOSP明确访问错误仍拒绝，错误保留code=0/输出而非猜超时。有效回复遇正常daemon提示仍通过；兼容旧字符串执行器，但未知stderr不伪造为空。输出留证各4096字符，截断标记传到业务报告；畸形输出、取消/迟到和单次消费仍拒绝，失败不建SDK/JDWP资源或发采集。实际本机子进程退出0+stderr联测不是Android Provider等待复现，旧原始失败缺字段不补写。

39项/3文件定向0失败（455ms），91项/6文件相关0失败（2.68秒），全量578项/93文件0失败（100.95秒）；桌面/CLI/MCP构建通过。原SDK代码/2000ms身份命令/15秒业务操作/250ms新鲜度/32帧预算不变，未重建Android或替换运行桌面，未提交推送。

方案采用两条明确入口：SDK之前的系统/JDWP启动观察与SDK身份确认后的原排队观察，不自动失败回退，不填假SDK实例/通知。历史驱动的tcp:0归属、弱系统身份和窗口未知判定尚不能复跑；已有原语测试不等于独立入口完成。下一项仅本地抽取当前marker自有转发，保留原SDK行为/收尾回归；后续明确完整门禁/截止线才接新入口，实机另明确范围。冷启动成功与业务阻塞根因仍未完成。

### 2026-10-07：抽取自有调试转发，原SDK路径回归通过

本轮只做本地代码/文档与测试，证据目录`.benchmarks/owned-forward-oHWqGG/`。从`sdk-queue-device.ts`抽出既有端口选择和转发租约到`owned-debug-forward.ts`，SDK两条转发直接共用；不复制历史tcp:0驱动、不伪造SDK实例/通知，也不内置默认ADB执行器。保留marker前缀、--no-rebind预约、750ms独立资源命令、8192字节/128行限制及一次幂等收尾。直接调用新增设备/远端准入校验，资源归属不代替安装包/进程/窗口准入或暂停授权。

新增13项直接回归：JDWP/localabstract原命令顺序、非法目标/端口、选端口及预约/绑定/完成后取消、丢创建/绑定/删除回复、已有映射/预约竞态/观察到的外来重绑定拒绝、坏/歧义/字节/行数上限、归属查询失败、两条不同租约及默认端口释放后的真实本机TCP。所有ADB映射为替身；本机TCP不是真实USB转发验收。无法确认归属或清理时保留失败，不盲删；没有remove-all或失败重试，ADB无原子比较修改能力，任意外部重绑定竞态仍不保证。

104项/7文件相关0失败（2.64秒），全量591项/94文件0失败（99.40秒），桌面/CLI/MCP构建通过。没有手机命令、启动/安装/SDK查询/树/图/暂停或compile/reset；SDK未改/重建，运行桌面未替换，旧失败报告未改，未提交推送。下一项先本地实现可信安装/真实进程/Activity/同轮启动时刻及新鲜窗口准入，再接总截止线和完整入口；本轮抽取不是早期启动实机证据或冷启动修复。

### 2026-10-07：独立启动身份/窗口准入本地完成，尚未接取栈

目录`.benchmarks/startup-admission-Igls2B/`。新增`startup-window-admission.ts`及16组直接回归，不改SDK或原采集。显式执行器由调用方提供；复用已安装单包SHA/路径和stat→cmdline→stat，严格绑定唯一前台Activity token及主进程。WindowState自身package/session/Activity建立归属，不用标题或IME引用替代；未知/歧义/外来焦点、进程/Activity/安装路径变化拒绝。新鲜窗口在身份夹取后再读，窗口已登记即结束；只认u0/主显示器，未知厂商格式不当无窗口。

从调用方同轮单调启动时刻起共15秒（含前检），沿用12秒触发；至多16次观察、单次run与暂停前一次复核。初版构建一处匹配数组类型标注失败，已修正，原构建日志保留。额外回归先复现换取消信号仍可继续复核（15通过/1失败），随后绑定初次run信号，原信号已取消/被替换时不再读；不重启期限或重复复核。最终91项/6文件相关0失败（2.37秒），全量607项/95文件0失败（99.13秒），桌面/CLI/MCP构建通过；前一版606项全量也通过，但不替代取消修正后的最终结果。

读取一份历史正常窗口记录离线解析通过，只验格式、不复用旧PID/时刻或补称启动成功。依据Android 14固定标签的ActivityRecord/WindowState/Session字段，来源见[启动复核](STARTUP_FAILURE_REVIEW.md#启动前置依赖与取证分工)。顺序查询非原子快照，window-ready不是第一帧；APK摘要是调用方已审查产物断言，初始SHA后的路径夹取非持续字节证明，最终驱动还须核对安装摘要/身份并绑定真实启动及授权。

所有设备命令是替身，实际手机/ADB/启动/安装/SDK查询/树/图/连接/暂停均0；没有Android构建、compile/reset、桌面替换、提交推送或改旧失败。完整取栈入口未实现，下一项仅本地接18秒操作、独立恢复1秒/清理3秒、一次32帧及恢复后符号解析；真实本机TCP与失败/丢回复/取消回归先行，实机另明确范围。冷启动根因与成功仍未完成。

### 2026-10-07：独立启动单次取栈库本地完成，真实驱动仍待接

目录`.benchmarks/startup-stack-entry-PYrIHz/`。新增`startup-stack-observation.ts`，提取`jdwp-main-stack.ts`供原SDK排队与新入口共用；直接复用独立窗口准入与marker转发，不查询SDK、伪造身份/通知或重跑历史tcp:0驱动。操作从同轮启动起算18秒，窗口仍15秒/12秒新查；一次最多32帧、暂停前一次复核、恢复计数确认后解析符号、最终安装SHA与进程/Activity/窗口复核。独立恢复1秒、连接/转发共3秒，不用Dispose或删除成功代替恢复证明。

新增19组真实本机TCP+设备命令替身回归，覆盖正常窗口跳过、未知身份、JDWP不可用、取消/迟到、丢暂停/帧/恢复回复、预先暂停、断线、截止线、末次身份改变、符号失败和外来/未知转发清理。写出前拒绝不恢复；原始帧、最多1060字节帧回复与多阶段错误保留。初次两项测试错误分别是替身匹配activities名称写错、迟到用例已越过15秒所以应当零读取，修正测试输入后通过，不能称产品修复。

转发未结束反例另先失败：超时的创建命令尚未结束，随后的空列表被错误当清理成功（`unjoined-before.log`，0通过/1失败/18过滤）。加入未结束命令门禁，停止后续修改并记录资源未知；迟到创建可在替身出现，但不会改已返回报告或盲删。最终126项/8文件相关0失败（6.80秒，`related-complete.log`）、626项/96文件全量0失败（102.85秒，`full-complete.log`）、桌面/CLI/MCP构建通过（`build-complete.log`）。旧625项全量/早期日志保留，不替代最终结果。

手机/ADB/启动/安装/SDK查询/树/图/真实连接/暂停均0；本机TCP协议命令不是安卓调试暂停。无Android构建/SDK更新、运行桌面替换、compile/reset、提交推送或旧报告修改。库无实际启动、默认设备执行器或留证写出；同轮时刻/授权是调用方断言，不是实际启动/人类授权证明。下一项仅本地接显式驱动、子进程取消/结束和有界命令输出/JSON留证，实机另明确范围。业务栈、冷启动根因与成功仍未完成。

### 2026-10-07：显式启动驱动、真实主机子进程与JSON留证本地完成

目录`.benchmarks/startup-explicit-driver-WAqZ3T/`。新增`startup-command-runner.ts`、`startup-stack-probe.ts`，导入/构造不做I/O；源码CLI需`--run --allow-launch-and-pause`并固定设备/包/组件/可信APK摘要。先预留可写报告、核本机及安装SHA/Debug/未运行，再仅一次启动，实际派发时刻/runId、新观察主进程与单次库绑定。启动前15秒、派发起18秒及窗口12/15秒不增；不会安装/强停/清数据/编译/SDK请求/采集或重复启动。

真实主机子进程通过shell-free执行；超时/取消只SIGKILL自己创建的进程，保留实际退出码/信号、两路前4096字节及截断，close确认才称结束。已退出父进程的继承管道不无限持有收尾；外层取消仍可返回未知失败，未确认退出/清理保留已读片段，迟到不改报告。正常窗口/JDWP不可用无栈、一次32帧/恢复/末次身份及有界原帧回复均在最终JSON保留。Starting或exit0不冒充就绪，截断stderr不能当无警告。

19项新增回归，真实本机子进程+TCP，设备命令仅夹具。初次`initial.log`失败是中文路径使用URL pathname被编码，改为fileURLToPath后15项通过（`paths-fixed.log`）；不是Android启动失败或业务修复。补期限/丢PID/未结束执行器/继承管道及真实CLI缺授权拒绝；完整覆盖授权目标、预检/一次消费、错误/警告/截断、取消/退出/迟到、取栈恢复及最终JSON。最终145项/10文件相关0失败（11.47秒，`related-final.log`）、645项/98文件全量0失败（107.66秒，`full-complete.log`）、完整构建通过（`build-final.log`）；早期日志保留不替代最终结果。

手机/ADB/实际启动/安装/SDK查询/树/图/安卓连接/暂停0；未修改SDK、部署/重启业务App或运行桌面、提交推送或回填历史失败。参数确认不是人类身份认证，派发不是实际成功启动，主机close不是Android启动任务撤销证明；本地替身不证明手机恢复或冷启动修复。下一项另明确范围的一次真机取证，已运行即停，不提供默认自动回退。

### 2026-10-07：一次真实启动前只读预检，App已运行所以停止

目录`.benchmarks/startup-device-admission-RUHo2x/`，`preflight.ts/preflight.json`。设备在线，可信本机APK重新计算完整SHA，与设备单APK SHA及前后安装路径一致；Debug标记/run-as、唯一启动入口、实际stat→cmdline→stat和最后同进程复核通过，转发空。留证保存实际命令/两路有界输出/退出及完成状态，命令均已结束。此轮是当前真实读取，不借旧PID/摘要报告冒充复核。

主App已运行；按当前计划未执行启动驱动，启动/强停/安装/SDK请求/树图/暂停均0，没有改运行App/桌面/SDK、编译状态或旧失败，也未提交推送。已向用户请求一次强停后冷启动和必要短暂取栈许可；许可未到不执行，获得后重新预检并观察新PID/startTicks，不沿用本轮身份/时刻。只读通过不是启动、取栈、恢复或根因验收，本轮无生产源码改动，未重跑645项本地测试。

### 2026-10-07：一次授权独立冷启动，JDWP基础读取超时，未暂停/取栈

目录`.benchmarks/startup-device-once-4j2Kd3/`。用户明确允许一次强停后冷启动与必要短暂取栈；`run-once.ts`先以wx预留报告，固定可信本机/安装SHA、Debug/run-as、唯一入口与空转发，才强停一次并调用一次新驱动。原文`summary.json/run.log`，独立驱动`startup-stack-agl0Dw/input.json/launch.json/report.json`，脱离原始输出的结果索引`result.json`。guard防同目录重放，许可已消费，没有第二次启动、安装、SDK请求或采集。

启动命令126.452ms返回code0/无stderr；派发后385.752ms完成新真实主进程核对。12秒新窗口观察后仍无本包主窗口，12.828秒进入自有转发；已知端口+marker归属核对、JDWP握手通过。但准备主线程的首条VirtualMachine.IDSizes（1/7）200ms内没有匹配回复，13.090秒前记录`prepare-main: JDWP timeout 1/7`。步骤未到prepared-main/sample，0帧/0主线程Suspend；恢复字段不伪填通过，未进入恢复事务。

最终独立安装SHA/实际进程/Activity复核通过，主窗口未登记；socket实际close、自有转发删除与后读确认、命令退出通过，清理48.900ms。最后操作命令16.113秒前结束；后查仅安装SHA、同新进程/Activity/窗口及转发，安装未变、所查主窗口仍无/focus=null、转发空，所有命令已退出。整个外层24.285秒含启动前预检和独立后查，不能称启动耗时或主线程阻塞时长。

强停/启动各1，SDK请求/树/图/主线程Suspend/安装各0；未清数据、编译/reset、改SDK或运行桌面、更新主程序、推送提交或回填旧报告。失败保持observation-failed，不补跑/恢复采集。本轮生产代码未变，未重跑645项本机回归；真实身份/入口/清理验证不等于真实取栈/暂停恢复或冷启动首采通过。

现有协议错误缺握手/实际写出/收包/异步事件/晚到与关闭时序，不能归因为权限、ART阻塞或200ms预算；握手通过不证明后续请求被处理。下一项只在本地补有界传输留证和真实TCP故障回归，维持预算、单次/取消/恢复规则，不自动启动下一轮手机。

### 2026-10-07：JDWP收发时序本地完成，未再次操作手机

目录`.benchmarks/jdwp-transport-evidence-B6VkAu/`。独立启动观察接入可选传输记录，SDK既有调用默认关闭；最多64条元数据（首条+最新63条）、丢弃数、固定握手/实际关闭里程碑。主机单调时间、请求编号/命令/长度及入队/本机写出/匹配回复/未匹配/超时/关闭分别记录，不存业务载荷或任意异常内容。最终JSON绑定runId，独立快照防迟到或调用方修改。

新增12项真实本机TCP测试与1项观察库联测。`before.log`先10项失败（缺诊断方法），最终相关158项/11文件0失败（12.38秒，`related-final.log`）、全量658项/99文件0失败（108.42秒，`full-final.log`），桌面/CLI/MCP构建通过（`build-final.log`）。覆盖分片、异步同编号事件、200ms超时/晚到、不回复、取消/拒绝、协议/连接错误、close及超限；晚到旧回复不能满足新请求，返回报告保持不变。

手机/ADB/启动/安装/SDK请求/采集/安卓暂停均0，未改SDK或运行桌面、提交推送或回填旧报告；本机协议夹具不当安卓暂停验收。没有增加200ms/总预算、等待或重试。写出不证明手机处理，未匹配不自动称晚到；新记录尚未用于真机，业务根因仍未知。下一项另明确范围后一次真机观察，旧强停/启动许可不继承。

### 2026-10-07：新收发观察前只读预检，App在运行所以停止

目录`.benchmarks/startup-transport-device-admission-M8g0Ur/`，`preflight.ts/preflight.json`。设备在线，重新计算本机可信APK与设备完整SHA、前后安装路径一致；Debug/run-as、唯一入口与前后真实stat→cmdline→stat一致、转发空。11条命令均正常退出并确认close，预检共4.117秒，不称启动耗时。当前进程仍存在，按约定不自动强停，不沿用上一轮已消费的启动/暂停许可。

启动/强停/安装/SDK请求/采集/暂停均0，未建JDWP连接，尚无新的传输时序；未改生产源码/SDK或运行桌面、提交推送或旧报告。本轮没有重跑658项本机回归，上一轮测试只作为对应源码的历史结果。获新的一次冷启动及必要短暂取栈确认后，重新核包和新进程，不复用本次身份/时刻。

### 2026-10-07：带收发记录的单次真机冷启动，确认成功回复晚到

新授权一次强停/启动及必要短暂取栈，目录`.benchmarks/startup-transport-device-once-8G7Fzg/`。`run-once.ts`以wx报告防重放，重新核本机/安装SHA、Debug/run-as、唯一入口、空转发及真实旧进程后仅强停1次、驱动1次、启动1次；独立驱动`startup-stack-gpxTUB/input.json/launch.json/report.json`，外层`summary.json/run.log`与脱敏`result.json`。安装/SDK请求/采集各0，旧预检和旧失败不变。

启动命令124.42ms返回，新进程身份通过；12.900秒后进入JDWP，握手3.095ms完成。编号1/命令1/7/11字节唯一请求在连接起3.414ms本机写出，207.809ms超时，378.105ms收到同编号31字节/errorCode=0回复。相对写出：超时204.396ms、成功回复374.691ms；回复晚于超时170.296ms。共13事件/0丢弃，没有异步事件或第二条请求；最终JSON与返回结果逐字段一致，runId一致，晚到回复保持unmatched不改失败。

0帧/0主线程Suspend，恢复字段未伪填通过。最终安装/真实同进程/Activity通过，socket实际close、自有转发删除/后读及命令close确认；清理33.691ms，最后操作命令派发后15.697秒前结束。独立只读后查同安装/进程、转发空，所查主窗口未登记/focus=null。整个外层22.684秒含预检和后查，不称启动时长或持续阻塞。

本轮证实成功回复晚于200ms预算，不是完全无回复；时差不等于ART单独处理耗时，不能外推旧轮同因或稳定性能。没有重试、改预算/SDK/运行桌面、安装/清数据/compile/reset、提交推送或旧报告回填。生产源码未改，未重跑658项本机回归；下一项仅本地首条只读请求预算测试，授权已消费，不再启动手机。

### 2026-10-07：首条独立启动只读预算500ms本地修正

目录`.benchmarks/startup-first-request-budget-malVwI/`。生产仅改`startup-stack-observation.ts`：第一条未暂停IDSizes上限500ms，其他仍200ms；准备每次读取夹取原3秒与同轮18秒剩余期限，回复到期拒绝，不重置时刻、不自动重试。SDK/共享JDWP与取栈原语未改，暂停/恢复/窗口门禁及实际close和自有转发规则保留。

新增8项真实本机TCP回归，`before.log`先22通过/6失败；实现后28项通过（6.05秒，`initial.log`）。375ms成功且后续/恢复200ms、600ms晚到仍失败/失配/报告不变、后续200ms超时、准备余量150ms/3秒到期、18秒余量、取消/断线均覆盖。相关166项/11文件0失败（14.92秒，`related-final.log`），全量666项/99文件0失败（109.76秒，`full-final.log`）。初次构建`build-initial.log`仅测试可选字段非空类型检查失败，补仅类型断言后最终28项复测0失败（6.02秒，`typed-final.log`）及构建通过（`build-final.log`）；非空断言擦除后测试运行行为不变。

手机/ADB/安装/启动/SDK请求/采集/安卓暂停均0，未改SDK或运行桌面、提交推送或旧报告。旧真机374.69ms晚到仍保留失败，不以本地500ms补称其成功；本机样例不证明手机暂停/恢复或稳定性能。下一项另确认范围后的单次真机验证，已消费授权不继承。

### 2026-10-07：500ms首条配置单轮真机取栈/恢复通过

目录`.benchmarks/startup-first-budget-device-once-QvQaYo/`，`run-once.ts/summary.json/run.log`，独立驱动`startup-stack-O9Wg8j/input.json/launch.json/report.json`，索引`result.json`。新确认一次强停/启动及必要短暂取栈；wx报告防重放，重新核本机/安装SHA、run-as/唯一入口/空转发与真实旧进程后强停1次、启动1次，新PID/startTicks重新观察。首条500ms、其他200ms/准备3秒/操作18秒/恢复1秒不扩大，无SDK请求/采集/安装或自动重试。

启动命令114.431ms返回，启动后13.083秒连接JDWP、握手5.657ms。准备与暂停前窗口/身份复核通过，真实30帧（原帧回复994字节）及30帧符号；主线程单点命中业务安全模式初始化的同步等待。暂停13ms后Resume回复和SuspendCount=0确认，恢复3.742ms；最终安装/真实同进程/Activity通过，socket实际close、marker自有转发删除及后读、所有本次命令close确认，清理56.400ms。最后操作命令派发后16.942秒前结束；两个pidof退出1为空回复的正常缺进程记录保留，不称所有命令exit0。

独立只读后查安装SHA/同新进程不变，转发空，所查主窗口未登记/focus=null。外层26.233秒包括启动前预检和独立后查，不称启动/阻塞时长。保存JSON与返回结果逐字段相等、runId一致；stack-collected只确认本轮取栈/恢复/身份/清理，不是SDK首采或首帧验收。

传输累计212事件，保留64条/丢148条；首条请求精确预算/收发与暂停恢复事件已被后续符号查询挤掉。不能算出首条耗时或宣称该轮200ms必然失败/500ms稳定必需；固定握手里程碑仍在，原报告不补写。只读业务同名源码的等待有超时，不是永久阻塞证明；本次触发状态/退出原因和部署源码对应未核，私有源码与原始符号留本机，不公开。

本轮未清数据、改生产源码/SDK/运行桌面、安装/compile/reset、提交推送或旧失败；未重跑666项本机测试。许可已消费，未发第二次启动或恢复采集。下一项只本地补固定首条关键摘要、超限/晚到/快照回归，不加协议请求、等待或重试；随后核对新栈的触发与完成路径，设备范围另确认。

### 2026-10-07：首条固定摘要不再随环日志淘汰

目录`.benchmarks/startup-first-summary-XG72zn/`。仅改共享诊断库的可选记录、独立观察的报告类型和两份相关测试：原64条环日志及丢弃数不变，在日志外存固定首条标量。保留编号/实际命令/预算、创建/入队/本机写出、首次结束、首次晚到与长度/错误码/白名单原因；匹配错误码不当成功，超时/取消/失败不被重复或晚到改写，未分配编号/握手失败不伪造交易。快照独立复制、实际close后冻结，SDK既有调用默认记录关闭，没有新协议请求/等待/重试或预算改变。

新增6项真实本机TCP回归，加固既有取消/关闭/超时断言；超过260个后续异步事件让首条日志确实被淘汰，摘要仍保留。覆盖正常、匹配错误/重复回复、首次晚到、取消/派发拒绝、无首条、待处理与结束快照隔离、默认关闭。先`red.log`17项9通过/8失败；实现后`transport.log`17通过，再新增待处理取消/晚到回归，最终`transport-final.log`Node18项0失败（1.11秒）。`related.log`143项/11文件0失败（12.62秒），`full.log`672项/99文件0失败（110.91秒），`build.log`桌面/CLI/MCP构建通过。

无手机/ADB/安装/强停/启动/SDK请求/采集/安卓暂停，未改业务/SDK/运行桌面、提交推送或旧报告；新摘要尚未实机验证，不能补写上轮丢失时序或宣称冷启动修复。下一项本地只读核对安全模式触发与等待完成路径，设备实际状态及部署源码对应保留未知。

### 2026-10-07：安全模式只读源码及保存APK机制复核

目录`.benchmarks/startup-safe-mode-review-dq1czj/`，`verify-artifact.ts/verify.log/artifact-review.json`及6份选定类的解码字节码/错误输出。保存APK前后SHA与上轮真机安装核验一致，19项离线产物断言通过；本地源码路径/散列/仓库版本只写私有报告，所读业务文件无未提交改动。本轮不访问设备，没有生产/业务源码改动、构建/安装或全量测试重跑。起初工具默认Java版本不足，切至已有JDK17；一项内部工作类查询因编译优化不存在而失败，错误输出保留，随后核对实际外层合成方法成功，不将失败空输出当类证明。

选定字节码确认：主进程启动增加持久计数，阈值为正且计数超过阈值进入候选；有效异常/退出另门控，用户主动结束等可排除。完整路径等待累计5通知，参数2+2秒，超时标记或中断后继续，不是永久等待或整个启动耗时上限。退出清零正常预期依赖启动完成与全量配置成功；只出现页面可能尚未清零，计数总和也不按通知类型去重。准备/回调处理异常可能不扣减、指定多补丁事件可能重复扣减，通知不代表任务成功，失败结束标志不代表未通知。

这些是保存APK和本地源码的可证机制/风险，不是上轮设备实际计数、真实待完成任务、实际等待时长、动态补丁或持续启动根因证明；没有证明整个源码与APK完全一致或手机当前安装仍相同。二进制/加密存储与遗留XML不能混为当前值，不读取/解密或改写业务存储。详细私有符号、源码和字节码不进入公开仓库。

下一项仅准备固定白名单、定界和身份/时钟关联的既有日志读取，实际设备范围另确认；日志缺失或无法关联为unknown，不继续重启补证、不清数据/禁用保护/增加预算。旧真机记录不回填。

### 2026-10-07 既有日志读取本地准备

新增`startup-log-reader.ts`，显式一次性绑定目标/安装摘要/真实PID/startTicks、原轮设备时钟和最多3个固定相对文件；复用自有命令执行器，无默认ADB/SDK/JDWP/系统缓冲或桌面CLI入口。18秒操作、独立3秒主机收尾，256KiB/文件、512KiB/轮、2048行/文件、4096行/轮、16命令。完整原文与4KiB命令摘要分别处理，截断/变化/超限/警告/取消/未知退出均拒绝；失败留部分证据，迟到不改报告。

12项新增本地测试覆盖身份/时钟/白名单、长文件、轮转/长度、坏编码/末行、容量、取消/迟到/清理，设备命令均为严格合成替身，真实本机shell只验证非App目录的零读取拒绝。29项相关0失败（3.67秒），684项/100文件全量0失败（113.55秒），桌面/CLI/MCP构建通过；产物`.benchmarks/startup-log-reader-EN3oDa/`。初次类型检查暴露ES2020不支持replaceAll，已换等价正则替换后完整构建通过；未扩大运行目标。

本轮手机/ADB/安装/启动/SDK/采集/暂停均0，业务和运行包未更新，未提交推送。Android工具/FD兼容尚未实机验证；元数据前后一致不是原子快照，主机close不证明远端撤销。原轮时钟缺失直接零命令unknown，不能用当前状态回填；读取完成也不是逐条事件关联或根因定位。下一项确认历史关联证据和固定日志范围，缺失就结束，不再重启补证。

### 2026-10-07 旧轮日志关联停止与文件名修正

固定检查最新真实取栈轮6份原始文件，前后SHA一致，13项离线产物断言通过。预检10/驱动120/后查8，共138条历史命令均close；保存包摘要/新进程与后查一致，但设备bootId、epoch/uptime锚点和既有日志查询均缺失，只有主机墙钟/单调时间。不取当前设备状态补历史，关联停止为clock-unassociated；计数/实际等待/清零顺序未知，原帧/恢复与旧失败不变。源码首次初始化选文件后同进程继续追加，小时命名不表示自动逐小时轮转；未证明设备文件或部署日志实现对应。

通用读取器修复合法冒号文件名被拒绝，增加1项合成单参数路径回归，仍拒绝通配、路径遍历、命令替换/分隔符/引号；没有业务目录/字段加入产品代码。30项相关0失败（4.23秒）、685项/100文件全量0失败（113.20秒），桌面/CLI/MCP构建通过。证据`.benchmarks/startup-log-admission-CvmtMC/`，私有源路径/规则和固定核对器留本机。手机/ADB/日志正文/SDK/启动/安装/暂停均0，业务源码/运行包未改、未提交推送。

该旧轮到此停止，不再尝试回填。下一项需另确认仅当前身份/设备时钟与指定目录有限文件名范围，单独记新观察；不读正文/递归扫描/清日志/解密存储/重启或继承旧启动权限，冷启动复现另确认。

- [2026-10-04 历史归档](LOOKIN_ALIGNMENT_HISTORY_2026-10-04.md) 保留更早完整对照；其中旧待办不驱动当前开发。
- 本次整理前四份完整原文保留于本机 .benchmarks/docs-cleanup/2026-10-05-before/：计划、状态、测试和 UI 记录，可恢复但不提交。
- 其他专项文档保留领域细节。以后只补有价值结论与证据索引，不再次把当前计划写成实验流水账。
