# 从关键屏到完整自包含原型的构造与核对规程

编写 `demo/index.html` 时读取本参考。

## 1. 四层递进构造
1. **关键屏先行**：挑信息密度最高或状态最复杂的一屏，塞入真实长标题、大数字带单位、空值与异常文案，先调通阅读主次与网格对齐。
2. **集中 CSS 变量 Token**：在 `<style>` 顶部的 `:root`（及 `[data-theme="dark"]`）集中映射 `DESIGN.md` 全部颜色、字号、间距、圆角变量，组件样式一律用 `var(--...)` 引用，禁止散写裸色值。
3. **原生语义 HTML 组件**：动作按钮用 `<button type="button">`，表单控件绑定 `<label>`，二维对比数据用 `<table>`（数字列设 `font-variant-numeric: tabular-nums`），模态框管理焦点进入与 `Escape` 返回。
4. **可触发的八态与动作契约**：提供顶部或边角轻量「原型演示切换器」，可一键在当前 `SCREEN` 切换空、加载、成功、错误、冲突、离线、无权限态，并支持「重置演示数据」。

## 2. 交付前必核七项
1. HTML 闭合完整，`<style>` 与 `<script>` 无语法截断。
2. 零外部网络依赖（无 `<link href="https://...">`、无 `@import url(...)`、无外部脚本或图床）。
3. `node .cac/scripts/ui-slop-scan.mjs --paths demo` 返回 `rc 0`（0 error）。
4. `node .cac/scripts/ui-audit.mjs demo --widths 1280,390 --out .cac/evidence/ui-audit --strict`：有引擎时确认 `pass: true`；无引擎返回 `rc 3` 时如实报「审计缺席」。
5. 键盘 `Tab` 焦点环清晰可见，无 `outline: none` 裸奔。
6. 390px 窄视口下核心内容不横向溢出、短文本按钮不异常折行成高柱。
7. `@media (prefers-reduced-motion: reduce)` 样式规则已内联生效。
