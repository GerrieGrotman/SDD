# Shared by the bug manager's scripts (/sdd-bugs): the workspace, its settings, ADO REST, and the bug index.
# Dot-source it:  . (Join-Path $PSScriptRoot 'BugsCommon.ps1')
#
# Runs on Windows PowerShell 5.1 and PowerShell 7: no ?? or ?: operators, no -AsHashtable.
# Every script prints one JSON object on standard output (what the view reads) and its progress on standard error.
#
# Environment:
#   SDD_ADO_TOKEN        a bearer token to use instead of `az account get-access-token`
#   AZURE_DEVOPS_EXT_PAT a personal access token (basic auth), when no SDD_ADO_TOKEN
#   SDD_ADO_URL          the organization's REST base instead of https://dev.azure.com/<org> (tests point it at a fake ADO)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    # Windows PowerShell 5.1 writes an array a function returned as {"value": [...], "Count": n}; without this type data it writes [...]
    Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue
}
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$script:AdoResource = '499b84ac-1321-427f-aa17-267ca6975798'
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
$script:Token = $null

function Write-Progress2([string]$Text) {
    [Console]::Error.WriteLine($Text)
}

function ConvertTo-JsonText($Value) {
    return (ConvertTo-Json -InputObject $Value -Depth 30 -Compress)
}

function Out-Result($Value) {
    [Console]::Out.WriteLine((ConvertTo-JsonText $Value))
}

function Exit-WithError([string]$Message, [int]$Code = 1) {
    Out-Result ([ordered]@{ ok = $false; error = $Message })
    exit $Code
}

function Write-Utf8File([string]$Path, [string]$Text) {
    # no BOM (the view parses the file as JSON), written beside and moved over, so a reader never sees half a file
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, $Text, $script:Utf8)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [IO.File]::ReadAllText($Path)
    if (-not $text.Trim()) { return $null }
    return ($text | ConvertFrom-Json)
}

function ConvertTo-Hashtable($Value) {
    # a parsed JSON value as hashtables and arrays, so settings can be merged key by key
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $h = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }
        return $h
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $h = [ordered]@{}
        foreach ($k in $Value.Keys) { $h[$k] = ConvertTo-Hashtable $Value[$k] }
        return $h
    }
    if (($Value -is [System.Collections.IEnumerable]) -and -not ($Value -is [string])) {
        $list = New-Object System.Collections.ArrayList
        foreach ($x in $Value) { [void]$list.Add((ConvertTo-Hashtable $x)) }
        return ,$list.ToArray()
    }
    return $Value
}

function Find-SddRoot([string]$Start) {
    $d = (Resolve-Path -LiteralPath $Start).Path
    while ($d) {
        if (Test-Path -LiteralPath (Join-Path (Join-Path $d '.claude') 'sdd.json')) { return $d }
        $up = Split-Path -Parent $d
        if (-not $up -or $up -eq $d) { break }
        $d = $up
    }
    return $null
}

function Merge-BugsConfig($Given) {
    # sdd.json "bugs" over defaults.json: an object one level down is merged key by key, a list replaces
    # the default whole (sddlib.merge_bugs and the view's bugsConfig do the same)
    $base = ConvertTo-Hashtable (Read-JsonFile (Join-Path $PSScriptRoot 'defaults.json'))
    $out = [ordered]@{}
    foreach ($k in $base.Keys) { $out[$k] = $base[$k] }
    if ($Given -is [System.Collections.IDictionary]) {
        foreach ($k in $Given.Keys) {
            if (($base[$k] -is [System.Collections.IDictionary]) -and ($Given[$k] -is [System.Collections.IDictionary])) {
                $m = [ordered]@{}
                foreach ($j in $base[$k].Keys) { $m[$j] = $base[$k][$j] }
                foreach ($j in $Given[$k].Keys) { $m[$j] = $Given[$k][$j] }
                $out[$k] = $m
            } else {
                $out[$k] = $Given[$k]
            }
        }
    }
    return $out
}

function Get-SddContext([string]$Root) {
    if (-not $Root) { $Root = Find-SddRoot (Get-Location).Path }
    if (-not $Root -or -not (Test-Path -LiteralPath (Join-Path (Join-Path $Root '.claude') 'sdd.json'))) {
        Exit-WithError "no .claude/sdd.json found at or above $((Get-Location).Path). Run /sdd init in the workspace first."
    }
    $Root = (Resolve-Path -LiteralPath $Root).Path
    $cfg = ConvertTo-Hashtable (Read-JsonFile (Join-Path (Join-Path $Root '.claude') 'sdd.json'))
    $bugs = Merge-BugsConfig $cfg['bugs']
    $specRoot = 'docs/spec'
    if ($cfg['specRoot']) { $specRoot = [string]$cfg['specRoot'] }
    $specDir = Join-Path $Root $specRoot
    $org = ''
    $projects = @()
    if ($cfg['ado']) {
        $org = [string]$cfg['ado']['org']
        if ($cfg['ado']['projects']) { $projects = @($cfg['ado']['projects']) }
    }
    if (@($bugs['query']['projects']).Count -gt 0) { $projects = @($bugs['query']['projects']) }
    $base = $env:SDD_ADO_URL
    if (-not $base) {
        if (-not $org) { Exit-WithError 'ado.org is empty in .claude/sdd.json' }
        $base = 'https://dev.azure.com/' + [uri]::EscapeDataString($org)
    }
    return [ordered]@{
        root = $Root; cfg = $cfg; bugs = $bugs; specDir = $specDir
        bugsDir = (Join-Path $specDir ([string]$bugs['folder']))
        org = $org; base = $base.TrimEnd('/'); projects = $projects
    }
}

# ---------------------------------------------------------------- ADO REST

function Get-AdoHeaders {
    if ($env:SDD_ADO_TOKEN) { return @{ Authorization = "Bearer $($env:SDD_ADO_TOKEN)" } }
    if ($env:AZURE_DEVOPS_EXT_PAT) {
        $b = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$($env:AZURE_DEVOPS_EXT_PAT)"))
        return @{ Authorization = "Basic $b" }
    }
    if (-not $script:Token) {
        $az = Get-Command az -ErrorAction SilentlyContinue
        if (-not $az) { Exit-WithError 'Azure CLI (az) not found. Install it and run: az login' }
        $t = & az account get-access-token --resource $script:AdoResource --query accessToken -o tsv 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $t) { Exit-WithError 'could not get an ADO token from az. Run: az login' }
        $script:Token = ([string]$t).Trim()
    }
    return @{ Authorization = "Bearer $($script:Token)" }
}

function Get-HttpStatus($ErrorRecord) {
    $r = $ErrorRecord.Exception.Response
    if ($r -and $r.StatusCode) { return [int]$r.StatusCode }
    return 0
}

function Get-HttpDetail($ErrorRecord) {
    $d = ''
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $d = $ErrorRecord.ErrorDetails.Message }
    if (-not $d) { $d = $ErrorRecord.Exception.Message }
    try {
        $j = $d | ConvertFrom-Json
        if ($j.message) { $d = $j.message }
    } catch { }
    if ($d.Length -gt 400) { $d = $d.Substring(0, 400) }
    return $d
}

function Invoke-Ado([string]$Method, [string]$Url, $Body = $null, [string]$ContentType = 'application/json') {
    $p = @{ Method = $Method; Uri = $Url; Headers = (Get-AdoHeaders); ContentType = $ContentType; UseBasicParsing = $true }
    if ($null -ne $Body) { $p['Body'] = $script:Utf8.GetBytes((ConvertTo-JsonText $Body)) }
    return Invoke-RestMethod @p
}

function Get-AdoItems($Ctx, $Ids) {
    # the items with their relations, 100 ids a call; a deleted id is left out
    $ids = @($Ids | ForEach-Object { [int]$_ } | Sort-Object -Unique)
    $out = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $ids.Count; $i += 100) {
        $chunk = $ids[$i..([Math]::Min($i + 99, $ids.Count - 1))]
        $r = Invoke-Ado POST "$($Ctx.base)/_apis/wit/workitemsbatch?api-version=7.1" ([ordered]@{ ids = @($chunk); errorPolicy = 'omit'; '$expand' = 'relations' })
        foreach ($w in @($r.value)) { if ($w) { [void]$out.Add($w) } }
    }
    return ,$out.ToArray()
}

function Format-WiqlText([string]$Text) {
    return "'" + $Text.Replace("'", "''") + "'"
}

function Get-BugQuery($Ctx, [string]$Project) {
    $b = $Ctx.bugs
    $q = $b['query']
    $types = (@($b['types']) | ForEach-Object { Format-WiqlText $_ }) -join ', '
    $w = "[System.TeamProject] = $(Format-WiqlText $Project) AND [System.WorkItemType] IN ($types)"
    $ex = @($q['excludeStates'])
    if ($ex.Count -gt 0) { $w += " AND [System.State] NOT IN ($((($ex | ForEach-Object { Format-WiqlText $_ }) -join ', ')))" }
    $areas = @($q['areaPaths'])
    if ($areas.Count -gt 0) { $w += ' AND (' + (($areas | ForEach-Object { "[System.AreaPath] UNDER $(Format-WiqlText $_)" }) -join ' OR ') + ')' }
    $its = @($q['iterationPaths'])
    if ($its.Count -gt 0) { $w += ' AND (' + (($its | ForEach-Object { "[System.IterationPath] UNDER $(Format-WiqlText $_)" }) -join ' OR ') + ')' }
    if ($q['where']) { $w += " AND ($($q['where']))" }
    return "SELECT [System.Id] FROM WorkItems WHERE $w ORDER BY [System.ChangedDate] DESC"
}

function Invoke-Wiql($Ctx, [string]$Project, [string]$Query, [int]$Top) {
    $url = "$($Ctx.base)/$([uri]::EscapeDataString($Project))/_apis/wit/wiql?`$top=$Top&api-version=7.1"
    $r = Invoke-Ado POST $url ([ordered]@{ query = $Query })
    return ,@($r.workItems | ForEach-Object { [int]$_.id })
}

# ---------------------------------------------------------------- reading an item

function ConvertFrom-AdoHtml([string]$Html, [int]$Limit = 6000) {
    if (-not $Html) { return '' }
    $t = $Html -replace '(?i)<br\s*/?>', "`n" -replace '(?i)</(p|div|li|tr|h\d|pre)>', "`n" -replace '(?i)<li[^>]*>', '- '
    $t = $t -replace '<[^>]+>', ''
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    $t = ($t -split "`r?`n" | ForEach-Object { $_.TrimEnd() }) -join "`n"
    $t = ($t -replace "`n{3,}", "`n`n").Trim()
    if ($t.Length -gt $Limit) { $t = $t.Substring(0, $Limit) + ' ...' }
    return $t
}

function Get-Person($Value) {
    if (-not $Value) { return $null }
    if ($Value -is [string]) {
        $m = [regex]::Match($Value, '^(.*?)\s*<([^>]+)>$')
        if ($m.Success) { return [ordered]@{ name = $m.Groups[1].Value; email = $m.Groups[2].Value.ToLower() } }
        $mail = ''
        if ($Value -match '@') { $mail = $Value.ToLower() }
        return [ordered]@{ name = $Value; email = $mail }
    }
    $name = [string]$Value.displayName
    $mail = ([string]$Value.uniqueName).ToLower()
    if (-not $name) { $name = $mail }
    return [ordered]@{ name = $name; email = $mail }
}

function Get-Field($Fields, [string]$Name) {
    $p = $Fields.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Get-FirstField($Fields, [string[]]$Names) {
    foreach ($n in $Names) {
        $v = Get-Field $Fields $n
        if ($null -ne $v -and "$v" -ne '') { return $v }
    }
    return $null
}

function Get-ArtifactParts([string]$Url) {
    # vstfs:///Git/Commit/{project}%2F{repo}%2F{sha}, vstfs:///Git/PullRequestId/{project}%2F{repo}%2F{id}
    $m = [regex]::Match($Url, '^vstfs:///Git/(Commit|PullRequestId)/(.+)$', 'IgnoreCase')
    if (-not $m.Success) { return $null }
    $parts = [uri]::UnescapeDataString($m.Groups[2].Value) -split '/'
    if ($parts.Count -lt 3) { return $null }
    return [ordered]@{ kind = $m.Groups[1].Value; project = $parts[0]; repo = $parts[1]; key = $parts[2] }
}

function Get-RepoInfo($Ctx, $Cache, [string]$Project, [string]$Repo) {
    if ($Cache.ContainsKey($Repo)) { return $Cache[$Repo] }
    $info = [ordered]@{ name = $Repo; webUrl = "https://dev.azure.com/$([uri]::EscapeDataString($Ctx.org))/$Project/_git/$Repo" }
    try {
        $r = Invoke-Ado GET "$($Ctx.base)/$Project/_apis/git/repositories/$($Repo)?api-version=7.1"
        if ($r.name) { $info.name = [string]$r.name }
        if ($r.webUrl) { $info.webUrl = [string]$r.webUrl }
    } catch {
        Write-Progress2 "warning: repository $Repo not read: $(Get-HttpDetail $_)"
    }
    $Cache[$Repo] = $info
    return $info
}

function Get-PrInfo($Ctx, $Cache, [string]$Project, [string]$Id) {
    # a PR that is completed or abandoned stays as it was: only an active one (or one never read) is read again
    $old = $null
    if ($Cache.ContainsKey($Id)) { $old = $Cache[$Id] }
    if ($old -and $old.status -and $old.status -ne 'active' -and -not $old.isStale) { return $old }
    $info = [ordered]@{ title = ''; status = '' }
    if ($old) { $info = $old }
    try {
        $r = Invoke-Ado GET "$($Ctx.base)/$Project/_apis/git/pullrequests/$($Id)?api-version=7.1"
        $info = [ordered]@{ title = [string]$r.title; status = [string]$r.status }
    } catch {
        Write-Progress2 "warning: pull request $Id not read: $(Get-HttpDetail $_)"
    }
    $Cache[$Id] = $info
    return $info
}

function ConvertTo-BugRecord($Ctx, $W, $Repos, $Prs) {
    # one item of index.json: what the list, the categories and the filters need, and no long text
    $f = $W.fields
    $id = [int]$W.id
    $project = [string](Get-Field $f 'System.TeamProject')
    $tags = @()
    $rawTags = [string](Get-Field $f 'System.Tags')
    if ($rawTags) { $tags = @($rawTags -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $commits = New-Object System.Collections.ArrayList
    $prList = New-Object System.Collections.ArrayList
    $links = New-Object System.Collections.ArrayList
    $related = New-Object System.Collections.ArrayList
    $parent = $null
    foreach ($r in @($W.relations)) {
        if (-not $r) { continue }
        $rel = [string]$r.rel
        $url = [string]$r.url
        $name = ''
        if ($r.attributes -and $r.attributes.name) { $name = [string]$r.attributes.name }
        if ($rel -eq 'ArtifactLink') {
            $a = Get-ArtifactParts $url
            if (-not $a) { continue }
            $repo = Get-RepoInfo $Ctx $Repos $a.project $a.repo
            if ($a.kind -eq 'Commit') {
                [void]$commits.Add([ordered]@{ sha = $a.key; repo = $repo.name; url = "$($repo.webUrl)/commit/$($a.key)" })
            } else {
                $pr = Get-PrInfo $Ctx $Prs $a.project $a.key
                [void]$prList.Add([ordered]@{ id = [int]$a.key; repo = $repo.name; url = "$($repo.webUrl)/pullrequest/$($a.key)"; title = $pr.title; status = $pr.status })
            }
        } elseif ($rel -eq 'Hyperlink') {
            $label = $url
            if ($r.attributes -and $r.attributes.comment) { $label = [string]$r.attributes.comment }
            [void]$links.Add([ordered]@{ name = $label; url = $url })
        } else {
            $m = [regex]::Match($url, '/workItems/(\d+)$', 'IgnoreCase')
            if ($m.Success) {
                if ($rel -eq 'System.LinkTypes.Hierarchy-Reverse') { $parent = [int]$m.Groups[1].Value }
                if (-not $name) { $name = ($rel -split '\.')[-1] }
                [void]$related.Add([ordered]@{ name = $name; id = [int]$m.Groups[1].Value })
            }
        }
    }
    $extra = [ordered]@{}
    foreach ($x in @($Ctx.bugs['extraFields'])) { if ($x) { $extra[[string]$x] = Get-Field $f ([string]$x) } }
    $prio = Get-Field $f 'Microsoft.VSTS.Common.Priority'
    if ($null -ne $prio -and "$prio" -ne '') { $prio = [int]$prio } else { $prio = $null }
    $effort = Get-FirstField $f @('Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size')
    if ($null -ne $effort) { $effort = [double]$effort }
    $rev = $W.rev
    if ($null -eq $rev) { $rev = Get-Field $f 'System.Rev' }
    return [ordered]@{
        id = $id; rev = [int]$rev
        type = [string](Get-Field $f 'System.WorkItemType'); title = [string](Get-Field $f 'System.Title')
        state = [string](Get-Field $f 'System.State'); reason = [string](Get-Field $f 'System.Reason')
        project = $project
        area = [string](Get-Field $f 'System.AreaPath'); iteration = [string](Get-Field $f 'System.IterationPath')
        tags = @($tags)
        assigned = (Get-Person (Get-Field $f 'System.AssignedTo'))
        severity = [string](Get-Field $f 'Microsoft.VSTS.Common.Severity'); priority = $prio; effort = $effort
        boardColumn = [string](Get-FirstField $f @('Custom.BoardColumnTitle', 'System.BoardColumn'))
        created = [string](Get-Field $f 'System.CreatedDate'); changed = [string](Get-Field $f 'System.ChangedDate')
        createdBy = (Get-Person (Get-Field $f 'System.CreatedBy'))
        url = "https://dev.azure.com/$([uri]::EscapeDataString($Ctx.org))/$([uri]::EscapeDataString($project))/_workitems/edit/$id"
        parent = $parent
        related = @($related.ToArray()); commits = @($commits.ToArray()); prs = @($prList.ToArray()); links = @($links.ToArray())
        extra = $extra
    }
}

function ConvertTo-BugText($W) {
    # items/<id>.json: the long text of one item, as plain text, for the detail and the probable cause
    $f = $W.fields
    $out = [ordered]@{}
    $map = [ordered]@{
        description = 'System.Description'; repro = 'Microsoft.VSTS.TCM.ReproSteps'; systemInfo = 'Microsoft.VSTS.TCM.SystemInfo'
        acceptance = 'Microsoft.VSTS.Common.AcceptanceCriteria'; resolution = 'Microsoft.VSTS.Common.Resolution'
        rootCause = 'Custom.RootCauseDetails'; foundIn = 'Microsoft.VSTS.Build.FoundIn'; integratedIn = 'Microsoft.VSTS.Build.IntegrationBuild'
    }
    foreach ($k in $map.Keys) {
        $v = Get-Field $f $map[$k]
        if ($v) { $out[$k] = (ConvertFrom-AdoHtml ([string]$v)) }
    }
    return $out
}

# ---------------------------------------------------------------- the bug folder

function Get-IndexPath($Ctx) { return (Join-Path $Ctx.bugsDir 'index.json') }
function Get-PendingPath($Ctx) { return (Join-Path $Ctx.bugsDir 'pending.json') }
function Get-ItemPath($Ctx, [int]$Id) { return (Join-Path (Join-Path $Ctx.bugsDir 'items') "$Id.json") }

function Read-BugIndex($Ctx) {
    $i = Read-JsonFile (Get-IndexPath $Ctx)
    if (-not $i) { return $null }
    return (ConvertTo-Hashtable $i)
}

function Save-BugIndex($Ctx, $Index) {
    Write-Utf8File (Get-IndexPath $Ctx) (ConvertTo-JsonText $Index)
}

function Save-BugText($Ctx, $W, $Comments = $null) {
    $path = Get-ItemPath $Ctx ([int]$W.id)
    $old = ConvertTo-Hashtable (Read-JsonFile $path)
    $doc = [ordered]@{ id = [int]$W.id; rev = [int]$W.rev; syncedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); text = (ConvertTo-BugText $W) }
    if ($null -ne $Comments) { $doc['comments'] = @($Comments) }
    elseif ($old -and $old['comments']) { $doc['comments'] = @($old['comments']) }
    Write-Utf8File $path (ConvertTo-JsonText $doc)
}

function Get-Me($Ctx) {
    $me = [string]$Ctx.bugs['me']
    if (-not $me) {
        try { $me = ([string](& git config user.email 2>$null)).Trim() } catch { $me = '' }
    }
    if (-not $me -and -not $env:SDD_ADO_URL) {
        try { $me = ([string](& az account show --query user.name -o tsv 2>$null)).Trim() } catch { $me = '' }
    }
    $name = ''
    try { $name = ([string](& git config user.name 2>$null)).Trim() } catch { $name = '' }
    return [ordered]@{ email = $me.ToLower(); name = $name }
}

function Update-IndexItems($Ctx, $Index, $Items) {
    # refreshed items replace their old entries in place (and new ones are added): a save or a refresh of one item
    # plain hashtables: an ordered one reads a key like '77' as a position
    $repos = @{}
    $prs = @{}
    if ($Index['repos']) { foreach ($k in @($Index['repos'].Keys)) { $repos[[string]$k] = $Index['repos'][$k] } }
    if ($Index['prs']) { foreach ($k in @($Index['prs'].Keys)) { $prs[[string]$k] = $Index['prs'][$k] } }
    $byId = @{}
    $order = New-Object System.Collections.ArrayList
    foreach ($r in @($Index['items'])) {
        if (-not $r) { continue }
        $byId[[int]$r['id']] = $r
        [void]$order.Add([int]$r['id'])
    }
    foreach ($w in @($Items)) {
        $rec = ConvertTo-BugRecord $Ctx $w $repos $prs
        if (-not $byId.ContainsKey([int]$rec.id)) { [void]$order.Add([int]$rec.id) }
        $byId[[int]$rec.id] = $rec
        Save-BugText $Ctx $w
    }
    $Index['items'] = @($order | ForEach-Object { $byId[$_] })
    $Index['repos'] = $repos
    $Index['prs'] = $prs
    $Index['count'] = $order.Count
    return $Index
}
