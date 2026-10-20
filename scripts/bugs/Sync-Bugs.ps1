<#
.SYNOPSIS
  Pulls the bugs and issues from Azure DevOps into the workspace's spec folder, for the bug manager (/sdd-bugs).

.DESCRIPTION
  Reads .claude/sdd.json: ado.org, ado.projects, specRoot, and "bugs" (see scripts/bugs/defaults.json).
  Writes <specRoot>/<bugs.folder>/ (default docs/spec/.bugs/):
    index.json        every bug and issue the query finds: the fields the list needs, the commits and PRs
    items/<id>.json   the long text of each (description, repro steps, ...), as plain text
  A full sync replaces the list: an item the query no longer finds (closed, moved) leaves it.
  With -Id it refreshes those items only and keeps the rest.

.PARAMETER Root
  The workspace (the folder holding .claude/sdd.json). Default: found from the current folder up.

.PARAMETER Id
  Refresh these work items only (comma-separated).

.EXAMPLE
  pwsh -NoProfile -File Sync-Bugs.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File Sync-Bugs.ps1 -Id 1234,1240
#>
param(
    [string]$Root = '',
    [string]$Id = ''
)

. (Join-Path $PSScriptRoot 'BugsCommon.ps1')

$ctx = Get-SddContext $Root
$started = Get-Date
$old = Read-BugIndex $ctx
$index = [ordered]@{ version = 1; syncedAt = ''; org = $ctx.org; projects = @($ctx.projects); me = $null; count = 0; items = @(); repos = @{}; prs = @{} }
if ($old) {
    foreach ($k in @('repos', 'prs')) { if ($old[$k]) { $index[$k] = $old[$k] } }
}

try {
    if ($Id) {
        $ids = @($Id -split '[,; ]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
        if ($ids.Count -eq 0) { Exit-WithError "no work item id in -Id '$Id'" }
        if (-not $old) { Exit-WithError 'nothing synced yet: run Sync-Bugs.ps1 without -Id first' }
        foreach ($k in $old.Keys) { if ($k -ne 'repos' -and $k -ne 'prs') { $index[$k] = $old[$k] } }
        $items = Get-AdoItems $ctx $ids
        $index = Update-IndexItems $ctx $index $items
        $index['me'] = Get-Me $ctx
        Save-BugIndex $ctx $index
        Out-Result ([ordered]@{ ok = $true; refreshed = @($items | ForEach-Object { [int]$_.id }); missing = @($ids | Where-Object { $i = $_; -not ($items | Where-Object { [int]$_.id -eq $i }) }); count = $index['count']; file = (Get-IndexPath $ctx) })
        exit 0
    }

    if (@($ctx.projects).Count -eq 0) { Exit-WithError 'no ADO project: set ado.projects (or bugs.query.projects) in .claude/sdd.json' }
    $types = @($ctx.bugs['types'])
    $excluded = @($ctx.bugs['query']['excludeStates'])
    $top = [int]$ctx.bugs['query']['top']
    if ($top -le 0) { $top = 1000 }
    $wanted = New-Object System.Collections.ArrayList
    foreach ($p in @($ctx.projects)) {
        $found = Invoke-Wiql $ctx $p (Get-BugQuery $ctx $p) $top
        Write-Progress2 "${p}: $(@($found).Count) bugs and issues"
        foreach ($x in @($found)) { if (-not $wanted.Contains($x)) { [void]$wanted.Add($x) } }
    }
    $items = @()
    if ($wanted.Count -gt 0) { $items = Get-AdoItems $ctx $wanted.ToArray() }
    # the query decides in ADO; this holds the line too, so a query that cannot filter (an old server, a fake) still does
    $items = @($items | Where-Object {
        ($types -contains [string]$_.fields.'System.WorkItemType') -and -not ($excluded -contains [string]$_.fields.'System.State')
    })
    $index = Update-IndexItems $ctx $index $items
    $index['me'] = Get-Me $ctx
    $index['syncedAt'] = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    # what changed since the last sync, and the long text of items that left the list
    $before = @{}
    if ($old) { foreach ($r in @($old['items'])) { if ($r) { $before[[string]$r['id']] = [int]$r['rev'] } } }
    $now = @{}
    foreach ($r in @($index['items'])) { $now[[string]$r['id']] = [int]$r['rev'] }
    $added = @($now.Keys | Where-Object { -not $before.ContainsKey($_) }).Count
    $changed = @($now.Keys | Where-Object { $before.ContainsKey($_) -and $before[$_] -ne $now[$_] }).Count
    $removed = @($before.Keys | Where-Object { -not $now.ContainsKey($_) })
    foreach ($gone in $removed) {
        foreach ($suffix in @('', '.evidence', '.analysis')) {
            $f = Join-Path (Join-Path $ctx.bugsDir 'items') "$gone$suffix.json"
            if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
        }
    }
    Save-BugIndex $ctx $index
    $secs = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Progress2 "synced $($index['count']) items in ${secs}s: $added new, $changed changed, $($removed.Count) gone"
    Out-Result ([ordered]@{ ok = $true; count = $index['count']; added = $added; changed = $changed; removed = $removed.Count; seconds = $secs; file = (Get-IndexPath $ctx) })
} catch {
    Write-Progress2 $_.ScriptStackTrace
    Exit-WithError "sync failed: $(Get-HttpDetail $_)"
}
