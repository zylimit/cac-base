---
name: design-md-template
description: DESIGN.md 标准输出模板（对齐 Google DESIGN.md 规范、predev-lint.mjs 与 ui-slop-scan.mjs）。
---

# DESIGN.md 输出模板

文件名：`DESIGN.md`（放项目根目录）。
- `predev-lint.mjs` 强制校验：
  1. 顶部必须有 YAML frontmatter，且至少包含字符串类型的 `colors.primary` 与 `colors.surface`；
  2. 正文花括号引用 `{token.path}` 必须在 YAML 前言中能解析到（教学说明若写示例名请放反引号内）；
  3. 八个核心二级段必须按固定顺序排列：`Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts`（`Motion` 等扩展段放最后），段名不可重复；
  4. 生成时替换全部 `{{...}}` 占位槽！
- `ui-slop-scan.mjs` 静态硬约束：主色禁落紫靛带（hue 235°–290°），禁奶油底配陶土橙套路，单文件品牌色 ≤5，字族 ≤2（等宽与系统回退除外），正文字号 ≥14px，正文行高 `1.4–1.6`，常规圆角 ≤8px（胶囊 `9999px` 除外）。

```markdown
---
version: "1.0"
name: "{{产品名称}}"
description: "{{一句话具体参照物定义}}"
colors:
  primary: "{{#hex 唯一主强调色，禁紫靛默认色}}"
  on-primary: "{{#hex}}"
  secondary: "{{#hex 次级信息与辅助边线}}"
  neutral: "{{#hex 页面底层背景}}"
  surface: "{{#hex 面板与容器表面}}"
  on-surface: "{{#hex 主正文色，与 surface 对比 ≥4.5:1}}"
  on-surface-muted: "{{#hex 次要说明字色，对比 ≥4.5:1}}"
  border: "{{#hex 分隔细线}}"
  success: "{{#hex}}"
  warning: "{{#hex}}"
  error: "{{#hex 错误与破坏性动作专用}}"
typography:
  display:
    fontFamily: "{{系统字体栈，零外部 Google Fonts CDN}}"
    fontSize: "{{28px}}"
    fontWeight: "600"
    lineHeight: "1.25"
  headline-md:
    fontFamily: "{{系统字体栈}}"
    fontSize: "{{20px}}"
    fontWeight: "600"
    lineHeight: "1.35"
  body-md:
    fontFamily: "{{系统字体栈}}"
    fontSize: "{{16px}}"
    fontWeight: "400"
    lineHeight: "1.5"
  label-sm:
    fontFamily: "{{系统字体栈}}"
    fontSize: "{{13px}}"
    fontWeight: "500"
    lineHeight: "1.4"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "{{13px}}"
    fontWeight: "400"
    lineHeight: "1.5"
rounded:
  none: "0px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "40px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
    height: "40px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
---

## Overview

{{用具体参照物描述整体视觉气质、受众阅读感受与信息密度，不堆砌空泛形容词。}}

## Colors

- **Primary ({colors.primary})**：{{唯一主动作强调色，每屏仅用于首要 CTA；不用于大面积背景}}
- **Secondary ({colors.secondary})**：{{次级标签与辅助边线}}
- **Neutral ({colors.neutral}) & Surface ({colors.surface})**：{{靠明度阶梯建立层次，正文用 {colors.on-surface}，弱化信息用 {colors.on-surface-muted}}}
- **Semantic ({colors.success} / {colors.warning} / {colors.error})**：{{状态提示必配文字或图标形状，不只靠颜色}}

## Typography

- **Body ({typography.body-md})**：{{正文 ≥14px（移动端 ≥16px），行高 1.5，行宽控制在 65ch 内}}
- **Headline ({typography.headline-md}) & Display ({typography.display})**：{{层级清晰，不靠负字距挤压小字}}
- **Mono ({typography.mono})**：{{仅用于单号、代码、时间戳与对齐数字 `tabular-nums`，使用本地系统字体栈零外部 CDN}}

## Layout

{{说明网格/流式最大宽度、不可压缩的主任务区，以及组内间距（{spacing.sm}）小于组间间距（{spacing.lg} / {spacing.section}）的呼吸节奏。}}

## Elevation & Depth

{{说明层次手段：优先通过 {colors.neutral}、{colors.surface} 与 1px {colors.border} 区分面板，仅浮层模态框使用克制阴影。}}

## Shapes

{{控件使用 {rounded.sm}，容器使用 {rounded.md}，弹层使用 {rounded.lg}（均 ≤8px），胶囊状态点用 {rounded.full}；严禁卡套卡。}}

## Components

- **Button**：{{主次分明，悬停改变明度不产生位移，聚焦显示清晰焦点环}}
- **Input & Form**：{{显式 label、就地错误提示、移动端命中高度 ≥44px}}
- **Table / List**：{{数字列启用 `tabular-nums` 右对齐，长文本安全截断或折行不撑破横向视口}}

## Do's and Don'ts

- **Do**：只将 `{colors.primary}` 用在当前屏幕最核心的一个动作上。
- **Do**：保持正文对比度 ≥4.5:1，支持全键盘导航与 `prefers-reduced-motion`。
- **Don't**：严禁引入外部字体 CDN（如 Google Fonts），一律使用本地系统字体栈回退。
- **Don't**：严禁紫靛默认主色、奶油底配陶土橙、ALL-CAPS 眉标、`A · B · C` 中点串、按钮尾缀 `→`、满屏大圆角灰影卡片阵列。

## Motion

- 交互反馈 120ms，面板展开 180ms，仅动 `transform` 与 `opacity`（严禁 `transition: all`）；开启 `prefers-reduced-motion` 时全部归零。
```
