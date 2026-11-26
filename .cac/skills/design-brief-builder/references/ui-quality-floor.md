---
name: ui-quality-floor
description: 界面质量地板（MUST / SHOULD / NEVER）：design-maker 原型验收、dev-builder 写前端、code-review 审 UI 共用标尺。
---

[定位]
    审美风格可选，质量地板不可降级。审查时违背 MUST 即报缺陷（`file:line - 问题描述`）。

[键盘、焦点与命中区]
    - **MUST** 全核心路径纯键盘可达，`Tab` 顺序与视觉一致；弹层开启捕获焦点、关闭归还触发点；可见焦点环不被 sticky 顶栏遮挡。
    - **MUST** 桌面点击区 ≥24px，移动端 ≥44px；移动端输入框字号 ≥16px。
    - **NEVER** 写 `outline: none` 却不提供高对比 `:focus-visible` 样式；**NEVER** 设 `user-scalable=no` 或 `maximum-scale=1`；**NEVER** 用无角色 `<div onclick>` 冒充按钮或链接。

[表单、状态与反馈]
    - **MUST** 每个输入控件关联显式 `<label>` 或 `aria-label`；提交请求期间按钮防重并保留上下文文案；校验错误就地贴近字段展示并保留用户已填内容；破坏性操作有二次确认或撤销窗口。
    - **MUST** 状态传达不只靠颜色（红绿状态必带文字或不同图标形状）；比较型数字列开启 `font-variant-numeric: tabular-nums`。
    - **NEVER** 拦截粘贴（`onPaste preventDefault`）；**NEVER** 把空数据态与报错态画成同一张脸。

[布局、动效与离线纯净度]
    - **MUST** 窄屏（390px）与桌面（1280px）无意外横向滚动溢出；flex/grid 文本子项配 `min-width: 0` 防长文本撑破容器。
    - **MUST** 尊重 `@media (prefers-reduced-motion: reduce)`；动画仅作用于 `transform` / `opacity`。
    - **MUST** 正文与背景对比度 ≥4.5:1（大字 ≥3:1）；深色模式设 `color-scheme: dark`，底层从 `#121212` 起步不用 `#000000` 死黑。
    - **NEVER** 使用 `transition: all`；原型文件 **NEVER** 依赖外部 CDN 字体/脚本导致断网白屏。
