<#
.SYNOPSIS
  Gathers the evidence for a bug's probable cause from the local repos, for the bug manager (/sdd-bugs).
  Costs no model tokens: it is text matching and git.

.DESCRIPTION
  From the item's synced text (title, repro steps, description, system info, comments) it takes the terms
  most likely to point at code: files named in stack traces (with their line), methods in stack frames,
  exception and error types, error codes, quoted messages and code-like names. It looks for them in the
  workspace's repos (.claude/sdd.json "repoDirs", else every folder one or two levels down holding .git) with
  `git ls-files` and `git grep`, reads the recent history of the files it finds, and the files changed by the
  commits linked to the item. The result is small on purpose: the view hands it to a model as is.

  Writes <specRoot>/<bugs.folder>/items/<id>.evidence.json and prints the same JSON.

.PARAMETER Id
  The work item. It must have been synced (Sync-Bugs.ps1).

.PARAMETER Max
  At most this many code hits. Default 10.

.EXAMPLE
  pwsh -NoProfile -File Find-BugEvidence.ps1 -Id 1234
#>
param(
    [string]$Root = '',
    [Parameter(Mandatory = $true)][int]$Id,
    [int]$Max = 10
)

. (Join-Path $PSScriptRoot 'BugsCommon.ps1')

$Stop = @('about', 'after', 'again', 'error', 'errors', 'exception', 'should', 'would', 'could', 'there', 'their', 'which',
    'while', 'where', 'when', 'what', 'with', 'without', 'from', 'this', 'that', 'these', 'those', 'have', 'been', 'being',
    'steps', 'expected', 'actual', 'result', 'results', 'reproduce', 'click', 'clicks', 'clicked', 'page', 'screen', 'button',
    'user', 'users', 'issue', 'still', 'shows', 'shown', 'value', 'values', 'other', 'into', 'then', 'than', 'also', 'only',
    'some', 'does', 'doesn', 'cannot', 'string', 'object', 'null', 'true', 'false', 'system', 'microsoft', 'windows')
$CodeExt = 'cs|ts|tsx|js|jsx|mjs|py|java|kt|go|rb|php|sql|cpp|cc|c|h|hpp|vb|fs|ps1|psm1|xaml|cshtml|razor|vue|svelte|json|xml|config|yaml|yml'

function Add-Term($List, [string]$Text, [string]$Kind, [int]$Line = 0) {
    $t = $Text.Trim().Trim('.', ',', ':', ';', '(', ')', '[', ']', '"', "'")
    if ($t.Length -lt 4 -or $t.Length -gt 80) { return }
    if ($Stop -contains $t.ToLower()) { return }
    foreach ($x in $List) { if ($x.text.ToLower() -eq $t.ToLower()) { return } }
    [void]$List.Add([ordered]@{ text = $t; kind = $Kind; line = $Line })
}

function Get-Terms([string]$Text, [string]$Title) {
    $files = New-Object System.Collections.ArrayList
    $symbols = New-Object System.Collections.ArrayList
    $words = New-Object System.Collections.ArrayList
    # a file in a stack trace or a path, and its line: Totals.cs:line 42, Totals.cs:42, totals.py", line 42, Totals.cs(42)
    $re = "(?<file>[\w\-.]+\.(?:$CodeExt))(?:(?::line\s*|:|\()(?<line>\d+)|""?,\s*line\s+(?<line2>\d+))?"
    foreach ($m in [regex]::Matches($Text, $re, 'IgnoreCase')) {
        $line = 0
        if ($m.Groups['line'].Success) { $line = [int]$m.Groups['line'].Value }
        elseif ($m.Groups['line2'].Success) { $line = [int]$m.Groups['line2'].Value }
        Add-Term $files $m.Groups['file'].Value 'file' $line
    }
    # a frame: at Billing.Totals.Round( -> Totals.Round and Round
    foreach ($m in [regex]::Matches($Text, '\bat\s+(?:[\w`<>]+\.)*(?<cls>\w+)\.(?<fn>\w+)\s*\(')) {
        Add-Term $symbols "$($m.Groups['cls'].Value).$($m.Groups['fn'].Value)" 'frame'
        Add-Term $symbols $m.Groups['fn'].Value 'method'
    }
    foreach ($m in [regex]::Matches($Text, '\b[A-Z]\w*(?:Exception|Error)\b')) { Add-Term $symbols $m.Value 'exception' }
    foreach ($m in [regex]::Matches($Text, '\b[A-Z]{2,6}-?\d{3,6}\b')) { Add-Term $symbols $m.Value 'code' }
    foreach ($m in [regex]::Matches($Text, '["\u201c]([^"\u201d\r\n]{8,70})["\u201d]')) { Add-Term $words $m.Groups[1].Value 'message' }
    foreach ($m in [regex]::Matches($Text, '\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b')) {
        Add-Term $words $m.Value 'name'
    }
    $titleWords = New-Object System.Collections.ArrayList
    foreach ($w in ($Title -split '[^\w]+')) { if ($w.Length -ge 5) { Add-Term $titleWords $w 'title' } }
    $all = New-Object System.Collections.ArrayList
    foreach ($group in @($files, $symbols, $words, $titleWords)) { foreach ($x in $group) { [void]$all.Add($x) } }
    return ,@($all | Select-Object -First 8)
}

function Get-Repos($Ctx) {
    $out = New-Object System.Collections.ArrayList
    $dirs = @($Ctx.cfg['repoDirs'])
    if ($dirs.Count -gt 0 -and $dirs[0]) {
        foreach ($d in $dirs) {
            $p = Join-Path $Ctx.root ([string]$d)
            if (Test-Path -LiteralPath (Join-Path $p '.git')) { [void]$out.Add((Resolve-Path -LiteralPath $p).Path) }
        }
        return ,$out.ToArray()
    }
    if (Test-Path -LiteralPath (Join-Path $Ctx.root '.git')) { [void]$out.Add($Ctx.root) }
    $skip = @('.claude', 'node_modules', '.git', 'bin', 'obj', 'dist', 'docs')
    foreach ($a in @(Get-ChildItem -LiteralPath $Ctx.root -Directory -Force -ErrorAction SilentlyContinue)) {
        if ($skip -contains $a.Name) { continue }
        if (Test-Path -LiteralPath (Join-Path $a.FullName '.git')) { [void]$out.Add($a.FullName); continue }
        foreach ($b in @(Get-ChildItem -LiteralPath $a.FullName -Directory -Force -ErrorAction SilentlyContinue)) {
            if ($skip -contains $b.Name) { continue }
            if (Test-Path -LiteralPath (Join-Path $b.FullName '.git')) { [void]$out.Add($b.FullName) }
        }
    }
    return ,$out.ToArray()
}

function Invoke-Git([string]$Repo, [string[]]$GitArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # one line per output item (no unary comma): callers pipe it, and take what they need
        $o = & git -C $Repo @GitArgs 2>$null
        if ($LASTEXITCODE -ne 0) { return }
        $o | ForEach-Object { [string]$_ }
    } finally {
        $ErrorActionPreference = $old
    }
}

function Get-GrepCap {
    # git grep stops at the first match in a file from git 2.38 (-m); before it, every match is read
    $v = [string](& git version 2>$null)
    $m = [regex]::Match($v, '(\d+)\.(\d+)')
    if ($m.Success -and ([int]$m.Groups[1].Value -gt 2 -or ([int]$m.Groups[1].Value -eq 2 -and [int]$m.Groups[2].Value -ge 38))) { return ,@('-m', '1') }
    return ,@()
}

function Limit-Text([string]$Text, [int]$Size = 140) {
    $t = ($Text -replace '\s+', ' ').Trim()
    if ($t.Length -gt $Size) { return $t.Substring(0, $Size) + '...' }
    return $t
}

$ctx = Get-SddContext $Root
$started = Get-Date
$index = Read-BugIndex $ctx
$rec = $null
if ($index) { $rec = @($index['items'] | Where-Object { [int]$_['id'] -eq $Id })[0] }
if (-not $rec) { Exit-WithError "$Id is not in the synced bugs: run Sync-Bugs.ps1 (or Get-BugDetail.ps1 -Id $Id) first" }
$doc = ConvertTo-Hashtable (Read-JsonFile (Get-ItemPath $ctx $Id))
$parts = New-Object System.Collections.ArrayList
[void]$parts.Add([string]$rec['title'])
if ($doc -and $doc['text']) { foreach ($k in @('repro', 'description', 'systemInfo', 'acceptance')) { if ($doc['text'][$k]) { [void]$parts.Add([string]$doc['text'][$k]) } } }
if ($doc -and $doc['comments']) { foreach ($c in @($doc['comments'] | Select-Object -First 3)) { [void]$parts.Add([string]$c['text']) } }
$text = $parts -join "`n"

$terms = Get-Terms $text ([string]$rec['title'])
$repos = Get-Repos $ctx
$cap = Get-GrepCap
$hits = New-Object System.Collections.ArrayList
foreach ($t in $terms) {
    if ($hits.Count -ge $Max) { break }
    foreach ($repo in $repos) {
        if ($hits.Count -ge $Max) { break }
        $name = Split-Path -Leaf $repo
        if ($t.kind -eq 'file') {
            foreach ($path in @(Invoke-Git $repo @('ls-files', '--', "*$($t.text)") | Select-Object -First 2)) {
                $hit = [ordered]@{ repo = $name; path = $path; line = $t.line; text = ''; term = $t.text }
                if ($t.line -gt 0) {
                    $lines = @(Get-Content -LiteralPath (Join-Path $repo $path) -TotalCount $t.line -ErrorAction SilentlyContinue)
                    if ($lines.Count -ge $t.line) { $hit.text = Limit-Text $lines[$t.line - 1] }
                }
                [void]$hits.Add($hit)
            }
            continue
        }
        foreach ($l in @(Invoke-Git $repo (@('grep', '-n', '-I', '-i', '-F') + $cap + @('-e', $t.text, '--', '.', ':!*.min.js', ':!*.lock', ':!package-lock.json')) | Select-Object -First 3)) {
            $m = [regex]::Match($l, '^(.*?):(\d+):(.*)$')
            if (-not $m.Success) { continue }
            # a line another term found already says nothing new
            if (@($hits | Where-Object { $_.repo -eq $name -and $_.path -eq $m.Groups[1].Value -and $_.line -eq [int]$m.Groups[2].Value }).Count) { continue }
            [void]$hits.Add([ordered]@{ repo = $name; path = $m.Groups[1].Value; line = [int]$m.Groups[2].Value; text = (Limit-Text $m.Groups[3].Value); term = $t.text })
            if ($hits.Count -ge $Max) { break }
        }
    }
}

# the recent history of the first files found: who changed them last, and why
$history = New-Object System.Collections.ArrayList
$seen = @{}
foreach ($h in $hits) {
    $k = "$($h.repo)/$($h.path)"
    if ($seen.ContainsKey($k) -or $history.Count -ge 4) { continue }
    $seen[$k] = $true
    $repo = @($repos | Where-Object { (Split-Path -Leaf $_) -eq $h.repo })[0]
    $log = @(Invoke-Git $repo @('log', '-n', '3', '--date=short', '--format=%h %ad %an: %s', '--', $h.path) | ForEach-Object { Limit-Text $_ 120 })
    if ($log.Count -gt 0) { [void]$history.Add([ordered]@{ repo = $h.repo; path = $h.path; commits = @($log) }) }
}

# the commits linked to the item in ADO, when their repo is here: what they changed
$linked = New-Object System.Collections.ArrayList
foreach ($c in @($rec['commits'])) {
    if (-not $c -or $linked.Count -ge 4) { continue }
    $repo = @($repos | Where-Object { (Split-Path -Leaf $_) -ieq [string]$c['repo'] })[0]
    if (-not $repo) { continue }
    $show = @(Invoke-Git $repo @('show', '--name-only', '--date=short', '--format=%h %ad %an: %s', [string]$c['sha']))
    if ($show.Count -eq 0) { continue }
    [void]$linked.Add([ordered]@{ repo = [string]$c['repo']; commit = (Limit-Text $show[0] 120); files = @($show | Select-Object -Skip 1 | Where-Object { $_ } | Select-Object -First 8) })
}

$out = [ordered]@{
    ok = $true; id = $Id; rev = [int]$rec['rev']
    terms = @($terms | ForEach-Object { $_.text }); repos = @($repos | ForEach-Object { Split-Path -Leaf $_ })
    hits = @($hits.ToArray()); history = @($history.ToArray()); linked = @($linked.ToArray())
    seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
}
Write-Utf8File (Join-Path (Join-Path $ctx.bugsDir 'items') "$Id.evidence.json") (ConvertTo-JsonText $out)
Out-Result $out
