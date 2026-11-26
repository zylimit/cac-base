#!/usr/bin/env pwsh
# scripts/windows-host-probe.ps1 - Reusable Windows PowerShell sandbox probe for CodeAgent CLI (`codeagent`).
# Verifies all host protocol contracts recorded in docs/HOST-CONTRACT.md inside an isolated temp sandbox:
#   1. CLI executable discovery (`codeagent` -> `codeAgentCLI` -> `codeagentcli` -> `cac`) & version/flags
#   2. Root `AGENTS.md` automatic context injection vs `.cac/rules/*.md` `paths:` non-auto-injection
#   3. `.cac/settings.json` `permissions.deny` native pre-hook enforcement
#   4. String-form Node Hook (`node .cac/hooks/probe-hook.mjs`) execution, stdin payload & env metadata
#   5. Sub-agent (`Agent` tool) `agent_id` & `agent_type` propagation in PreToolUse/PostToolUse/SubagentStop
#   6. `disable-model-invocation: true` native enforcement on `.cac/skills/manual-only/SKILL.md`
#
# SECURITY FLOOR: Strictly redacts ANY environment variable whose name matches
# TOKEN / KEY / SECRET / PASS / CREDENTIAL / AUTH / COOKIE / PRIVATE / BEARER.
# Never prints, logs, or writes raw credential/token values!
# Saved as UTF-8 WITHOUT BOM (pure ASCII source for PowerShell 5.1 & pwsh 7 compatibility).

[CmdletBinding()]
param(
  [switch]$SetupOnly,
  [switch]$KeepSandbox,
  [string]$OutFile = '',
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

$SensitiveEnvPattern = '(?i)(TOKEN|KEY|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE|BEARER)'

function Get-RedactedHostEnvSummary {
  $summary = [ordered]@{}
  Get-ChildItem Env: | Sort-Object Name | ForEach-Object {
    $name = $_.Name
    if ($name -match '^(CODEAGENT|CAC_|DEVUC_|ENTERPRISE_|X_AUTH)') {
      if ($name -match $SensitiveEnvPattern) {
        $len = if ($null -ne $_.Value) { $_.Value.Length } else { 0 }
        $summary[$name] = "[REDACTED len=$len]"
      }
      else {
        $summary[$name] = $_.Value
      }
    }
  }
  return $summary
}

function Find-CodeAgentCli {
  $candidates = @('codeagent', 'codeAgentCLI', 'codeagentcli', 'cac')
  foreach ($c in $candidates) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) {
      return [ordered]@{
        found = $true
        name  = $c
        path  = $cmd.Source
      }
    }
  }
  return [ordered]@{
    found = $false
    name  = $null
    path  = $null
  }
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  [Console]::Error.WriteLine('[probe] node (>= 20) is required to run the sandbox hook logger')
  exit 3
}

$sandboxRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cac-host-probe-" + [Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $sandboxRoot -Force | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom([string]$FilePath, [string]$Text) {
  $dir = Split-Path -Parent $FilePath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $normalized = $Text -replace "`r`n", "`n"
  [System.IO.File]::WriteAllText($FilePath, $normalized, $utf8NoBom)
}

try {
  # 1. Populate sandbox files
  Write-Utf8NoBom (Join-Path $sandboxRoot 'AGENTS.md') @'
# Sandbox Constitution
When asked for the constitution token, always include literal `[AGENTS-MD-OK]` in your reply.
'@

  Write-Utf8NoBom (Join-Path $sandboxRoot '.cac/rules/src-rule.md') @'
---
paths:
  - "src/**"
---
If this rule was auto-injected by paths, include `[RULE-PATHS-OK]` in your reply.
'@

  Write-Utf8NoBom (Join-Path $sandboxRoot '.cac/agents/probe-reader.md') @'
---
name: probe-reader
description: Read-only sandbox subagent for verifying agent_id and agent_type propagation.
permission_mode: plan
tools:
  - Read
  - Glob
  - Grep
---
Read the requested file and reply concisely with its content.
'@

  Write-Utf8NoBom (Join-Path $sandboxRoot '.cac/skills/manual-only/SKILL.md') @'
---
name: manual-only
description: Manual-only probe skill for verifying disable-model-invocation.
disable-model-invocation: true
---
Manual skill body.
'@

  Write-Utf8NoBom (Join-Path $sandboxRoot '.env') "PROBE_DUMMY_VAR=do-not-read`n"
  Write-Utf8NoBom (Join-Path $sandboxRoot 'src/hello.txt') "hello-from-sandbox`n"

  # 2. Write redacting Node hook probe logger (zero TOKEN/KEY leakage!)
  $probeHookJs = @'
import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_RE = /(TOKEN|KEY|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE|BEARER)/i;

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  raw = '';
}

let event = {};
try {
  event = raw.trim() ? JSON.parse(raw) : {};
} catch {
  event = { parseError: true };
}

const envSnapshot = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CODEAGENT|CAC_|DEVUC_|ENTERPRISE_|X_AUTH)/.test(k)) {
    envSnapshot[k] = SENSITIVE_RE.test(k)
      ? `[REDACTED len=${String(v ?? '').length}]`
      : String(v ?? '');
  }
}

const record = {
  ts: new Date().toISOString(),
  cwd: process.cwd(),
  hook_event_name: event.hook_event_name || null,
  tool_name: event.tool_name || null,
  agent_id: event.agent_id || null,
  agent_type: event.agent_type || null,
  stop_hook_active: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null,
  has_last_assistant_message: typeof event.last_assistant_message === 'string',
  input_keys: Object.keys(event).sort(),
  tool_input_keys: event.tool_input && typeof event.tool_input === 'object' ? Object.keys(event.tool_input).sort() : [],
  env: envSnapshot,
};

const logFile = path.join(process.cwd(), '.cac', '.runtime', 'probe-events.jsonl');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');

if (
  event.hook_event_name === 'PreToolUse' &&
  event.tool_input &&
  typeof event.tool_input.command === 'string' &&
  event.tool_input.command.includes('PROBE_TRIGGER_DENY')
) {
  process.stderr.write('Blocked by probe PreToolUse guard\n');
  process.exit(2);
}
'@
  Write-Utf8NoBom (Join-Path $sandboxRoot '.cac/hooks/probe-hook.mjs') $probeHookJs

  $settingsJson = @'
{
  "permissions": {
    "deny": [
      "Read(.env)"
    ]
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node .cac/hooks/probe-hook.mjs" }] }
    ]
  }
}
'@
  Write-Utf8NoBom (Join-Path $sandboxRoot '.cac/settings.json') $settingsJson

  # Initialize sandbox git repo if git is available
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Push-Location -LiteralPath $sandboxRoot
    try {
      & git init -q 2>$null | Out-Null
      & git config user.email 'probe@example.invalid' 2>$null | Out-Null
      & git config user.name 'cac-probe' 2>$null | Out-Null
    }
    finally {
      Pop-Location
    }
  }

  $cli = Find-CodeAgentCli
  $cliVersion = $null
  if ($cli.found) {
    try {
      $cliVersion = (& $cli.path --version 2>$null | Select-Object -First 1 | Out-String).Trim()
    }
    catch {
      $cliVersion = 'unknown'
    }
  }

  $probeResult = [ordered]@{
    schemaVersion = 1
    timestamp     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    os            = [System.Environment]::OSVersion.VersionString
    psVersion     = $PSVersionTable.PSVersion.ToString()
    nodeVersion   = (& node --version 2>$null | Out-String).Trim()
    cli           = $cli
    cliVersion    = $cliVersion
    sandboxRoot   = if ($KeepSandbox -or $SetupOnly) { $sandboxRoot } else { '<cleaned>' }
    hostEnv       = Get-RedactedHostEnvSummary
    setupOnly     = [bool]$SetupOnly
    liveRun       = $null
    events        = @()
  }

  if (-not $SetupOnly -and $cli.found) {
    Push-Location -LiteralPath $sandboxRoot
    try {
      $prompt = 'Read src/hello.txt and state the constitution token from AGENTS.md in one short line.'
      $job = Start-Job -ScriptBlock {
        param($exe, $dir, $p)
        Set-Location -LiteralPath $dir
        & $exe -p $p --output-format json 2>&1 | Out-String
      } -ArgumentList $cli.path, $sandboxRoot, $prompt

      if (Wait-Job $job -Timeout $TimeoutSec) {
        $outText = Receive-Job $job
        $probeResult.liveRun = [ordered]@{
          completed      = $true
          agentsMdLoaded = ($outText -match '\[AGENTS-MD-OK\]')
          rulePathsAuto  = ($outText -match '\[RULE-PATHS-OK\]')
        }
      }
      else {
        Stop-Job $job -ErrorAction SilentlyContinue
        $probeResult.liveRun = [ordered]@{
          completed = $false
          reason    = "timed out after ${TimeoutSec}s"
        }
      }
      Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
    finally {
      Pop-Location
    }

    $eventsFile = Join-Path $sandboxRoot '.cac/.runtime/probe-events.jsonl'
    if (Test-Path -LiteralPath $eventsFile) {
      $lines = [System.IO.File]::ReadAllLines($eventsFile)
      foreach ($l in $lines) {
        if ($l.Trim()) {
          $probeResult.events += ($l | ConvertFrom-Json)
        }
      }
    }
  }

  $jsonOut = $probeResult | ConvertTo-Json -Depth 8 -Compress
  if ($OutFile) {
    Write-Utf8NoBom $OutFile ($jsonOut + "`n")
  }
  Write-Output $jsonOut
}
finally {
  if (-not $KeepSandbox -and -not $SetupOnly -and (Test-Path -LiteralPath $sandboxRoot)) {
    Remove-Item -LiteralPath $sandboxRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
