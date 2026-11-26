// SessionStart：合并输出 cac-base 核心铁律横幅、当前档位状态、待进化 feedback 催办与脏工作树恢复提示。
// 单次进程启动完成全部检查，并经单条 hookSpecificOutput.additionalContext 注入上下文。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinJson, readTextFile, git, context, runFailOpen } from './lib/io.mjs';

const BANNER = [
  '🔒 cac-base 核心治理铁律：',
  '1. 主 Agent 不亲自编码/审查/测试/部署——一律委派 Sub-Agent（implementer / code-reviewer / tester / deployer）',
  '2. 命中阶段或派发前必先显式 Read 对应 .cac/rules/*.md 细则（宿主不按路径自动注入 rules）',
  '3. 按档审查：Task 先定 LOW / MEDIUM / HIGH，MEDIUM 起派 code-reviewer fresh 实例审，HIGH 加独立 tester',
  '4. 验收以客观证据为准：跑全新命令读真实输出与退出码，degraded(rc 3) / SKIPPED 绝不算 PASS',
  '5. 存量资产保留复用：删/停/重写现有 hook/skill/agent/rule 须用户拍板（家底改动本轮自动升 strict）',
  '6. 三文件同步：决策/约束/完成即时写 progress.md；需求变更成对写 Product-Spec.md + Product-Spec-CHANGELOG.md',
].join('\n');

async function tierNow(root) {
  try {
    const m = await import('./lib/tier.mjs');
    if (m.gateMode('session-start', { projectDir: root }) === 'off') return { disabled: true };
    const t = m.effectiveTier({ projectDir: root });
    const session = m.readSession(root);
    return { ...t, reason: (session && session.reason) || '' };
  } catch (_e) {
    return null;
  }
}

function hoursLeft(epoch) {
  if (epoch === null || epoch === undefined || epoch === '' || !Number.isFinite(Number(epoch))) return null;
  return Math.max(0, Math.round((Number(epoch) * 1000 - Date.now()) / 360000) / 10);
}

function checkEvolutionReminder(root) {
  const indexFile = path.join(root, '.cac', 'feedback', 'FEEDBACK-INDEX.md');
  const r = readTextFile(indexFile);
  if (r.text === null) return null;

  const lines = r.text.replace(/\r/g, '').split('\n');
  const pending = lines.filter((l) => l.startsWith('- [')).length;
  const total = lines.filter((l) => /^- (✅\[已毕业\] |⏭\[已跳过\] |⏸\[暂不成文\] )?\[/.test(l)).length;
  if (pending <= 0) return null;

  return `📋 项目有 ${pending} 条待处理 feedback（共 ${total} 条）。建议派发 evolution-runner 检查是否有规则/技能进化建议。`;
}

function checkDirtyWorktreeReminder(root) {
  const inside = git(['rev-parse', '--is-inside-work-tree'], { cwd: root });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;

  const st = git(['status', '--porcelain'], { cwd: root });
  if (st.status !== 0) return null;
  const count = st.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  if (count === 0) return null;

  return `⚠️ 检测到 git 工作树有 ${count} 处未提交改动——上个会话可能中断或已压缩，progress.md 未必反映最新实况。建议先执行 /recap-project 读 progress.md 并跑 node .cac/scripts/project-status.mjs 校准后再继续。`;
}

runFailOpen(async () => {
  const ev = readStdinJson();
  const root = projectDir(ev);
  const lines = [];

  try {
    // 1. 安装事务中断检测
    if (root && fs.existsSync(path.join(root, '.cac', '.runtime', 'install.marker'))) {
      lines.push('⚠️ 上次框架安装未完成（存在 .cac/.runtime/install.marker）：请先重跑 pwsh setup.ps1（或 bash setup.sh）补装完再开工。');
    }

    const tier = root ? await tierNow(root) : null;
    if (tier && tier.disabled) return;

    const source = ev ? String(ev.source || '') : '';
    const quiet = source === 'compact' || source === 'resume';

    // 2. fast 档反向高亮预警（即使在 compact/resume 恢复后也持续提醒）
    if (tier && tier.tier === 'fast') {
      const left = tier.sticky === true ? null : hoursLeft(tier.expiresEpoch);
      const span = tier.sticky === true ? 'sticky 到撤销为止' : (left === null ? '无过期时间' : `剩 ${left} h`);
      lines.push(`‼️ tier: fast（${span}${tier.reason ? `，原因：${tier.reason}` : ''}）：治理闸仅提醒不拦截，欠账照常登记（.cac/.runtime/tier.json）。完成后请运行 \`node .cac/harness/harness.mjs tier set standard\` 恢复标准模式。`);
      return;
    }

    if (quiet) return;

    // 3. 标准/严格/自动升档播报 + 核心铁律横幅
    if (tier) {
      const hits = (tier.raisedBy || []).slice(0, 3).join('、');
      lines.push(tier.source === 'raise'
        ? `tier: ${tier.tier}（来源 raise：工作树修改了 ${hits}${(tier.raisedBy || []).length > 3 ? ' 等' : ''}）——家底治理面改动触发自动升档，本轮闸门按 strict 最严档运行。`
        : `tier: ${tier.tier}（来源 ${tier.source}）`);
    }
    lines.push(BANNER);

    // 4. 待毕业 feedback 提醒与脏工作树恢复提醒
    if (root) {
      const evo = checkEvolutionReminder(root);
      if (evo) lines.push(evo);
      const dirty = checkDirtyWorktreeReminder(root);
      if (dirty) lines.push(dirty);
    }
  } finally {
    if (lines.length > 0) {
      context('SessionStart', lines.join('\n\n'));
    }
  }
});
