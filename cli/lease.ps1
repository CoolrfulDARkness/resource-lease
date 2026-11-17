#Requires -Version 5.1
<#
.SYNOPSIS
  Resource lease CLI (v2) - cross-process, multi-resource, crash-safe lease
  arbiter that speaks the same on-disk protocol as the DSH resource-lease
  plugin and the MCP server.

.DESCRIPTION
  Zero dependencies: no plugin needed. Any agent, script or skill can call it.
  The contract implemented here is docs/RESOURCE-MODEL-v2.md (sections 2, 3,
  4, 5, 7.2, 7.3).

  DURATION UNITS (all implementations agree on this):
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

  WHAT v2 ADDS (and why the old single-key form still works):
    * A key is normalized to a CANONICAL form before it touches the disk, and
      it EXPANDS into a set of facets. Conflict is decided on facets, not on
      string equality, so "path:D:/out" vs "path:d:\\out", "port:9222" vs
      "port:9220-9230" and "path:D:/out" vs "path:D:/out/sub" are all seen as
      the same collision. See Get-CanonicalKey / Expand-Facets / Test-FacetConflict.
    * One acquire can request SEVERAL keys. They are taken in a global,
      machine-independent order (ordinal on the canonical facet string) and
      rolled back in reverse on failure, so two agents asking for the same
      pair in opposite orders cannot deadlock (contract G2).
    * Liveness beats TTL: a lock whose owner records a process identity
      (ownerInfo/owner object with pid+host+procStart) is reclaimed at once
      when that process is gone or its start time no longer matches (PID
      reuse). See Test-OwnerDead.

  Resource key convention:  <class>:<subject>[:<qualifier>...]
    path:C:\\out             a directory tree       (exclusive)
    port:9222 / port:9220-9230  a fixed port / a range (exclusive)
    proc:build               a job name             (exclusive)
    browser:instance         the whole browser      (exclusive)
    browser:profile:work     one user-data-dir     (exclusive, + path facet)
    browser:cdp:9222         a CDP endpoint         (+ port facet)
    screen:focus             screen / input focus   (exclusive)
    window:hwnd:197772       one window             (exclusive)
    api:openai:rpm           a rate-limit quota     (pool)
    named:deploy             anything else          (exclusive)
    Keys with an unknown class (for example the v1 spellings "dir:src/parser",
    "repo:root", "browser:chromium") are kept as-is apart from lowercasing, so
    every lock file name v1 produced is byte-identical here.

  Keys are sanitized to [A-Za-z0-9._-] AND lowercased for the lock filename,
  so "Browser:Chromium" and "browser:chromium" are the same lock. The plugin
  and the MCP server apply the identical rule; without it the same key would
  name two files on a case-sensitive filesystem and mutual exclusion would
  fail silently there.

  `run` defaults are -Wait 0 (fail immediately, never queue) and -Ttl from
  DSH_RESOURCE_TTL (600s when unset). Pass -Wait explicitly when you really
  want to queue.

.EXAMPLE
  .\\lease.ps1 acquire path:D:/out port:9222 --ttl 300s --reason "build"
  .\\lease.ps1 acquire browser:profile:work -Ttl 600s -Reason "screenshot"
  .\\lease.ps1 run --keys path:D:/out,port:9222 -- node build.mjs
  .\\lease.ps1 release --id lz_ab12cd34ef56 | release --all --owner agent-a
  .\\lease.ps1 status

.NOTES
  Exit codes of the protocol itself (contract 7.3):
    0 = success
    2 = conflict / wait timeout / unknown lease id
    3 = bad usage
    4 = backend or IO error (lock root unusable, index unreadable, ...)
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

$IndexRoot  = Join-Path $LockRoot '_leases'
$Machine    = [Environment]::MachineName
$Utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

$DefaultOwner = if ($env:DSH_AGENT_NAME) { $env:DSH_AGENT_NAME } else { "pid:$PID" }

function Get-SessionName {
  if ($env:DSH_SESSION_ID) { return [string]$env:DSH_SESSION_ID }
  return 'local'
}

$SessionName = Get-SessionName

# Key classes defined by the contract (section 2). Anything else is a legacy
# v1 key and is only lowercased, so its lock filename never changes.
$KnownClasses = @('path', 'port', 'proc', 'browser', 'screen', 'window', 'api', 'named')

# How old an UNREADABLE lock file must be before it counts as a crashed residue
# and may be taken over. A file that a live process just created has no
# parseable body for a few milliseconds; calling that "expired" lets two agents
# hold one lock. A crashed writer stops touching its file, so it ages past this.
$StaleTakeoverGraceMs = 2000

# The multi-facet "scan for ancestor / range / cross-class collisions, then
# create the files" step has to be one critical section, otherwise two agents
# acquiring path:a and path:a/sub can both pass the scan and both win (G1 is a
# guarantee, not a best effort). This mutex file serializes that step; it is a
# leading-underscore name so status/scan/release skip it.
$GlobalLockName  = '_global.lock'
$GlobalLockTtlMs = [int64]15000
$GlobalLockWaitMs = 8000

function Exit-With([int]$code, [string]$message) {
  if ($message) { [Console]::Error.WriteLine($message) }
  exit $code
}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

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
# A bare number is SECONDS on purpose: "30" is ambiguous (30s vs 30ms) and the
# three implementations used to disagree by 1000x, silently. Fields whose name
# already carries the unit (ttlMs/waitMs, numeric) are not parsed here.
function ConvertTo-Ms([string]$text, [int]$default) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $default }
  if ($text -match '^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$') {
    if (-not $Matches[2]) {
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

# --------------------------------------------------------- keys and canonical form

<#
  Class of a key or facet = the text before the first colon. A key with no
  colon at all ("out") is a legacy v1 named key; it canonicalizes to itself.

  NEVER calls exit: this runs while scanning foreign lock files, and a bogus
  file on disk must not be able to abort our process.
#>
function Get-KeyClass([string]$key) {
  if ([string]::IsNullOrEmpty($key)) { return 'named' }
  $i = $key.IndexOf(':')
  if ($i -lt 0) { return 'named' }
  return $key.Substring(0, $i).ToLowerInvariant()
}

<#
  Canonical path subject (contract section 2):
    ABSOLUTE (required) -> forward slashes -> lowercase -> resolve . and ..
    -> strip the trailing slash (except a drive root).
  Symlinks are deliberately NOT resolved: resolution is a TOCTOU risk and the
  contract puts it out of scope (section 8, boundary 2).

  A relative path is a HARD ERROR, never resolved against the current
  directory. Resolving it would make the canonical form depend on where the
  caller happened to run, so two agents in different directories would hold two
  different locks for one directory - exclusion would fail silently, which is
  the one failure mode this tool exists to prevent. "C:out" (drive-relative) is
  rejected too: it is rooted but still cwd-dependent.

  Returns $null on failure instead of exiting, so foreign lock files can never
  take the process down; argument parsing turns $null into exit code 3.
#>
function Get-CanonicalPath([string]$subject) {
  if ([string]::IsNullOrWhiteSpace($subject)) { return $null }
  $s = $subject.Trim()
  $isAbsolute = ($s -match '^[A-Za-z]:[\\/]') -or ($s -match '^\\\\') -or ($s -match '^//')
  if (-not $isAbsolute) { return $null }
  $s = $s -replace '\\', '/'
  try { $full = [System.IO.Path]::GetFullPath($s) } catch { return $null }
  $full = $full -replace '\\', '/'
  $full = $full.ToLowerInvariant()
  if ($full -match '^[a-z]:/$') { return $full }
  while ($full.Length -gt 1 -and $full.EndsWith('/')) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  return $full
}

<#
  Canonical port subject: decimal integer without leading zeros, or a range
  "lo-hi" with lo <= hi. Returns $null on failure (see Get-CanonicalPath).
#>
function Get-CanonicalPort([string]$subject) {
  if ([string]::IsNullOrWhiteSpace($subject)) { return $null }
  $s = $subject.Trim()
  if ($s -match '^\d+$') {
    try { return [string]([int64]$s) } catch { return $null }
  }
  if ($s -match '^(\d+)-(\d+)$') {
    try { $lo = [int64]$Matches[1]; $hi = [int64]$Matches[2] } catch { return $null }
    if ($lo -gt $hi) { return $null }
    return ("{0}-{1}" -f $lo, $hi)
  }
  return $null
}

<#
  The canonical form of a key. This is the ONLY equality basis (contract
  section 2): a key is canonicalized before it is written to disk and again
  before it is compared with anything read from disk.

  Legacy keys (unknown class) are only lowercased. That is deliberate: the v1
  CLI wrote "dir:src/parser" as `dir_src_parser.lock` and the plugin still does,
  so adding a class prefix here would silently stop the two from excluding each
  other.

  Returns $null when the key is unusable; callers decide the exit code.
#>
function Get-CanonicalKey([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $k = $raw.Trim()
  $i = $k.IndexOf(':')
  if ($i -lt 0) { return $k.ToLowerInvariant() }
  $cls = $k.Substring(0, $i).ToLowerInvariant()
  $rest = $k.Substring($i + 1)
  if (-not ($KnownClasses -contains $cls)) {
    if ($rest.Trim() -eq '') { return $null }
    return $k.ToLowerInvariant()
  }
  if ($rest.Trim() -eq '') { return $null }
  switch ($cls) {
    'path' {
      $p = Get-CanonicalPath $rest
      if ($null -eq $p) { return $null }
      return ('path:' + $p)
    }
    'port' {
      $p = Get-CanonicalPort $rest
      if ($null -eq $p) { return $null }
      return ('port:' + $p)
    }
    default { return ($cls + ':' + $rest.ToLowerInvariant()) }
  }
}

# Absolute, canonical directory that holds one named browser profile.
# Overridable with DSH_BROWSER_PROFILE_ROOT so tests (and users with a
# relocated browser) stay deterministic. The plugin MUST use the same root for
# the path facet to line up; see the note in the report.
function Get-ProfileDir([string]$name) {
  $root = if ($env:DSH_BROWSER_PROFILE_ROOT) { $env:DSH_BROWSER_PROFILE_ROOT }
          else { Join-Path $env:LOCALAPPDATA 'dsh-resource-lease\browser-profiles' }
  return (Get-CanonicalPath (Join-Path $root $name))
}

<#
  Facet expansion (contract section 3.1): one key can name more than one
  resource. The FIRST facet is always the canonical key itself, so the primary
  lock filename stays sanitizeKey(canonicalKey) - the plugin's rule.

    browser:profile:work -> browser:profile:work + path:<profile dir>
    browser:cdp:9222     -> browser:cdp:9222      + port:9222

  This is what makes "two agents using different spellings of one resource"
  collide: agent A asks for browser:cdp:9222, agent B asks for port:9222, and
  they meet on the same port facet file.
#>
function Expand-Facets([string]$canonicalKey) {
  $list = New-Object System.Collections.ArrayList
  if (-not $canonicalKey) { return ,$list.ToArray() }
  $null = $list.Add($canonicalKey)
  if ($canonicalKey.StartsWith('browser:profile:')) {
    $name = $canonicalKey.Substring('browser:profile:'.Length)
    if ($name) {
      $dir = Get-ProfileDir $name
      if ($dir) { $null = $list.Add('path:' + $dir) }
    }
  } elseif ($canonicalKey.StartsWith('browser:cdp:')) {
    $p = $canonicalKey.Substring('browser:cdp:'.Length)
    $cp = Get-CanonicalPort $p
    if ($cp) { $null = $list.Add('port:' + $cp) }
  }
  return ,$list.ToArray()
}

function Get-FacetSubject([string]$facet) {
  $i = $facet.IndexOf(':')
  if ($i -lt 0) { return '' }
  return $facet.Substring($i + 1)
}

# ------------------------------------------------------------ conflict predicates

<#
  Path subjects conflict when they are equal OR one is an ANCESTOR of the
  other, and ancestor-ness is decided per path SEGMENT, never by raw string
  prefix: "d:/out" and "d:/out2" must not collide (contract section 3.1 - the
  mistake v1 made).
#>
function Get-PathSegments([string]$p) {
  $parts = @()
  foreach ($seg in ($p -split '/')) {
    if ($seg -ne '') { $parts += $seg }
  }
  return ,$parts
}

function Test-PathSubjectConflict([string]$a, [string]$b) {
  if ($a -eq $b) { return $true }
  $sa = Get-PathSegments $a
  $sb = Get-PathSegments $b
  $n = [Math]::Min($sa.Count, $sb.Count)
  if ($n -eq 0) { return $false }
  for ($i = 0; $i -lt $n; $i++) {
    if ($sa[$i] -ne $sb[$i]) { return $false }
  }
  # every segment of the shorter one matched: it is an ancestor (or equal)
  return $true
}

function Get-PortRange([string]$s) {
  if ($s -match '^(\d+)-(\d+)$') { return @([int64]$Matches[1], [int64]$Matches[2]) }
  if ($s -match '^\d+$') { return @([int64]$s, [int64]$s) }
  return $null
}

function Test-PortSubjectConflict([string]$a, [string]$b) {
  if ($a -eq $b) { return $true }
  $ra = Get-PortRange $a
  $rb = Get-PortRange $b
  if ($null -eq $ra -or $null -eq $rb) { return ($a -eq $b) }
  return (($ra[0] -le $rb[1]) -and ($rb[0] -le $ra[1]))
}

<#
  The one conflict table (contract sections 3.2 and 3.3). Keeping it in a
  single function is a hard requirement: scattered implications are how
  "screen:focus vs window:*" ends up over-serializing everything.

  Inputs must already be canonical facets.
#>
function Test-FacetConflict([string]$fa, [string]$fb) {
  if ($fa -eq $fb) { return $true }
  $ca = Get-KeyClass $fa
  $cb = Get-KeyClass $fb
  $sa = Get-FacetSubject $fa
  $sb = Get-FacetSubject $fb

  if ($ca -ne $cb) {
    # browser:instance is a CONTAINER: it conflicts with every browser:* facet.
    if ($ca -eq 'browser' -and $sa -eq 'instance') { return $true }
    if ($cb -eq 'browser' -and $sb -eq 'instance') { return $true }
    # browser:cdp:<p> holds the TCP port <p> as well. Facet expansion already
    # turns it into a port facet; this clause keeps hand-written records honest.
    if ($ca -eq 'browser' -and $cb -eq 'port' -and $sa -match '^cdp:(\d+)$') {
      return (([string]([int64]$Matches[1])) -eq $sb)
    }
    if ($cb -eq 'browser' -and $ca -eq 'port' -and $sb -match '^cdp:(\d+)$') {
      return (([string]([int64]$Matches[1])) -eq $sa)
    }
    # screen:focus is an input stream, window:* is a target object: two agents
    # may hold different windows and still need focus serialized on its own.
    # They must NOT conflict, or every UI job serializes globally.
    return $false
  }

  switch ($ca) {
    'path' { return (Test-PathSubjectConflict $sa $sb) }
    'port' { return (Test-PortSubjectConflict $sa $sb) }
    'browser' {
      if ($sa -eq 'instance' -or $sb -eq 'instance') { return $true }
      return ($sa -eq $sb)
    }
    default { return ($sa -eq $sb) }
  }
}

<#
  Global total order used to sequence multi-key acquisition (contract section
  3.4), so two agents asking for {A,B} in opposite orders cannot form a cycle.
  Ordinal comparison, NOT culture-aware: culture collation ignores punctuation
  at the primary level, which would make "path:d:/a-b" and "path:d:/ab"
  compare equal on one machine and ordered on another - exactly the kind of
  machine-dependent order that turns a total order into a deadlock.

  The contract writes this as class + ":" + subject. Dropping the qualifier
  produces TIES for browser:profile:work and browser:profile:home, and a tie is
  not a total order, so the full canonical facet string is used instead (it is
  unique per facet). Documented deviation; see the task report.
#>
function Sort-FacetList([string[]]$items) {
  $list = New-Object System.Collections.ArrayList
  foreach ($it in $items) {
    if (-not $list.Contains($it)) { $null = $list.Add([string]$it) }
  }
  # insertion sort: facet counts are tiny and this keeps the comparison
  # explicitly ordinal instead of relying on PowerShell's default sorting.
  for ($i = 1; $i -lt $list.Count; $i++) {
    $cur = [string]$list[$i]
    $j = $i - 1
    while (($j -ge 0) -and ([string]::CompareOrdinal([string]$list[$j], $cur) -gt 0)) {
      $list[$j + 1] = $list[$j]
      $j = $j - 1
    }
    $list[$j + 1] = $cur
  }
  return ,$list.ToArray()
}

# --------------------------------------------------------------- lock file paths

<#
  sanitizeKey (contract section 2): map everything outside [A-Za-z0-9._-] to
  '_' and lowercase. This does NOT take part in semantic equality - equality is
  canonical-key equality - it only produces a safe filename. Lowercasing is
  part of the rule: without it "Browser:Chromium" and "browser:chromium" name
  two files on a case-sensitive filesystem and exclusion fails silently.
#>
function Get-SanitizedKey([string]$key) {
  return ($key -replace '[^A-Za-z0-9._-]', '_').ToLowerInvariant()
}

# Lock file for one facet. A pool gets one file per slot; everything else -
# including shared - uses the single <base>.lock file.
#
# Contract 8.6: in v2.0 `shared` is DECLARED intent only, not a multi-reader.
# The disk model is "one facet, one file, O_EXCL", and one file cannot hold two
# holders, so a second shared request is refused by the file itself. Real
# multi-reader needs a per-holder file or a multi-record file - a storage change
# that has NOT been made (see 8.6). If you need concurrency, use
# `-Mode pool -Slots N`, which is what the contract points at.
# The plugin's lockPathFor() has the same rule, so the two tools agree byte for byte.
function Get-FacetLockPath([string]$facet, [string]$mode, [int]$slot) {
  $base = Get-SanitizedKey $facet
  if ($mode -eq 'pool') {
    return (Join-Path $LockRoot ("{0}.slot-{1}.lock" -f $base, $slot))
  }
  return (Join-Path $LockRoot ("{0}.lock" -f $base))
}

function New-LeaseId { 'lz_' + [guid]::NewGuid().ToString('N').Substring(0, 12) }

# ------------------------------------------------------------------ meta helpers

function Read-Meta([string]$path) {
  if (-not [System.IO.File]::Exists($path)) { return $null }
  try {
    $text = [System.IO.File]::ReadAllText($path, $Utf8NoBom)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
  } catch { return $null }
}

function Test-Expired($meta) {
  if (-not $meta) { return $true }              # unreadable metadata = takeable
  if (-not $meta.expiresAt) { return $true }
  return ([int64]$meta.expiresAt -lt (Now-Ms))
}

function Get-ObjectField($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return $obj[$name] }
    return $null
  }
  $p = $obj.PSObject.Properties[$name]
  if ($p) { return $p.Value }
  return $null
}

<#
  The owner identity (contract section 5): { agent, session, pid, host,
  procStart }. Two on-disk spellings are accepted so the CLI, the plugin and
  the MCP server can all read each other's records:

    * owner = "agent-name" (v1, and still what this CLI writes) plus an
      ownerInfo object carrying the process identity;
    * owner = { agent, session, pid, host, procStart } (the plugin's v2 shape).

  Returns $null when the record carries no process identity at all.
#>
function Get-OwnerInfo($meta) {
  if (-not $meta) { return $null }
  $o = $meta.owner
  if ($null -ne $o -and -not ($o -is [string])) {
    if ($null -ne (Get-ObjectField $o 'agent')) { return $o }
  }
  $i = $meta.ownerInfo
  if ($null -ne $i) { return $i }
  return $null
}

function Get-OwnerName($meta) {
  if (-not $meta) { return '' }
  $o = $meta.owner
  if ($null -ne $o) {
    if ($o -is [string]) { return [string]$o }
    $n = Get-ObjectField $o 'agent'
    if ($null -ne $n) { return [string]$n }
  }
  $i = Get-OwnerInfo $meta
  if ($i) {
    $n = Get-ObjectField $i 'agent'
    if ($null -ne $n) { return [string]$n }
  }
  return ''
}

function Get-OwnerSession($meta) {
  $i = Get-OwnerInfo $meta
  if ($i) {
    $v = Get-ObjectField $i 'session'
    if ($null -ne $v) { return [string]$v }
  }
  if ($meta -and $meta.session) { return [string]$meta.session }
  return ''
}

function Get-OwnerPid($meta) {
  $i = Get-OwnerInfo $meta
  if ($i) {
    $v = Get-ObjectField $i 'pid'
    if ($null -ne $v) { return [string]$v }
  }
  if ($meta -and $meta.pid) { return [string]$meta.pid }
  return ''
}

function Get-OwnerHost($meta) {
  $i = Get-OwnerInfo $meta
  if ($i) {
    $v = Get-ObjectField $i 'host'
    if ($null -ne $v) { return [string]$v }
  }
  if ($meta -and $meta.host) { return [string]$meta.host }
  return ''
}

# Process start time in epoch ms, or Exists/StartMs flags when unknowable.
# StartMs 0 means "process exists but its start time could not be read" (for
# example a protected process); callers treat that as ALIVE, never as a PID
# mismatch, because a false takeover gives two holders.
function Get-ProcInfo([int]$procId) {
  if ($procId -le 0) { return [pscustomobject]@{ Exists = $false; StartMs = [int64]0 } }
  $p = $null
  try { $p = [System.Diagnostics.Process]::GetProcessById($procId) }
  catch { return [pscustomobject]@{ Exists = $false; StartMs = [int64]0 } }
  try {
    $dto = [DateTimeOffset]$p.StartTime
    return [pscustomobject]@{ Exists = $true; StartMs = [int64]$dto.ToUnixTimeMilliseconds() }
  } catch {
    return [pscustomobject]@{ Exists = $true; StartMs = [int64]0 }
  }
}

function Get-SelfProcStartMs {
  try {
    $dto = [DateTimeOffset]([System.Diagnostics.Process]::GetCurrentProcess().StartTime)
    return [int64]$dto.ToUnixTimeMilliseconds()
  } catch { return [int64]0 }
}

<#
  Liveness judgement (contract section 5). True means "the owner is provably
  gone, reclaim now instead of waiting for the TTL".

  Only records that CARRY a process identity take part. A record written by
  this CLI sets ownerInfo.pidGated = false on purpose: a one-shot CLI process
  exits right after acquire, so its pid is dead a millisecond later while its
  lease is perfectly valid. Inferring liveness from that pid would make every
  CLI lease instantly reclaimable and would destroy the whole point of the
  lock. Long-lived owners (the plugin, a harness, a build daemon) record
  pidGated = true (or omit the flag) and get the immediate reclaim.

  Also: a different host can only be judged by TTL - we cannot see its
  process table (section 5, cross-host).
#>
function Test-OwnerDead($meta) {
  if (-not $meta) { return $false }
  $info = Get-OwnerInfo $meta
  if (-not $info) { return $false }
  $gated = Get-ObjectField $info 'pidGated'
  if ($null -ne $gated -and -not [bool]$gated) { return $false }

  $hostText = [string](Get-ObjectField $info 'host')
  if (-not $hostText) { return $false }
  if ($hostText -ne $Machine) { return $false }

  $pidText = [string](Get-ObjectField $info 'pid')
  if (-not $pidText) { return $false }
  $procId = 0
  if (-not [int]::TryParse($pidText, [ref]$procId)) { return $false }
  if ($procId -le 0) { return $false }

  $pi = Get-ProcInfo $procId
  if (-not $pi.Exists) { return $true }                         # G3: gone

  $recorded = [int64]0
  $psText = [string](Get-ObjectField $info 'procStart')
  if (-not [int64]::TryParse($psText, [ref]$recorded)) { return $false }
  if ($recorded -le 0) { return $false }
  if ($pi.StartMs -le 0) { return $false }                       # unknowable
  # procStart has second precision, so allow a two second wobble.
  if ([Math]::Abs($pi.StartMs - $recorded) -gt 2000) { return $true }   # PID reuse
  return $false
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
    $bytes = $Utf8NoBom.GetBytes(($meta | ConvertTo-Json -Depth 8))
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
  Take over a lease that is EXPIRED or whose owner is PROVABLY DEAD.

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
     turns out to be a valid, unexpired, still-alive lease, we grabbed a live
     lock that its owner had just finished writing. Put it back and report
     failure.

  A DIRECTORY squatting on the lock path is treated as an unreadable residue:
  it has no body but it does have an mtime, so it gets the same grace period and
  is then archived (Directory.Move, which is the rename CAS for directories).
#>
function Try-Takeover([string]$path) {
  $isDir = [System.IO.Directory]::Exists($path)
  $meta = Read-Meta $path                            # null for a directory
  if ($meta) {
    if (-not (Test-Expired $meta) -and -not (Test-OwnerDead $meta)) { return $false }
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
  if ($archived -and -not (Test-Expired $archived) -and -not (Test-OwnerDead $archived)) {
    # We archived a live lease: its owner was still writing it. Undo, or two
    # agents would hold the same resource.
    $restored = $false
    try { [System.IO.File]::Move($stale, $path); $restored = $true } catch { }
    $ownerName = Get-OwnerName $archived
    $name = [System.IO.Path]::GetFileName($path)
    if ($restored) {
      [Console]::Error.WriteLine("Takeover aborted: $name is a live lease (owner $ownerName); restored it intact")
    } else {
      [Console]::Error.WriteLine("Takeover aborted: $name turned out to be a live lease (owner $ownerName) but could not be restored; see $([System.IO.Path]::GetFileName($stale))")
    }
    return $false
  }

  $owner = if ($meta) { Get-OwnerName $meta } else { '' }
  if (-not $owner) { $owner = '?' }
  $name = [System.IO.Path]::GetFileName($path)
  if ($isDir) {
    [Console]::Error.WriteLine("Archived a directory that occupied the lock path: $name (a lock is a file; moved it aside to $([System.IO.Path]::GetFileName($stale)))")
  } elseif ($meta -and (Test-OwnerDead $meta)) {
    [Console]::Error.WriteLine("Took over a lease whose owner is gone: $name (previous owner $owner, pid $(Get-OwnerPid $meta))")
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

# ------------------------------------------------------- the global acquire mutex

function Get-GlobalLockPath { return (Join-Path $LockRoot $GlobalLockName) }

<#
  Serialize "scan for cross-facet collisions, then create every facet file".

  Without this, G1 is only true for exact-key races: agent A acquiring
  path:d:/out and agent B acquiring path:d:/out/sub touch two DIFFERENT files,
  so a pure O_EXCL strategy lets both win even though their facets overlap. The
  mutex is held for a few file creations only, and it is never held across the
  user command (`run` releases it long before the child starts).

  A stale mutex is taken over exactly like a lock (expired TTL, dead owner, or
  unreadable-but-old) so a crashed process cannot wedge every future acquire.
#>
function Enter-GlobalLock {
  $path = Get-GlobalLockPath
  $id = New-LeaseId
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try { $null = [System.IO.Directory]::CreateDirectory($LockRoot) }
    catch {
      return [pscustomobject]@{ Ok = $false; Id = $null; Message = "Cannot use the lock root '$LockRoot': $($_.Exception.Message)" }
    }
    $meta = [ordered]@{
      id = $id; pid = $PID; host = $Machine
      createdAt = (Now-Ms); expiresAt = (Now-Ms) + $GlobalLockTtlMs; lockPath = $path
    }
    if (Try-AcquireLock $path $meta) {
      return [pscustomobject]@{ Ok = $true; Id = $id; Message = '' }
    }

    $existing = Read-Meta $path
    $take = $false
    if ($existing) {
      if ([int64]$existing.expiresAt -lt (Now-Ms)) { $take = $true }
      elseif ([string]$existing.host -eq $Machine) {
        $pi = Get-ProcInfo ([int]$existing.pid)
        if (-not $pi.Exists) { $take = $true }
      }
    } else {
      if ((Get-LockAgeMs $path) -gt $StaleTakeoverGraceMs) { $take = $true }
    }
    if ($take) {
      $stale = "$path.stale.$(Now-Ms).$PID"
      try { [System.IO.File]::Move($path, $stale); continue } catch { }
    }

    if ($sw.ElapsedMilliseconds -gt $GlobalLockWaitMs) {
      return [pscustomobject]@{ Ok = $false; Id = $null; Message = "Timed out waiting for the acquire mutex '$path' (a holder is stuck for more than $GlobalLockWaitMs ms)" }
    }
    Start-Sleep -Milliseconds 20
  }
}

function Exit-GlobalLock([string]$id) {
  if (-not $id) { return }
  $path = Get-GlobalLockPath
  try {
    $m = Read-Meta $path
    if ($m -and [string]$m.id -eq $id) { [System.IO.File]::Delete($path) }
  } catch { }
}

# ------------------------------------------------------------------ lease index

<#
  Aggregated record: one leaseId can cover several facets (contract 4.2).
  The per-facet lock FILES stay authoritative for exclusion - this index only
  answers "which files does lease X hold", so losing it must never break
  mutual exclusion. `release --all` and `release <id>` are the only readers.

  Both `path` (v1, single file) and `paths` (v2, every facet file) are written
  so an older reader still finds something useful.
#>
function Register-Lease($meta, [string[]]$paths) {
  try {
    if (-not [System.IO.Directory]::Exists($IndexRoot)) {
      $null = [System.IO.Directory]::CreateDirectory($IndexRoot)
    }
    $first = ''
    if ($paths -and @($paths).Count -gt 0) { $first = [string]@($paths)[0] }
    $rec = [ordered]@{
      id = $meta.id
      key = $meta.key
      keys = @($meta.keys)
      canonicalKeys = @($meta.canonicalKeys)
      facet = $meta.facet
      facets = @($meta.facets)
      path = $first
      paths = @($paths)
      owner = $meta.owner
      ownerInfo = $meta.ownerInfo
      session = $meta.session
      pid = $meta.pid
      host = $meta.host
      procStart = $meta.procStart
      reason = $meta.reason
      mode = $meta.mode
      slots = $meta.slots
      createdAt = $meta.createdAt
      expiresAt = $meta.expiresAt
    }
    [System.IO.File]::WriteAllText((Join-Path $IndexRoot ($meta.id + '.json')), ($rec | ConvertTo-Json -Depth 8), $Utf8NoBom)
    return $true
  } catch {
    # An index write failure does not endanger exclusion (the facet files are
    # already in place); say so instead of pretending the lease is broken.
    [Console]::Error.WriteLine("Warning: could not write the lease index for $($meta.id): $($_.Exception.Message)")
    return $false
  }
}

function Get-IndexRecord([string]$id) {
  $f = Join-Path $IndexRoot ($id + '.json')
  if (-not [System.IO.File]::Exists($f)) { return $null }
  try { return [System.IO.File]::ReadAllText($f, $Utf8NoBom) | ConvertFrom-Json } catch { return $null }
}

function Get-RecordPaths($rec) {
  $out = New-Object System.Collections.ArrayList
  if ($rec -and $rec.paths) {
    foreach ($p in @($rec.paths)) { if ($p) { $null = $out.Add([string]$p) } }
  }
  if ($out.Count -eq 0 -and $rec -and $rec.path) { $null = $out.Add([string]$rec.path) }
  return ,$out.ToArray()
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
  So read the file first and require its id to match the index record; delete
  only on a match. A mismatch is logged, never acted on. Multi-facet leases are
  released in REVERSE acquisition order, for symmetry with rollback.

  Returns 'released' | 'takenover' | 'missing'. It is a bare string, so every
  caller MUST capture it - an uncaptured string would land on stdout.
#>
function Remove-LeaseById([string]$id) {
  $rec = Get-IndexRecord $id
  if (-not $rec) { return 'missing' }

  $indexFile = Join-Path $IndexRoot ($id + '.json')
  $paths = Get-RecordPaths $rec

  $existing = @()
  foreach ($p in $paths) { if ([System.IO.File]::Exists($p)) { $existing += $p } }
  if ($existing.Count -eq 0) {
    try { [System.IO.File]::Delete($indexFile) } catch { }
    return 'missing'
  }

  $removed = 0
  $foreign = @()
  for ($i = $existing.Count - 1; $i -ge 0; $i--) {
    $p = $existing[$i]
    $onDisk = Read-Meta $p
    $diskId = if ($onDisk -and $onDisk.id) { [string]$onDisk.id } else { '' }
    if ($diskId -ne $id) {
      # Someone else owns this file now (takeover). Never delete it.
      $foreign += ("{0} (now id='{1}' owner='{2}')" -f [System.IO.Path]::GetFileName($p), $diskId, (Get-OwnerName $onDisk))
      continue
    }
    try { [System.IO.File]::Delete($p); $removed++ } catch { }
  }

  try { [System.IO.File]::Delete($indexFile) } catch { }

  if ($foreign.Count -gt 0) {
    $listed = $foreign -join '; '
    [Console]::Error.WriteLine("Lease $id is no longer ours: $listed. Another holder took it over, so that lock was left intact and our stale index record was dropped.")
    return 'takenover'
  }
  if ($removed -eq 0) { return 'missing' }
  return 'released'
}

# ------------------------------------------------------------------ arg parsing

$opts = @{
  Owner = $DefaultOwner; Mode = 'exclusive'; Slots = 1
  Ttl = $null; Wait = $null; Reason = $null; All = $false; Cmd = $null; Keys = $null
}
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
    '^-{1,2}(?i)keys$'   { $i++; $opts.Keys   = [string]$rest[$i] }
    '^-{1,2}(?i)all$'    { $opts.All = $true }
    '^-{1,2}(?i)id$'     { $i++; $positional += [string]$rest[$i] }
    '^-h$|^-{1,2}(?i)help$' { $command = 'help' }
    default { $positional += $a }
  }
  $i++
}
# Everything after "--" is the command that `run` should execute.
$runCommand = if ($i -lt $rest.Count) { @($rest[$i..($rest.Count - 1)]) } else { @() }
if ($positional.Count -ge 1) { $command = [string]$positional[0] }
if (-not $command) { $command = 'status' }

# Multi-key requesting (contract 7.2): keys are positional, several at a time,
# no comma needed. `--keys a,b` is the equivalent comma form used by `run`.
$keys = @()
if ($positional.Count -ge 2) {
  for ($j = 1; $j -lt $positional.Count; $j++) { $keys += [string]$positional[$j] }
}
if ($opts.Keys) {
  foreach ($part in ([string]$opts.Keys).Split(',')) {
    $t = $part.Trim()
    if ($t -ne '') { $keys += $t }
  }
}
$primaryKey = if ($keys.Count -gt 0) { [string]$keys[0] } else { $null }

# ------------------------------------------------------------ conflict reporting

<#
  Conflict details (contract 4.3): who blocked us, on which facet, with which
  identity, why, and how long they still have. A bare "busy" is not enough -
  the caller has to be able to see whether waiting makes sense.
#>
function Format-ConflictLine($c) {
  if ($c.unreadable) {
    return ("{0} (a holder still writing its lock file - no readable metadata yet)" -f $c.facet)
  }
  $left = [int64]$c.expiresInMs
  if ($left -lt 0) { $left = 0 }
  $agent = if ($c.agent) { $c.agent } else { '(unknown)' }
  $session = if ($c.session) { $c.session } else { '(unknown)' }
  $hostText = if ($c.host) { $c.host } else { '(unknown)' }
  $reason = if ($c.reason) { $c.reason } else { '(none)' }
  return ("{0} (agent={1}, session={2}, pid={3}, host={4}, reason={5}, mode={6}, {7}ms left)" -f `
    $c.facet, $agent, $session, $c.pid, $hostText, $reason, $c.mode, $left)
}

function Write-ConflictReport([string[]]$rawKeys, $res) {
  $conflicts = @($res.Conflicts)
  $lines = @()
  foreach ($c in $conflicts) { $lines += (Format-ConflictLine $c) }
  if ($lines.Count -eq 0) { $lines += 'an unknown holder' }

  $message = "Resource busy: " + ($rawKeys -join ' ') + " - held by " + ($lines -join '; ')
  [Console]::Error.WriteLine($message)

  # Contract 8.6: say what to do instead, rather than letting the caller conclude
  # that `shared` is broken. It is not broken; it is single-holder in v2.0.
  if ($opts.Mode -eq 'shared') {
    [Console]::Error.WriteLine("Note: in v2.0 'shared' is a single holder (contract 8.6), so it does NOT admit a second reader. For concurrent readers use: -Mode pool -Slots N")
  }

  $released = @($res.Released)
  if ($released.Count -gt 0) {
    [Console]::Error.WriteLine("Rolled back (reverse order): " + ($released -join ', '))
  }

  $detail = [ordered]@{
    ok = $false
    keys = @($rawKeys)
    conflicts = @($conflicts | ForEach-Object {
      [ordered]@{
        facet = $_.facet
        key = $_.key
        heldBy = [ordered]@{ agent = $_.agent; session = $_.session; pid = $_.pid; host = $_.host }
        reason = $_.reason
        expiresInMs = $_.expiresInMs
        mode = $_.mode
      }
    })
    released = $released
  }
  [Console]::Error.WriteLine(($detail | ConvertTo-Json -Depth 8))
}

# ------------------------------------------------------------- acquire internals

function New-LockMeta([string]$id, [string]$keyOut, [string[]]$canonKeys, [string]$facet,
                      [string[]]$allFacets, [string]$useMode, [int]$slots, [int]$slot,
                      [string]$reason, [int64]$createdAt, [int64]$expiresAt, [string]$lockPath) {
  $info = [ordered]@{
    agent = $opts.Owner
    session = $SessionName
    pid = $PID
    host = $Machine
    procStart = $script:selfProcStart
    # A one-shot CLI process: its pid is dead the moment the command returns,
    # while the lease is still valid. Never infer liveness from it (see
    # Test-OwnerDead).
    pidGated = $false
  }
  return [ordered]@{
    id = $id
    key = $keyOut
    canonicalKey = $keyOut
    keys = @($canonKeys)
    facet = $facet
    facets = @($allFacets)
    mode = $useMode
    slots = $slots
    slot = $slot
    owner = $opts.Owner
    ownerInfo = $info
    reason = $reason
    pid = $PID
    host = $Machine
    session = $SessionName
    procStart = $script:selfProcStart
    createdAt = $createdAt
    expiresAt = $expiresAt
    lockPath = $lockPath
  }
}

# Facets an existing record can collide on. A lease with several facets has one
# lock FILE per facet, so the file's own `facet` is the authority; records that
# predate the facet field fall back to expanding their key. Deliberately not
# "every facet of the lease": that would report the same collision once per
# file and make one blocker look like several.
function Get-RecordFacet($meta) {
  if (-not $meta) { return $null }
  if ($meta.facet) { return [string]$meta.facet }
  if ($meta.key) {
    $c = Get-CanonicalKey ([string]$meta.key)
    if ($c) {
      $f = Expand-Facets $c
      if ($f.Count -gt 0) { return [string]$f[0] }
    }
  }
  return $null
}

<#
  Cross-facet collisions among locks that are already on disk. Same-facet
  collisions are NOT reported here: those are decided by the per-facet slot
  files (a single file for exclusive AND shared - contract 8.6 - one file per
  slot for a pool), which is also where the O_EXCL race is settled.
#>
function Find-FacetConflicts([string[]]$wantedFacets, [hashtable]$wantMode) {
  $out = New-Object System.Collections.ArrayList
  if (-not [System.IO.Directory]::Exists($LockRoot)) { return ,$out.ToArray() }
  $now = Now-Ms
  $seen = @{}
  $files = @(Get-ChildItem -Path $LockRoot -File -Filter '*.lock' -Force -ErrorAction SilentlyContinue)
  foreach ($f in $files) {
    if ($f.Name.StartsWith('_')) { continue }        # the acquire mutex is not a lease
    $meta = Read-Meta $f.FullName
    if (-not $meta) { continue }                     # unreadable: settled by takeover
    if (Test-Expired $meta) { continue }
    if (Test-OwnerDead $meta) { continue }

    $existingMode = 'exclusive'
    if ([string]$meta.mode -eq 'shared') { $existingMode = 'shared' }

    $exFacet = Get-RecordFacet $meta
    if (-not $exFacet) { continue }

    foreach ($wFacet in $wantedFacets) {
      if ($exFacet -eq $wFacet) { continue }
      if (-not (Test-FacetConflict $exFacet $wFacet)) { continue }
      $wMode = 'exclusive'
      if ($wantMode.ContainsKey($wFacet)) { $wMode = [string]$wantMode[$wFacet] }
      # shared + shared does not conflict (contract 3.2)
      if ($existingMode -eq 'shared' -and $wMode -eq 'shared') { continue }
      # One blocker, one line: several lock files can name the same facet (a
      # pool, a shared holder), and repeating it reads like several blockers.
      if ($seen.ContainsKey($exFacet)) { continue }
      $seen[$exFacet] = $true
      $null = $out.Add([pscustomobject]@{
        facet = $exFacet
        key = [string]$meta.key
        agent = Get-OwnerName $meta
        session = Get-OwnerSession $meta
        pid = Get-OwnerPid $meta
        host = Get-OwnerHost $meta
        reason = [string]$meta.reason
        expiresInMs = ([int64]$meta.expiresAt - $now)
        mode = $existingMode
        lockPath = $f.FullName
        unreadable = $false
      })
    }
  }
  return ,$out.ToArray()
}

<#
  One acquisition attempt over the whole (already ordered) facet set, inside
  the global mutex (contract 4.1).

  Returns an object:
    Ok        - everything was acquired
    Code      - 0 success, 2 conflict, 3 bad usage, 4 backend/IO
    Lease     - the JSON-ready lease record on success
    Conflicts - what blocked us
    Released  - facet files rolled back (reverse order), for observability
#>
function Invoke-AcquireOnce([string[]]$sorted, [hashtable]$wantMode, [string[]]$canonKeys,
                            [string]$mode, [int]$slots, [int64]$ttlMs, [string]$reason) {
  $gl = Enter-GlobalLock
  if (-not $gl.Ok) {
    return [pscustomobject]@{ Ok = $false; Code = 4; Message = $gl.Message; Lease = $null; Conflicts = @(); Released = @() }
  }
  $acquired = New-Object System.Collections.ArrayList
  $id = New-LeaseId
  try {
    $scan = Find-FacetConflicts $sorted $wantMode
    if ($scan.Count -gt 0) {
      return [pscustomobject]@{ Ok = $false; Code = 2; Message = ''; Lease = $null; Conflicts = $scan; Released = @() }
    }

    $createdAt = Now-Ms
    $expiresAt = $createdAt + $ttlMs
    $keyOut = $canonKeys[0]
    $gotSlot = 0
    $lastBlocked = $null

    foreach ($facet in $sorted) {
      $useMode = [string]$wantMode[$facet]
      if ($mode -eq 'pool') { $useMode = 'pool' }
      $slotCount = 1
      $slotReport = 1
      if ($useMode -eq 'pool') { $slotCount = [Math]::Max(1, $slots); $slotReport = $slotCount }
      # Contract 8.6: a `shared` holder occupies the ONE <base>.lock file, exactly
      # like an exclusive holder, so a second shared request is refused here (the
      # file is O_EXCL). This used to loop over 64 `.shared-<n>.lock` slots, which
      # invented a multi-reader the contract explicitly says v2.0 does not have -
      # and which the plugin never implemented, so the same request succeeded via
      # the CLI and failed via the plugin. Concurrent readers: pool -Slots N.

      $got = $null
      $gotSlotIndex = 0
      $path = $null
      $lastBlockedMeta = $null
      $lastBlockedPath = $null

      for ($s = 0; $s -lt $slotCount; $s++) {
        $path = Get-FacetLockPath $facet $useMode $s
        $meta = New-LockMeta $id $keyOut $canonKeys $facet $sorted $useMode $slotReport $s $reason $createdAt $expiresAt $path
        if (Try-AcquireLock $path $meta) { $got = $path; $gotSlotIndex = $s; break }

        # Held. Take it over if it is provably dead or expired, then retry once.
        if (Try-Takeover $path) {
          $meta = New-LockMeta $id $keyOut $canonKeys $facet $sorted $useMode $slotReport $s $reason $createdAt $expiresAt $path
          if (Try-AcquireLock $path $meta) { $got = $path; $gotSlotIndex = $s; break }
        }

        $blocker = Read-Meta $path
        $lastBlockedMeta = $blocker
        $lastBlockedPath = $path

        if ($useMode -eq 'shared') {
          # One shared file, so a taken one is genuinely taken (contract 8.6).
          # Do NOT fall through to another slot: there is no other slot, and
          # pretending there is is how the CLI and the plugin came to disagree.
          break
        }
        if ($useMode -eq 'pool') {
          # a pool has several slots: a taken slot means "try the next one",
          # not "the pool is full" (v1 tried every slot before giving up)
          continue
        }
        break                                  # exclusive: one file, genuinely held
      }

      if (-not $got) {
        # Reverse-order rollback. Every removal re-reads the file and requires
        # our own id (removeIfOwned): deleting by path alone would delete a
        # lock that someone took over from us (contract 4.1 / test matrix 15).
        $released = New-Object System.Collections.ArrayList
        for ($k = $acquired.Count - 1; $k -ge 0; $k--) {
          $p = [string]$acquired[$k]
          $onDisk = Read-Meta $p
          if ($onDisk -and [string]$onDisk.id -eq $id) {
            try { [System.IO.File]::Delete($p); $null = $released.Add([System.IO.Path]::GetFileName($p)) } catch { }
          }
        }

        $conflict = $null
        if ($lastBlockedMeta) {
          $conflict = [pscustomobject]@{
            facet = $facet
            key = [string]$lastBlockedMeta.key
            agent = Get-OwnerName $lastBlockedMeta
            session = Get-OwnerSession $lastBlockedMeta
            pid = Get-OwnerPid $lastBlockedMeta
            host = Get-OwnerHost $lastBlockedMeta
            reason = [string]$lastBlockedMeta.reason
            expiresInMs = ([int64]$lastBlockedMeta.expiresAt - (Now-Ms))
            mode = [string]$lastBlockedMeta.mode
            lockPath = $lastBlockedPath
            unreadable = $false
          }
        } else {
          $conflict = [pscustomobject]@{
            facet = $facet; key = ''; agent = ''; session = ''; pid = ''; host = ''
            reason = ''; expiresInMs = [int64]0; mode = $useMode
            lockPath = $lastBlockedPath; unreadable = $true
          }
        }
        $lastBlocked = $conflict
        return [pscustomobject]@{
          Ok = $false; Code = 2; Message = ''; Lease = $null
          Conflicts = @($conflict); Released = $released.ToArray()
        }
      }

      $null = $acquired.Add($got)
      $gotSlot = $gotSlotIndex
    }

    $paths = $acquired.ToArray()

    $lease = [ordered]@{
      id = $id
      key = $keyOut
      keys = @($canonKeys)
      canonicalKey = $keyOut
      facets = @($sorted)
      owner = $opts.Owner
      ownerInfo = [ordered]@{
        agent = $opts.Owner; session = $SessionName; pid = $PID; host = $Machine
        procStart = $script:selfProcStart; pidGated = $false
      }
      reason = $reason
      mode = $mode
      slots = $slots
      slot = $gotSlot
      session = $SessionName
      pid = $PID
      host = $Machine
      procStart = $script:selfProcStart
      createdAt = $createdAt
      expiresAt = $expiresAt
      locks = @($paths)
      lockPath = [string]@($paths)[0]
    }

    $indexMeta = $lease
    $indexMeta['facet'] = [string]$sorted[0]
    $null = Register-Lease $indexMeta $paths

    return [pscustomobject]@{ Ok = $true; Code = 0; Message = ''; Lease = $lease; Conflicts = @(); Released = @() }
  } finally {
    Exit-GlobalLock $gl.Id
  }
}

<#
  Full multi-key acquire (contract 4.1):

    1. canonicalize every requested key and expand it into facets
    2. merge duplicates (mode: exclusive wins; slots: max)
    3. sort by the global order -> no circular wait (G2)
    4. acquire in that order, rolling back in reverse on the first failure
    5. one leaseId covering every facet

  A queueing request retries the WHOLE set rather than resuming in the middle,
  so it can never sit holding half the resources while waiting.
#>
function Get-AcquireOutcome([string[]]$rawKeys, [string]$mode, [int]$slots, [int64]$ttlMs, [int64]$waitMs, [string]$reason) {
  $canon = New-Object System.Collections.ArrayList
  foreach ($k in $rawKeys) {
    $c = Get-CanonicalKey $k
    if (-not $c) {
      return [pscustomobject]@{
        Ok = $false; Code = 3; Lease = $null; Conflicts = @(); Released = @()
        Message = "Invalid resource key: '$k' (path keys need an ABSOLUTE path, e.g. path:D:/out; ports are <n> or <lo-hi>; see lease.ps1 help)"
      }
    }
    if (-not $canon.Contains($c)) { $null = $canon.Add($c) }
  }
  if ($canon.Count -eq 0) {
    return [pscustomobject]@{ Ok = $false; Code = 3; Message = 'acquire needs at least one resource key'; Lease = $null; Conflicts = @(); Released = @() }
  }

  $wantMode = @{}
  $facetSource = @{}
  $facets = New-Object System.Collections.ArrayList
  foreach ($c in $canon) {
    foreach ($facet in (Expand-Facets $c)) {
      $fm = 'exclusive'
      if ($mode -eq 'shared') { $fm = 'shared' }
      if (-not $wantMode.ContainsKey($facet)) {
        $wantMode[$facet] = $fm
        $facetSource[$facet] = $c
        $null = $facets.Add($facet)
      } elseif ($wantMode[$facet] -eq 'shared' -and $fm -eq 'exclusive') {
        $wantMode[$facet] = 'exclusive'
      }
    }
  }

  $sorted = Sort-FacetList $facets.ToArray()

  # A request that contradicts itself can never be satisfied; say so instead of
  # acquiring half of it and rolling back. Facets of ONE key never count: they
  # are supposed to be held together (browser:cdp:9222 legitimately expands to
  # a port facet that implies itself), so only cross-key pairs are rejected.
  for ($x = 0; $x -lt $sorted.Count; $x++) {
    for ($y = $x + 1; $y -lt $sorted.Count; $y++) {
      if ($facetSource[$sorted[$x]] -eq $facetSource[$sorted[$y]]) { continue }
      if (-not (Test-FacetConflict $sorted[$x] $sorted[$y])) { continue }
      if ($wantMode[$sorted[$x]] -eq 'shared' -and $wantMode[$sorted[$y]] -eq 'shared') { continue }
      return [pscustomobject]@{
        Ok = $false; Code = 3; Lease = $null; Conflicts = @(); Released = @()
        Message = "The requested keys conflict with each other: $($sorted[$x]) (from $($facetSource[$sorted[$x]])) vs $($sorted[$y]) (from $($facetSource[$sorted[$y]]))"
      }
    }
  }

  $deadline = (Now-Ms) + $waitMs
  while ($true) {
    $res = Invoke-AcquireOnce $sorted $wantMode $canon.ToArray() $mode $slots $ttlMs $reason
    if ($res.Ok) { return $res }
    if ($res.Code -ne 2) { return $res }
    if ((Now-Ms) -ge $deadline) { return $res }
    Start-Sleep -Milliseconds 150
  }
}

# --------------------------------------------------------------- command bodies

function Invoke-Acquire {
  if ($keys.Count -eq 0) {
    Exit-With 3 "Usage: lease.ps1 acquire [key] [key...] [-Mode exclusive|shared|pool] [-Slots N] [-Ttl 30s] [-Wait 120s] [-Owner name] [-Reason text]"
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

  $res = Get-AcquireOutcome $keys $opts.Mode $opts.Slots $ttlMs $waitMs $opts.Reason
  if ($res.Ok) {
    ($res.Lease | ConvertTo-Json -Depth 8)
    $script:code = 0; return
  }
  if ($res.Code -eq 3) { Exit-With 3 $res.Message }
  if ($res.Code -eq 4) { Exit-With 4 $res.Message }
  Write-ConflictReport $keys $res
  $script:code = 2; return
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

      $recOwner = Get-OwnerName $rec
      if ($recOwner -eq $opts.Owner) {
        $hit = $false
        foreach ($p in (Get-RecordPaths $rec)) {
          if (-not [System.IO.File]::Exists($p)) { continue }
          $m = Read-Meta $p
          if ($m -and [string]$m.id -eq [string]$rec.id) {
            try { [System.IO.File]::Delete($p); $hit = $true } catch { }
          }
        }
        if ($hit) { $n++ }
        Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
      } else {
        # Foreign record: drop it only when every file it claims is gone, so a
        # stale index cannot keep growing.
        $anyLeft = $false
        foreach ($p in (Get-RecordPaths $rec)) { if ([System.IO.File]::Exists($p)) { $anyLeft = $true } }
        if (-not $anyLeft) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
      }
    }
    "released=$n owner=$($opts.Owner)"
    $script:code = 0; return
  }

  if (-not $primaryKey) { Exit-With 3 "Usage: lease.ps1 release [leaseId] | release --all -Owner [name]" }
  $outcome = Remove-LeaseById $primaryKey
  if ($outcome -eq 'released') { "released=$primaryKey"; $script:code = 0; return }
  if ($outcome -eq 'takenover') {
    Exit-With 2 "Lease $primaryKey is no longer yours: it was taken over by another holder. Its lock was left intact and nothing was released."
  }
  Exit-With 2 "No such lease: $primaryKey (already released, or wrong id)"
}

function Invoke-Status {
  if (-not [System.IO.Directory]::Exists($LockRoot)) {
    "Resource leases: none (lock root does not exist: $LockRoot)"; $script:code = 0; return
  }
  $now = Now-Ms
  $rows = @()

  $files = @()
  try { $files = @(Get-ChildItem $LockRoot -File -Filter '*.lock' -Force -ErrorAction SilentlyContinue) } catch { $files = @() }
  foreach ($f in $files) {
    if ($f.Name.StartsWith('_')) { continue }        # the acquire mutex is not a lease
    $m = Read-Meta $f.FullName
    if (-not $m) { continue }
    $remain = [int64]$m.expiresAt - $now
    $modeText = if ($m.mode -eq 'pool') { "pool($($m.slot + 1)/$($m.slots))" } else { [string]$m.mode }
    $remainText = if ($remain -gt 0) { "$([Math]::Round($remain / 1000, 1))s" } else { 'EXPIRED(takeable)' }
    if ($remain -gt 0 -and (Test-OwnerDead $m)) { $remainText = 'DEAD(takeable)' }
    $facetText = if ($m.facet) { [string]$m.facet } elseif ($m.key) { [string]$m.key } else { '' }
    # Show the facet only when it differs from the key: a plain key is its own
    # facet, and repeating it in both columns doubles every grep of the table.
    if ($facetText -eq [string]$m.key) { $facetText = '' }
    $rows += [pscustomobject]@{
      key    = $m.key
      facet  = $facetText
      mode   = $modeText
      owner  = (Get-OwnerName $m)
      session = (Get-OwnerSession $m)
      reason = $m.reason
      remain = $remainText
      pid    = (Get-OwnerPid $m)
    }
  }

  if ($rows.Count -eq 0) { "Resource leases: none"; $script:code = 0; return }
  $rows | Sort-Object key, facet | Format-Table -AutoSize | Out-String -Width 250 | Write-Output
  $script:code = 0; return
}

function Invoke-Run {
  # Three ways to say what to hold:
  #   run [key] [key...]              positional keys
  #   run --keys a,b                  comma form
  # And two ways to say what to run:
  #   run ... -Cmd "command line"     robust: handed to cmd.exe /c, so switches
  #                                   like -NoProfile or -m are safe
  #   run ... -- [command ...]        simple commands without dash switches
  if ($keys.Count -eq 0) {
    Exit-With 3 "Usage: lease.ps1 run [key] [key...] -Cmd [command line]   OR   lease.ps1 run --keys key1,key2 -- [command ...]"
  }
  if (-not $opts.Cmd -and $runCommand.Count -eq 0) {
    Exit-With 3 "run requires -Cmd [command line] or -- [command ...]"
  }
  if ([string]::IsNullOrWhiteSpace($opts.Owner)) {
    Exit-With 3 "run needs a non-empty -Owner (or set DSH_AGENT_NAME)."
  }

  # Defaults: fail immediately (-Wait 0) and a 10 minute lease, unless
  # DSH_RESOURCE_TTL says otherwise. Immediate failure is the protocol's first
  # rule; queueing is opt-in (-Wait 120s), never implicit.
  $defaultTtl = if ($env:DSH_RESOURCE_TTL) { ConvertTo-Ms $env:DSH_RESOURCE_TTL 600000 } else { 600000 }
  $ttlMs  = ConvertTo-Ms $opts.Ttl $defaultTtl
  $waitMs = ConvertTo-Ms $opts.Wait 0
  if ($ttlMs -lt 1000) { $ttlMs = 1000 }   # same floor as acquire

  $res = Get-AcquireOutcome $keys $opts.Mode $opts.Slots $ttlMs $waitMs $opts.Reason
  if (-not $res.Ok) {
    if ($res.Code -eq 3) { Exit-With 3 $res.Message }
    if ($res.Code -eq 4) { Exit-With 4 $res.Message }
    Write-ConflictReport $keys $res
    $script:code = 2; return
  }

  $lease = $res.Lease
  try {
    [Console]::Error.WriteLine("Acquired lease $($lease.id) on $($keys -join ' ') (owner $($lease.owner))")
    if ($opts.Cmd) {
      & cmd.exe /c $opts.Cmd
    } else {
      $exe  = $runCommand[0]
      $argv = @()
      if ($runCommand.Count -gt 1) { $argv = $runCommand[1..($runCommand.Count - 1)] }
      & $exe @argv
    }
    $script:code = $LASTEXITCODE
  } finally {
    # Critical: release on the exception path too -- but only OUR lease. If the
    # lease expired (or our process identity stopped matching) and someone else
    # took it over while the command ran, the lock file belongs to them;
    # deleting it would hand the resource to a third agent while the new holder
    # still thinks it is exclusive. Log, do not delete.
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
    'Resource lease CLI (v2: multi-key, facet conflicts, liveness)',
    '',
    '  lease.ps1 acquire [key] [key...] [-Mode exclusive|shared|pool] [-Slots N] [-Ttl 30s] [-Wait 120s] [-Owner name] [-Reason text]',
    '  lease.ps1 acquire --keys key1,key2 ...        <- comma form of the same thing',
    '  lease.ps1 release [leaseId] | release --all [-Owner name]',
    '  lease.ps1 status',
    '  lease.ps1 run [key] [key...] -Cmd [command line]        <- robust: dash switches safe',
    '  lease.ps1 run --keys key1,key2 -- [command ...]         <- simple commands only',
    '',
    '  Multiple keys are taken atomically, in a machine-independent order,',
    '  and rolled back in reverse when one of them is busy.',
    '',
    '  -Mode shared is a single holder in v2.0 (contract 8.6): it declares intent',
    '  but one facet file cannot hold two readers. Use -Mode pool -Slots N for',
    '  concurrent readers.',
    '',
    '  run defaults: -Wait 0 (fail immediately; pass -Wait 120s to queue)',
    '                -Ttl $env:DSH_RESOURCE_TTL, else 600s',
    '',
    'Exit codes: 0 = success, 2 = conflict / wait timeout / unknown lease,',
    '            3 = bad usage, 4 = backend or IO error',
    "            run instead exits with the child command's exit code (any value)",
    '            tell them apart by stderr: "Resource busy" vs "Acquired lease"',
    '',
    'Resource keys: path:<dir> port:<n|lo-hi> proc:<job> browser:<instance|profile:<n>|cdp:<port>>',
    '               screen:focus window:hwnd:<n> api:<provider>:<metric> named:<anything>',
    "Lock root: $LockRoot  (override with DSH_RESOURCE_LOCK_ROOT)"
  )
  $lines -join [Environment]::NewLine | Write-Output
  $script:code = 0; return
}

# ---------------------------------------------------------------------- dispatch

$script:selfProcStart = Get-SelfProcStartMs
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
