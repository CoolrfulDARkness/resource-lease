#Requires -Version 5.1
<#
.SYNOPSIS
  Resource lease CLI - cross-process file lock for arbitrating exclusive
  resources between sub-agents.

.DESCRIPTION
  Zero dependencies: no plugin needed. Any agent, script or skill can call it.

  DURATION UNITS (all three implementations agree on this):
    - a duration STRING with a unit: "500ms", "30s", "2m", "1h"
    - a duration STRING with a bare number: SECONDS ("600" = 600 s).
      Seconds is the safer reading for a lock: a too-long TTL merely leaves a
      stale lease, while a too-short one gets taken over early and produces
      two holders. Env vars always arrive as strings.
    - the numeric tool fields ttlMs / waitMs are MILLISECONDS (name says so).
    - anything unparseable is a hard error, never a silent fallback.
    TTL is clamped to a 1000 ms floor everywhere.

  ATOMICITY NOTE (important, and easy to get wrong):
    The lock is a FILE created with FileMode.CreateNew, which maps to
    open(O_CREAT | O_EXCL) - the only portable primitive that decides
    success/failure in a single system call.
    Do NOT implement this with a directory. A directory lock's verdict depends
    on whether creation THREW. Plain New-Item -ItemType Directory does throw on
    an existing directory in PowerShell 5.1, but the variants people reach for
    (-Force, [System.IO.Directory]::CreateDirectory) do NOT throw, so every
    racer "succeeds" and mutual exclusion is silently broken. File +
    FileMode.CreateNew has no such ambiguity.

  ENCODING NOTE:
    This file is intentionally pure ASCII. Windows PowerShell 5.1 reads .ps1
    files with the system ANSI code page, so a non-ASCII literal can corrupt
    and even swallow a closing quote, breaking the whole script.

  Resource key convention: <category>:<specific>
    browser:chromium      a Chromium instance          (pool 2 recommended)
    browser:profile:main  a specific user-data-dir     (exclusive)
    port:9222             a fixed port                 (exclusive)
    screen:focus          screen / input focus         (exclusive)
    dir:src/parser        a shared write target        (exclusive)
    repo:root             a git repository             (exclusive)

  Keys are sanitized to [A-Za-z0-9._-] AND lowercased for the lock filename,
  so "Browser:Chromium" and "browser:chromium" are the same lock. The MCP
  server and the plugin apply the identical rule; without it the same key
  would name two files on a case-sensitive filesystem and mutual exclusion
  would fail silently there.

  `run` defaults are -Wait 0 (fail immediately, never queue) and -Ttl from
  DSH_RESOURCE_TTL (600s when unset). Pass -Wait explicitly when you really
  want to queue.

.EXAMPLE
  .\lease.ps1 acquire browser:chromium -Ttl 60s -Wait 120s -Reason "screenshot"
  .\lease.ps1 run browser:chromium -Cmd "node render.mjs"
  .\lease.ps1 status
  .\lease.ps1 release --all -Owner agent-a

.NOTES
  Exit codes of the protocol itself:
    0 = success | 2 = busy / wait timeout / unknown lease id | 3 = bad usage
  `run` is the exception: it exits with the CHILD process's exit code, so any
  value is possible there. To tell "did not get the lease" apart from "the
  command failed", read stderr: a lock failure prints a "Resource busy" line
  and never prints "Acquired lease".
#>
[CmdletBinding()]
param(
  # Everything is parsed by hand: the CLI accepts arbitrary "-Flag value"
  # switches, so no positional parameter is declared (declaring one would
  # swallow the subcommand and confuse the remaining-argument stream).
  [Parameter(ValueFromRemainingArguments = $true)]$Rest
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------- configuration

$LockRoot = if ($env:DSH_RESOURCE_LOCK_ROOT) { $env:DSH_RESOURCE_LOCK_ROOT }
            else { Join-Path $env:LOCALAPPDATA 'dsh-resource-lease\locks' }

$IndexRoot = Join-Path $LockRoot '_leases'
$DefaultOwner = if ($env:DSH_AGENT_NAME) { $env:DSH_AGENT_NAME } else { "pid:$PID" }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Exit-With([int]$code, [string]$message) {
  if ($message) { [Console]::Error.WriteLine($message) }
  exit $code
}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# How old an UNREADABLE lock file must be before it counts as a crashed residue
# and may be taken over. A file that a live process just created has no
# parseable body for a few milliseconds; calling that "expired" lets two agents
# hold one lock. A crashed writer stops touching its file, so it ages past this.
$StaleTakeoverGraceMs = 2000

# Age of a lock path in ms, or -1 when nothing is there.
# Works for FILES AND DIRECTORIES: FileInfo.Exists is false for a directory,
# which used to make a directory squatting on a lock path look "gone" (-1) and
# therefore un-takeable. The path then reported busy forever - no TTL could
# rescue it - while `status` showed no lease at all.
function Get-LockAgeMs([string]$path) {
  try {
    if ([System.IO.Directory]::Exists($path)) {
      $info = New-Object System.IO.DirectoryInfo($path)
    } else {
      $info = New-Object System.IO.FileInfo($path)
    }
    if (-not $info.Exists) { return -1 }
    return [int64](([DateTime]::UtcNow - $info.LastWriteTimeUtc).TotalMilliseconds)
  } catch {
    return -1
  }
}

# Parse "30s" / "2m" / "500ms" into milliseconds.
# A bare number is REJECTED on purpose: "30" is ambiguous (30s vs 30ms) and the
# three implementations used to disagree by 1000x, silently. Fields whose name
# already carries the unit (ttlMs/waitMs, numeric) are not parsed here.
function ConvertTo-Ms([string]$text, [int]$default) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $default }
  if ($text -match '^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$') {
    if (-not $Matches[2]) {
      # Bare number in a string: SECONDS. See .DESCRIPTION for why seconds and
      # not milliseconds, and why this must not be an error (env vars are
      # strings, so rejecting "600" would break every existing deployment).
      return [int]([double]$Matches[1] * 1000)
    }
    $n = [double]$Matches[1]
    switch ($Matches[2]) {
      'ms'    { return [int]$n }
      's'     { return [int]($n * 1000) }
      'm'     { return [int]($n * 60000) }
      'h'     { return [int]($n * 3600000) }
      default { return [int]$n }
    }
  }
  Exit-With 3 "Cannot parse duration: '$text' (examples: 30s / 2m / 500ms)"
}

# Lock file base name: sanitize + lowercase.
# Lowercasing is what the protocol requires ("keys are lowercase") and what
# keeps "Browser:Chromium" and "browser:chromium" on ONE file on a
# case-sensitive filesystem. Windows hides the bug (case-insensitive names),
# Linux does not: two files, no exclusion, no error.
function Get-KeyBase([string]$key) {
  return ($key -replace '[^A-Za-z0-9._-]', '_').ToLowerInvariant()
}

# Lock file path. Pool slots get one file each.
function Get-LockPath([string]$key, [int]$slot, [string]$mode) {
  $base = Get-KeyBase $key
  if ($mode -eq 'pool') { return (Join-Path $LockRoot ("{0}.slot-{1}.lock" -f $base, $slot)) }
  return (Join-Path $LockRoot ("{0}.lock" -f $base))
}

function New-LeaseId { 'lz_' + [guid]::NewGuid().ToString('N').Substring(0, 12) }

function Read-Meta([string]$path) {
  if (-not [System.IO.File]::Exists($path)) { return $null }
  try { return [System.IO.File]::ReadAllText($path, $Utf8NoBom) | ConvertFrom-Json } catch { return $null }
}

function Test-Expired($meta) {
  if (-not $meta) { return $true }              # unreadable metadata = takeable
  if (-not $meta.expiresAt) { return $true }
  return ([int64]$meta.expiresAt -lt (Now-Ms))
}

<#
  The one and only atomic grab.
  FileMode.CreateNew throws IOException when the file already exists, and that
  check-and-create is a single open(O_CREAT|O_EXCL) call - no TOCTOU window.
#>
function Try-AcquireLock([string]$path, $meta) {
  $fs = $null
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $bytes = $Utf8NoBom.GetBytes(($meta | ConvertTo-Json -Depth 6))
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
    return $true
  } catch [System.IO.IOException] {
    return $false                                 # already held
  } catch {
    return $false
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

<#
  Take over an expired lease.
  File.Move is the CAS: when two processes race to take over, only the one
  whose Move succeeds continues; the other throws because the source is gone.

  Two rules here exist because breaking either one produces TWO holders of one
  lock, which is the failure this tool is supposed to make impossible:

  1. An UNREADABLE lock file is not takeable on its own. A file that exists but
     has no parseable body is almost always a live writer between CreateNew and
     its first write (a share violation or an empty read). Treating that as
     "expired" archived a brand-new 30s lease and both agents went on holding
     the same resource - reproduced, not theoretical. An unreadable body only
     becomes takeable once the file is older than $StaleTakeoverGraceMs, which
     is a crashed residue rather than a writer in flight.

  2. Do not trust our own read. After the move, re-read the ARCHIVED copy: if it
     turns out to be a valid, unexpired lease, we grabbed a live lock that its
     owner had just finished writing. Put it back and report failure.

  A DIRECTORY squatting on the lock path is treated as an unreadable residue:
  it has no body but it does have an mtime, so it gets the same grace period and
  is then archived (Directory.Move, which is the rename CAS for directories).
  Without that branch the path was busy forever with no TTL escape, because
  File.Exists() is false for a directory. The MCP server and the plugin already
  archive such a directory; this is the third implementation catching up.
#>
function Try-Takeover([string]$path) {
  $isDir = [System.IO.Directory]::Exists($path)
  $meta = Read-Meta $path                            # null for a directory
  if ($meta) {
    if (-not (Test-Expired $meta)) { return $false }
  } else {
    $ageMs = Get-LockAgeMs $path
    if ($ageMs -lt 0 -or $ageMs -lt $StaleTakeoverGraceMs) { return $false }
  }

  $stale = "$path.stale.$(Now-Ms).$PID"
  try {
    if ($isDir) { [System.IO.Directory]::Move($path, $stale) }
    else        { [System.IO.File]::Move($path, $stale) }
  } catch {
    return $false                                 # someone else won the takeover
  }

  $archived = Read-Meta $stale
  if ($archived -and -not (Test-Expired $archived)) {
    # We archived a live lease: its owner was still writing it. Undo, or two
    # agents would hold the same resource.
    $restored = $false
    try { [System.IO.File]::Move($stale, $path); $restored = $true } catch { }
    $name = [System.IO.Path]::GetFileName($path)
    if ($restored) {
      [Console]::Error.WriteLine("Takeover aborted: $name is a live lease (owner $($archived.owner)); restored it intact")
    } else {
      [Console]::Error.WriteLine("Takeover aborted: $name turned out to be a live lease (owner $($archived.owner)) but could not be restored; see $([System.IO.Path]::GetFileName($stale))")
    }
    return $false
  }

  $owner = if ($meta -and $meta.owner) { $meta.owner } else { '?' }
  $name = [System.IO.Path]::GetFileName($path)
  if ($isDir) {
    [Console]::Error.WriteLine("Archived a directory that occupied the lock path: $name (a lock is a file; moved it aside to $([System.IO.Path]::GetFileName($stale)))")
  } else {
    [Console]::Error.WriteLine("Took over an expired lease: $name (previous owner $owner)")
  }
  # Keep the archived copy for forensics; purge anything older than an hour.
  # -Recurse covers an archived DIRECTORY; -File would have skipped it, leaving
  # it in the lock root forever.
  try {
    Get-ChildItem -Path $LockRoot -Force -Filter '*.stale.*' -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  } catch { }
  return $true
}

function Register-Lease($meta) {
  if (-not [System.IO.Directory]::Exists($IndexRoot)) {
    $null = [System.IO.Directory]::CreateDirectory($IndexRoot)
  }
  $rec = @{ id = $meta.id; key = $meta.key; owner = $meta.owner; pid = $meta.pid; path = $meta.lockPath }
  [System.IO.File]::WriteAllText((Join-Path $IndexRoot ($meta.id + '.json')), ($rec | ConvertTo-Json), $Utf8NoBom)
}

function Get-IndexRecord([string]$id) {
  $f = Join-Path $IndexRoot ($id + '.json')
  if (-not [System.IO.File]::Exists($f)) { return $null }
  try { return [System.IO.File]::ReadAllText($f, $Utf8NoBom) | ConvertFrom-Json } catch { return $null }
}

<#
  Release one lease by id.

  The lock FILE is authoritative, not our index record. Deleting by path alone
  is the one bug that produces silent double-hold - the failure this whole tool
  exists to prevent:
    1. our lease EXPIRED and another agent took it over. The file now belongs
       to that agent. Deleting it would let a third agent in while the new
       holder still believes it is exclusive.
    2. our index record is stale (a previous run, a restart) while the file was
       created by someone else.
  So read the file first and require its id (and owner) to match the index
  record; delete only on a match. A mismatch is logged, never acted on. This is
  the same rule as releaseById() in mcp/resource-lease-mcp.mjs, so the two
  implementations agree.

  Returns 'released' | 'takenover' | 'missing'. It is a bare string, so every
  caller MUST capture it - an uncaptured string would land on stdout.
#>
function Remove-LeaseById([string]$id) {
  $rec = Get-IndexRecord $id
  if (-not $rec) { return 'missing' }

  $indexFile = Join-Path $IndexRoot ($id + '.json')
  $lockPath = if ($rec.path) { [string]$rec.path } else { '' }

  if (-not $lockPath -or -not [System.IO.File]::Exists($lockPath)) {
    try { [System.IO.File]::Delete($indexFile) } catch { }
    return 'missing'
  }

  $onDisk = Read-Meta $lockPath
  $diskId    = if ($onDisk -and $onDisk.id)    { [string]$onDisk.id }    else { '' }
  $diskOwner = if ($onDisk -and $onDisk.owner) { [string]$onDisk.owner } else { '' }
  $recOwner  = if ($rec.owner) { [string]$rec.owner } else { $diskOwner }

  if ($diskId -ne $id -or ($diskOwner -and ($diskOwner -ne $recOwner))) {
    [Console]::Error.WriteLine("Lease $id is no longer ours (lock file now holds id='$diskId' owner='$diskOwner'); kept that lock and dropped our stale index record")
    try { [System.IO.File]::Delete($indexFile) } catch { }
    return 'takenover'
  }

  try { [System.IO.File]::Delete($lockPath) } catch { }
  try { [System.IO.File]::Delete($indexFile) } catch { }
  return 'released'
}

# ------------------------------------------------------------------ arg parsing

$opts = @{ Owner = $DefaultOwner; Mode = 'exclusive'; Slots = 1; Ttl = $null; Wait = $null; Reason = $null; All = $false; Cmd = $null }
$positional = @()
$command = $null
$i = 0
$rest = @($Rest)
while ($i -lt $rest.Count) {
  $a = [string]$rest[$i]
  if ($a -eq '--') { $i++; break }
  switch -Regex ($a) {
    '^-{1,2}(?i)owner$'  { $i++; $opts.Owner  = [string]$rest[$i] }
    '^-{1,2}(?i)mode$'   { $i++; $opts.Mode   = [string]$rest[$i] }
    '^-{1,2}(?i)slots$'  { $i++; $opts.Slots  = [int]$rest[$i] }
    '^-{1,2}(?i)ttl$'    { $i++; $opts.Ttl    = [string]$rest[$i] }
    '^-{1,2}(?i)wait$'   { $i++; $opts.Wait   = [string]$rest[$i] }
    '^-{1,2}(?i)reason$' { $i++; $opts.Reason = [string]$rest[$i] }
    '^-{1,2}(?i)cmd$'    { $i++; $opts.Cmd    = [string]$rest[$i] }
    '^-{1,2}(?i)all$'    { $opts.All = $true }
    '^-h$|^-{1,2}(?i)help$' { $command = 'help' }
    default { $positional += $a }
  }
  $i++
}
# Everything after "--" is the command that `run` should execute.
$runCommand = if ($i -lt $rest.Count) { @($rest[$i..($rest.Count - 1)]) } else { @() }
if ($positional.Count -ge 1) { $command = $positional[0] }
if (-not $command) { $command = 'status' }
$key = if ($positional.Count -ge 2) { $positional[1] } else { $null }

# --------------------------------------------------------------- command bodies

function Invoke-Acquire {
  if (-not $key) {
    Exit-With 3 "Usage: lease.ps1 acquire [resource-key] [-Mode exclusive|shared|pool] [-Slots N] [-Ttl 30s] [-Wait 120s] [-Owner name] [-Reason text]"
  }
  if ([string]::IsNullOrWhiteSpace($opts.Owner)) {
    # Two agents both named "" are indistinguishable, so one's
    # `release --all -Owner ""` would free the other's leases.
    Exit-With 3 "acquire needs a non-empty -Owner (or set DSH_AGENT_NAME). An empty owner makes every lease look like yours, so release --all would delete other agents' locks."
  }

  $defaultTtl = if ($env:DSH_RESOURCE_TTL) { ConvertTo-Ms $env:DSH_RESOURCE_TTL 30000 } else { 30000 }
  $ttlMs  = ConvertTo-Ms $opts.Ttl $defaultTtl
  $waitMs = ConvertTo-Ms $opts.Wait 0
  if ($ttlMs -lt 1000) { $ttlMs = 1000 }   # floor: 0 would make expiresAt == createdAt
  $deadline = (Now-Ms) + $waitMs

  if (-not [System.IO.Directory]::Exists($LockRoot)) {
    $null = [System.IO.Directory]::CreateDirectory($LockRoot)
  }

  while ($true) {
    $slots = if ($opts.Mode -eq 'pool') { [Math]::Max(1, $opts.Slots) } else { 1 }

    for ($s = 0; $s -lt $slots; $s++) {
      $lockPath = Get-LockPath $key $s $opts.Mode
      $meta = [ordered]@{
        id        = New-LeaseId
        key       = $key
        mode      = $opts.Mode
        slots     = $slots
        slot      = $s
        owner     = $opts.Owner
        reason    = $opts.Reason
        pid       = $PID
        host      = [Environment]::MachineName
        createdAt = (Now-Ms)
        expiresAt = (Now-Ms) + $ttlMs
        lockPath  = $lockPath
      }

      if (Try-AcquireLock $lockPath $meta) {
        Register-Lease $meta
        [pscustomobject]$meta | ConvertTo-Json -Depth 6
        $script:code = 0; return
      }

      if (Try-Takeover $lockPath) {
        $s--                                        # retry the same slot
        continue
      }
    }

    if ((Now-Ms) -ge $deadline) {
      $holders = @()
      for ($s = 0; $s -lt $slots; $s++) {
        $m = Read-Meta (Get-LockPath $key $s $opts.Mode)
        if ($m) {
          $left = [int64]$m.expiresAt - (Now-Ms)
          $holders += ("{0}(reason={1}, {2}ms left)" -f $m.owner, $m.reason, $left)
        }
      }
      if ($holders.Count -eq 0) {
        # The lock file exists but has no readable body yet: a holder that is
        # mid-write. Say so instead of claiming an empty owner.
        $holders += 'a holder still writing its lock file (no readable metadata yet)'
      }
      Exit-With 2 ("Resource busy: $key - held by " + ($holders -join '; '))
    }
    Start-Sleep -Milliseconds 150
  }
}

function Invoke-Release {
  if ($opts.All) {
    if ([string]::IsNullOrWhiteSpace($opts.Owner)) {
      Exit-With 3 "release --all needs a non-empty -Owner (or set DSH_AGENT_NAME). An empty owner matches every lease, so it would release other agents' locks."
    }
    if (-not [System.IO.Directory]::Exists($IndexRoot)) { "released=0 owner=$($opts.Owner)"; $script:code = 0; return }
    $n = 0
    foreach ($f in Get-ChildItem $IndexRoot -File -Filter '*.json' -ErrorAction SilentlyContinue) {
      $rec = $null
      try { $rec = [System.IO.File]::ReadAllText($f.FullName, $Utf8NoBom) | ConvertFrom-Json }
      catch { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue; continue }
      if ($rec.path -and [System.IO.File]::Exists($rec.path)) {
        $m = Read-Meta $rec.path
        if ($m -and $m.owner -eq $opts.Owner) {
          try { [System.IO.File]::Delete($rec.path) } catch { }
          Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
          $n++
        }
      } else {
        Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
      }
    }
    "released=$n owner=$($opts.Owner)"
    $script:code = 0; return
  }

  if (-not $key) { Exit-With 3 "Usage: lease.ps1 release [leaseId] | release --all -Owner [name]" }
  $outcome = Remove-LeaseById $key
  if ($outcome -eq 'released') { "released=$key"; $script:code = 0; return }
  if ($outcome -eq 'takenover') {
    Exit-With 2 "Lease $key is no longer yours: it expired and another holder took it over. Its lock was left intact and nothing was released."
  }
  Exit-With 2 "No such lease: $key (already released, or wrong id)"
}

function Invoke-Status {
  if (-not [System.IO.Directory]::Exists($LockRoot)) {
    "Resource leases: none (lock root does not exist: $LockRoot)"; $script:code = 0; return
  }
  $now = Now-Ms
  $rows = @()

  foreach ($f in Get-ChildItem $LockRoot -File -Filter '*.lock' -ErrorAction SilentlyContinue) {
    $m = Read-Meta $f.FullName
    if (-not $m) { continue }
    $remain = [int64]$m.expiresAt - $now
    $modeText   = if ($m.mode -eq 'pool') { "pool($($m.slot + 1)/$($m.slots))" } else { $m.mode }
    $remainText = if ($remain -gt 0) { "$([Math]::Round($remain / 1000, 1))s" } else { 'EXPIRED(takeable)' }
    $rows += [pscustomobject]@{
      key    = $m.key
      mode   = $modeText
      owner  = $m.owner
      reason = $m.reason
      remain = $remainText
      pid    = $m.pid
    }
  }

  if ($rows.Count -eq 0) { "Resource leases: none"; $script:code = 0; return }
  $rows | Sort-Object key | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
  $script:code = 0; return
}

function Invoke-Run {
  # Two ways to say what to run:
  #   run [key] -Cmd "command line"   robust: handed to cmd.exe /c, so switches
  #                                   like -NoProfile or -m are safe
  #   run [key] -- [command ...]      simple commands without dash switches
  if (-not $key) { Exit-With 3 "Usage: lease.ps1 run [resource-key] -Cmd [command line]   OR   lease.ps1 run [resource-key] -- [command ...]" }
  if (-not $opts.Cmd -and $runCommand.Count -eq 0) {
    Exit-With 3 "run requires -Cmd [command line] or -- [command ...]"
  }

  # Defaults: fail immediately (-Wait 0) and a 10 minute lease, unless
  # DSH_RESOURCE_TTL says otherwise. Immediate failure is the protocol's first
  # rule; queueing is opt-in (-Wait 120s), never implicit.
  $defaultTtl = if ($env:DSH_RESOURCE_TTL) { ConvertTo-Ms $env:DSH_RESOURCE_TTL 600000 } else { 600000 }
  $ttlMs  = ConvertTo-Ms $opts.Ttl $defaultTtl
  $waitMs = ConvertTo-Ms $opts.Wait 0
  if ($ttlMs -lt 1000) { $ttlMs = 1000 }   # same floor as acquire
  $lease = $null
  try {
    # Pass the exact milliseconds through: rounding to whole seconds would
    # turn a 500ms lease into 0.
    $opts.Ttl  = "$($ttlMs)ms"
    $opts.Wait = "$($waitMs)ms"
    $json = Invoke-Acquire
    if (-not $json) { $script:code = 2; return }
    $lease = $json | ConvertFrom-Json
    [Console]::Error.WriteLine("Acquired lease $($lease.id) on $key (owner $($lease.owner))")

    if ($opts.Cmd) {
      & cmd.exe /c $opts.Cmd
    } else {
      $exe  = $runCommand[0]
      $argv = @()
      if ($runCommand.Count -gt 1) { $argv = $runCommand[1..($runCommand.Count - 1)] }
      & $exe @argv
    }
    $script:code = $LASTEXITCODE; return
  } finally {
    # Critical: release on the exception path too -- but only OUR lease. If the
    # lease expired and someone else took it over while the command ran, the
    # lock file belongs to them; deleting it would hand the resource to a third
    # agent while the new holder still thinks it is exclusive. Log, do not delete.
    if ($lease) {
      try {
        $outcome = Remove-LeaseById $lease.id
        if ($outcome -eq 'released') {
          [Console]::Error.WriteLine("Released lease $($lease.id)")
        } elseif ($outcome -eq 'takenover') {
          [Console]::Error.WriteLine("Lease $($lease.id) had already been taken over; left the new holder's lock in place")
        } else {
          [Console]::Error.WriteLine("Lease $($lease.id) was already gone (TTL expiry or manual release)")
        }
      } catch {
        [Console]::Error.WriteLine("Release failed (TTL will clean it up): $($_.Exception.Message)")
      }
    }
  }
}

function Invoke-Help {
  $lines = @(
    'Resource lease CLI',
    '',
    '  lease.ps1 acquire [key] [-Mode exclusive|shared|pool] [-Slots N] [-Ttl 30s] [-Wait 120s] [-Owner name] [-Reason text]',
    '  lease.ps1 release [leaseId] | release --all [-Owner name]',
    '  lease.ps1 status',
    '  lease.ps1 run [key] -Cmd [command line]        <- robust: dash switches safe',
    '  lease.ps1 run [key] -- [command ...]           <- simple commands only',
    '',
    '  run defaults: -Wait 0 (fail immediately; pass -Wait 120s to queue)',
    '                -Ttl $env:DSH_RESOURCE_TTL, else 600s',
    '',
    'Exit codes: 0 = success, 2 = busy / wait timeout / unknown lease, 3 = bad usage',
    "            run instead exits with the child command's exit code (any value)",
    '            tell them apart by stderr: "Resource busy" vs "Acquired lease"',
    "Lock root: $LockRoot  (override with DSH_RESOURCE_LOCK_ROOT)"
  )
  $lines -join [Environment]::NewLine | Write-Output
  $script:code = 0; return
}

# ---------------------------------------------------------------------- dispatch

$script:code = 0
switch ($command) {
  'acquire' { Invoke-Acquire }
  'release' { Invoke-Release }
  'status'  { Invoke-Status }
  'run'     { Invoke-Run }
  'help'    { Invoke-Help }
  default   { Exit-With 3 "Unknown subcommand: '$command' (available: acquire/release/status/run/help)" }
}
exit ([int]$script:code)
