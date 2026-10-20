<#
.SYNOPSIS
  Saves the bug manager's staged changes (/sdd-bugs) to Azure DevOps.

.DESCRIPTION
  Reads <specRoot>/<bugs.folder>/pending.json, the changes the person staged in the view:
    { "version": 1, "changes": [ { "key", "id", "kind", "field", "value", "was", "label" } ] }
  kind "field"      sets a field (System.State, System.AssignedTo, System.AreaPath, System.IterationPath,
                    Microsoft.VSTS.Common.Severity, Microsoft.VSTS.Common.Priority, ...) to "value";
                    "was" is what the field held when it was staged. An empty value clears the field.
  kind "tagAdd"     adds the tag "value"; "tagRemove" removes it.
  kind "comment"    posts "value" as a comment.

  Every item is read again first. A field someone else changed in ADO since it was staged (it is neither
  "was" nor "value" now) is a conflict: it is not written, and stays pending with the value ADO holds now.
  The rest is written in one patch per item that starts with a `test /rev` op, so nothing is overwritten
  that changed between the read and the write; on HTTP 412 the item is read again and decided again (3 tries).
  Tags are merged into the tags the item has now. A comment may not name `#<id>` (ADO posts a mention):
  write `ADO <id>`.

  What was saved leaves pending.json; a conflict or an error stays, with a "problem" the view shows.
  The saved items are read back into index.json. Prints a JSON summary.

.PARAMETER Id
  Save only the changes of these work items (comma-separated). Default: all.

.EXAMPLE
  pwsh -NoProfile -File Save-BugChanges.ps1
#>
param(
    [string]$Root = '',
    [string]$Id = ''
)

. (Join-Path $PSScriptRoot 'BugsCommon.ps1')

$Mention = '(?<![\w#&/])#\d{3,}\b'

function Get-Norm([string]$Field, $Value) {
    if ($null -eq $Value) { return '' }
    if ($Field -eq 'System.AssignedTo') {
        $p = Get-Person $Value
        if ($p.email) { return $p.email }
        return ([string]$p.name).ToLower()
    }
    return ([string]$Value).Trim()
}

function Get-TagList($Fields) {
    $raw = [string](Get-Field $Fields 'System.Tags')
    if (-not $raw) { return ,@() }
    return ,@($raw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-Plan($W, $Changes) {
    # what to write for one item, decided from what ADO holds now: the ops, and each change's fate
    $f = $W.fields
    $ops = New-Object System.Collections.ArrayList
    $fate = @{}
    foreach ($c in @($Changes | Where-Object { $_['kind'] -eq 'field' })) {
        $field = [string]$c['field']
        $now = Get-Norm $field (Get-Field $f $field)
        $want = Get-Norm $field $c['value']
        $was = Get-Norm $field $c['was']
        if ($now -eq $want) {
            $fate[$c['key']] = @{ status = 'already' }
        } elseif ($now -ne $was) {
            $shown = [string](Get-Field $f $field)
            if ($field -eq 'System.AssignedTo') { $p = Get-Person (Get-Field $f $field); if ($p) { $shown = $p.name } else { $shown = '' } }
            $fate[$c['key']] = @{ status = 'conflict'; current = $now; message = "changed in ADO since you staged it: it is now '$shown'" }
        } else {
            if ([string]$c['value'] -eq '') {
                [void]$ops.Add([ordered]@{ op = 'remove'; path = "/fields/$field" })
            } else {
                $v = $c['value']
                if ($field -eq 'Microsoft.VSTS.Common.Priority') { $v = [int]$v }
                [void]$ops.Add([ordered]@{ op = 'add'; path = "/fields/$field"; value = $v })
            }
            $fate[$c['key']] = @{ status = 'saved' }
        }
    }
    $tagChanges = @($Changes | Where-Object { $_['kind'] -eq 'tagAdd' -or $_['kind'] -eq 'tagRemove' })
    if ($tagChanges.Count -gt 0) {
        $tags = New-Object System.Collections.ArrayList
        foreach ($t in (Get-TagList $f)) { [void]$tags.Add($t) }
        $before = ($tags | ForEach-Object { $_.ToLower() }) -join ';'
        foreach ($c in $tagChanges) {
            $t = ([string]$c['value']).Trim()
            $hit = @($tags | Where-Object { $_.ToLower() -eq $t.ToLower() })
            if ($c['kind'] -eq 'tagAdd' -and $hit.Count -eq 0) { [void]$tags.Add($t) }
            if ($c['kind'] -eq 'tagRemove') { foreach ($h in $hit) { $tags.Remove($h) } }
            $fate[$c['key']] = @{ status = 'saved' }
        }
        if ((($tags | ForEach-Object { $_.ToLower() }) -join ';') -ne $before) {
            [void]$ops.Add([ordered]@{ op = 'add'; path = '/fields/System.Tags'; value = ($tags -join '; ') })
        } else {
            foreach ($c in $tagChanges) { $fate[$c['key']] = @{ status = 'already' } }
        }
    }
    return @{ ops = $ops; fate = $fate }
}

function ConvertTo-CommentHtml([string]$Text) {
    $h = [System.Net.WebUtility]::HtmlEncode($Text.Trim())
    return '<div>' + ($h -replace "`r?`n", '<br>') + '</div>'
}

$ctx = Get-SddContext $Root
$pendingPath = Get-PendingPath $ctx
$pending = ConvertTo-Hashtable (Read-JsonFile $pendingPath)
$all = @()
if ($pending -and $pending['changes']) { $all = @($pending['changes']) }
$only = @()
if ($Id) { $only = @($Id -split '[,; ]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
$todo = @($all | Where-Object { $_ -and ($only.Count -eq 0 -or $only -contains [int]$_['id']) })
if ($todo.Count -eq 0) {
    Out-Result ([ordered]@{ ok = $true; saved = 0; conflicts = 0; errors = 0; results = @(); message = 'nothing to save' })
    exit 0
}

$results = @{}
$touched = New-Object System.Collections.ArrayList
try {
    $ids = @($todo | ForEach-Object { [int]$_['id'] } | Sort-Object -Unique)
    $current = @{}
    foreach ($w in (Get-AdoItems $ctx $ids)) { $current[[int]$w.id] = $w }
    foreach ($wid in $ids) {
        $changes = @($todo | Where-Object { [int]$_['id'] -eq $wid })
        if (-not $current.ContainsKey($wid)) {
            foreach ($c in $changes) { $results[$c['key']] = @{ status = 'error'; message = 'not found in ADO (deleted, or no access)' } }
            continue
        }
        $w = $current[$wid]
        $project = [string]$w.fields.'System.TeamProject'
        $url = "$($ctx.base)/$([uri]::EscapeDataString($project))/_apis/wit/workitems/$($wid)?api-version=7.1"
        $edits = @($changes | Where-Object { $_['kind'] -ne 'comment' })
        if ($edits.Count -gt 0) {
            $done = $false
            for ($try = 1; $try -le 3 -and -not $done; $try++) {
                $plan = Get-Plan $w $edits
                if ($plan.ops.Count -eq 0) {
                    foreach ($k in $plan.fate.Keys) { $results[$k] = $plan.fate[$k] }
                    $done = $true
                    break
                }
                $body = New-Object System.Collections.ArrayList
                [void]$body.Add([ordered]@{ op = 'test'; path = '/rev'; value = [int]$w.rev })
                foreach ($o in $plan.ops) { [void]$body.Add($o) }
                try {
                    [void](Invoke-Ado PATCH $url $body.ToArray() 'application/json-patch+json')
                    foreach ($k in $plan.fate.Keys) { $results[$k] = $plan.fate[$k] }
                    [void]$touched.Add($wid)
                    $done = $true
                } catch {
                    $status = Get-HttpStatus $_
                    $detail = Get-HttpDetail $_
                    if (($status -eq 412 -or $detail -match 'HTTP 412') -and $try -lt 3) {
                        Write-Progress2 "$($wid): changed while saving, reading it again"
                        $w = (Get-AdoItems $ctx @($wid))[0]
                        continue
                    }
                    # the patch failed whole: what it would have written is not saved; a conflict stays a conflict
                    foreach ($k in $plan.fate.Keys) {
                        if ($plan.fate[$k].status -eq 'saved') { $results[$k] = @{ status = 'error'; message = $detail } }
                        else { $results[$k] = $plan.fate[$k] }
                    }
                    $done = $true
                }
            }
        }
        foreach ($c in @($changes | Where-Object { $_['kind'] -eq 'comment' })) {
            $text = [string]$c['value']
            $m = [regex]::Match($text, $Mention)
            if ($m.Success) {
                $results[$c['key']] = @{ status = 'error'; message = "names $($m.Value): ADO posts that as a mention on that item. Write 'ADO $($m.Value.Substring(1))' instead." }
                continue
            }
            if (-not $text.Trim()) { $results[$c['key']] = @{ status = 'already' }; continue }
            try {
                $curl = "$($ctx.base)/$([uri]::EscapeDataString($project))/_apis/wit/workItems/$wid/comments?api-version=7.1-preview.4"
                [void](Invoke-Ado POST $curl ([ordered]@{ text = (ConvertTo-CommentHtml $text) }))
                $results[$c['key']] = @{ status = 'saved' }
                [void]$touched.Add($wid)
            } catch {
                $results[$c['key']] = @{ status = 'error'; message = (Get-HttpDetail $_) }
            }
        }
    }

    # pending.json again: the view may have staged more while this ran; only what was decided here changes
    $now = ConvertTo-Hashtable (Read-JsonFile $pendingPath)
    $left = New-Object System.Collections.ArrayList
    if ($now -and $now['changes']) {
        foreach ($c in @($now['changes'])) {
            if (-not $c) { continue }
            $r = $results[$c['key']]
            if ($r -and ($r.status -eq 'saved' -or $r.status -eq 'already')) { continue }
            if ($r) {
                $problem = [ordered]@{ kind = $r.status; text = $r.message }
                if ($r.ContainsKey('current')) { $problem['current'] = $r.current }
                $c['problem'] = $problem
            }
            [void]$left.Add($c)
        }
    }
    Write-Utf8File $pendingPath (ConvertTo-JsonText ([ordered]@{ version = 1; changes = @($left.ToArray()) }))

    $refreshed = @($touched | Sort-Object -Unique)
    if ($refreshed.Count -gt 0) {
        $index = Read-BugIndex $ctx
        if ($index) {
            $index = Update-IndexItems $ctx $index (Get-AdoItems $ctx $refreshed)
            Save-BugIndex $ctx $index
        }
    }
    $list = @($todo | ForEach-Object {
        $r = $results[$_['key']]
        if (-not $r) { $r = @{ status = 'error'; message = 'not decided' } }
        [ordered]@{ key = $_['key']; id = [int]$_['id']; label = $_['label']; status = $r.status; message = $r.message }
    })
    $count = { param($s) @($list | Where-Object { $_.status -eq $s }).Count }
    Out-Result ([ordered]@{
        ok = $true; saved = ((& $count 'saved') + (& $count 'already')); conflicts = (& $count 'conflict'); errors = (& $count 'error')
        refreshed = $refreshed; results = $list
    })
} catch {
    Write-Progress2 $_.ScriptStackTrace
    Exit-WithError "save failed: $(Get-HttpDetail $_)"
}
