#!/usr/bin/env pwsh
# setup.ps1 - cac-base Windows PowerShell thin wrapper (PowerShell 5.1+ / pwsh 7+).
# Pure ASCII UTF-8 without BOM. Validates node >= 20 via strict integer comparison and forwards to scripts/cac-base.mjs.
# Supports both positional target and subcommand forms:
#   pwsh -File .\setup.ps1 D:\proj -DryRun
#   pwsh -File .\setup.ps1 -Target D:\proj -WithHarness -WithTests
#   pwsh -File .\setup.ps1 install -Target D:\proj
#   pwsh -File .\setup.ps1 -Uninstall -Target D:\proj
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command = '',
  [string]$Target = '',
  [string]$Out = '',
  [switch]$DryRun,
  [switch]$WithTests,
  [switch]$WithHarness,
  [switch]$Force,
  [switch]$Uninstall,
  [ValidateSet('', 'string', 'exec')]
  [string]$HookForm = '',
  [switch]$Json,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = 'Stop'

function Exit-Usage([string]$Message) {
  [Console]::Error.WriteLine("setup: $Message")
  [Console]::Error.WriteLine('Usage: pwsh -File .\setup.ps1 [install|upgrade|uninstall|doctor|release] [-Target <dir> | <dir>] [-Out <path>] [-DryRun] [-WithTests] [-WithHarness] [-Force] [-Uninstall] [-HookForm string|exec]')
  exit 2
}

$KnownCommands = @('install', 'upgrade', 'uninstall', 'doctor', 'manifest', 'pack-check', 'release', 'help')
$CommonTypoSubcommands = @(
  'package', 'pack', 'bundle', 'check', 'verify', 'test', 'tests',
  'lint', 'audit', 'status', 'init', 'update', 'remove', 'clean', 'version'
)
$AllowedForwardFlags = @(
  '--dry-run', '--with-tests', '--with-harness', '--force', '--uninstall',
  '--write', '--check', '--leak', '--json', '--strict-syntax', '-h', '--help'
)

$forwardArgs = New-Object System.Collections.Generic.List[string]
$resolvedCmd = ''
$resolvedTarget = $Target

# Inspect $Command: could be empty, a subcommand, a POSIX flag (e.g. --dry-run / --help), or a positional target path!
if ($Command -ne '') {
  if ($KnownCommands -contains $Command) {
    $resolvedCmd = $Command
  }
  elseif ($Command.StartsWith('-')) {
    $ExtraArgs = @($Command) + $ExtraArgs
  }
  else {
    if ($resolvedTarget -ne '') {
      Exit-Usage "both positional target ($Command) and -Target ($resolvedTarget) were specified; pass only one"
    }
    if (($Command -cmatch '^[a-z]+$') -and ($CommonTypoSubcommands -contains $Command)) {
      Exit-Usage "unknown subcommand '$Command' (pass -Target .\$Command to install into a folder named '$Command')"
    }
    $resolvedTarget = $Command
  }
}

# Validate and collect any remaining arguments (POSIX long flags or subcommand positionals like release <version>)
for ($i = 0; $i -lt $ExtraArgs.Count; $i++) {
  $arg = $ExtraArgs[$i]
  if ($AllowedForwardFlags -contains $arg) {
    [void]$forwardArgs.Add($arg)
    continue
  }
  if ($arg -eq '--target' -or $arg -eq '--hook-form' -or $arg -eq '--out') {
    if (($i + 1) -ge $ExtraArgs.Count -or $ExtraArgs[$i + 1].StartsWith('-')) {
      Exit-Usage "option $arg requires a value"
    }
    $val = $ExtraArgs[$i + 1]
    $i++
    if ($arg -eq '--target') {
      if ($resolvedTarget -ne '') { Exit-Usage "duplicate target specified ($resolvedTarget vs $val)" }
      $resolvedTarget = $val
    }
    elseif ($arg -eq '--hook-form') {
      if ($val -ne 'string' -and $val -ne 'exec') { Exit-Usage "--hook-form expects 'string' or 'exec' (got: $val)" }
      $HookForm = $val
    }
    else {
      if ($Out -ne '') { Exit-Usage "duplicate out path specified ($Out vs $val)" }
      $Out = $val
    }
    continue
  }
  if ($arg.StartsWith('--target=')) {
    $val = $arg.Substring(9)
    if (-not $val) { Exit-Usage '--target= requires a non-empty value' }
    if ($resolvedTarget -ne '') { Exit-Usage "duplicate target specified ($resolvedTarget vs $val)" }
    $resolvedTarget = $val
    continue
  }
  if ($arg.StartsWith('--hook-form=')) {
    $val = $arg.Substring(12)
    if ($val -ne 'string' -and $val -ne 'exec') { Exit-Usage "--hook-form expects 'string' or 'exec' (got: $val)" }
    $HookForm = $val
    continue
  }
  if ($arg.StartsWith('--out=')) {
    $val = $arg.Substring(6)
    if (-not $val) { Exit-Usage '--out= requires a non-empty value' }
    if ($Out -ne '') { Exit-Usage "duplicate out path specified ($Out vs $val)" }
    $Out = $val
    continue
  }
  if ($arg.StartsWith('-')) {
    Exit-Usage "unknown option: $arg"
  }
  if ($resolvedCmd -eq '' -and ($KnownCommands -contains $arg)) {
    $resolvedCmd = $arg
    continue
  }
  if ($resolvedCmd -eq 'release') {
    [void]$forwardArgs.Add($arg)
    continue
  }
  if ($resolvedTarget -eq '') {
    if ($resolvedCmd -eq '' -and ($arg -cmatch '^[a-z]+$') -and ($CommonTypoSubcommands -contains $arg)) {
      Exit-Usage "unknown subcommand '$arg' (pass -Target .\$arg to install into a folder named '$arg')"
    }
    $resolvedTarget = $arg
  }
  else {
    Exit-Usage "unexpected extra positional argument: $arg"
  }
}

if ($Uninstall) {
  if ($resolvedCmd -ne '' -and $resolvedCmd -ne 'install' -and $resolvedCmd -ne 'uninstall') {
    Exit-Usage "-Uninstall cannot be combined with subcommand '$resolvedCmd'"
  }
  $resolvedCmd = 'uninstall'
}
if ($resolvedCmd -eq '') {
  $resolvedCmd = 'install'
}

# Strict integer check for Node >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  [Console]::Error.WriteLine('[setup] missing required runtime: node (>= 20)')
  exit 3
}

$majorStr = (& node -p "process.versions.node.split('.')[0]" 2>$null | Out-String).Trim()
$majorInt = 0
if (-not [int]::TryParse($majorStr, [ref]$majorInt) -or $majorInt -lt 20) {
  $verStr = (& node --version 2>$null | Out-String).Trim()
  [Console]::Error.WriteLine("[setup] node >= 20 required (found: $verStr)")
  exit 3
}

$cliArgs = New-Object System.Collections.Generic.List[string]
[void]$cliArgs.Add($resolvedCmd)

if ($resolvedTarget -ne '') {
  [void]$cliArgs.Add('--target')
  [void]$cliArgs.Add($resolvedTarget)
}
if ($DryRun -and -not ($forwardArgs -contains '--dry-run')) { [void]$cliArgs.Add('--dry-run') }
if ($WithTests -and -not ($forwardArgs -contains '--with-tests')) { [void]$cliArgs.Add('--with-tests') }
if ($WithHarness -and -not ($forwardArgs -contains '--with-harness')) { [void]$cliArgs.Add('--with-harness') }
if ($Force -and -not ($forwardArgs -contains '--force')) { [void]$cliArgs.Add('--force') }
if ($Json -and -not ($forwardArgs -contains '--json')) { [void]$cliArgs.Add('--json') }
if ($HookForm -ne '') {
  [void]$cliArgs.Add('--hook-form')
  [void]$cliArgs.Add($HookForm)
}
if ($Out -ne '') {
  [void]$cliArgs.Add('--out')
  [void]$cliArgs.Add($Out)
}
foreach ($fa in $forwardArgs) {
  [void]$cliArgs.Add($fa)
}

$entryScript = Join-Path $PSScriptRoot 'scripts\cac-base.mjs'
& node $entryScript @cliArgs
exit $LASTEXITCODE
