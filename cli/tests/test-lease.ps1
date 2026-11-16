#Requires -Version 5.1
<#
  Functional tests for the resource lease CLI.
  Uses a throwaway lock root so the real environment is untouched.
  Cross-process tests really spawn independent processes - no fake jobs.

  Pure ASCII on purpose (see the header of lease.ps1 for the reason).

  NOTE ON EXIT CODES: Start-Process -PassThru does not reliably expose
  ExitCode in Windows PowerShell 5.1, so every child is launched through a
  System.Diagnostics.Process object instead.

  NOTE ON LOCK ROOTS: every case gets its OWN lock root (New-CaseRoot). A shared
  root made two earlier failures invisible:
    - the "crash residue" case built a DIRECTORY, which the implementation
      never treats as a lock (it only reads <key>.lock files), so the case
      passed without ever exercising a takeover;
    - its ".stale count >= 1" assertion passed on leftovers from the previous
      case in the same root.
  Fresh root per case means a ".stale" count of 0 -> 1 is real evidence.

  REGRESSION CASES (added after the adversarial review):
    [13] expired -> takeover -> stale id release must NOT delete the new
         holder's lock (the silent-double-hold bug).
    [14] same thing through `run`: if the lease was taken over mid-command,
         `run` must log it and leave the new holder's lock alone.
    [15] key case: "Case:Key" and "case:key" must name ONE lock file.
    [16] `run` must fail fast by default (-Wait 0), not queue.
    [17] an empty owner must be rejected (it makes `release --all` reap
         other agents' leases).
    [18] `run` must honour DSH_RESOURCE_TTL instead of a hardcoded 600s.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'lease.ps1'
if (-not (Test-Path $cli)) { throw "lease.ps1 not found: $cli" }

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lease-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else     { $script:fail++; Write-Host "  FAIL  $name   $detail" -ForegroundColor Red }
}

# A fresh, empty lock root for one case. Returned so the case can inspect the
# files it creates; also exported so the child processes land in the same place.
function New-CaseRoot([string]$name) {
  $root = Join-Path $script:testRoot $name
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $env:DSH_RESOURCE_LOCK_ROOT = $root
  return $root
}

function Quote-Arg([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '""' }
  if ($s -match '[\s"]') { return '"' + ($s -replace '"', '\"') + '"' }
  return $s
}

# Start the CLI as a real child process (returns the live Process object).
function Start-Cli {
  param([string[]]$Arguments)
  $parts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Arg $cli))
  foreach ($a in $Arguments) { if ($null -ne $a) { $parts += (Quote-Arg ([string]$a)) } }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName               = 'powershell.exe'
  $psi.Arguments              = ($parts -join ' ')
  $psi.UseShellExecute        = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.CreateNoWindow         = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $null = $proc.Start()
  return $proc
}

# Read both streams to completion, then report the real exit code.
function Complete-Cli($proc) {
  $out = $proc.StandardOutput.ReadToEnd()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return [pscustomobject]@{ Code = $proc.ExitCode; Out = [string]$out; Err = [string]$err }
}

function Invoke-Cli {
  param([string[]]$Arguments)
  return Complete-Cli (Start-Cli $Arguments)
}

function Get-Status { (Invoke-Cli @('status')).Out }

function ConvertTo-Lease($text) {
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

Write-Host "Test root: $testRoot" -ForegroundColor Cyan

# Scratch directory for the resource SUBJECTS (directories, ports). Kept
# outside every lock root on purpose: a case root is a lock root, and a stray
# directory in it would be mistaken for a squatter by the tests that count
# *.lock files.
$dataRoot = Join-Path $testRoot 'data'
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null

# Mirror of the CLI's sanitizeKey (contract section 2), used to predict the
# lock filename for a canonical facet: map everything outside [A-Za-z0-9._-] to
# '_' and lowercase.
function LockName([string]$facet) {
  return (($facet -replace '[^A-Za-z0-9._-]', '_').ToLowerInvariant() + '.lock')
}

# The lease lock files of a root, excluding the acquire mutex (leading "_").
function Get-LeaseFiles([string]$root) {
  return @(Get-ChildItem $root -File -Filter '*.lock' -Force -ErrorAction SilentlyContinue |
             Where-Object { -not $_.Name.StartsWith('_') })
}

function Write-RawLock([string]$path, $meta) {
  [System.IO.File]::WriteAllText($path, ($meta | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
}

function Read-RawText([string]$path) {
  try { return [System.IO.File]::ReadAllText($path) } catch { return '' }
}

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Get-SelfStartMs {
  return [int64]([DateTimeOffset](Get-Process -Id $PID).StartTime).ToUnixTimeMilliseconds()
}

<#
  Per-group cleanup safety net.

  Several cases deliberately create a holder and leave it standing (to prove a
  conflict names its owner, or that a live owner is not reclaimed). Every case
  gets its OWN lock root, so a forgotten holder cannot leak into another case -
  but it CAN fail a later assertion inside the SAME case, and then a test
  scaffolding mistake looks exactly like a product bug. That happened once
  already: a case kept a 60s lease alive and the next `run --keys` in the same
  root was reported "Resource busy".

  So every v2 case ends with this call. It deletes the case's lock files and
  index records directly instead of going through `release --all` on purpose:
  it must work even when the case deleted its index on purpose, and it must not
  spawn one process per owner (the suite would get minutes slower).
#>
function Clear-CaseLeases {
  $root = $env:DSH_RESOURCE_LOCK_ROOT
  if (-not $root -or -not (Test-Path $root)) { return }
  foreach ($f in (Get-LeaseFiles $root)) {
    Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
  }
  $idx = Join-Path $root '_leases'
  if (Test-Path $idx) {
    Get-ChildItem $idx -File -Filter '*.json' -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

# ------------------------------------------------------------------ 1. help
Write-Host ''
Write-Host '[1] help' -ForegroundColor Cyan
$null = New-CaseRoot 'help'
$r = Invoke-Cli @('help')
Check 'help exits 0' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'help mentions acquire' ($r.Out -match 'acquire') ''
Check 'help mentions -Cmd' ($r.Out -match '-Cmd') ''
Check 'help documents the run default of -Wait 0' ($r.Out -match '-Wait 0') ''

# ------------------------------------------------- 2. acquire / status / release
# 2, 3 and 4 are one sequential story and therefore share a lock root.
Write-Host ''
Write-Host '[2] acquire / status / release (exclusive)' -ForegroundColor Cyan
$root = New-CaseRoot 'core'
$r = Invoke-Cli @('acquire','browser:chromium','-Ttl','30s','-Owner','t1','-Reason','test-acquire')
Check 'acquire exits 0' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$lease = ConvertTo-Lease $r.Out
Check 'acquire returns JSON with id' ($lease -and $lease.id) "out=$($r.Out)"
Check 'acquire records owner'  ($lease -and $lease.owner -eq 't1') ''
Check 'acquire records reason' ($lease -and $lease.reason -eq 'test-acquire') ''
Check 'acquire records key'    ($lease -and $lease.key -eq 'browser:chromium') ''
Check 'lock file is <key>.lock, not a directory' (Test-Path (Join-Path $root 'browser_chromium.lock') -PathType Leaf) ''

$out = Get-Status
Check 'status shows the holder' ($out -match 't1' -and $out -match 'browser:chromium') "out=$out"

# ------------------------------------- 3. second acquire on same key must fail
Write-Host ''
Write-Host '[3] second acquire on the same key fails fast (-Wait 0)' -ForegroundColor Cyan
$r = Invoke-Cli @('acquire','browser:chromium','-Wait','0','-Owner','t2')
Check 'busy exits 2' ($r.Code -eq 2) "code=$($r.Code)"
Check 'busy message names the holder' ($r.Err -match 't1') "err=$($r.Err)"

# ----------------------------------------------- 4. release then acquire again
Write-Host ''
Write-Host '[4] acquire works again after release' -ForegroundColor Cyan
$r = Invoke-Cli @('release', $lease.id)
Check 'release exits 0' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'release deletes the lock file' (-not (Test-Path (Join-Path $root 'browser_chromium.lock'))) ''
$r = Invoke-Cli @('acquire','browser:chromium','-Wait','0','-Owner','t2','-Ttl','30s')
Check 'acquire succeeds after release' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
if ($r.Code -eq 0) { $null = Invoke-Cli @('release', ((ConvertTo-Lease $r.Out).id)) }

# ----------------------------------- 5. two independent processes race one key
Write-Host ''
Write-Host '[5] cross-process race: two processes, exactly one wins' -ForegroundColor Cyan
$null = New-CaseRoot 'race'
$p1 = Start-Cli @('acquire','race:key','-Wait','0','-Owner','racer1','-Ttl','30s')
$p2 = Start-Cli @('acquire','race:key','-Wait','0','-Owner','racer2','-Ttl','30s')
$c1 = Complete-Cli $p1
$c2 = Complete-Cli $p2
$codes = @($c1.Code, $c2.Code) | Sort-Object
Check 'exactly one success(0) and one busy(2)' (($codes -join ',') -eq '0,2') "codes=$($codes -join ',')"
$out = Get-Status
Check 'status lists race:key exactly once' ((([regex]::Matches($out,'race:key')).Count) -eq 1) "out=$out"
$null = Invoke-Cli @('release','--all','-Owner','racer1')
$null = Invoke-Cli @('release','--all','-Owner','racer2')

# ---------------------------------------------------- 6. TTL expiry takeover
Write-Host ''
Write-Host '[6] expired lease can be taken over' -ForegroundColor Cyan
$null = New-CaseRoot 'ttl'
$r = Invoke-Cli @('acquire','ttl:key','-Ttl','1s','-Owner','shortlived')
Check 'short TTL acquired' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$shortLease = ConvertTo-Lease $r.Out
Start-Sleep -Seconds 2
$out = Get-Status
Check 'status marks it EXPIRED' ($out -match 'EXPIRED') "out=$out"
$r = Invoke-Cli @('acquire','ttl:key','-Wait','0','-Owner','takerover','-Ttl','30s')
Check 'takeover succeeds' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'takeover is logged on stderr' ($r.Err -match 'Took over') "err=$($r.Err)"
$newLease = ConvertTo-Lease $r.Out
Check 'new lease is a different id' ($newLease -and $shortLease -and ($newLease.id -ne $shortLease.id)) ''
$null = Invoke-Cli @('release','--all','-Owner','takerover')

# ------------------------------------------- 7. self-heal after a crash residue
# The residue must be the REAL artefact the implementation looks for: a
# <key>.lock FILE whose meta is long expired. A directory proves nothing.
Write-Host ''
Write-Host '[7] crashed agent residue self-heals (real .lock file)' -ForegroundColor Cyan
$root = New-CaseRoot 'crash'
$crashKey = 'crash:key'
$crashLock = Join-Path $root 'crash_key.lock'
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$deadMeta = [ordered]@{
  id='lz_dead'; key=$crashKey; mode='exclusive'; slots=1; slot=0
  owner='crashed-agent'; reason='crashed'; pid=999999; host='X'
  createdAt = ($nowMs - 600000)
  expiresAt = ($nowMs - 300000)
  lockPath  = $crashLock
}
[System.IO.File]::WriteAllText($crashLock, ($deadMeta | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
$staleBefore = @(Get-ChildItem $root -File -Filter '*.stale.*' -ErrorAction SilentlyContinue).Count
Check 'the case starts with a real lock file and zero .stale files' ((Test-Path $crashLock -PathType Leaf) -and $staleBefore -eq 0) "before=$staleBefore"
$r = Invoke-Cli @('acquire',$crashKey,'-Wait','0','-Owner','recoverer','-Ttl','30s')
Check 'takes over crashed residue (exit 0)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'stderr reports Took over' ($r.Err -match 'Took over') "err=$($r.Err)"
$staleAfter = @(Get-ChildItem $root -File -Filter '*.stale.*' -ErrorAction SilentlyContinue).Count
Check '.stale archive went 0 -> 1 inside this case' ($staleAfter -eq 1) "after=$staleAfter"
$recovered = ConvertTo-Lease $r.Out
Check 'the new holder is not the dead id' ($recovered -and $recovered.id -ne 'lz_dead') ''
$out = Get-Status
Check 'status shows the new holder, not the crash' ($out -match 'recoverer' -and -not ($out -match 'crashed-agent')) "out=$out"
$null = Invoke-Cli @('release','--all','-Owner','recoverer')

# ------------------------------------------------ 8. pool mode with 3 racers
Write-Host ''
Write-Host '[8] pool mode: slots=2, three racers, two get in' -ForegroundColor Cyan
$root = New-CaseRoot 'pool'
$procs = @()
foreach ($n in 1..3) {
  $procs += Start-Cli @('acquire','browser:chromium','-Mode','pool','-Slots','2','-Wait','0','-Owner',"pool$n",'-Ttl','30s')
}
$results = @()
foreach ($p in $procs) { $results += (Complete-Cli $p) }
$okCount   = @($results | Where-Object { $_.Code -eq 0 }).Count
$busyCount = @($results | Where-Object { $_.Code -eq 2 }).Count
$poolDetail = (($results | ForEach-Object { "code=$($_.Code) err=$(($_.Err -replace '\r?\n', ' ').Trim())" }) -join ' // ')
Check 'two succeeded'    ($okCount -eq 2)   "ok=$okCount busy=$busyCount :: $poolDetail"
Check 'one was rejected' ($busyCount -eq 1) "ok=$okCount busy=$busyCount :: $poolDetail"
Check 'each slot has its own file' (@(Get-ChildItem $root -File -Filter 'browser_chromium.slot-*.lock').Count -eq 2) ''
$out = Get-Status
Check 'status shows the pool slot count' ($out -match 'pool\(\d/2\)') "out=$out"
foreach ($n in 1..3) { $null = Invoke-Cli @('release','--all','-Owner',"pool$n") }

# ------------------------------------------------------- 9. run wrapper happy
Write-Host ''
Write-Host '[9] run wrapper releases on success' -ForegroundColor Cyan
$null = New-CaseRoot 'runhappy'
$r = Invoke-Cli @('run','run:key','-Cmd','exit 0')
Check 'run exits 0' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'run reports Acquired on stderr' ($r.Err -match 'Acquired lease') "err=$($r.Err)"
$out = Get-Status
Check 'lease released after run' (-not ($out -match 'run:key')) "out=$out"

# ------------------------------------------------ 10. run wrapper on failure
Write-Host ''
Write-Host '[10] run wrapper releases even when the command fails' -ForegroundColor Cyan
$null = New-CaseRoot 'runfail'
$r = Invoke-Cli @('run','run2:key','-Cmd','exit 7')
Check 'run propagates child exit code 7' ($r.Code -eq 7) "code=$($r.Code) err=$($r.Err)"
$out = Get-Status
Check 'lease released after failure' (-not ($out -match 'run2:key')) "out=$out"

# ------------------------------- 11. run -Cmd survives dash switches
Write-Host ''
Write-Host '[11] run -Cmd passes dash switches safely' -ForegroundColor Cyan
$null = New-CaseRoot 'runswitch'
$r = Invoke-Cli @('run','run3:key','-Cmd','powershell.exe -NoProfile -Command exit 5')
Check 'dash switches survive, exit code 5' ($r.Code -eq 5) "code=$($r.Code) err=$($r.Err)"

# ------------------------------------------------------ 12. usage error codes
Write-Host ''
Write-Host '[12] usage errors exit 3' -ForegroundColor Cyan
$null = New-CaseRoot 'usage'
$r = Invoke-Cli @('acquire')
Check 'missing key exits 3' ($r.Code -eq 3) "code=$($r.Code)"
$r = Invoke-Cli @('acquire','x:y','-Ttl','banana')
Check 'bad duration exits 3' ($r.Code -eq 3) "code=$($r.Code)"
$r = Invoke-Cli @('nosuchcmd')
Check 'unknown subcommand exits 3' ($r.Code -eq 3) "code=$($r.Code)"
$r = Invoke-Cli @('release','lz_deadbeef0000')
Check 'unknown lease id exits 2' ($r.Code -eq 2) "code=$($r.Code)"

# --------------------- 13. REGRESSION: stale release must not kill the new lock
Write-Host ''
Write-Host '[13] REGRESSION: expired -> takeover -> stale id release keeps the new lock' -ForegroundColor Cyan
$root = New-CaseRoot 'ownership'
$lockPath = Join-Path $root 'owned_key.lock'
$r = Invoke-Cli @('acquire','owned:key','-Ttl','1s','-Owner','owner-A')
$idA = (ConvertTo-Lease $r.Out).id
Check 'A acquires a 1s lease' ($r.Code -eq 0 -and $idA) "code=$($r.Code) err=$($r.Err)"
Start-Sleep -Seconds 2
$r = Invoke-Cli @('acquire','owned:key','-Wait','0','-Owner','owner-B','-Ttl','60s')
$idB = (ConvertTo-Lease $r.Out).id
Check 'B takes over the expired lease' ($r.Code -eq 0 -and $r.Err -match 'Took over') "code=$($r.Code) err=$($r.Err)"
Check 'B holds a different id' ($idB -and ($idB -ne $idA)) "A=$idA B=$idB"
Check 'B lock file is on disk' (Test-Path $lockPath -PathType Leaf) ''
$r = Invoke-Cli @('release', $idA)
Check 'A releasing its own dead id fails (exit 2)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'A is told the lease was taken over' (($r.Err -match 'took it over') -and ($r.Err -match 'left intact')) "err=$($r.Err)"
Check 'B lock file SURVIVES the stale release' (Test-Path $lockPath -PathType Leaf) ''
$m = $null
try { $m = [System.IO.File]::ReadAllText($lockPath) | ConvertFrom-Json } catch { }
Check 'the surviving lock still belongs to B' ($m -and $m.id -eq $idB -and $m.owner -eq 'owner-B') "meta=$($m | ConvertTo-Json -Compress)"
$out = Get-Status
Check 'status still shows owner-B and not owner-A' (($out -match 'owner-B') -and -not ($out -match 'owner-A')) "out=$out"
$r = Invoke-Cli @('acquire','owned:key','-Wait','0','-Owner','owner-C','-Ttl','30s')
Check 'a third agent is still blocked (no silent double-hold)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the third agent did not create a lock file' ((Test-Path $lockPath -PathType Leaf) -and (@(Get-ChildItem $root -File -Filter '*.lock').Count -eq 1)) ''
$r = Invoke-Cli @('release', $idB)
Check 'the real holder can still release' ($r.Code -eq 0 -and -not (Test-Path $lockPath)) "code=$($r.Code) err=$($r.Err)"

# ------------------ 14. REGRESSION: run must not delete a lease taken over mid-run
Write-Host ''
Write-Host '[14] REGRESSION: run leaves a mid-run takeover intact' -ForegroundColor Cyan
$root = New-CaseRoot 'runtakeover'
$lockPath = Join-Path $root 'rt_key.lock'
$p = Start-Cli @('run','rt:key','-Ttl','1s','-Cmd','ping -n 6 127.0.0.1 >nul')
Start-Sleep -Milliseconds 2500
$r = Invoke-Cli @('acquire','rt:key','-Wait','0','-Owner','thief','-Ttl','60s')
$idThief = (ConvertTo-Lease $r.Out).id
Check 'a second agent takes the lease over while run is still working' ($r.Code -eq 0 -and $r.Err -match 'Took over') "code=$($r.Code) err=$($r.Err)"
$c = Complete-Cli $p
Check 'run still exits with the child code (0)' ($c.Code -eq 0) "code=$($c.Code) err=$($c.Err)"
Check 'run logs that its lease was taken over' ($c.Err -match 'taken over') "err=$($c.Err)"
Check 'the thief lock file SURVIVES run finishing' (Test-Path $lockPath -PathType Leaf) ''
$m = $null
try { $m = [System.IO.File]::ReadAllText($lockPath) | ConvertFrom-Json } catch { }
Check 'the surviving lock belongs to the thief' ($m -and $m.id -eq $idThief -and $m.owner -eq 'thief') "meta=$($m | ConvertTo-Json -Compress)"
$out = Get-Status
Check 'status still shows the thief' ($out -match 'thief') "out=$out"
$r = Invoke-Cli @('acquire','rt:key','-Wait','0','-Owner','late','-Ttl','30s')
Check 'a later agent is still blocked' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$null = Invoke-Cli @('release','--all','-Owner','thief')

# -------------------------------- 15. REGRESSION: key case is one single lock
Write-Host ''
Write-Host '[15] REGRESSION: mixed-case key is lowercased onto one lock file' -ForegroundColor Cyan
$root = New-CaseRoot 'casekey'
$r = Invoke-Cli @('acquire','Case:Key','-Wait','0','-Owner','caser1','-Ttl','30s')
Check 'mixed-case key acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'the lock file name is lowercased' (Test-Path (Join-Path $root 'case_key.lock') -PathType Leaf) ''
Check 'no uppercase lock file exists' (@(Get-ChildItem $root -File -Filter '*.lock' | Where-Object { $_.Name -cnotmatch '^[a-z0-9._-]+\.lock$' }).Count -eq 0) ''
$r = Invoke-Cli @('acquire','case:key','-Wait','0','-Owner','caser2','-Ttl','30s')
Check 'the lowercase spelling hits the same lock (busy)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$null = Invoke-Cli @('release','--all','-Owner','caser1')

# --------------------------------- 16. REGRESSION: run fails fast by default
Write-Host ''
Write-Host '[16] REGRESSION: run defaults to -Wait 0 (never queues)' -ForegroundColor Cyan
$root = New-CaseRoot 'runwait'
$null = Invoke-Cli @('acquire','busy:key','-Wait','0','-Owner','sitter','-Ttl','8s')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$c = Invoke-Cli @('run','busy:key','-Cmd','exit 0')
$sw.Stop()
Check 'run on a held key exits 2' ($c.Code -eq 2) "code=$($c.Code) out=$($c.Out)"
Check 'run returns immediately instead of waiting out the TTL' ($sw.ElapsedMilliseconds -lt 3000) "elapsed=$($sw.ElapsedMilliseconds)ms"
Check 'run says Resource busy and never claims Acquired' (($c.Err -match 'Resource busy') -and -not ($c.Err -match 'Acquired lease')) "err=$($c.Err)"
Check 'the sitter still holds the lease' ((Get-Status) -match 'sitter') ''
$null = Invoke-Cli @('release','--all','-Owner','sitter')

# ------------------------------------- 17. REGRESSION: empty owner is refused
Write-Host ''
Write-Host '[17] REGRESSION: an empty owner is rejected (exit 3)' -ForegroundColor Cyan
$root = New-CaseRoot 'emptyowner'
$r = Invoke-Cli @('acquire','e:key','-Owner','','-Ttl','30s')
Check 'acquire with an empty owner exits 3' ($r.Code -eq 3) "code=$($r.Code) out=$($r.Out) err=$($r.Err)"
Check 'no lock was created by the rejected call' (@(Get-ChildItem $root -File -Filter '*.lock').Count -eq 0) ''
$r = Invoke-Cli @('acquire','e:key','-Wait','0','-Owner','agent-A','-Ttl','30s')
Check 'a named owner acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('release','--all','-Owner','')
Check 'release --all with an empty owner exits 3' ($r.Code -eq 3) "code=$($r.Code) out=$($r.Out) err=$($r.Err)"
$out = Get-Status
Check 'the other agent lease was not reaped' ($out -match 'agent-A') "out=$out"
$null = Invoke-Cli @('release','--all','-Owner','agent-A')

# ------------------------------- 18. REGRESSION: run honours DSH_RESOURCE_TTL
Write-Host ''
Write-Host '[18] REGRESSION: run honours DSH_RESOURCE_TTL (not a hardcoded 600s)' -ForegroundColor Cyan
$root = New-CaseRoot 'runtll'
$savedTtl = $env:DSH_RESOURCE_TTL
$env:DSH_RESOURCE_TTL = '7s'
$p = Start-Cli @('run','ttlrun:key','-Cmd','ping -n 5 127.0.0.1 >nul')
Start-Sleep -Milliseconds 1500
$m = $null
try { $m = [System.IO.File]::ReadAllText((Join-Path $root 'ttlrun_key.lock')) | ConvertFrom-Json } catch { }
$span = if ($m) { [int64]$m.expiresAt - [int64]$m.createdAt } else { -1 }
Check 'the run lease TTL is 7000ms, taken from the environment' ($span -eq 7000) "span=$span meta=$($m | ConvertTo-Json -Compress)"
$env:DSH_RESOURCE_TTL = $savedTtl
$null = Complete-Cli $p

# ---------- 19. REGRESSION: an unreadable lock file is not automatically stale
# A lock file that exists but has no parseable body is what a live writer looks
# like for a few milliseconds. Treating it as expired archived a fresh 30s lease
# and left TWO holders of one lock (reproduced under load). Only a file that is
# also OLD is a crashed residue worth taking over.
Write-Host ''
Write-Host '[19] REGRESSION: a half-written lock file is not takeable' -ForegroundColor Cyan
$root = New-CaseRoot 'unreadable'
$lockPath = Join-Path $root 'half_key.lock'
[System.IO.File]::WriteAllBytes($lockPath, (New-Object byte[] 0))
$r = Invoke-Cli @('acquire','half:key','-Wait','0','-Owner','late-arrival','-Ttl','30s')
Check 'a fresh, empty lock file counts as HELD (exit 2)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the busy message admits there is no readable metadata' ($r.Err -match 'no readable metadata') "err=$($r.Err)"
Check 'the half-written file was NOT archived' (Test-Path $lockPath -PathType Leaf) ''
Check 'nothing was archived to .stale' (@(Get-ChildItem $root -File -Filter '*.stale.*' -ErrorAction SilentlyContinue).Count -eq 0) ''
[System.IO.File]::SetLastWriteTime($lockPath, (Get-Date).AddMinutes(-5))
$r = Invoke-Cli @('acquire','half:key','-Wait','0','-Owner','recoverer','-Ttl','30s')
Check 'an OLD empty lock file IS takeable (crashed residue)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'that takeover is logged' ($r.Err -match 'Took over') "err=$($r.Err)"
Check '.stale count is 1 after the residue takeover' (@(Get-ChildItem $root -File -Filter '*.stale.*' -ErrorAction SilentlyContinue).Count -eq 1) ''
$null = Invoke-Cli @('release','--all','-Owner','recoverer')

# ------------- 20. REGRESSION: a directory on the lock path must not lock forever
# Read-Meta used File.Exists (false for a directory) and Get-LockAgeMs used
# FileInfo.Exists (also false), so Try-Takeover returned "not takeable" without
# ever looking at the age: the key was busy FOR EVER, no TTL could rescue it,
# and `status` showed no lease at all. The plugin and the MCP server archived
# such a directory; the CLI is the third implementation catching up.
Write-Host ''
Write-Host '[20] REGRESSION: a directory squatting on the lock path is archived' -ForegroundColor Cyan
$root = New-CaseRoot 'dirlock'
$lockPath = Join-Path $root 'dir_key.lock'
New-Item -ItemType Directory -Force -Path $lockPath | Out-Null
Check 'a directory occupies the lock path' (Test-Path $lockPath -PathType Container) ''
$r = Invoke-Cli @('acquire','dir:key','-Wait','0','-Owner','early-bird','-Ttl','30s')
Check 'a JUST-created directory counts as held (grace period, exit 2)' ($r.Code -eq 2) "code=$($r.Code) err=$($r.Err)"
Check 'the directory was not archived inside the grace period' (@(Get-ChildItem $root -Force -Filter '*.stale.*' -ErrorAction SilentlyContinue).Count -eq 0) ''
[System.IO.Directory]::SetLastWriteTimeUtc($lockPath, [DateTime]::UtcNow.AddMinutes(-5))
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$r = Invoke-Cli @('acquire','dir:key','-Wait','0','-Owner','late-arrival','-Ttl','30s')
$sw.Stop()
Check 'a STALE directory no longer blocks for ever (exit 0)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'the takeover returns promptly instead of spinning' ($sw.ElapsedMilliseconds -lt 5000) "elapsed=$($sw.ElapsedMilliseconds)ms"
Check 'stderr says a directory was archived' ($r.Err -match 'Archived a directory') "err=$($r.Err)"
Check 'the lock path is a FILE again' (Test-Path $lockPath -PathType Leaf) ''
Check 'the directory was moved aside, not deleted' (@(Get-ChildItem $root -Force -Filter '*.stale.*' -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer }).Count -eq 1) ''
$out = Get-Status
Check 'status now shows the NEW holder' ($out -match 'late-arrival') "out=$out"
$r = Invoke-Cli @('acquire','dir:key','-Wait','0','-Owner','third-agent','-Ttl','30s')
Check 'a later agent is blocked by the new holder, not by the directory' (($r.Code -eq 2) -and ($r.Err -match 'late-arrival')) "code=$($r.Code) err=$($r.Err)"
$null = Invoke-Cli @('release','--all','-Owner','late-arrival')

# ============================================================================
# v2 CASES
# The contract these cover is docs/RESOURCE-MODEL-v2.md: multi-key atomic
# acquire (section 4), canonical form + facet conflicts (sections 2, 3),
# liveness (section 5), CLI surface and exit codes (7.2, 7.3), and the test
# matrix entries 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15 (section 11).
# ============================================================================

# ------------------------------- 21. multi-key acquire is one atomic lease
Write-Host ''
Write-Host '[21] multi-key acquire: two keys, one lease, two lock files' -ForegroundColor Cyan
$root = New-CaseRoot 'multikey'
$mkDir = Join-Path $dataRoot 'out'
$r = Invoke-Cli @('acquire', "path:$mkDir", 'port:9222', '--ttl', '300s', '--reason', 'build', '-Owner', 'mk1')
Check 'multi-key acquire exits 0' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$mkLease = ConvertTo-Lease $r.Out
Check 'the lease covers both requested keys' ($mkLease -and @($mkLease.keys).Count -eq 2) "out=$($r.Out)"
Check 'the lease covers two facets' ($mkLease -and @($mkLease.facets).Count -eq 2) ''
Check 'the facets come out in orderKey order (path before port)' ($mkLease -and $mkLease.facets[0].StartsWith('path:') -and $mkLease.facets[1] -eq 'port:9222') "facets=$($mkLease.facets -join ',')"
Check 'two lock files were created and both exist' ($mkLease -and @($mkLease.locks).Count -eq 2 -and @($mkLease.locks | Where-Object { -not (Test-Path $_ -PathType Leaf) }).Count -eq 0) ''
Check 'the port facet has its own file' (Test-Path (Join-Path $root 'port_9222.lock') -PathType Leaf) ''
Check 'the primary file is still sanitizeKey(canonicalKey)' ($mkLease -and (Test-Path (Join-Path $root (LockName $mkLease.facets[0])) -PathType Leaf)) ''
Check 'the acquire mutex did not linger' (-not (Test-Path (Join-Path $root '_global.lock'))) ''
$mkIndex = $null
try { $mkIndex = [System.IO.File]::ReadAllText((Join-Path $root ("_leases\" + $mkLease.id + '.json'))) | ConvertFrom-Json } catch { }
Check 'the aggregated index lists every facet file' ($mkIndex -and @($mkIndex.paths).Count -eq 2) "index=$($mkIndex | ConvertTo-Json -Compress)"
Check 'the index also carries the v1 single-path field' ($mkIndex -and $mkIndex.path) ''
$r = Invoke-Cli @('release', $mkLease.id)
Check 'releasing the id frees every facet' ($r.Code -eq 0 -and @($mkLease.locks | Where-Object { Test-Path $_ }).Count -eq 0) "code=$($r.Code) err=$($r.Err)"
Clear-CaseLeases

# ------------------- 22. path ancestor conflicts, sibling prefixes do not
Write-Host ''
Write-Host '[22] path facets: ancestor conflicts, sibling prefix does not (matrix 2, 3)' -ForegroundColor Cyan
$root = New-CaseRoot 'paths'
$ancBase = Join-Path $dataRoot 'anc'
$r = Invoke-Cli @('acquire', "path:$ancBase", '-Owner', 'ancA', '-Ttl', '60s', '-Reason', 'hold-out')
Check 'holding a directory succeeds' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', "path:$ancBase\sub", '-Wait', '0', '-Owner', 'ancB')
Check 'a descendant path conflicts (matrix 2)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the conflict names the ancestor facet' ($r.Err -match 'path:c:') "err=$($r.Err)"
Check 'the conflict names the ancestor holder' ($r.Err -match 'ancA') "err=$($r.Err)"
$r = Invoke-Cli @('acquire', "path:${ancBase}2", '-Wait', '0', '-Owner', 'ancC', '-Ttl', '30s')
Check 'a sibling with a shared string prefix does NOT conflict (matrix 3)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'the blocked descendant never created a file' ((Get-LeaseFiles $root).Count -eq 2) "files=$((Get-LeaseFiles $root).Count)"
Clear-CaseLeases

# ------------------------------------------- 23. port ranges overlap (matrix 5)
Write-Host ''
Write-Host '[23] port facets: range overlap (matrix 5)' -ForegroundColor Cyan
$root = New-CaseRoot 'ports'
$r = Invoke-Cli @('acquire', 'port:9220-9230', '-Owner', 'rangeHold', '-Ttl', '60s', '-Reason', 'wide')
Check 'a port range acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', 'port:9222', '-Wait', '0', '-Owner', 'single')
Check 'a port inside the held range conflicts (matrix 5)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$r = Invoke-Cli @('acquire', 'port:9230', '-Wait', '0', '-Owner', 'edge')
Check 'the range boundary is inclusive' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$r = Invoke-Cli @('acquire', 'port:9300', '-Wait', '0', '-Owner', 'outside', '-Ttl', '30s')
Check 'a port outside the range does not conflict' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Clear-CaseLeases

# ------------------------------- 24. canonical form: spellings are one lock
Write-Host ''
Write-Host '[24] canonical form: different spellings hit the same lock' -ForegroundColor Cyan
$root = New-CaseRoot 'canon'
$canonDir = Join-Path $dataRoot 'Canon'
$r = Invoke-Cli @('acquire', "path:$canonDir", '-Owner', 'c1', '-Ttl', '60s')
Check 'a mixed-case path acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$canonLease = ConvertTo-Lease $r.Out
Check 'the canonical path is lowercase with forward slashes' ($canonLease -and $canonLease.facets[0] -match '^path:c:/.*canon$') "facet=$($canonLease.facets[0])"
$r = Invoke-Cli @('acquire', ("path:" + $canonDir.ToUpper() + '\'), '-Wait', '0', '-Owner', 'c2')
Check 'uppercase + backslashes + trailing separator is the same lock' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$r = Invoke-Cli @('acquire', 'port:9222', '-Owner', 'p1', '-Ttl', '60s')
Check 'port:9222 acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', 'port:09222', '-Wait', '0', '-Owner', 'p2')
Check 'leading zeros in a port are normalized away' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the normalized port named one file, not two' ((Test-Path (Join-Path $root 'port_9222.lock')) -and -not (Test-Path (Join-Path $root 'port_09222.lock'))) ''
Clear-CaseLeases

# ------------------------- 25. multi-key partial failure rolls back (matrix 7)
Write-Host ''
Write-Host '[25] multi-key partial failure: reverse rollback, no residue (matrix 7)' -ForegroundColor Cyan
$root = New-CaseRoot 'rollback'
$r = Invoke-Cli @('acquire', 'port:9421', '-Owner', 'blocker', '-Ttl', '60s', '-Reason', 'held')
Check 'the blocker holds the port' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$blockerFile = Join-Path $root 'port_9421.lock'
$blockerBefore = Read-RawText $blockerFile
$rbDir = Join-Path $dataRoot 'rb'
$r = Invoke-Cli @('acquire', "path:$rbDir", 'port:9421', '-Wait', '0', '-Owner', 'rollbacker', '-Reason', 'try')
Check 'a multi-key acquire with one busy key exits 2' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$rbFiles = Get-LeaseFiles $root
Check 'exactly one lock file remains: nothing was left behind' ($rbFiles.Count -eq 1 -and $rbFiles[0].Name -eq 'port_9421.lock') "files=$(($rbFiles | ForEach-Object { $_.Name }) -join ',')"
Check 'the rollback is reported on stderr' ($r.Err -match 'Rolled back') "err=$($r.Err)"
Check 'the rollback names the facet it released' ($r.Err -match 'path_') "err=$($r.Err)"
Check 'the rollback ran in reverse order (the port is not in it)' (-not ($r.Err -match 'Rolled back.*port_9421')) "err=$($r.Err)"
Check 'the blocking holder lock was not touched (matrix 15)' ((Read-RawText $blockerFile) -eq $blockerBefore) ''
Check 'the conflict names the blocking facet and holder' (($r.Err -match 'port:9421') -and ($r.Err -match 'blocker')) "err=$($r.Err)"
$rbIndexCount = @(Get-ChildItem (Join-Path $root '_leases') -File -Filter '*.json' -ErrorAction SilentlyContinue).Count
Check 'the rolled-back attempt left no index record of its own' ($rbIndexCount -eq 1) "index records=$rbIndexCount"
Clear-CaseLeases

# ------------------------------ 26. the index is not the source of truth (13)
Write-Host ''
Write-Host '[26] deleting the index does not break exclusion (matrix 13)' -ForegroundColor Cyan
$root = New-CaseRoot 'noindex'
$niDir = Join-Path $dataRoot 'ni'
$r = Invoke-Cli @('acquire', "path:$niDir", '-Owner', 'niA', '-Ttl', '60s', '-Reason', 'hold')
Check 'the holder acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$niLease = ConvertTo-Lease $r.Out
$niIndex = Join-Path $root ('_leases\' + $niLease.id + '.json')
Check 'the index record exists before we delete it' (Test-Path $niIndex -PathType Leaf) ''
Remove-Item $niIndex -Force -ErrorAction SilentlyContinue
Check 'the index record is gone' (-not (Test-Path $niIndex)) ''
$r = Invoke-Cli @('acquire', "path:$niDir", '-Wait', '0', '-Owner', 'niB')
Check 'exclusion still holds without the index (matrix 13)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'status still reports the holder' ((Get-Status) -match 'niA') ''
Check 'the facet lock file is still on disk' (@($niLease.locks | Where-Object { Test-Path $_ }).Count -eq 1) ''
Remove-Item (Join-Path $root (LockName $niLease.facets[0])) -Force -ErrorAction SilentlyContinue
Clear-CaseLeases

# --------------------- 27. two processes race one path facet (matrix 1, G1)
Write-Host ''
Write-Host '[27] two processes race one path facet: exactly one wins (matrix 1)' -ForegroundColor Cyan
$root = New-CaseRoot 'racepath'
$rpDir = Join-Path $dataRoot 'racepath'
$pr1 = Start-Cli @('acquire', "path:$rpDir", '-Wait', '0', '-Owner', 'rp1', '-Ttl', '30s')
$pr2 = Start-Cli @('acquire', "path:$rpDir", '-Wait', '0', '-Owner', 'rp2', '-Ttl', '30s')
$rc1 = Complete-Cli $pr1
$rc2 = Complete-Cli $pr2
$codes = @($rc1.Code, $rc2.Code) | Sort-Object
Check 'exactly one success(0) and one conflict(2) (matrix 1)' (($codes -join ',') -eq '0,2') "codes=$($codes -join ',')"
Check 'only one lock file exists after the race' ((Get-LeaseFiles $root).Count -eq 1) "files=$((Get-LeaseFiles $root).Count)"
Check 'the acquire mutex did not linger after the race' (-not (Test-Path (Join-Path $root '_global.lock'))) ''
Clear-CaseLeases

# ---------------- 28. opposite request order cannot deadlock (matrix 6, G2)
Write-Host ''
Write-Host '[28] opposite request order: no deadlock, no partial hold (matrix 6)' -ForegroundColor Cyan
$root = New-CaseRoot 'order'
$ordDir = Join-Path $dataRoot 'order1'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$pa = Start-Cli @('acquire', "path:$ordDir", 'port:9451', '-Wait', '0', '-Owner', 'ordA', '-Ttl', '30s')
$pb = Start-Cli @('acquire', 'port:9451', "path:$ordDir", '-Wait', '0', '-Owner', 'ordB', '-Ttl', '30s')
$oc1 = Complete-Cli $pa
$oc2 = Complete-Cli $pb
$sw.Stop()
$ocodes = @($oc1.Code, $oc2.Code) | Sort-Object
Check 'both opposite-order racers finish instead of deadlocking (G2)' ($sw.ElapsedMilliseconds -lt 25000) "elapsed=$($sw.ElapsedMilliseconds)ms"
Check 'exactly one of them gets BOTH keys (matrix 6)' (($ocodes -join ',') -eq '0,2') "codes=$($ocodes -join ',')"
$ordFiles = Get-LeaseFiles $root
Check 'the loser left no partial hold behind' ($ordFiles.Count -eq 2) "files=$(($ordFiles | ForEach-Object { $_.Name }) -join ',')"
$ordIds = @()
foreach ($f in $ordFiles) {
  $m = $null
  try { $m = [System.IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json } catch { }
  if ($m) { $ordIds += [string]$m.id }
}
Check 'the two surviving files belong to ONE lease id' ((@($ordIds | Sort-Object -Unique)).Count -eq 1) "ids=$($ordIds -join ',')"
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$pc = Start-Cli @('acquire', "path:$ordDir", 'port:9451', '-Wait', '2s', '-Owner', 'ordC', '-Ttl', '30s')
$oc3 = Complete-Cli $pc
$sw2.Stop()
Check 'a QUEUEING racer gives up with exit 2 when the wait expires' ($oc3.Code -eq 2) "code=$($oc3.Code) err=$($oc3.Err)"
Check 'the queueing racer rolled back and left no residue' ((Get-LeaseFiles $root).Count -eq 2) "files=$((Get-LeaseFiles $root).Count)"
Check 'the queueing racer actually waited before giving up' ($sw2.ElapsedMilliseconds -ge 1500) "elapsed=$($sw2.ElapsedMilliseconds)ms"
Clear-CaseLeases

# ------------ 29. liveness beats TTL: dead pid, PID reuse, live, cross-host
Write-Host ''
Write-Host '[29] liveness beats TTL (matrix 8, 9)' -ForegroundColor Cyan
$root = New-CaseRoot 'liveness'
$nowMs = Get-NowMs
$selfHost = [Environment]::MachineName

# (a) same host, pid gone -> immediate reclaim, even with 60s of TTL left
$deadPath = Join-Path $root 'live_probe.lock'
Write-RawLock $deadPath ([ordered]@{
  id = 'lz_deadowner1'; key = 'live:probe'; facet = 'live:probe'; facets = @('live:probe')
  mode = 'exclusive'; slots = 1; slot = 0
  owner = [ordered]@{ agent = 'ghost'; session = 'sess-ghost'; pid = 999999; host = $selfHost; procStart = ($nowMs - 5000) }
  reason = 'crashed-holder'; pid = 999999; host = $selfHost
  createdAt = $nowMs; expiresAt = ($nowMs + 60000); lockPath = $deadPath
})
$deadMeta = $null
try { $deadMeta = [System.IO.File]::ReadAllText($deadPath) | ConvertFrom-Json } catch { }
Check 'the dead-owner lease still has ~60s of TTL left (not expired)' ($deadMeta -and ([int64]$deadMeta.expiresAt -gt $nowMs)) ''
Check 'status marks a provably dead owner as takeable' ((Get-Status) -match 'DEAD') "out=$(Get-Status)"
$r = Invoke-Cli @('acquire', 'live:probe', '-Wait', '0', '-Owner', 'reaper', '-Ttl', '30s')
Check 'a lease whose owner pid is gone is reclaimed at once (matrix 8)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'the liveness reclaim says why it happened' ($r.Err -match 'owner is gone') "err=$($r.Err)"
$null = Invoke-Cli @('release', '--all', '-Owner', 'reaper')

# (b) same host, pid alive but procStart mismatched -> PID reuse, reclaim
$reusePath = Join-Path $root 'live_reuse.lock'
Write-RawLock $reusePath ([ordered]@{
  id = 'lz_reuse1'; key = 'live:reuse'; facet = 'live:reuse'; facets = @('live:reuse')
  mode = 'exclusive'; slots = 1; slot = 0
  owner = [ordered]@{ agent = 'recycled'; session = 'sess-x'; pid = $PID; host = $selfHost; procStart = 1 }
  reason = 'pid-reused'; pid = $PID; host = $selfHost
  createdAt = $nowMs; expiresAt = ($nowMs + 60000); lockPath = $reusePath
})
$r = Invoke-Cli @('acquire', 'live:reuse', '-Wait', '0', '-Owner', 'reuser', '-Ttl', '30s')
Check 'PID reuse (procStart mismatch) is reclaimed at once (matrix 9)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$null = Invoke-Cli @('release', '--all', '-Owner', 'reuser')

# (c) same host, pid alive and procStart correct -> must NOT be reclaimed
$alivePath = Join-Path $root 'live_alive.lock'
Write-RawLock $alivePath ([ordered]@{
  id = 'lz_alive1'; key = 'live:alive'; facet = 'live:alive'; facets = @('live:alive')
  mode = 'exclusive'; slots = 1; slot = 0
  owner = [ordered]@{ agent = 'live-owner'; session = 'sess-live'; pid = $PID; host = $selfHost; procStart = (Get-SelfStartMs) }
  reason = 'still-running'; pid = $PID; host = $selfHost
  createdAt = $nowMs; expiresAt = ($nowMs + 60000); lockPath = $alivePath
})
$r = Invoke-Cli @('acquire', 'live:alive', '-Wait', '0', '-Owner', 'late')
Check 'a live owner with a matching procStart is NOT reclaimed' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the live owner is named in the conflict' ($r.Err -match 'live-owner') "err=$($r.Err)"

# (d) another host -> only the TTL may judge it
$farPath = Join-Path $root 'live_far.lock'
Write-RawLock $farPath ([ordered]@{
  id = 'lz_far1'; key = 'live:far'; facet = 'live:far'; facets = @('live:far')
  mode = 'exclusive'; slots = 1; slot = 0
  owner = [ordered]@{ agent = 'far-owner'; session = 'sess-far'; pid = 999999; host = 'SOME-OTHER-PC'; procStart = 123 }
  reason = 'remote'; pid = 999999; host = 'SOME-OTHER-PC'
  createdAt = $nowMs; expiresAt = ($nowMs + 60000); lockPath = $farPath
})
$r = Invoke-Cli @('acquire', 'live:far', '-Wait', '0', '-Owner', 'local-guy')
Check 'a dead pid on ANOTHER host is not judged (TTL only)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Clear-CaseLeases

# ------------------- 30. facet expansion: profile dir, cdp port, screen/window
Write-Host ''
Write-Host '[30] facet expansion across classes (matrix 4)' -ForegroundColor Cyan
$root = New-CaseRoot 'facets'
$savedProfiles = $env:DSH_BROWSER_PROFILE_ROOT
$profileRoot = Join-Path $dataRoot 'profiles'
$env:DSH_BROWSER_PROFILE_ROOT = $profileRoot
$r = Invoke-Cli @('acquire', 'browser:profile:work', '-Owner', 'bw', '-Ttl', '60s', '-Reason', 'shot')
Check 'browser:profile:work acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$bwLease = ConvertTo-Lease $r.Out
Check 'it expands into two facets (key + profile directory)' ($bwLease -and @($bwLease.facets).Count -eq 2) "facets=$($bwLease.facets -join ',')"
Check 'the primary lock file is still sanitizeKey(canonicalKey)' (Test-Path (Join-Path $root 'browser_profile_work.lock') -PathType Leaf) ''
Check 'the profile path facet got its own file' (@($bwLease.locks | Where-Object { Test-Path $_ }).Count -eq 2) ''
$profDir = Join-Path $profileRoot 'work'
$r = Invoke-Cli @('acquire', "path:$profDir", '-Wait', '0', '-Owner', 'other')
Check 'another agent naming the profile DIRECTORY collides (matrix 4)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the collision names the path facet' ($r.Err -match 'path:c:') "err=$($r.Err)"
$null = Invoke-Cli @('release', $bwLease.id)

$r = Invoke-Cli @('acquire', 'browser:cdp:9222', '-Owner', 'cdpA', '-Ttl', '30s')
Check 'browser:cdp:9222 acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', 'port:9222', '-Wait', '0', '-Owner', 'portB')
Check 'a plain port:9222 collides with browser:cdp:9222' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"

$r = Invoke-Cli @('acquire', 'window:hwnd:197772', '-Owner', 'winA', '-Ttl', '30s')
Check 'a window can be held' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', 'screen:focus', '-Wait', '0', '-Owner', 'focusA', '-Ttl', '30s')
Check 'screen:focus does NOT conflict with window:* (no over-serialization)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$env:DSH_BROWSER_PROFILE_ROOT = $savedProfiles
Clear-CaseLeases

# ------------------------------- 31. shared + shared, shared + exclusive
# Contract 8.6 is explicit: in v2.0 `shared` is DECLARED intent, not a real
# multi-reader. The storage model is one facet file with O_EXCL, so the SECOND
# shared request must be refused - exactly as the plugin's lockPathFor() does it.
# This section used to assert the opposite (64 `.shared-<n>.lock` slots), i.e. a
# CLI-only multi-reader the contract says does not exist; the CLI and the plugin
# then disagreed about the same request. The predicate (3.2, matrix 10) still
# allows shared+shared; the STORE is what refuses it, which is the point of 8.6.
Write-Host ''
Write-Host '[31] shared mode is a single holder (8.6); a writer still excludes it (matrix 11)' -ForegroundColor Cyan
$root = New-CaseRoot 'shared'
$shDir = Join-Path $dataRoot 'shared'
$r = Invoke-Cli @('acquire', "path:$shDir", '-Mode', 'shared', '-Owner', 'sh1', '-Ttl', '60s')
Check 'the first shared holder acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', "path:$shDir", '-Mode', 'shared', '-Owner', 'sh2', '-Ttl', '60s')
Check 'a second shared holder is REFUSED (8.6: no multi-reader in v2.0)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out) err=$($r.Err)"
Check 'a refused shared request created no second lock file' ((Get-LeaseFiles $root).Count -eq 1) "files=$((Get-LeaseFiles $root).Count)"
Check 'the refusal points at pool for concurrent readers' ($r.Err -match 'pool') "err=$($r.Err)"
Check 'no .shared-N file was ever written' (@(Get-ChildItem $root -File -Filter '*.shared-*.lock').Count -eq 0) ''
$r = Invoke-Cli @('acquire', "path:$shDir", '-Mode', 'exclusive', '-Wait', '0', '-Owner', 'ex1')
Check 'an exclusive request conflicts with shared holders (matrix 11)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$out = Get-Status
Check 'status shows the shared holder as the single holder' (($out -match 'sh1') -and -not ($out -match 'sh2')) "out=$out"
# The escape hatch the contract points at must actually work.
$r = Invoke-Cli @('acquire', "path:$shDir", '-Mode', 'pool', '-Slots', '2', '-Owner', 'poolA', '-Ttl', '60s')
Check 'pool is the supported way to admit concurrent readers (8.6)' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Clear-CaseLeases

# ----------------------------- 32. --keys comma form (CLI surface, section 7.2)
Write-Host ''
Write-Host '[32] --keys comma form for acquire and run' -ForegroundColor Cyan
$root = New-CaseRoot 'keyscsv'
$csvDir = Join-Path $dataRoot 'csv'
$r = Invoke-Cli @('acquire', '--keys', "path:$csvDir,port:9461", '-Owner', 'csvA', '-Ttl', '60s', '-Reason', 'csv')
Check '--keys a,b acquires both keys' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$csvLease = ConvertTo-Lease $r.Out
Check 'the comma form produced two facets' ($csvLease -and @($csvLease.facets).Count -eq 2) ''
Check 'both comma-form facets are on disk' (@($csvLease.locks | Where-Object { Test-Path $_ }).Count -eq 2) ''
$r = Invoke-Cli @('release', $csvLease.id)
Check 'the comma-form lease releases both facets' ($r.Code -eq 0 -and (Get-LeaseFiles $root).Count -eq 0) "code=$($r.Code) files=$((Get-LeaseFiles $root).Count)"
$r = Invoke-Cli @('run', '--keys', "path:$csvDir,port:9462", '-Cmd', 'exit 0')
Check 'run --keys a,b works' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Check 'run released every facet it took' ((Get-LeaseFiles $root).Count -eq 0) "files=$((Get-LeaseFiles $root).Count)"
$r = Invoke-Cli @('run', '--keys', "path:$csvDir,port:9462", '-Cmd', 'exit 3')
Check 'run still propagates the child exit code with several keys' ($r.Code -eq 3) "code=$($r.Code) err=$($r.Err)"
Clear-CaseLeases

# ---------------------------- 33. conflict output carries every field (4.3)
Write-Host ''
Write-Host '[33] conflict output: facet, holder identity, reason, remaining TTL' -ForegroundColor Cyan
$root = New-CaseRoot 'conflictout'
$savedSession = $env:DSH_SESSION_ID
$env:DSH_SESSION_ID = 'sess-conflict-1'
$cfDir = Join-Path $dataRoot 'conflict'
$r = Invoke-Cli @('acquire', "path:$cfDir", '-Owner', 'holderX', '-Ttl', '120s', '-Reason', 'rendering charts')
Check 'the holder acquires' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', "path:$cfDir\sub", '-Wait', '0', '-Owner', 'lateY')
Check 'the blocked request exits 2' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
Check 'the conflict names the conflicting facet' ($r.Err -match 'path:c:') "err=$($r.Err)"
Check 'the conflict carries the holder agent' ($r.Err -match 'agent=holderX') "err=$($r.Err)"
Check 'the conflict carries the holder session' ($r.Err -match 'session=sess-conflict-1') "err=$($r.Err)"
Check 'the conflict carries the holder pid' ($r.Err -match 'pid=\d+') "err=$($r.Err)"
Check 'the conflict carries the holder host' ($r.Err -match 'host=[A-Za-z0-9._-]+') "err=$($r.Err)"
Check 'the conflict carries the holder reason' ($r.Err -match 'reason=rendering charts') "err=$($r.Err)"
Check 'the conflict carries the remaining TTL' ($r.Err -match '\d+ms left') "err=$($r.Err)"
Check 'the conflict is also machine readable (JSON detail)' ($r.Err -match '"expiresInMs"') "err=$($r.Err)"
Check 'the JSON detail carries the facet' ($r.Err -match '"facet":\s*"path:') "err=$($r.Err)"
$env:DSH_SESSION_ID = $savedSession
Check 'status never lists the acquire mutex as a lease' (-not ((Get-Status) -match '_global')) ''
Check 'no acquire mutex was left behind' (-not (Test-Path (Join-Path $root '_global.lock'))) ''
Clear-CaseLeases

# -------------------------- 34. usage errors keep exit 3 (section 7.3)
Write-Host ''
Write-Host '[34] key syntax errors exit 3' -ForegroundColor Cyan
$root = New-CaseRoot 'keysyntax'
$scDir = Join-Path $dataRoot 'selfc'
$r = Invoke-Cli @('acquire', "path:$scDir", "path:$scDir\child", '-Owner', 'sc1', '-Ttl', '30s')
Check 'a request whose own keys conflict exits 3' ($r.Code -eq 3) "code=$($r.Code) out=$($r.Out)"
Check 'a self-conflicting request created nothing' ((Get-LeaseFiles $root).Count -eq 0) ''
$r = Invoke-Cli @('acquire', 'port:notaport', '-Owner', 'x')
Check 'an unparseable port key exits 3' ($r.Code -eq 3) "code=$($r.Code)"
$r = Invoke-Cli @('acquire', 'port:9230-9220', '-Owner', 'x')
Check 'a reversed port range exits 3' ($r.Code -eq 3) "code=$($r.Code)"
$r = Invoke-Cli @('acquire', 'path:', '-Owner', 'x')
Check 'an empty path subject exits 3' ($r.Code -eq 3) "code=$($r.Code)"
$r = Invoke-Cli @('run', '-Cmd', 'exit 0')
Check 'run without any key exits 3' ($r.Code -eq 3) "code=$($r.Code)"

# ------------------- 35. backend / IO failure is exit 4, never a silent pass
Write-Host ''
Write-Host '[35] an unusable lock root exits 4 (section 7.3)' -ForegroundColor Cyan
$badRoot = Join-Path $testRoot 'notadir'
[System.IO.File]::WriteAllText($badRoot, 'not a directory')
$env:DSH_RESOURCE_LOCK_ROOT = $badRoot
$r = Invoke-Cli @('acquire', 'io:key', '-Wait', '0', '-Owner', 'io1', '-Ttl', '30s')
Check 'acquire against an unusable lock root exits 4' ($r.Code -eq 4) "code=$($r.Code) out=$($r.Out) err=$($r.Err)"
Check 'the IO failure is explained on stderr' ($r.Err -match 'lock root') "err=$($r.Err)"
$r = Invoke-Cli @('run', 'io:key', '-Cmd', 'exit 0')
Check 'run reports the same backend failure as 4, not as a conflict' ($r.Code -eq 4) "code=$($r.Code) err=$($r.Err)"
Check 'run did not claim to have acquired anything' (-not ($r.Err -match 'Acquired lease')) "err=$($r.Err)"

# --------------------- 36. a path key must be absolute (contract section 2)
# Resolving a relative path against the current directory would make the
# canonical form depend on where the caller happened to run: two agents in
# different directories would hold two different locks for ONE directory and
# exclusion would fail silently. So a relative path is a hard error, not a
# convenience.
Write-Host ''
Write-Host '[36] a relative path key is a hard error, not a cwd guess' -ForegroundColor Cyan
$root = New-CaseRoot 'relpath'
$r = Invoke-Cli @('acquire', 'path:relative/out', '-Owner', 'rel1', '-Ttl', '30s')
Check 'a relative path key exits 3' ($r.Code -eq 3) "code=$($r.Code) out=$($r.Out) err=$($r.Err)"
Check 'the error explains the absolute-path rule' ($r.Err -match 'ABSOLUTE') "err=$($r.Err)"
Check 'the rejected relative key created no lock file' ((Get-LeaseFiles $root).Count -eq 0) ''
$r = Invoke-Cli @('acquire', 'path:C:drive-relative', '-Owner', 'rel2', '-Ttl', '30s')
Check 'a drive-relative path (C:foo) is rejected too' ($r.Code -eq 3) "code=$($r.Code) err=$($r.Err)"
$r = Invoke-Cli @('acquire', ('path:' + (Join-Path $dataRoot 'abs')), '-Owner', 'rel3', '-Ttl', '30s')
Check 'an absolute path key is accepted' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
Clear-CaseLeases

# --------------- 37. the acquire order is a total order on the FULL key (3.4)
# Two facets of the same class must still order deterministically, otherwise
# two agents taking {profile:a, profile:b} in opposite orders can deadlock. An
# orderKey that drops the qualifier would give both the same sort key.
Write-Host ''
Write-Host '[37] the acquire order is a total order on the full canonical key (3.4)' -ForegroundColor Cyan
$root = New-CaseRoot 'ordertotal'
$savedProfiles = $env:DSH_BROWSER_PROFILE_ROOT
$env:DSH_BROWSER_PROFILE_ROOT = (Join-Path $dataRoot 'profiles2')
$r = Invoke-Cli @('acquire', 'browser:profile:zzz', 'browser:profile:aaa', '-Owner', 'ord1', '-Ttl', '30s')
Check 'two same-class keys acquire together' ($r.Code -eq 0) "code=$($r.Code) err=$($r.Err)"
$ordLease = ConvertTo-Lease $r.Out
Check 'same-class facets are ordered, not tied' ($ordLease -and @($ordLease.facets).Count -ge 2 -and $ordLease.facets[0] -ne $ordLease.facets[1]) "facets=$($ordLease.facets -join ',')"
Check 'the ordinal order puts :aaa before :zzz' ($ordLease -and ($ordLease.facets -join ',') -match 'profile:aaa.*profile:zzz') "facets=$($ordLease.facets -join ',')"
$r = Invoke-Cli @('acquire', 'browser:profile:aaa', 'browser:profile:zzz', '-Wait', '0', '-Owner', 'ord2')
Check 'the reversed spelling of the same pair is the same request (busy)' ($r.Code -eq 2) "code=$($r.Code) out=$($r.Out)"
$env:DSH_BROWSER_PROFILE_ROOT = $savedProfiles
Clear-CaseLeases

# ------------------------------------------------------------------- summary
Write-Host ''
Write-Host ('=' * 60)
Write-Host ("RESULT: PASS=$script:pass  FAIL=$script:fail") -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })

Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
exit $(if ($script:fail -eq 0) { 0 } else { 1 })