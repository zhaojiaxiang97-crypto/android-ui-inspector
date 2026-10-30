# 文档索引

更新：2026-10-15。架构第八轮已统一 SDK 编码队列、顺序写出与图片流发布，完成旧/新版样例真机对照；R0–R8 各批次已收尾，见[验收](CORE_ACCEPTANCE.md#architecture-round8-acceptance)。Lookin UI五轮共30项已完成源码，最新结果见[第五轮验收](CORE_ACCEPTANCE.md#lookin-ui-round5-acceptance)。Mac arm64安装版仍为此前候选；真实样例、升级/回退及Helper结果按原验收保留。原U系列后续与手机复核继续暂停，本轮仅做架构计划内的自有样例 SDK 验证；历史记录不自动成为待办。

## 当前文档

| 文档 | 职责 |
| --- | --- |
| [第一次使用](FIRST_USE.md) | 从连接自有样例到采集、保存重开、只读共享及停止；含真实2D/3D截图 |
| [项目状态](PROJECT_STATUS.md) | 能力、当前阶段和保留缺口 |
| [Lookin计划](LOOKIN_ALIGNMENT_PLAN.md#下一步) | 当前安排、暂停方向和执行边界 |
| [Lookin 3D层级源码研究与改造方案](LOOKIN_LAYER_RENDERING_REDESIGN.md#8-实施结果) | 单一布局边框、结构轮廓合并、按组件展开和视角衔接已实现；保留源码依据与239层复算 |
| [Lookin后续功能迁移](LOOKIN_MIGRATION_PLAN.md) | 前三项源码完成、后续候选、上游依据与验收边界 |
| [Lookin UI与交互细节计划](LOOKIN_UI_INTERACTION_PLAN.md) | 7项源码已实现；属性栏、工具状态、2D测距、候选、搜索、查看历史与外观 |
| [Lookin UI与交互第二轮计划](LOOKIN_UI_INTERACTION_NEXT_PLAN.md) | 6项源码已实现；树行、查看范围、布局记忆、连续缩放、颜色格式与固定属性参考 |
| [Lookin UI与交互第三轮计划](LOOKIN_UI_INTERACTION_ROUND3_PLAN.md#implementation-results) | 6项源码已实现；单层恢复、分支展开、搜索巡览、图片快捷操作/预览与偏好跳转 |
| [Lookin UI与交互第四轮计划](LOOKIN_UI_INTERACTION_ROUND4_PLAN.md#implementation-results) | 6项源码已实现；画布浮层、属性搜索翻页、隐藏清单、仅边框模式、结构阅读与颜色快捷菜单 |
| [Lookin UI与交互第五轮计划](LOOKIN_UI_INTERACTION_ROUND5_PLAN.md#implementation-results) | 5项源码已实现；2D右键、就地分组管理、局部刷新菜单、预览内输出与准确输入3D展示参数 |
| [验收清单](CORE_ACCEPTANCE.md) | 最近安装版本、关键已验范围和限制 |
| [本机交付](DELIVERY.md) | 固定版本、安装、Helper配置、备份与回退 |
| [测试计划](TEST_PLAN.md) | 验证入口、通过标准和发布门槛 |
| [开发目录](DEVELOPMENT_STRUCTURE.md) | 模块职责、依赖方向和真实代码入口 |
| [架构重构完成记录](ARCHITECTURE_REFACTOR_PLAN.md#architecture-closeout) | R0–R8 已完成；统一批次状态、实际代码边界与八轮验收入口，保留原始审查和实施依据 |
| [Android接入](../android/README.md) | SDK构建/接入；实际安装另限定范围 |
| [CLI](CLI.md) / [MCP](MCP.md) | 命令和授权调试用法 |
| [e2e实验](../scripts/experiments/tester-e2e/README.md) | 确定性用例、报告和数据/模型边界 |
| [截图坐标](SCREEN_COORDINATES.md) / [树性能](TREE_PERFORMANCE.md) / [Windows启动](WINDOWS_STARTUP.md) | 专项实现与环境限制 |

U1–U6c阶段实窗复核使用旧历史和报告，后续首次使用验收另采项目自有样例。用户说明此前是在等待权限确认，原“程序卡住”判断已撤回；版本、结果和原观察分别见[验收清单](CORE_ACCEPTANCE.md)及[沿革](archive/CORE_ACCEPTANCE_2026-10-09.md#ui复刻收口u1u6c2026-10-11)。

## 历史参考

[归档索引](archive/README.md)集中保留方案、独有失败和证据路径。UI逐轮结果已合并进既有验收沿革；原7份图层/UI方案见[设计沿革](archive/LAYER_UI_HISTORY.md)。归档中的“当前/下一步/已安装”只对应原日期。

## 维护规则

- 能力写状态，安排写计划，门禁写测试，当前结果写验收；逐轮细节进入归档，避免多页复制。
- 新增脚本/文件或合并入口时更新链接；删除前保留独有断言和失败证据。
- 源码、隔离工装、安装窗口、手机和目标平台分别标明；旧授权不自动延续。
- 私有源码、APK、业务画面、配置和日志只留本机忽略目录；上手文档仅使用核过内容的项目自有样例截图。
