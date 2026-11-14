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

# ------------------------------------------------------------------- summary
Write-Host ''
Write-Host ('=' * 60)
Write-Host ("RESULT: PASS=$script:pass  FAIL=$script:fail") -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })

Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
exit $(if ($script:fail -eq 0) { 0 } else { 1 })