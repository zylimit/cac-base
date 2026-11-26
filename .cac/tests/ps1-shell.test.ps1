#!/usr/bin/env pwsh
# # risk: high
# .cac/tests/ps1-shell.test.ps1 - End-to-end PowerShell smoke & contract test suite.
# Pure ASCII UTF-8 without BOM. Compatible with Windows PowerShell 5.1 and PowerShell 7+ (pwsh).
# Covers:
#   1. No-BOM, pure-ASCII, and PowerShell Language.Parser AST verification on setup.ps1, windows-host-probe.ps1, and self
#   2. Unknown flag (--dryrun) and Windows reserved segment (CON) rejection (exit 2, zero mkdir)
#   3. setup.ps1 -DryRun zero-write guarantee
#   4. Default lightweight install + doctor.mjs health verification
#   5. setup.ps1 -WithHarness optional bundle + doctor.mjs verification
#   6. 3-way conflict protection (.cac-base-new sidecars, user edits and FEEDBACK-INDEX.md preserved)
#   7. setup.ps1 -Uninstall safe teardown (removes unmodified managed files, keeps AGENTS.md and user-modified files)
#   8. scripts/windows-host-probe.ps1 -SetupOnly sandbox & redaction smoke check

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '..') '..'))
$SetupPs1 = Join-Path $RepoRoot 'setup.ps1'
$ProbePs1 = Join-Path (Join-Path $RepoRoot 'scripts') 'windows-host-probe.ps1'
$SelfPs1  = Join-Path (Join-Path (Join-Path $RepoRoot '.cac') 'tests') 'ps1-shell.test.ps1'

$PsExe = $null
try {
  $PsExe = (Get-Process -Id $PID).Path
} catch {
  $PsExe = $null
}
if (-not $PsExe) {
  $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwshCmd) {
    $PsExe = $pwshCmd.Source
  } else {
    $PsExe = 'powershell'
  }
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom([string]$FilePath, [string]$Text) {
  $parent = Split-Path -Parent $FilePath
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($FilePath, $Text, $Utf8NoBom)
}

function Invoke-PsScript([string]$ScriptPath, [string[]]$ScriptArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $stdoutLines = & $PsExe -NoProfile -File $ScriptPath @ScriptArgs 2>$null
    $rc = $LASTEXITCODE
    $stdoutText = ($stdoutLines | Out-String).Trim()
    return @{ ExitCode = $rc; Stdout = $stdoutText }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-NodeJson([string]$ScriptPath, [string[]]$NodeArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $stdoutLines = & node $ScriptPath @NodeArgs 2>$null
    $rc = $LASTEXITCODE
    $stdoutText = ($stdoutLines | Out-String).Trim()
    return @{ ExitCode = $rc; Stdout = $stdoutText }
  } finally {
    $ErrorActionPreference = $prev
  }
}

$PassCount = 0
function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "ASSERTION FAILED: $Message"
  }
}

function Step-Pass([string]$Label) {
  $script:PassCount++
  Write-Host ("ok {0} - {1}" -f $script:PassCount, $Label)
}

# 1. PowerShell AST, No-BOM, and Pure-ASCII check
$PsFiles = @(
  @{ Name = 'setup.ps1'; Path = $SetupPs1 },
  @{ Name = 'scripts/windows-host-probe.ps1'; Path = $ProbePs1 },
  @{ Name = '.cac/tests/ps1-shell.test.ps1'; Path = $SelfPs1 }
)

foreach ($item in $PsFiles) {
  Assert-True (Test-Path -LiteralPath $item.Path) ("Missing PowerShell script: " + $item.Name)
  $bytes = [System.IO.File]::ReadAllBytes($item.Path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  Assert-True (-not $hasBom) ("UTF-8 BOM detected in " + $item.Name)

  for ($idx = 0; $idx -lt $bytes.Length; $idx++) {
    Assert-True ($bytes[$idx] -lt 0x80) ("Non-ASCII byte 0x{0:X2} at offset {1} in {2}" -f $bytes[$idx], $idx, $item.Name)
  }

  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($item.Path, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors -and $parseErrors.Count -gt 0) {
    throw ("PowerShell AST parse error in {0}: {1}" -f $item.Name, $parseErrors[0].Message)
  }
}
Step-Pass 'AST parse, no-BOM, and pure-ASCII check passed for setup.ps1, windows-host-probe.ps1, and ps1-shell.test.ps1'

$TmpBase = Join-Path ([System.IO.Path]::GetTempPath()) ('cac-ps1-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$ProbeSandboxToClean = $null

try {
  New-Item -ItemType Directory -Path $TmpBase -Force | Out-Null

  # 2. Reject unknown option --dryrun and Windows reserved device name CON (exit 2, zero mkdir)
  $workCwd = Join-Path $TmpBase 'cwd-guard'
  New-Item -ItemType Directory -Path $workCwd -Force | Out-Null

  Push-Location -LiteralPath $workCwd
  try {
    $rTypo = Invoke-PsScript $SetupPs1 @('--dryrun')
  } finally {
    Pop-Location
  }
  Assert-True ($rTypo.ExitCode -eq 2) ("Expected setup.ps1 --dryrun to exit 2, got " + $rTypo.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $workCwd '--dryrun'))) 'setup.ps1 must NOT create directory --dryrun'

  $conTarget = Join-Path $TmpBase 'CON'
  $rCon = Invoke-PsScript $SetupPs1 @($conTarget)
  Assert-True ($rCon.ExitCode -eq 2) ("Expected setup.ps1 CON path rejection exit 2, got " + $rCon.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath $conTarget)) 'setup.ps1 must NOT create reserved CON directory'
  Step-Pass 'Unknown option (--dryrun) and reserved segment (CON) rejected with exit 2 and zero filesystem side effects'

  # 3. setup.ps1 -DryRun leaves zero files on disk
  $dryTarget = Join-Path $TmpBase 'dry-target'
  $rDry = Invoke-PsScript $SetupPs1 @($dryTarget, '-DryRun', '-WithHarness', '-WithTests')
  Assert-True ($rDry.ExitCode -eq 0) ("setup.ps1 -DryRun failed with exit " + $rDry.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath $dryTarget)) 'setup.ps1 -DryRun must not create target directory'
  Step-Pass 'setup.ps1 -DryRun succeeded with zero writes'

  # 4. Default lightweight install + doctor.mjs
  $lightTarget = Join-Path $TmpBase 'light-target'
  $rLight = Invoke-PsScript $SetupPs1 @('-Target', $lightTarget)
  Assert-True ($rLight.ExitCode -eq 0) ("setup.ps1 lightweight install failed with exit " + $rLight.ExitCode)

  $topNames = @(Get-ChildItem -LiteralPath $lightTarget -Force | Select-Object -ExpandProperty Name | Sort-Object)
  Assert-True (($topNames -join ',') -eq '.cac,AGENTS.md') ("Expected only .cac and AGENTS.md at root, got: " + ($topNames -join ','))
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $lightTarget '.cac/harness/ext'))) 'Lightweight install must omit .cac/harness/ext'

  $lightDoctor = Join-Path (Join-Path (Join-Path $lightTarget '.cac') 'scripts') 'doctor.mjs'
  $rDocLight = Invoke-NodeJson $lightDoctor @($lightTarget, '--json')
  Assert-True ($rDocLight.ExitCode -eq 0) ("doctor.mjs failed on lightweight target: " + $rDocLight.Stdout)
  $docLightObj = $rDocLight.Stdout | ConvertFrom-Json
  Assert-True ([bool]$docLightObj.ok) 'doctor.mjs JSON ok must be true on lightweight target'
  Step-Pass 'Default lightweight install and doctor.mjs --json passed with zero pollution'

  # 5. Install with -WithHarness + doctor.mjs
  $fullTarget = Join-Path $TmpBase 'full-target'
  $rFull = Invoke-PsScript $SetupPs1 @('install', '-Target', $fullTarget, '-WithHarness')
  Assert-True ($rFull.ExitCode -eq 0) ("setup.ps1 -WithHarness install failed with exit " + $rFull.ExitCode)
  Assert-True (Test-Path -LiteralPath (Join-Path $fullTarget '.cac/FRAMEWORK-MANIFEST.json')) 'Missing FRAMEWORK-MANIFEST.json'
  Assert-True (Test-Path -LiteralPath (Join-Path $fullTarget '.cac/FRAMEWORK-MANIFEST-OPTIONAL.json')) 'Missing FRAMEWORK-MANIFEST-OPTIONAL.json'
  Assert-True (Test-Path -LiteralPath (Join-Path $fullTarget '.cac/rules/harness-large-repo.md')) 'Missing synced .cac/rules/harness-large-repo.md'

  $fullDoctor = Join-Path (Join-Path (Join-Path $fullTarget '.cac') 'scripts') 'doctor.mjs'
  $rDocFull = Invoke-NodeJson $fullDoctor @($fullTarget, '--json')
  Assert-True ($rDocFull.ExitCode -eq 0) ("doctor.mjs failed on -WithHarness target: " + $rDocFull.Stdout)
  Step-Pass 'setup.ps1 -WithHarness install and doctor.mjs --json passed'

  # 6. Conflict protection (.cac-base-new sidecar) and FEEDBACK-INDEX.md preservation
  $agentsFile = Join-Path $fullTarget 'AGENTS.md'
  $origAgents = [System.IO.File]::ReadAllText($agentsFile)
  Write-Utf8NoBom $agentsFile ($origAgents + "`n# Local Windows Team Rule`n")

  $ruleFile = Join-Path $fullTarget '.cac/rules/file-structure.md'
  $origRule = [System.IO.File]::ReadAllText($ruleFile)
  Write-Utf8NoBom $ruleFile ($origRule + "`n<!-- custom-ps1-rule -->`n")

  $fbIndex = Join-Path $fullTarget '.cac/feedback/FEEDBACK-INDEX.md'
  $customFb = "# FEEDBACK-INDEX`n- fb-win-001: keep me`n"
  Write-Utf8NoBom $fbIndex $customFb

  $rUpg = Invoke-PsScript $SetupPs1 @('upgrade', '-Target', $fullTarget, '-WithHarness')
  Assert-True ($rUpg.ExitCode -eq 0) ("setup.ps1 upgrade failed with exit " + $rUpg.ExitCode)
  Assert-True (Test-Path -LiteralPath ($agentsFile + '.cac-base-new')) 'Expected AGENTS.md.cac-base-new'
  Assert-True (Test-Path -LiteralPath ($ruleFile + '.cac-base-new')) 'Expected file-structure.md.cac-base-new'
  Assert-True ([System.IO.File]::ReadAllText($agentsFile).Contains('Local Windows Team Rule')) 'AGENTS.md user edit was overwritten'
  Assert-True ([System.IO.File]::ReadAllText($ruleFile).Contains('custom-ps1-rule')) 'file-structure.md user edit was overwritten'
  Assert-True ([System.IO.File]::ReadAllText($fbIndex) -eq $customFb) 'FEEDBACK-INDEX.md was overwritten on upgrade'
  Step-Pass '3-way upgrade preserved user edits via .cac-base-new and left FEEDBACK-INDEX.md untouched'

  # 7. Uninstall removes unmodified managed files while keeping AGENTS.md and user-modified rule
  Remove-Item -LiteralPath ($agentsFile + '.cac-base-new'), ($ruleFile + '.cac-base-new') -Force
  $rUninst = Invoke-PsScript $SetupPs1 @('-Uninstall', '-Target', $fullTarget)
  Assert-True ($rUninst.ExitCode -eq 0) ("setup.ps1 -Uninstall failed with exit " + $rUninst.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $fullTarget '.cac/FRAMEWORK-MANIFEST.json'))) 'FRAMEWORK-MANIFEST.json must be removed on uninstall'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $fullTarget '.cac/scripts/doctor.mjs'))) 'Unmodified doctor.mjs must be removed on uninstall'
  Assert-True (Test-Path -LiteralPath $agentsFile) 'AGENTS.md must be preserved on uninstall'
  Assert-True (Test-Path -LiteralPath $ruleFile) 'User-modified file-structure.md must be preserved on non-force uninstall'
  Step-Pass 'setup.ps1 -Uninstall removed unmodified framework files and preserved AGENTS.md + user-modified rule'

  # 8. windows-host-probe.ps1 -SetupOnly sandbox & redaction smoke check
  $probeOutFile = Join-Path $TmpBase 'probe-out.json'
  $env:CAC_DUMMY_SECRET_TOKEN = 'super-secret-probe-token-do-not-print'
  try {
    $rProbe = Invoke-PsScript $ProbePs1 @('-SetupOnly', '-OutFile', $probeOutFile)
    Assert-True ($rProbe.ExitCode -eq 0) ("windows-host-probe.ps1 -SetupOnly failed with exit " + $rProbe.ExitCode)
  } finally {
    Remove-Item Env:CAC_DUMMY_SECRET_TOKEN -ErrorAction SilentlyContinue
  }

  Assert-True (-not $rProbe.Stdout.Contains('super-secret-probe-token-do-not-print')) 'windows-host-probe.ps1 leaked sensitive env token!'
  $probeObj = $rProbe.Stdout | ConvertFrom-Json
  $ProbeSandboxToClean = $probeObj.sandboxRoot
  Assert-True ($probeObj.schemaVersion -eq 1) 'Expected schemaVersion = 1 from windows-host-probe.ps1'
  Assert-True ([bool]$probeObj.setupOnly) 'Expected setupOnly = true'
  Assert-True ([string]$probeObj.hostEnv.CAC_DUMMY_SECRET_TOKEN -match '^\[REDACTED len=') 'Expected redacted CAC_DUMMY_SECRET_TOKEN'
  Assert-True (Test-Path -LiteralPath (Join-Path $ProbeSandboxToClean '.cac/hooks/probe-hook.mjs')) 'Probe sandbox missing probe-hook.mjs'
  Step-Pass 'windows-host-probe.ps1 -SetupOnly verified sandbox creation and strict token redaction'

  Write-Host ("1..{0} ALL PASSED" -f $PassCount)
  exit 0
}
finally {
  if ($ProbeSandboxToClean -and (Test-Path -LiteralPath $ProbeSandboxToClean)) {
    Remove-Item -LiteralPath $ProbeSandboxToClean -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $TmpBase) {
    Remove-Item -LiteralPath $TmpBase -Recurse -Force -ErrorAction SilentlyContinue
  }
}
