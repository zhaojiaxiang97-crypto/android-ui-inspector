# 选中 ImageView 3D 浮层视觉修复计划

状态：已完成
日期：2026-09-14

## 1. 问题描述

在 3D 层级视图中选中 `ImageView` 后，它会像一张独立图片一样浮在最上方。旋转到侧面时，这个小图片和截图底面、其他层级分离，视觉上像设备中真的存在一块悬浮面板。

## 2. 原因判断

- `ImageView` 节点本身是真实设备 hierarchy 中的节点，当前设备中的 bounds 为 `135×135px`。
- 3D 视图把每个节点都映射成 CSS 3D 平面；选中节点使用截图纹理和高优先级 `z-index`，因此被视觉上突出。
- `UIAutomator` 只提供 bounds、树深度和属性，不提供真实 RenderNode、Canvas 或 GPU Z 轴。树层级不能直接当作真实绘制顺序。
- 所以问题主要是可视化表达方式，不是设备多出了一层 ImageView。

## 3. 修复目标

- 选中 `ImageView` 仍然保留准确的 bounds、选中状态和节点信息。
- 选中节点不再显示成单独的截图贴图，不再产生“浮在最顶层”的错觉。
- 使用绿色边框、轻微光晕和 HUD 表示当前选中节点。
- 截图底面、结构轮廓和普通可观察子层继续保持同步旋转。
- 左侧树、3D 层、breadcrumb 和属性面板继续同步。

## 4. 最小改动方案

### 4.1 调整选中层渲染

修改 `src/components/Layer3DPreview.tsx`：

1. 选中节点继续保留为可交互的 layer plane，保证点击和键盘操作不回归。
2. 选中节点不再铺设截图纹理，改为透明面或仅保留结构边界。
3. 选中节点的文字信息继续放在 2D HUD 中，不跟随平面倾斜。
4. 保留普通子层的局部纹理，让有明显 bounds 变化的层仍然有空间参考。

### 4.2 调整选中状态样式

修改 `src/App.css`：

1. 取消选中 `ImageView` 的截图背景和大面积绿色填充。
2. 保留绿色边框、细光晕和可读的选中标记。
3. 让选中层的视觉重点落在 bounds，而不是图片内容。
4. 保持 `prefers-reduced-motion`、键盘聚焦和浅色主题样式。

### 4.3 增加验收标记

修改 `scripts/app-smoke.mjs`：

- 检查选中层仍存在且跟随树选择；
- 检查选中层的 `data-layer-texture` 为 `false`；
- 检查截图底面仍在同一个移动场景中；
- 保持左键拖拽、拖出窗口释放、键盘旋转和重置检查。

## 5. 验收标准

| 场景 | 预期结果 |
| --- | --- |
| 正面视角 | 选中 ImageView 只显示 bounds 高亮，不像独立图片浮起 |
| 45°旋转 | 选中框与截图底面、层级轮廓保持同一相机变换 |
| 90°旋转 | 不出现单独的 ImageView 贴图或大面积悬浮图片 |
| 点击选中层 | 树、breadcrumb、HUD 和属性面板同步更新 |
| 切换其他节点 | 旧选中状态清理，新节点只显示边界高亮 |
| 重置视角 | 回到 `Yaw 0° · Pitch 0°`，层级关系仍可读 |
| 小窗口 | 1264×816 下无横向溢出，HUD 不遮挡主要画面 |

## 6. 验证方式

```bash
bun run build
bun test
node --experimental-websocket scripts/app-smoke.mjs --fixture --viewport=1264x816 --drag-outside
node --experimental-websocket scripts/app-smoke.mjs --require-device --viewport=1264x816 --drag-outside
bun run visual:baseline
```

人工检查：

1. 选中真实设备中的 `ImageView`；
2. 重置后分别拖动到约 45°、90°和 180°；
3. 确认 ImageView 只作为边界标记存在，截图和其他结构层同步移动；
4. 检查树选择、breadcrumb 和属性面板没有回归。

## 7. 实施结果

- 选中层不再铺设截图纹理，仅保留透明 bounds 高亮和 HUD。
- 截图底面继续与层级平面共用同一 3D 场景，并跟随拖拽同步旋转。
- smoke 增加了 `data-layer-texture=false` 验收，避免选中层再次变成悬浮贴图。
- 构建、56 个单测、fixture、真实设备和人工拖拽检查均通过。
- 三个固定窗口尺寸的视觉基线均通过，确认没有出现独立的 ImageView 图片层。

## 8. 不在本次范围内

- 不推断真实 Android RenderNode 或 GPU 绘制顺序；
- 不修改 UI hierarchy 解析、ADB 连接和截图数据格式；
- 不引入 Three.js、WebGL 或新的渲染依赖；
- 不删除左侧树中的真实节点。

## 9. 完成判定

当选中的 `ImageView` 不再以截图贴图形式浮在最上层，同时保留节点定位、选中同步和 3D 旋转能力，并通过构建、单测、模拟数据和真实设备验证后，本计划完成。
