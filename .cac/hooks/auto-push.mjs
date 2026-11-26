// PostToolUse(Bash|PowerShell|Shell)：git commit 成功后若本地领先上游分支则自动 git push。
// 默认在 profile.json 的 fast/standard/strict 三档全部设为 "off"，仅当用户在 overrides 中显式设 "on" 时启用。

import fs from 'node:fs';
import { projectDir, readStdinJson, git, fastOff, runFailOpen } from './lib/io.mjs';

const COMMIT_RE = /(?:^|[\s;&|(){}])git(?:\.exe)?(?:\s+-\S+(?:\s+\S+)?)*\s+commit(?:\s|$)/i;

runFailOpen(async () => {
  const ev = readStdinJson();
  const root = projectDir(ev);
  if (await fastOff('auto-push', root)) return;

  const cmd = ev && ev.tool_input ? String(ev.tool_input.command || '') : '';
  if (!COMMIT_RE.test(cmd)) return;

  if (!root || !fs.existsSync(root)) return;
  if (git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: root }).status !== 0) return;

  const ahead = git(['rev-list', '@{u}..HEAD', '--count'], { cwd: root });
  if (Number(ahead.stdout.trim() || 0) > 0) {
    git(['push'], { cwd: root });
  }
});
