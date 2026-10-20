<#
.SYNOPSIS
  Opens a new Claude Code chat that starts (or resumes) the sdd flow on one work item, for the bug manager (/sdd-bugs).

.DESCRIPTION
  .claude/sdd.json "bugs.newChat" decides how:
    "mode": "desktop"   (default) a new Claude Code session in the Claude Desktop app, through its link
                        claude://code/new?q=<prompt>&folder=<workspace>: the prompt is in the composer, not sent;
                        the app asks once to confirm the folder. See
                        https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
    "mode": "terminal"  a new terminal window in the workspace running: claude "/sdd:sdd <id>"
                        Windows: a Windows Terminal tab when wt.exe is there, else a console window.
                        macOS: Terminal. Linux: x-terminal-emulator, gnome-terminal, konsole or xterm.
    "mode": "url"       opens "url" with {id}, {prompt} and {root} filled in (URL-encoded), for a link that
                        the Claude app (or another launcher) answers with a new chat.
  /sdd on an item with a flow in progress resumes it where it stands, so the same prompt starts or continues.

.PARAMETER Id
  The work item.

.PARAMETER DryRun
  Print what would be started and start nothing.

.EXAMPLE
  pwsh -NoProfile -File Start-SddChat.ps1 -Id 1234
#>
param(
    [string]$Root = '',
    [Parameter(Mandatory = $true)][int]$Id,
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot 'BugsCommon.ps1')

$ctx = Get-SddContext $Root
$prompt = "/sdd:sdd $Id"
$nc = $ctx.bugs['newChat']
$mode = 'desktop'
if ($nc -and $nc['mode']) { $mode = [string]$nc['mode'] }
$onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
$onMac = (-not $onWindows) -and $IsMacOS

function Join-Args([string[]]$List) {
    # one argument string for Start-Process, which joins a list without quoting it: each item in double
    # quotes, as .NET splits the string back into arguments
    return (($List | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"') + '"' }) -join ' ')
}

function Start-Or-Show([string]$How, [string]$File, [string[]]$ArgList, [string]$Dir = '') {
    $shown = [ordered]@{ ok = $true; how = $How; file = $File; args = @($ArgList); prompt = $prompt }
    if ($DryRun) { $shown['dryRun'] = $true; Out-Result $shown; exit 0 }
    try {
        $p = @{ FilePath = $File }
        if ($ArgList.Count -gt 0) { $p['ArgumentList'] = $ArgList }
        if ($Dir) { $p['WorkingDirectory'] = $Dir }
        Start-Process @p
    } catch {
        Exit-WithError "could not start ${How}: $($_.Exception.Message)"
    }
    Out-Result $shown
    exit 0
}

if ($mode -eq 'url' -or $mode -eq 'desktop') {
    $tpl = [string]$nc['url']
    if ($mode -eq 'desktop') { $tpl = 'claude://code/new?q={prompt}&folder={root}' }
    if (-not $tpl) { Exit-WithError 'bugs.newChat.mode is "url" but bugs.newChat.url is empty in .claude/sdd.json' }
    $url = $tpl.Replace('{id}', [string]$Id).Replace('{prompt}', [uri]::EscapeDataString($prompt)).Replace('{root}', [uri]::EscapeDataString($ctx.root))
    $how = 'url'
    if ($mode -eq 'desktop') { $how = 'Claude Desktop' }
    if ($onWindows) { Start-Or-Show $how $url @() }
    if ($onMac) { Start-Or-Show $how 'open' @(Join-Args @($url)) }
    Start-Or-Show $how 'xdg-open' @(Join-Args @($url))
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Exit-WithError 'the claude command is not on PATH, so no chat can start in a terminal. Install Claude Code (the CLI), or set bugs.newChat in .claude/sdd.json, or use "In this chat".'
}

if ($onWindows) {
    # one argument string: Start-Process does not quote list items, and cmd /k keeps the quotes of the prompt as typed
    if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
        # a trailing backslash (a drive root, C:\) would escape the closing quote: C:\. is the same folder
        $dir = $ctx.root
        if ($dir.EndsWith('\')) { $dir += '.' }
        Start-Or-Show 'Windows Terminal' 'wt.exe' @("-d `"$dir`" --title `"sdd $Id`" cmd /k claude `"$prompt`"")
    }
    Start-Or-Show 'console' 'cmd.exe' @("/k claude `"$prompt`"") $ctx.root
}

$q = "'" + $ctx.root.Replace("'", "'\''") + "'"
$line = "cd $q && claude '$prompt'"
if ($onMac) {
    $script = $line.Replace('\', '\\').Replace('"', '\"')
    Start-Or-Show 'Terminal' 'osascript' @(Join-Args @('-e', "tell application `"Terminal`" to do script `"$script`"", '-e', 'tell application "Terminal" to activate'))
}
foreach ($t in @('x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { continue }
    if ($t -eq 'gnome-terminal') { Start-Or-Show $t $t @(Join-Args @("--working-directory=$($ctx.root)", '--', 'claude', $prompt)) }
    Start-Or-Show $t $t @(Join-Args @('-e', 'bash', '-lc', $line))
}
Exit-WithError 'no terminal program found to open a new chat in (x-terminal-emulator, gnome-terminal, konsole, xterm). Set bugs.newChat in .claude/sdd.json, or use "In this chat".'
