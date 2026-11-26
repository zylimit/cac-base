// release-gate.mjs — 发布前置安全地板闸（profile.floor，任何档位永不降级）。
//
// 双通道挂载（HOST-CONTRACT §4）：
//   1. PreToolUse (matcher: "Skill")：当 ev.tool_input.skill 为 "release-builder" 时触发；
//   2. UserPromptSubmit：当用户直接输入 `/release-builder` 斜杠指令时触发。
// 校验规则：
//   - 若 .cac/.needs-review 仍有未清待审文件 → 阻断进入发布流程；
//   - 若已清空 → 放行并注入发布三件套独立验收与测试全绿清单提醒。

import { projectDir, readStdinJson, pendingReviewFiles, block, denyTool, context, runFailOpen } from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';

const CTX = '发布前置卡点提醒（release-gate 注入）：① 打包前必过测试卡点——test-builder 全量跑，报绿须附运行清单（跑了哪些文件、各自结果），证据=运行器真实输出；② fast 档绝不豁免发布卡点；③ 部署完成后主 Agent 必须独立核查部署三件套（构建/容器时间戳与版本 tag、健康检查端点响应、live 关键路径冒烟），绝不盲信 deployer 自报。';

runFailOpen(() => {
  const ev = readStdinJson();
  if (!ev || typeof ev !== 'object') return;

  const eventName = String(ev.hook_event_name || '');
  const toolName = String(ev.tool_name || '');
  const isSkillCall = eventName === 'PreToolUse' || toolName === 'Skill' || Boolean(ev.tool_input && ev.tool_input.skill);

  if (isSkillCall) {
    const skill = String((ev.tool_input && ev.tool_input.skill) || '').trim().replace(/^\//, '');
    if (skill !== 'release-builder') return;

    const root = projectDir(ev);
    const pending = pendingReviewFiles(root);
    if (pending.length > 0) {
      const reason = `发布前置闸：待审清单未清（${pending.length} 个文件待 code review：${pending.join('、')}）。请先完成 review→fix 闭环（通过后执行 echo clean > .cac/.needs-review），再执行 /release-builder。`;
      gateLog('release-gate', reason, root);
      denyTool(reason);
      return;
    }
    context('PreToolUse', CTX);
    return;
  }

  // UserPromptSubmit（或兼容 command_name）
  const prompt = String(ev.prompt || '');
  const cmdName = String(ev.command_name || '');
  const matchedPrompt = /^\s*\/release-builder(?:\s|$)/.test(prompt) || cmdName === 'release-builder';
  if (!matchedPrompt) return;

  const root = projectDir(ev);
  const pending = pendingReviewFiles(root);
  if (pending.length > 0) {
    const reason = `发布前置闸：待审清单未清（${pending.length} 个文件待 code review：${pending.join('、')}）。请先完成 review→fix 闭环（通过后执行 echo clean > .cac/.needs-review），再执行 /release-builder。`;
    gateLog('release-gate', reason, root);
    block(reason);
    return;
  }

  context(eventName || 'UserPromptSubmit', CTX);
});
