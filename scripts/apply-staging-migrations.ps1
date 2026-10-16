#Requires -Version 5.1
<#
.SYNOPSIS
    Apply the 17 migrations to STAGING, self-gating, read-only until every check passes.

.DESCRIPTION
    Paste this into the PowerShell window where $env:PGURI is already set. It runs
    the documented sequence and STOPS ITSELF the moment reality differs from
    expectation, rather than relying on anyone reading output carefully.

    Gates, in order. Each one aborts the whole script on failure:

      1. $env:PGURI is set.
      2. Static audits pass (schema completeness, read-only, self-test).
      3. Local config preflight passes - staging configured, distinct from prod.
      4. Connection preflight passes - correct ref, not production, empty.
      5. Pre-migration dump is written.
      6. Dry run reports EXACTLY 17 pending migrations.
      7. Dry run contains none of the stop-phrases.
      8. Apply, same explicit connection and arguments.
      9. Post-apply verification of history and schema.

    It never runs a bare `supabase db push`, never passes --include-all, and never
    edits migration history. If anything fails after step 8, it reports the exact
    failure and the resulting staging state, and stops. It performs no recovery.

.PARAMETER WhatIf
    Run every gate but stop before applying. Dry run of the dry run.

.NOTES
    Exit codes: 0 applied, 1 refused/failed, 2 could not determine.
#>

param([switch]$WhatIf)

$ErrorActionPreference = 'Stop'
$script:Out = New-Object System.Collections.Generic.List[string]

function Write-Step  ([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Write-Note  ([string]$m) { Write-Host "   $m" }
function Write-Good  ([string]$m) { Write-Host "   [ok]   $m" -ForegroundColor Green }
function Write-Bad   ([string]$m) { Write-Host "   [STOP] $m" -ForegroundColor Red }
function Stop-Run    ([string]$m, [int]$code = 1) { Write-Bad $m; Write-Host ''; exit $code }

function Redact([string]$text) {
    if ($null -eq $text) { return '' }
    $t = $text -replace '://[^:@/\s]+:[^@/\s]+@', '://***:***@'
    if ($env:PGURI) { $t = $t.Replace($env:PGURI, '***REDACTED-URI***') }
    return $t
}

# --------------------------------------------------------------------------
# 0. Preflight
# --------------------------------------------------------------------------
Write-Host ''
Write-Host '  PharmaFlow - staging migration apply' -ForegroundColor White
Write-Host '  ============================================================'

$repo = $PSScriptRoot
if (-not $repo) { $repo = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location (Split-Path -Parent $repo)

if (-not $env:PGURI) {
    Stop-Run '$env:PGURI is not set in THIS shell. Re-run: $sec = Read-Host "Staging session pooler URI" -AsSecureString; $env:PGURI = [System.Net.NetworkCredential]::new("",$sec).Password' 2
}

# Hard constants. Not read from any file, so a corrupted config cannot retarget
# this script.
$ExpectedRef  = 'xnhsuifcbplnwtxnpedw'
$ExpectedMigs = 17

Write-Step '1. credential present'
Write-Good '$env:PGURI is set (value never printed)'

# --------------------------------------------------------------------------
# 1. Static audits
# --------------------------------------------------------------------------
Write-Step '2. static audits'
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"
foreach ($s in @('audit-schema-completeness.mjs','audit-readonly.mjs','selftest-staging-connection.mjs','selftest-dryrun-gate.mjs','verify-staging-target.mjs')) {
    & $bun "scripts/$s" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Run "static audit failed: scripts/$s" }
    Write-Good "scripts/$s"
}

# --------------------------------------------------------------------------
# 2. Connection preflight
# --------------------------------------------------------------------------
Write-Step '3. connection preflight'
$conn = & $bun 'scripts/verify-staging-connection.mjs' 2>&1 | Out-String
$connCode = $LASTEXITCODE
$connSafe = Redact $conn
Write-Host $connSafe

# Pre-apply, the ONLY acceptable result is exit 0: identity verified and the
# database empty. Exit 1 (already populated), 2 (undetermined), 3 (refused) and
# 4 (connection failure) all stop the run. Same taxonomy as post-apply, where
# exit 1 is the only success instead - that inversion is deliberate.
Write-Note "connection verifier exited $connCode"
if ($connCode -ne 0) {
    Stop-Run "connection preflight returned $connCode, expected 0 (verified and empty)."
}
if ($connSafe -notmatch [regex]::Escape($ExpectedRef)) { Stop-Run "output never mentioned the expected staging ref $ExpectedRef" }
if ($connSafe -notmatch 'RESULT: verified') { Stop-Run 'connection preflight did not reach RESULT: verified' }
Write-Good 'verified: staging, not production, empty and unmigrated'

# --------------------------------------------------------------------------
# 3. Dump before anything
# --------------------------------------------------------------------------
Write-Step '4. pre-migration dump'
$dump = 'staging-before-migrations.sql'
if (Test-Path $dump) { Remove-Item $dump -Force }
$dumpOut = & supabase db dump --db-url $env:PGURI -f $dump 2>&1 | Out-String
$dumpCode = $LASTEXITCODE
Write-Host (Redact $dumpOut)
# Exit code first. File existence alone is not enough: a dump interrupted partway
# through can leave a truncated file behind that looks like a successful dump.
if ($dumpCode -ne 0) { Stop-Run "the dump FAILED (exit $dumpCode) - refusing to continue" }
if (-not (Test-Path $dump)) { Stop-Run "dump was not written to $dump - refusing to continue" }
if ((Get-Item $dump).Length -eq 0) { Stop-Run "the dump at $dump is empty - refusing to continue" }
Write-Good "wrote $dump ($((Get-Item $dump).Length) bytes) - the only record of 'empty'"

# --------------------------------------------------------------------------
# 4. Dry run
# --------------------------------------------------------------------------
Write-Step '5. dry run'
$dry = & supabase --workdir . db push --dry-run --db-url $env:PGURI --skip-vault 2>&1 | Out-String
$dryCode = $LASTEXITCODE
$drySafe = Redact $dry
Write-Host $drySafe

# Checked for a clearer diagnosis rather than for safety: an errored dry run
# names 0 migrations and is already caught by the "exactly 17" count below. This
# just stops the operator reading "expected 17, named 0" when the real problem is
# that the command failed.
if ($dryCode -ne 0) { Stop-Run "the dry run itself FAILED (exit $dryCode). Its output cannot be trusted." }

$found = [regex]::Matches($drySafe, '(?m)\b(2026\d{10}_\w+\.sql)\b') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Note ("migrations named in the dry run: " + $found.Count)

$stopPhrases = @(
    'Remote migration versions not found',
    'remote migration versions not found',
    'not found in local migrations directory',
    'has been applied but',
    'Already up to date',
    'already up to date',
    'must be run'
)
foreach ($p in $stopPhrases) {
    if ($drySafe -match [regex]::Escape($p)) { Stop-Run "dry run contains a stop-phrase: `"$p`". Read the output above." }
}

if ($found.Count -ne $ExpectedMigs) {
    Stop-Run "expected exactly $ExpectedMigs pending migrations, the dry run named $($found.Count). NOT applying."
}
Write-Good "exactly $ExpectedMigs migrations pending"

if ($WhatIf) {
    Write-Host ''
    Write-Host '  -WhatIf was passed. Stopping before the apply.' -ForegroundColor Yellow
    Write-Host ''
    exit 0
}

# --------------------------------------------------------------------------
# 5. Apply
# --------------------------------------------------------------------------
Write-Step '6. APPLY'
Write-Host '   This writes to the staging database.' -ForegroundColor Yellow
$confirm = Read-Host '   Type APPLY-STAGING to continue'
if ($confirm -cne 'APPLY-STAGING') { Stop-Run 'not confirmed - nothing was applied' }

$apply = & supabase --workdir . db push --db-url $env:PGURI --skip-vault 2>&1 | Out-String
$applySafe = Redact $apply
Write-Host $applySafe

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Bad 'THE APPLY FAILED.'
    Write-Note 'Staging may now be partially migrated. This script performs NO recovery.'
    Write-Note 'Inspect the state below, then decide separately. Do NOT re-run blindly.'
    Write-Step 'resulting staging state'
    & $bun 'scripts/verify-staging-connection.mjs' 2>&1 | Out-String | ForEach-Object { Write-Host (Redact $_) }
    Write-Step 'migration history as the server sees it'
    $hist = & supabase --workdir . db push --dry-run --db-url $env:PGURI --skip-vault 2>&1 | Out-String
    Write-Host (Redact $hist)
    exit 1
}

# --------------------------------------------------------------------------
# 6. Verify
# --------------------------------------------------------------------------
Write-Step '7. post-apply verification'
$verify = & $bun 'scripts/verify-staging-connection.mjs' 2>&1 | Out-String
$verifyCode = $LASTEXITCODE
Write-Host (Redact $verify)

# Exit-code taxonomy, from scripts/verify-staging-connection.mjs:
#   0  identity verified, database fresh/empty   <- WRONG after an apply
#   1  identity verified, database populated      <- the ONLY acceptable result
#   2  unable to determine the target
#   3  target refused (production, mismatch, prohibited pooler)
#   4  connection or verification failure
#
# Accepting "anything but 0" would treat a drifted-to-production URI, a wrong
# password and a dead network as a successful migration. Only 1 is success.
Write-Note "connection verifier exited $verifyCode"
if ($verifyCode -ne 1) {
    Write-Bad "post-apply verification FAILED (exit $verifyCode, expected 1)."
    switch ($verifyCode) {
        0       { Write-Note '  exit 0 - the database still reports as EMPTY. The migrations did not land.' }
        2       { Write-Note '  exit 2 - the target could not be determined.' }
        3       { Write-Note '  exit 3 - THE TARGET WAS REFUSED. Do not continue; check $env:PGURI.' }
        4       { Write-Note '  exit 4 - the connection or verification failed. Nothing was confirmed.' }
        default { Write-Note "  exit $verifyCode - unrecognised exit code. Treat as failure." }
    }
    Write-Note '  No success is being reported.'
    exit 1
}
Write-Good 'exit 1 - identity verified AND the database is populated, as expected'

# The second push must now be a no-op. If it still wants to apply something, the
# apply did not complete, whatever the verifier said.
$again = & supabase --workdir . db push --dry-run --db-url $env:PGURI --skip-vault 2>&1 | Out-String
$againCode = $LASTEXITCODE
Write-Host (Redact $again)

# The command's own exit code is checked FIRST, and it matters.
#
# Counting migration names alone is not enough here. A dry run that FAILS - a
# dropped connection, an expired password, a pooler hiccup - prints no migration
# names at all, which is byte-for-byte what "nothing pending" looks like. The
# original check was `-ne 0 -> FAIL`, so a failed second dry run sailed through
# and the script printed "Identity and history checks passed." on a run that had
# verified nothing.
#
# The pre-apply gate does not have this problem: it requires EXACTLY 17 names, so
# an errored dry run yields 0 and stops. This one requires zero, so the failure
# mode is inverted and the exit code has to be checked explicitly.
if ($againCode -ne 0) {
    Write-Bad "the second dry run FAILED (exit $againCode). Its output cannot be trusted."
    Write-Note '  A failed command lists no migrations, which is indistinguishable'
    Write-Note '  from "nothing pending" if only the names are counted.'
    Write-Note '  No success is being reported.'
    exit 1
}

$againNames = @([regex]::Matches((Redact $again), '(?m)\b(2026\d{10}_\w+\.sql)\b') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
if ($againNames.Count -ne 0) {
    Write-Bad "a second dry run still lists $($againNames.Count) migration(s): $($againNames -join ', ')"
    Write-Note '  The apply did not complete. Reporting failure.'
    exit 1
}
Write-Good 'a second dry run lists nothing - the chain is fully applied'

Write-Step 'expected post-apply state - run these in the staging SQL editor'
Write-Host '   select count(*) from supabase_migrations.schema_migrations;                      -- expect 17'
Write-Host "   select count(*) from information_schema.tables where table_schema='public'`n     and table_type='BASE TABLE';                                              -- expect 19"
Write-Host "   select count(*) from information_schema.views where table_schema='public';                                    -- expect  8"
Write-Host "   select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace`n    where n.nspname='public' and p.proname like 'pf\_%';                           -- expect 47"
Write-Host '   select status, count(*) from branches group by status;                          -- expect NO ROWS'

Write-Host ''
Write-Host '  Identity and history checks passed.' -ForegroundColor Green
Write-Host '  The five counts above are NOT machine-checked - confirm them in the SQL'
Write-Host '  editor before treating this as a validated staging environment.'
Write-Host ''
exit 0