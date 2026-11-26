# Judge 单一实证裁决规程（主 Agent 执行）

主 Agent 在收齐 `$REPORT` 中的 Blue 自证表与 Red 四 Lens 攻击发现后亲自执行唯一裁决：

## 核心裁决铁律
1. **一个 Error Finding 绝不被干净 Lens 否决**：只要任一 Lens 给出了经核实的阻断缺陷（尤其 `security / safety / privacy` 与 Windows 跨平台崩溃），即使其他 Lens 全绿也必须采信并判 `FIX_REQUIRED`。
2. **只认实证不听声大**：逐条打开对应的 `file:line` 或运行最小验证命令核实——Red 指控无行号或复现不成立的予以「驳回」并写明原因；确属 `Product-Spec.md` 自身规则矛盾或遗漏的标为 `spec-suspect` 回流 `/product-spec-builder`。
3. **三态出口清晰**：
   - `ACCEPT`：0 条采信的阻断项，允许推进提交/合并/发版；
   - `FIX_REQUIRED`：给出带 `file:line` 的必修表，派 `bug-fixer` / `implementer` 修复后重跑验证；
   - `NEEDS_MORE_EVIDENCE`：关键死角尚未覆盖或复现条件不全，补齐实测证据后再判。
