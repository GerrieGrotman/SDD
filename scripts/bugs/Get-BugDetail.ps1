<#
.SYNOPSIS
  Reads one bug or issue again from Azure DevOps, with its latest comments, for the bug manager (/sdd-bugs).

.DESCRIPTION
  Refreshes the item in <specRoot>/<bugs.folder>/index.json and items/<id>.json (its text and comments),
  and prints the item, its text and the comments as one JSON object.

.PARAMETER Id
  The work item.

.PARAMETER Comments
  How many of the newest comments to keep. Default 10.

.EXAMPLE
  pwsh -NoProfile -File Get-BugDetail.ps1 -Id 1234
#>
param(
    [string]$Root = '',
    [Parameter(Mandatory = $true)][int]$Id,
    [int]$Comments = 10
)

. (Join-Path $PSScriptRoot 'BugsCommon.ps1')

$ctx = Get-SddContext $Root
try {
    $items = Get-AdoItems $ctx @($Id)
    if (@($items).Count -eq 0) { Exit-WithError "work item $Id not found (deleted, or no access)" }
    $w = $items[0]
    $project = [string]$w.fields.'System.TeamProject'
    $list = New-Object System.Collections.ArrayList
    try {
        $r = Invoke-Ado GET "$($ctx.base)/$([uri]::EscapeDataString($project))/_apis/wit/workItems/$Id/comments?`$top=$Comments&order=desc&api-version=7.1-preview.4"
        foreach ($c in @($r.comments)) {
            if (-not $c) { continue }
            $by = ''
            if ($c.createdBy) { $by = [string]$c.createdBy.displayName }
            [void]$list.Add([ordered]@{ by = $by; at = [string]$c.createdDate; text = (ConvertFrom-AdoHtml ([string]$c.text) 1500) })
        }
    } catch {
        Write-Progress2 "warning: comments not read: $(Get-HttpDetail $_)"
    }
    $index = Read-BugIndex $ctx
    if (-not $index) { $index = [ordered]@{ version = 1; syncedAt = ''; org = $ctx.org; projects = @($ctx.projects); me = (Get-Me $ctx); count = 0; items = @(); repos = @{}; prs = @{} } }
    $index = Update-IndexItems $ctx $index @($w)
    Save-BugIndex $ctx $index
    Save-BugText $ctx $w @($list.ToArray())
    $doc = ConvertTo-Hashtable (Read-JsonFile (Get-ItemPath $ctx $Id))
    $rec = @($index['items'] | Where-Object { [int]$_['id'] -eq $Id })[0]
    Out-Result ([ordered]@{ ok = $true; id = $Id; item = $rec; text = $doc['text']; comments = @($list.ToArray()) })
} catch {
    Write-Progress2 $_.ScriptStackTrace
    Exit-WithError "could not read $($Id): $(Get-HttpDetail $_)"
}
