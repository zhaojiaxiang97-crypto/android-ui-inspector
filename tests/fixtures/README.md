# UIAutomator fixtures

这些 XML 是本地测试夹具，不是用户数据导出。`uiautomator-device-landscape-sanitized.xml` 的层级形状、bounds、稀疏 child index、虚拟节点 class 和缺少 `visible-to-user` 的情况来自一份真实 Android 设备 dump；其中 package、text、resource-id、content-desc 已统一替换为合成值，未包含序列号、账号、URL 或截图。

- `uiautomator-portrait.xml`：常见 Android 属性、嵌套控件和竖屏 bounds。
- `uiautomator-landscape.xml`：横屏 rotation、屏幕边缘和 focus 状态。
- `uiautomator-device-landscape-sanitized.xml`：真实设备 dump 形状的脱敏样本，包含 `View$VirtualChild`、稀疏 index 和空/倒置 bounds。
- `uiautomator-legacy.xml`：无 XML 声明、缺少大量属性、数字布尔值的旧式样本。
- `uiautomator-escaped.xml`：XML entity 解码和 rotation=3。
- `uiautomator-invalid-bounds.xml`：格式错误、超出安全整数范围和尾随字符的 bounds。
- `uiautomator-oem-style.xml`：合成 OEM 风格变体，属性顺序、空格、数字布尔值和额外字段不同。
- `uiautomator-modern-virtual.xml`：合成现代无障碍/虚拟内容变体；不绑定某个具体厂商或 Android 版本。

夹具只用于解析器回归；它们不能代表所有厂商的完整 UIAutomator 输出，也不替代真实设备验收。

## 来源矩阵

| 样本 | 来源 | 实机结论 |
| --- | --- | --- |
| `uiautomator-device-landscape-sanitized.xml` | 真实 Xiaomi Android 14 / API 34 设备 dump 的脱敏结构 | 仅代表当前这台设备 |
| `uiautomator-portrait.xml`、`uiautomator-landscape.xml` | 合成的标准 UIAutomator 属性组合 | 不代表特定设备 |
| `uiautomator-legacy.xml` | 合成旧式输出组合 | 不代表某个具体 Android 版本 |
| `uiautomator-oem-style.xml`、`uiautomator-modern-virtual.xml` | 合成兼容性变体 | 不代表特定厂商/版本，等待对应实机样本 |

当前只有一台实体设备可采集；其他 Android 版本和厂商仍需接入对应设备后再把样本升级为实机证据。

解析器保留 200 层嵌套上限，与本地快照校验预算一致；接近上限的层级会被迭代归一化，明显超深的 XML 会被安全拒绝。
