// The sdd view: a pane that shows where a work item is in its flow, a band when one waits on the
// person, and a toast when a gate passes. It reads `env.py view` (local files, no ADO) and the spec
// documents. The one thing it writes is what each turn cost (`env.py cost`: one appended line in the item's
// folder). It never passes a gate or runs any other state-changing command; "Resume" only fills the
// prompt box with `/sdd <id>` for the person to send.
import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BugAnalysis, BugChange, BugDetail, BugEvidence, BugFilter, BugIndex, BugRecord, BugsConfig, SddAsk, SddColors, SddLiveState, SddDoc, SddItem, SddQuestion, SddSnapshot, SddStage } from '../types'
import { GLYPH, agentRows, contextTone, moneyText, spendHead, SPEND_ICON, spendTokens, spendTotal, tokensLine, answerMessage, answersFor, approveAnswers, approveFor, approveMessage,decidedGates, fileLinks, defaultStage, flowFinished, railSlice, railBarColor, clipboardArgv, stageWord, shortStamp, flowTag, MARK_WORD, idFromArgs, idFromScript, itemOptions, itemSuggestions, pendingGate, reviewLinks, stamp, fileTarget, gateStory, phaseKey, phaseLabel, refLink, stageDocs, stageHistory, stageRows, stageSummary, spinnerNote, statusWord, when, yourTurn } from './view/model'
import type { AgentInfoLike, AgentTone, Mark, StageRow } from './view/model'
import { ageShort, agoText, cleanupNote, conflictNote, counts, groupByItem, historyArgs, joinWorktrees, lineFacts, lineKey, linePath, lineTone, lineWord, sortLines } from './view/worktrees'
import { ANALYSIS_SYSTEM, F, FIELD_NAME, NO_FILTER, ago, analysisKey, analysisNote, analysisPrompt, bugsConfig, categorize, chipCounts, clipboardArgvFor, commentProblem, countText, currentValue, filterItems, isMine,
  itemLinks, keepMine, parseJson, parseTeam, pathOptions, pendingByItem, people, powershellCandidates, revertChange, revertItem, scriptAnswer, scriptArgv, sddState,
  saveSummary, sddCommand, severityColor, shortName, sortItems, stageChange, stateOptions, tagOptions, typeIcon, withPending } from './view/bugs'

const PANE = 'sdd-view'
const snap = { plugin: 'sdd', key: 'snap' } as const
const error = { plugin: 'sdd', key: 'error' } as const
const selected = { plugin: 'sdd', key: 'selected' } as const
const stage = { plugin: 'sdd', key: 'stage' } as const
const doc = { plugin: 'sdd', key: 'doc' } as const
const place = { plugin: 'sdd', key: 'workspace' } as const
const feedback = { plugin: 'sdd', key: 'feedback' } as const
const gate = { plugin: 'sdd', key: 'gate' } as const
const autoOpened = { plugin: 'sdd', key: 'opened' } as const
const mine = { plugin: 'sdd', key: 'mine' } as const
const home = { plugin: 'sdd', key: 'home' } as const
const asked = { plugin: 'sdd', key: 'asked' } as const
const picks = { plugin: 'sdd', key: 'picks' } as const

const SCRIPT_RUN = /scripts[\\/]+(env|spec)\.py/
const DOC_LIMIT = 9000
// Colour carries meaning only, and a glyph always says the same thing for the terminal and colour-blind readers.
// The workspace sets them in .claude/sdd.json "view.colors" (env.py view hands them over); these are the
// fallback while nothing is read yet. A line under the pointer turns its text `hoverText` and its icon lighter.
const DEFAULT_COLORS: SddColors = { done: '#3f9a63', now: '#c98a12', work: '#4a7fc4', revoked: '#c0503f', gate: '#8a73c9',
  dim: '#7b8794', line: '#5c6670', hoverText: '#ffffff' }
let C: SddColors = DEFAULT_COLORS

function paint(colors: Partial<SddColors> | undefined): void {
  C = { ...DEFAULT_COLORS, ...(colors ?? {}) }
}

/** The colour halfway to white: an icon under the pointer, still in its status colour. */
function lighten(color: string | undefined): string | undefined {
  const m = /^#([0-9a-f]{6})/i.exec(color ?? '')
  if (!m) return color
  const n = parseInt(m[1], 16)
  const up = (v: number) => Math.round(v + (255 - v) * 0.5).toString(16).padStart(2, '0')
  return `#${up(n >> 16)}${up((n >> 8) & 255)}${up(n & 255)}`
}

function markColor(m: Mark): string | undefined {
  return { done: C.done, skipped: C.dim, missed: C.revoked, active: C.work, waiting: C.now, blocked: C.revoked, abandoned: C.dim, next: C.work, later: undefined }[m]
}

function stageName(st: SddStage): string {
  return st.key === st.label ? st.label : `${st.key.replace('Phase ', '')}  ${st.label}`
}


let python = 'python'  // module state: lost on reload, which is fine
let isOpen = false
let isWorkspace = false
// Cost and context, from session.measure. The cost is charged to the stage the item was in when the turn began.
let desktopReady = false  // a Desktop app is attached: until then the mod does nothing
let sessionId = ''
/** Why the last finished turn charged nothing, for the pane to say when an item shows no cost; null = it was recorded. */
let costWhy: string | null = null
let costFailed = false
let staleBaseline = false  // /clear, /resume or /branch ran: read the session id and cost total again at the next turn
let lastUsd: number | null = null
let turnOf: { id: number; key: string } | null = null
// What the turn spent so far and has not been recorded: dollars from session.measure, tokens from turn.complete.
// Either event may come last, so both flush, and a turn is counted once (turnCounted).
type Pending = { usd: number; input: number; output: number; cacheRead: number; cacheWrite: number; model: string }
const nothing = (): Pending => ({ usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' })
let pend = nothing()
let turnCounted = false
let ctx: { percent: number; window: number } | null = null
let agentsBusy = false  // an agent works: the pane redraws on a timer so its row keeps up
let notified = ''  // the wait the person was last notified of; lost on reload, which at worst tells them once more
// An open AskUserQuestion call's way to take an answer from the view, by tool_use_id. Lost on a
// reload; the view then says to answer in the chat.
const answering = new Map<string, (answers: Record<string, string>) => void>()

// Helpers do only the reading and drawing calls. $.state is read and written in the hook bodies
// (and the closures they make), which is where the engine hands it out.

/** Runs `env.py view` (local files, no ADO) and toasts what changed since `before`. */
async function loadView($: EngineInterface, id: number | null, before: SddSnapshot | null, folder: string | null): Promise<View> {
  const argv = (exe: string) => [exe, `${$.plugin.root}/scripts/env.py`, 'view', '--json', '--compact',
    ...(id != null ? ['--id', String(id)] : [])]
  const cwd = folder || (await $.session.cwd())
  let out: SddSnapshot | null = null
  let why: string | null = null
  for (const exe of [python, 'python3', 'py']) {
    try {
      const r = await $.process.run(argv(exe), { cwd, timeoutMs: 20000 })
      python = exe
      if (r.exitCode === 0) out = JSON.parse(r.stdout) as SddSnapshot
      else why = (r.stderr || r.stdout).trim().split('\n').pop() || `env.py view exited ${r.exitCode}`
      break
    } catch (err) {
      why = `could not run python: ${String(err)}`
    }
  }
  isWorkspace = out !== null
  if (out && before) toastChanges($, before, out)
  return { out, why }
}

type View = { out: SddSnapshot | null; why: string | null }

function toastChanges($: EngineInterface, a: SddSnapshot, b: SddSnapshot): void {
  for (const now of b.items) {
    const was = a.items.find(x => x.id === now.id)
    if (!was) continue
    const passed = Object.keys(now.gates ?? {}).filter(g => !(was.gates ?? {})[g])
    if (passed.length) $.ui.toast(`${now.id} · gate passed: ${passed.join(', ')}`)
    const flow = b.flows[now.flow]
    const from = flow ? phaseKey(flow, was.progress?.phase) : was.progress?.phase
    const to = flow ? phaseKey(flow, now.progress?.phase) : now.progress?.phase
    if (to && from !== to) $.ui.toast(`${now.id} · now in ${phaseLabel(flow, now)}`)
  }
}

async function openPane($: EngineInterface, id: number | null): Promise<void> {
  isOpen = true
  await $.ui.open({ id: PANE, title: id != null ? `sdd ${id}` : 'sdd', closeOnEscape: true, columns: 100 })
}

/** Opens a folder on this computer in the file manager or VS Code. It changes nothing in sdd. */
/** Opens the sdd view on a work item (`/sdd-view [id] [folder]`); the command and the band's button both run it. Says what it did. */
async function openSddView($: EngineInterface, args: string): Promise<string> {
  const [, num, rest] = /^(\d+)?\s*(.*)$/s.exec(args.trim()) ?? []
  const folder = (rest ?? '').trim().replace(/^["']|["']$/g, '')
  if (folder) await $.state.set(place, folder)
  // every get of one dispatch reads its start, so use what was just parsed
  const where = folder || ((await $.state.get(place)).value ?? null)
  const id = num ? Number(num) : ((await $.state.get(mine)).value ?? null)
  await $.state.set(selected, id)
  await $.state.set(stage, null)
  await $.state.set(doc, null)
  await openPane($, id)
  const v = await loadView($, id, (await $.state.get(snap)).value ?? null, where)
  await $.state.set(snap, v.out)
  await $.state.set(error, v.why)
  return `sdd view${id != null ? ` of ${id}` : ''} opened${where ? ` on ${where}` : ''}.`
}

/** The launcher's repowatch button: its pane, from another plugin's command, so say so when it is missing. */
async function showRepowatch($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'repowatch', args: '' })
  } catch (err) {
    $.ui.toast(`repowatch could not open (is the repowatch plugin enabled?): ${String(err).slice(0, 120)}`)
  }
}

/** The spanner: repowatch's Worktrees list, on that one worktree. Another plugin's command, so say so when it is missing. */
async function showWorktree($: EngineInterface, path: string): Promise<void> {
  try {
    const res = await $.command.run({ command: 'repowatch', args: `worktree ${JSON.stringify({ path })}` })
    if (/^Usage:|no such|not found/i.test(res.text ?? '')) $.ui.toast(res.text ?? 'repowatch could not show that worktree')
  } catch (err) {
    $.ui.toast(`repowatch could not show that worktree (is the repowatch plugin enabled?): ${String(err).slice(0, 120)}`)
  }
}

async function openIn($: EngineInterface, app: 'files' | 'code', path: string): Promise<void> {
  const isWin = /^[A-Za-z]:[\\/]/.test(path)
  const native = isWin ? path.replace(/\//g, '\\') : path
  const argv = app === 'code'
    ? (isWin ? ['cmd', '/c', 'code', native] : ['code', native])
    : (isWin ? ['cmd', '/c', 'explorer', native] : ['open', native])  // through cmd, as code: explorer.exe started directly misreads a path with spaces
  try {
    const r = await $.process.run(argv, { timeoutMs: 15000 })
    if (r.exitCode > 1) $.ui.toast(`Could not open ${path}: ${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.exitCode}`}`)  // explorer exits 1 even when it opened
  } catch (err) {
    $.ui.toast(`Could not open ${app === 'code' ? 'VS Code' : 'the folder'}: ${String(err)}`)
  }
}

/** Copies a path to the clipboard (the mod kit has no clipboard call, so the computer's own tool does it) and says so. */
async function copyPath($: EngineInterface, path: string): Promise<void> {
  try {
    const r = await $.process.run(clipboardArgv(path), { timeoutMs: 10000 })
    if (r.exitCode === 0) $.ui.toast('Path copied')
    else $.ui.toast(`Could not copy the path: ${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.exitCode}`}`)
  } catch (err) {
    $.ui.toast(`Could not copy the path: ${String(err).slice(0, 160)}`)
  }
}

/** Opens a code file in VS Code at its line (or, with no line, in the app the computer uses for it). */
async function openFile($: EngineInterface, path: string, line?: number): Promise<void> {
  const isWin = /^[A-Za-z]:[\\/]/.test(path)
  const native = isWin ? path.replace(/\//g, '\\') : path
  const argv = line
    ? (isWin ? ['cmd', '/c', 'code', '-g', `${native}:${line}`] : ['code', '-g', `${native}:${line}`])
    : (isWin ? ['cmd', '/c', 'explorer', native] : ['open', native])  // explorer opens a file in its default app
  try {
    await $.process.run(argv, { timeoutMs: 15000 })
  } catch (err) {
    $.ui.toast(`Could not open ${path}: ${String(err)}`)
  }
}

async function readDoc($: EngineInterface, item: SddItem, name: string): Promise<SddDoc> {
  try {
    const text = await $.fs.read(`${item.spec?.path}/${name}`)
    const isCut = text.length > DOC_LIMIT
    return { name, text: isCut ? text.slice(0, DOC_LIMIT) : text, isCut }
  } catch (err) {
    return { name, text: `Could not read ${name}: ${String(err)}`, isCut: false }
  }
}

/** The session's subagents and teammates; none when the list cannot be read. */
async function listAgents($: EngineInterface): Promise<AgentInfoLike[]> {
  try {
    return await $.agent.list()
  } catch {
    return []
  }
}

// The picture is laid out for the pane's width in pixels. The app tells the pane its width in columns; a column is about
// this many pixels. If the guess is high the picture is scaled down to fit the pane, if low it leaves a margin.
const WT_PANE = 'sdd-worktrees'
const WT_COLORS = { urgent: '#c0503f', warn: '#c98a12', ok: '#3f9a63', dim: '#7b8794', work: '#4a7fc4' }
const WT_REFRESH_MS = 30_000
const live = { plugin: 'sdd', key: 'wtLive' } as const
const liveError = { plugin: 'sdd', key: 'wtError' } as const
const offset = { plugin: 'sdd', key: 'wtOffset' } as const
const wtLineState = { plugin: 'sdd', key: 'wtLine' } as const
let wtOpen = false
let wtTimer = false

type Live = { state: SddLiveState | null; why: string | null }

/** Opens the Worktrees page and reads the worktrees. The command and the band's button both run it: a hook cannot run its own plugin's command. */
async function openWorktreesPage($: EngineInterface): Promise<void> {
  wtOpen = true
  if (!wtTimer) {
    wtTimer = true
    $.clock.every(WT_REFRESH_MS, () => {
      if (!wtOpen) return
      void (async () => {
        const s = (await $.state.get(snap)).value ?? null
        const r = await wtReadLive($, s?.root ?? null)
        await $.state.set(live, r.state)
        await $.state.set(liveError, r.why)
      })()
    })
  }
  await $.ui.open({ id: WT_PANE, title: 'sdd worktrees', closeOnEscape: true, columns: 110 })
  const s = (await $.state.get(snap)).value ?? null
  const r = await wtReadLive($, s?.root ?? null)
  await $.state.set(live, r.state)
  await $.state.set(liveError, r.why)
  await $.state.set(offset, 0)
}

/** Reads repowatch's state file in the workspace. Missing = repowatch has not scanned yet. */
async function wtReadLive($: EngineInterface, root: string | null): Promise<Live> {
  if (!root) return { state: null, why: 'No sdd workspace found from this folder.' }
  try {
    const parsed = JSON.parse(await $.fs.read(`${root}/.claude/repowatch/state.json`)) as SddLiveState
    return { state: parsed, why: null }
  } catch {
    return { state: null, why: 'repowatch has not scanned this workspace yet. It scans by itself every few minutes while Auto sync is on in /repowatch; Sync now there does it now.' }
  }
}

/** Records what a turn spent, in dollars and tokens, against the item and the stage the turn began in:
 *  `env.py cost` appends one line to the item's folder. Chats on the same item append to the same file and
 *  never rewrite each other. `turns` is 1 for the first line of a turn and 0 for a further line of it. */
async function recordCost($: EngineInterface, folder: string | null, id: number, key: string, p: Pending, turns: 0 | 1): Promise<string | null> {
  const cwd = folder || (await $.session.cwd())
  const args = ['cost', '--id', String(id), '--stage', key, '--usd', p.usd.toFixed(6), '--input', String(p.input), '--output', String(p.output),
    '--cache-read', String(p.cacheRead), '--cache-write', String(p.cacheWrite), '--turns', String(turns), '--session', sessionId,
    ...(p.model ? ['--model', p.model] : [])]
  let why: string | null = null
  for (const exe of [python, 'python3', 'py']) {
    try {
      const r = await $.process.run([exe, `${$.plugin.root}/scripts/env.py`, ...args], { cwd, timeoutMs: 20000 })
      python = exe
      return r.exitCode === 0 ? null : (r.stderr || r.stdout).trim().split('\n').pop() || `env.py cost exited ${r.exitCode}`
    } catch (err) {
      why = `could not run python: ${String(err)}`
    }
  }
  return why
}

/** Records what is pending against the stage the turn began in. True when a line was written. A chat with no
 *  item has nothing to charge: what is pending is dropped. A failure says so once a session. */
async function flushCost($: EngineInterface, folder: string | null): Promise<boolean> {
  const p = pend
  if (!(p.usd > 0 || p.input + p.output + p.cacheRead + p.cacheWrite > 0)) return false
  pend = nothing()  // before any await: a second flush at once finds nothing
  if (!turnOf) { costWhy = 'this chat has no work item yet (the turn was not charged); run /sdd <id> in it'; return false }
  if (!sessionId) { costWhy = 'the session reported no id (the turn was not charged)'; return false }
  const turns = turnCounted ? 0 : 1
  turnCounted = true
  const why = await recordCost($, folder, turnOf.id, turnOf.key, p, turns)
  costWhy = why ? `the last turn was not recorded: ${why.slice(0, 100)}` : null
  if (why && !costFailed) {
    costFailed = true  // a missing script would otherwise say it after every turn
    $.ui.toast(`Cost not recorded: ${why.slice(0, 160)}`)
  }
  return !why
}

/** The session's id and what it has spent so far: the point later spending is measured from. It is read when
 *  the session starts and again at the first turn after /clear, /resume and /branch, which change both without a start. */
async function baseline($: EngineInterface): Promise<void> {
  turnOf = null
  pend = nothing()
  turnCounted = false
  try {
    sessionId = await $.session.id()
    const u = await $.session.usage()
    lastUsd = u.cost?.usd ?? null
    if (u.context.percent != null) ctx = { percent: u.context.percent, window: u.context.window }
  } catch {
    lastUsd = null
  }
}

/** The sdd view is for the Claude Desktop app. This sets it up once a Desktop app is attached to the session (at the start,
 *  or when it attaches; never from a draw, which may not write state): the commands, the first read of the work items, the cost baseline and the
 *  timers. Anywhere else (a terminal, the VS Code extension, a phone, `claude -p`) it does nothing, and every hook passes
 *  through. A mod cannot refuse to load, so this is how it stays out of the way. */
async function setupDesktop($: EngineInterface, isAttach = false): Promise<boolean> {
  if (desktopReady) return true
  let surfaces: readonly string[] = []
  try {
    surfaces = await $.session.surfaces()
  } catch {
    surfaces = []
  }
  if (!isAttach && !surfaces.includes('desktop')) return false
  desktopReady = true
  await $.state.set(bugsBusyS, null)  // a reload ended whatever the last copy of the module was running
  await $.command.register({
    name: 'sdd-bugs',
    description: 'Triage the bugs and issues synced from ADO: categories, staged changes saved as a batch, probable cause, the /sdd command to copy',
    argumentHint: '[mine]',
  })
  await $.command.register({
    name: 'sdd-worktrees',
    description: 'Show every sdd work item that still has worktrees, with the live state of each (from repowatch)',
  })
  await $.command.register({
    name: 'sdd-view',
    description: 'Show the sdd flow of the work item this chat works on (or the one given) in a pane',
    argumentHint: '[work item id] [workspace folder]',
  })
  const sync = async () => {
    const v = await loadView($, (await $.state.get(selected)).value ?? (await $.state.get(mine)).value ?? null,
      (await $.state.get(snap)).value ?? null, (await $.state.get(place)).value ?? null)
    await $.state.set(snap, v.out)
    await $.state.set(error, v.why)
  }
  // background reads: if the session ends under one, there is nobody to tell
  void sync().catch(() => undefined)
  await baseline($)
  $.clock.every(30_000, () => {
    if (isOpen || isWorkspace) void sync().catch(() => undefined)
  })
  // an agent that works changes without any prop changing: redraw the open pane every few seconds
  $.clock.every(3_000, () => {
    if (isOpen && agentsBusy) $.ui.invalidate('ui.render')
  })
  return true
}

const AGENT_GLYPH: Record<AgentTone, string> = { working: '●', waiting: '●', done: '✓', failed: '✕', quiet: '○' }

// ---------------------------------------------------------------- the bug manager (/sdd-bugs): helpers
// The PowerShell scripts in scripts/bugs/ do everything that touches ADO or git; this reads the files they write
// (index.json, items/<id>.json) and writes one of its own, pending.json: the changes staged and not yet saved.
// The only model call is the probable cause, on the person's press, with a short prompt (view/bugs.ts).
const BUG_PANE = 'sdd-bugs'
const bugsIdx = { plugin: 'sdd', key: 'bugs' } as const
const bugsErr = { plugin: 'sdd', key: 'bugsError' } as const
const bugsCfgS = { plugin: 'sdd', key: 'bugsCfg' } as const
const bugsPend = { plugin: 'sdd', key: 'bugsPending' } as const
const bugsTeamS = { plugin: 'sdd', key: 'bugsTeam' } as const
const bugsFilt = { plugin: 'sdd', key: 'bugsFilter' } as const
const bugsOpenS = { plugin: 'sdd', key: 'bugsOpen' } as const
const bugsEditS = { plugin: 'sdd', key: 'bugsEdit' } as const
const bugsBusyS = { plugin: 'sdd', key: 'bugsBusy' } as const
const bugsDetailS = { plugin: 'sdd', key: 'bugsDetail' } as const
const bugsEvS = { plugin: 'sdd', key: 'bugsEvidence' } as const
const bugsAnS = { plugin: 'sdd', key: 'bugsAnalysis' } as const
const bugsOffS = { plugin: 'sdd', key: 'bugsOffset' } as const
const bugsReviewS = { plugin: 'sdd', key: 'bugsReview' } as const
const bugsPickedS = { plugin: 'sdd', key: 'bugsPicked' } as const
const BUSY_WORD: Record<string, string> = { sync: 'Syncing from ADO', save: 'Saving to ADO', detail: 'Reading from ADO', evidence: 'Gathering evidence',
  analysis: 'Finding the probable cause' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
let bugsPaneOpen = false
let bugsTimer = false
let bugsDirKnown: string | null = null
let bugsSeen = ''  // what bugsRead last read: settings, index.json and pending.json
let bugsRunning: string | null = null  // the long action running in this copy of the module (a reload ends it)
let pwshExe: string | null = null  // the PowerShell that ran last; lost on reload, which costs one more try

type BugsWhere = { root: string; dir: string; cfg: BugsConfig }
type ScriptOut = { ok: boolean; error?: string }

/** The workspace (the one the sdd view read, else the first folder at or above the session's holding
 *  .claude/sdd.json), the bug folder in its spec folder, and the settings. A string says why there is none. */
async function bugsWhere($: EngineInterface): Promise<BugsWhere | string> {
  let root: string | null = (await $.state.get(snap)).value?.root ?? (await $.state.get(place)).value ?? null
  if (!root) {
    let d = (await $.session.cwd()).replace(/[\\/]+$/, '')
    for (let i = 0; i < 12 && d; i++) {
      try {
        await $.fs.read(`${d}/.claude/sdd.json`)
        root = d
        break
      } catch {
        const up = d.replace(/[\\/][^\\/]*$/, '')
        if (up === d) break
        d = up
      }
    }
  }
  if (!root) return 'No sdd workspace here: no .claude/sdd.json at or above this folder. Run /sdd init in the workspace first.'
  let raw: { specRoot?: string; bugs?: unknown } = {}
  try {
    raw = parseJson(await $.fs.read(`${root}/.claude/sdd.json`))
  } catch (err) {
    return `Could not read ${root}/.claude/sdd.json: ${String(err).slice(0, 160)}`
  }
  let defaults: BugsConfig
  try {
    defaults = parseJson<BugsConfig>(await $.fs.read(`${$.plugin.root}/scripts/bugs/defaults.json`))
  } catch {
    return 'The sdd plugin has no scripts/bugs/defaults.json: update or reinstall it.'
  }
  const cfg = bugsConfig(defaults, raw.bugs)
  const spec = String(raw.specRoot || 'docs/spec')
  const specDir = /^([A-Za-z]:)?[\\/]/.test(spec) ? spec : `${root}/${spec}`
  bugsDirKnown = `${specDir}/${cfg.folder || '.bugs'}`.replace(/\\/g, '/')
  return { root, dir: bugsDirKnown, cfg }
}

/** Reads what the scripts wrote: the list and the staged changes. No index yet: not synced. `quiet` (the timer)
 *  changes nothing when the files are as they were, so a redraw never comes for nothing (or over a half-typed field). */
async function bugsRead($: EngineInterface, quiet = false): Promise<BugsWhere | null> {
  const w = await bugsWhere($)
  if (typeof w === 'string') {
    await $.state.set(bugsErr, w)
    return null
  }
  const read = async (name: string) => {
    try {
      return await $.fs.read(`${w.dir}/${name}`)
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }
  const [indexText, pendingText] = [await read('index.json'), await read('pending.json')]
  // the dev team's file sits in the workspace, not in the bugs folder
  const teamPath = /^([A-Za-z]:)?[\\/]/.test(w.cfg.developersFile) ? w.cfg.developersFile : `${w.root}/${w.cfg.developersFile}`
  let teamText: string | Error
  try {
    teamText = await $.fs.read(teamPath)
  } catch (err) {
    teamText = err instanceof Error ? err : new Error(String(err))
  }
  const seen = [JSON.stringify(w.cfg), String(indexText), String(pendingText), String(teamText)].join('\u0000')
  if (quiet && seen === bugsSeen) return w
  bugsSeen = seen
  await $.state.set(bugsCfgS, w.cfg)
  await $.state.set(bugsTeamS, teamText instanceof Error ? null : parseTeam(teamText))
  let index: BugIndex | null = null
  let why: string | null = null
  try {
    if (indexText instanceof Error) throw indexText
    index = parseJson<BugIndex>(indexText)
  } catch (err) {
    // missing (never synced) or unreadable: a sync writes it again either way
    const what = String(err)
    why = /JSON|Unexpected|parse/i.test(what)
      ? `${w.dir}/index.json is damaged (${what.slice(0, 120)}). Press Sync to pull the bugs and issues from ADO again.`
      : 'Not synced yet. Press Sync to pull the bugs and issues from ADO.'
  }
  let pending: BugChange[] = []
  try {
    if (!(pendingText instanceof Error)) pending = parseJson<{ changes?: BugChange[] }>(pendingText).changes ?? []
  } catch {
    pending = []
  }
  await $.state.set(bugsIdx, index)
  await $.state.set(bugsErr, why)
  await $.state.set(bugsPend, pending)
  return w
}

/** Runs one script of scripts/bugs/ with PowerShell and reads its answer: the last JSON line it printed. */
async function bugsRun<T>($: EngineInterface, w: BugsWhere, script: string, args: string[], timeoutMs: number): Promise<{ out: (T & ScriptOut) | null; why: string | null }> {
  const isWin = /^[A-Za-z]:/.test(w.root)
  let why: string | null = null
  for (const exe of pwshExe ? [pwshExe] : powershellCandidates(w.cfg.powershell, isWin)) {
    try {
      const r = await $.process.run(scriptArgv(exe, $.plugin.root, script, w.root, args), { cwd: w.root, timeoutMs })
      pwshExe = exe
      const out = scriptAnswer<T & ScriptOut>(r.stdout)
      if (out?.ok) return { out, why: null }
      return { out, why: out?.error ?? ((r.stderr || r.stdout).trim().split('\n').pop() || `${script} exited ${r.exitCode}`) }
    } catch (err) {
      why = String(err).slice(0, 200)
      // only a PowerShell that is not there is worth another try; a timeout is the script's own
      if (!/ENOENT|not found|no such|cannot find|spawn/i.test(why)) return { out: null, why: `${script}: ${why}` }
    }
  }
  pwshExe = null
  return { out: null, why: `No PowerShell to run ${script} (${why ?? 'none found'}). Install PowerShell 7 (pwsh), or set "bugs.powershell" in .claude/sdd.json.` }
}

/** Runs one long action at a time: a second press while one runs says so instead. */
async function bugsBusy($: EngineInterface, what: string, fn: () => Promise<void>): Promise<void> {
  if (bugsRunning) {
    $.ui.toast(`Wait: ${BUSY_WORD[bugsRunning] ?? bugsRunning} is still running.`)
    return
  }
  bugsRunning = what
  await $.state.set(bugsBusyS, what)
  try {
    await fn()
  } catch (err) {
    $.ui.toast(`${BUSY_WORD[what] ?? what} failed: ${String(err).slice(0, 200)}`)
  } finally {
    bugsRunning = null
    await $.state.set(bugsBusyS, null)
  }
}

/** Changes the staged list and writes it to pending.json, where the save script reads it. */
async function bugsStage($: EngineInterface, change: (p: BugChange[]) => BugChange[]): Promise<void> {
  if (bugsRunning === 'save') {
    $.ui.toast('Wait for the save to finish, then change more.')
    return
  }
  const next = await update($, bugsPend, cur => change(cur ?? []))
  // the folder only: reading the files again here would put the old list back over the one just staged
  const w = bugsDirKnown ? null : await bugsWhere($)
  const dir = bugsDirKnown ?? (w && typeof w !== 'string' ? w.dir : null)
  if (!dir) return
  try {
    await $.fs.write(`${dir}/pending.json`, JSON.stringify({ version: 1, changes: next }, null, 1) + '\n')
  } catch (err) {
    $.ui.toast(`Could not write the staged changes: ${String(err).slice(0, 160)}`)
  }
}

/** Opens an item's row (or closes it when it is open), with what is kept of it on disk: its text, comments,
 *  evidence and probable cause. Nothing is asked of ADO or the model. */
async function bugsToggle($: EngineInterface, id: number, isOpen: boolean): Promise<void> {
  await $.state.set(bugsEditS, null)
  if (isOpen) {
    await $.state.set(bugsOpenS, null)
    return
  }
  await $.state.set(bugsOpenS, id)
  const w = bugsDirKnown ? null : await bugsWhere($)
  const dir = bugsDirKnown ?? (w && typeof w !== 'string' ? w.dir : null)
  let detail: BugDetail | null = null
  let ev: BugEvidence | null = null
  if (dir) {
    try {
      const d = parseJson<{ text?: Record<string, string>; comments?: BugDetail['comments'] }>(await $.fs.read(`${dir}/items/${id}.json`))
      detail = { id, text: d.text ?? {}, comments: d.comments ?? [] }
    } catch {
      detail = { id, text: {}, comments: [] }
    }
    try {
      ev = parseJson<BugEvidence>(await $.fs.read(`${dir}/items/${id}.evidence.json`))
    } catch {
      ev = null
    }
    try {
      const a = parseJson<BugAnalysis>(await $.fs.read(`${dir}/items/${id}.analysis.json`))
      await update($, bugsAnS, cur => ({ ...(cur ?? {}), [String(id)]: a }))
    } catch {
      // never analysed
    }
  }
  await $.state.set(bugsDetailS, detail)
  await $.state.set(bugsEvS, ev)
}

/** Opens the bug manager. `mine` in the arguments shows only the items assigned to the person. */
async function openBugsPage($: EngineInterface, args = ''): Promise<string> {
  bugsPaneOpen = true
  if (!bugsTimer) {
    bugsTimer = true
    // a sync from another chat or a terminal shows up without a press: the files are re-read, nothing else runs
    $.clock.every(60_000, () => {
      if (bugsPaneOpen) void (async () => {
        if (!bugsRunning) await bugsRead($, true)
      })().catch(() => undefined)
    })
  }
  if (/\bmine\b/i.test(args)) await update($, bugsFilt, f => ({ ...(f ?? NO_FILTER), mine: true, category: 'all' }))
  await $.ui.open({ id: BUG_PANE, title: 'sdd bugs', closeOnEscape: true, columns: 120 })
  const w = await bugsRead($)
  return w ? 'sdd bugs opened.' : 'sdd bugs opened (no workspace: see the pane).'
}

export const register: Register = on => {
  // ---------------------------------------------------------------- the Worktrees page (/sdd-worktrees)
  // It lives in this file: older engines follow `$` into a function of the same file only.

  on('command.run', { command: 'sdd-worktrees' }, async ($, e) => {
    if (!desktopReady) return { text: 'The sdd worktrees page works in the Claude Desktop app only.' }
    await openWorktreesPage($)
    return { text: 'sdd worktrees opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: WT_PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s: SddSnapshot | null = (await $.state.get(snap)).value ?? null
    const liveState = (await $.state.get(live)).value ?? null
    const why = (await $.state.get(liveError)).value ?? null
    const from = (await $.state.get(offset)).value ?? 0
    const openLine = (await $.state.get(wtLineState)).value ?? null
    const now = Math.floor(Date.now() / 1000)

    const reload = async () => {
      const r = await wtReadLive($, s?.root ?? null)
      await $.state.set(live, r.state)
      await $.state.set(liveError, r.why)
    }
    // the history is repowatch's to draw: ask its command, which opens its own pane on that branch
    const showHistory = (args: string) => async () => {
      try {
        const res = await $.command.run({ command: 'repowatch', args })
        if (/^Usage:|no such|not found/i.test(res.text ?? '')) $.ui.toast(res.text ?? 'repowatch could not show that history')
      } catch (err) {
        $.ui.toast(`repowatch could not show that history (is the repowatch plugin enabled?): ${String(err).slice(0, 120)}`)
      }
    }
    const openItem = (id: number) => async () => {
      await $.state.set(selected, id)
      await $.state.set(stage, null)
      await $.state.set(doc, null)
      await $.ui.open({ id: 'sdd-view', title: `sdd ${id}`, closeOnEscape: true, columns: 100 })
    }

    const header = (
      <Box flexDirection="column">
        <Box>
          <Text bold>sdd worktrees  </Text>
          <Button key="reload" label="↻" onPress={reload} />
          <Text> </Text>
          <Button key="rw" label="Clean up in repowatch" onPress={() => $.prompt.fill({ text: '/repowatch worktrees' })} />
        </Box>
        {why && <Text color={WT_COLORS.warn}>{why}</Text>}
      </Box>
    )

    if (!s) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>The work items have not been read yet. Open /sdd-view first.</Text>
        </Box>
      )
    }

    const lines = sortLines(joinWorktrees(s.items, liveState))
    const blocks = groupByItem(lines)
    const size = Math.max(2, Math.floor(((e.viewport?.rows ?? 30) - 8) / 3))
    const shown = blocks.slice(from, from + size)
    const c = counts(lines)

    return (
      <Box flexDirection="column">
        {header}
        <Box gap={2}>
          <Text color={WT_COLORS.dim}>● {c.items} work items</Text>
          {c.cleanup > 0 && <Text color={WT_COLORS.ok}>● {c.cleanup} to clean up</Text>}
          {c.conflicts > 0 && <Text color={WT_COLORS.urgent}>● {c.conflicts} will conflict</Text>}
          {c.dirty > 0 && <Text color={WT_COLORS.warn}>● {c.dirty} with uncommitted files</Text>}
          <Text dimColor>{c.worktrees} worktrees{liveState ? ` · scanned ${agoText(liveState.generated, now).replace('last commit ', '')}` : ''}</Text>
        </Box>
        {blocks.length === 0 && <Text dimColor>No work item has a worktree folder.</Text>}
        {shown.map(b => {
          const flow = s.flows[b.item.flow]
          return (
            <Box key={`item-${b.item.id}`} flexDirection="column" marginTop={1}>
              <Box gap={1} alignItems="center">
                <Button key={`open-${b.item.id}`} label={`${b.item.id}`} onPress={openItem(b.item.id)} />
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">{b.item.title}</Text>
                </Box>
                <Text color={b.item.progress?.status === 'waiting' ? WT_COLORS.warn : WT_COLORS.dim}>
                  {phaseLabel(flow, b.item) || 'not started'} · {statusWord(b.item)}
                </Text>
              </Box>
              {b.lines.map(l => {
                const key = lineKey(l)
                const isOpen = openLine === key
                const tone = { conflict: WT_COLORS.urgent, cleanup: WT_COLORS.ok, review: WT_COLORS.warn, ok: WT_COLORS.dim }[lineTone(l)]
                const note = cleanupNote(l)
                const clash = conflictNote(l)
                return (
                  <Box key={`${l.item.id}-${l.repo}`} flexDirection="column" marginLeft={2}>
                    <Box gap={1} alignItems="center">
                      <Text color={tone}>●</Text>
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Button key={`wt-${key}`} label={`${l.repo} · ${l.branch}`} onPress={() => $.state.set(wtLineState, isOpen ? null : key)} />
                      </Box>
                      <Text color={tone}>{lineWord(l)}</Text>
                      <Text dimColor>{ageShort(l.live?.lastCommit, now).padStart(4)}</Text>
                    </Box>
                    {isOpen && (
                      <Box flexDirection="row" alignItems="stretch">
                        <Box key={`wtrail-${key}`} width={2} flexShrink={0} flexDirection="row">
                          <Box width="25%" flexShrink={0} />
                          <Box width="20%" flexShrink={0} backgroundColor={tone} />
                        </Box>
                        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} marginBottom={1}>
                          <Text dimColor wrap="wrap">{lineFacts(l, now).join(' · ')}</Text>
                          {note && <Text color={WT_COLORS.warn} wrap="wrap">{note}</Text>}
                          {clash && <Text color={WT_COLORS.urgent} wrap="wrap">{clash}</Text>}
                          <Box gap={1} flexWrap="wrap">
                            <Button key={`copy-${key}`} label="📋" onPress={() => copyPath($, linePath(l))} />
                            <Button key={`hist-${l.item.id}-${l.repo}`} label="History" onPress={showHistory(historyArgs(l))} />
                          </Box>
                        </Box>
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        {blocks.length > size && (
          <Box>
            <Text dimColor>{from + 1}-{Math.min(blocks.length, from + size)} of {blocks.length}  </Text>
            {from > 0 && <Button key="prev" label="Prev" onPress={() => $.state.set(offset, Math.max(0, from - size))} />}
            <Text> </Text>
            {from + size < blocks.length && <Button key="next" label="Next" onPress={() => $.state.set(offset, from + size)} />}
          </Box>
        )}
      </Box>
    )
  })

  // ---------------------------------------------------------------- the bug manager (/sdd-bugs)
  // Triage bugs and issues: categories, filters, staged changes saved to ADO as one batch (or reverted), the
  // links back to ADO, a probable cause on demand, and the /sdd command to copy. It lives in this file for
  // the same reason as the Worktrees page.

  on('command.run', { command: 'sdd-bugs' }, async ($, e) => {
    if (!desktopReady) return { text: 'The sdd bug manager works in the Claude Desktop app only.' }
    return { text: await openBugsPage($, e.args) }
  })

  on('ui.render', { component: 'Pane', requestId: BUG_PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = t
    const Select = 'Select' in t ? t.Select : undefined
    const Input = 'Input' in t ? t.Input : undefined
    const cols = e.props.bodyColumns
    const s = (await $.state.get(snap)).value ?? null
    paint(s?.colors)
    const index = (await $.state.get(bugsIdx)).value ?? null
    const why = (await $.state.get(bugsErr)).value ?? null
    const cfg = (await $.state.get(bugsCfgS)).value ?? null
    const pending = (await $.state.get(bugsPend)).value ?? []
    const devTeam = (await $.state.get(bugsTeamS)).value ?? null  // the developers of the dev team file; null = no such file
    const filter = { ...NO_FILTER, ...((await $.state.get(bugsFilt)).value ?? {}) }
    const openId = (await $.state.get(bugsOpenS)).value ?? null
    const editing = (await $.state.get(bugsEditS)).value ?? null
    const busy = (await $.state.get(bugsBusyS)).value ?? null
    const detail = (await $.state.get(bugsDetailS)).value ?? null
    const evidence = (await $.state.get(bugsEvS)).value ?? null
    const analyses = (await $.state.get(bugsAnS)).value ?? {}
    const from = (await $.state.get(bugsOffS)).value ?? 0
    const review = (await $.state.get(bugsReviewS)).value ?? false
    const picked = (await $.state.get(bugsPickedS)).value ?? []
    const now = Date.now()
    const tint = /^#[0-9a-f]{6}$/i.test(C.work) ? `${C.work}22` : undefined
    const pickTint = /^#[0-9a-f]{6}$/i.test(C.gate) ? `${C.gate}22` : undefined

    // ---- what the presses do; they run after the drawing, so they may write
    const where = async (): Promise<BugsWhere | null> => {
      const w = await bugsWhere($)
      if (typeof w === 'string') {
        $.ui.toast(w)
        return null
      }
      return w
    }
    const setFilter = (f: Partial<BugFilter>) => void (async () => {
      await update($, bugsFilt, cur => ({ ...NO_FILTER, ...(cur ?? {}), ...f }))
      await $.state.set(bugsOffS, 0)
    })()
    // the workspace's .claude/sdd.json, where "bugs" holds the categories and the rest of the settings, in the app the computer uses for it
    const openConfig = () => void (async () => {
      const w = await where()
      if (w) await openFile($, `${w.root}/.claude/sdd.json`)
    })()
    const sync = () => void bugsBusy($, 'sync', async () => {
      const w = await where()
      if (!w) return
      const r = await bugsRun<{ count: number; added: number; changed: number; removed: number; seconds: number }>($, w, 'Sync-Bugs.ps1', [], 600_000)
      await bugsRead($)
      $.ui.toast(r.out?.ok
        ? `Synced ${r.out.count} bugs and issues in ${r.out.seconds}s: ${r.out.added} new, ${r.out.changed} changed, ${r.out.removed} gone.`
        : `Sync failed: ${r.why}`)
    })
    const save = (id?: number) => void bugsBusy($, 'save', async () => {
      const w = await where()
      if (!w) return
      const r = await bugsRun<{ saved: number; already?: number; conflicts: number; errors: number; message?: string }>($, w, 'Save-BugChanges.ps1', id != null ? ['-Id', String(id)] : [], 300_000)
      await bugsRead($)
      if (!r.out?.ok) {
        $.ui.toast(`Save failed: ${r.why}. Nothing saved is lost: the changes are still staged.`)
        return
      }
      const o = r.out
      const left = o.conflicts + o.errors
      $.ui.toast(saveSummary(o))
      if (left) await $.state.set(bugsReviewS, true)
      if (openId != null) await bugsToggle($, openId, false)
    })
    const refresh = (id: number) => void bugsBusy($, 'detail', async () => {
      const w = await where()
      if (!w) return
      const r = await bugsRun<{ text: Record<string, string>; comments: BugDetail['comments'] }>($, w, 'Get-BugDetail.ps1', ['-Id', String(id)], 120_000)
      if (!r.out?.ok) {
        $.ui.toast(`Could not read ${id} from ADO: ${r.why}`)
        return
      }
      await bugsRead($)
      await $.state.set(bugsDetailS, { id, text: r.out.text ?? {}, comments: r.out.comments ?? [] })
      $.ui.toast(`${id} read again from ADO.`)
    })
    const gather = async (w: BugsWhere, id: number): Promise<BugEvidence | null> => {
      const r = await bugsRun<BugEvidence>($, w, 'Find-BugEvidence.ps1', ['-Id', String(id)], 120_000)
      if (!r.out?.ok) {
        $.ui.toast(`No evidence: ${r.why}`)
        return null
      }
      await $.state.set(bugsEvS, r.out)
      return r.out
    }
    const findEvidence = (id: number) => void bugsBusy($, 'evidence', async () => {
      const w = await where()
      if (!w) return
      const ev = await gather(w, id)
      if (ev) $.ui.toast(`${ev.hits.length} code hits in ${ev.repos.length} repos, in ${ev.seconds}s (no tokens).`)
    })
    const analyse = (item: BugRecord, d: BugDetail | null, have: BugEvidence | null) => void bugsBusy($, 'analysis', async () => {
      const w = await where()
      if (!w) return
      const ev = have && have.id === item.id ? have : await gather(w, item.id)
      const a = w.cfg.analysis ?? { model: 'haiku', maxTokens: 500, effort: 'low' }
      const model = a.model || 'haiku'
      const r = await $.model.complete({
        model, system: ANALYSIS_SYSTEM, prompt: analysisPrompt(item, d && d.id === item.id ? d : null, ev),
        maxTokens: Math.max(100, Math.min(4000, Number(a.maxTokens) || 500)), timeoutMs: 120_000,
        ...(EFFORTS.includes(a.effort) ? { effort: a.effort as 'low' } : {}),
      })
      if (!r.isAnswered) {
        $.ui.toast(`No probable cause: the model call ended with ${r.reason}${'status' in r && r.status ? ` (HTTP ${r.status})` : ''}.`)
        return
      }
      const u = r.usage
      const done: BugAnalysis = { id: item.id, key: analysisKey(item, ev), text: r.text.trim(), model,
        input: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), output: u?.output_tokens ?? 0,
        at: new Date().toISOString() }
      await update($, bugsAnS, cur => ({ ...(cur ?? {}), [String(item.id)]: done }))
      try {
        await $.fs.write(`${w.dir}/items/${item.id}.analysis.json`, JSON.stringify(done, null, 1) + '\n')
      } catch {
        // kept for this session only
      }
    })
    // the command for a new chat, on the clipboard: a mod cannot open a chat, so the person pastes it into one
    const copyCommand = (id: number) => void (async () => {
      const w = await where()
      if (!w) return
      const cmd = sddCommand(id)
      try {
        const r = await $.process.run(clipboardArgvFor(cmd, /^[A-Za-z]:/.test(w.root)), { cwd: w.root, timeoutMs: 10000 })
        $.ui.toast(r.exitCode === 0
          ? `Copied "${cmd}". Paste it in a new chat to ${sddState(s, id).label.toLowerCase()}.`
          : `Could not copy ${cmd}: ${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.exitCode}`}`)
      } catch (err) {
        $.ui.toast(`Could not copy ${cmd}: ${String(err).slice(0, 160)}`)
      }
    })()
    const here = (id: number) => void (async () => {
      await $.prompt.fill({ text: sddCommand(id) })
      $.ui.toast(`${sddCommand(id)} is in the prompt box: press Enter to run it in this chat.`)
    })()
    const stage = (item: BugRecord, field: string, value: string) => void bugsStage($, p =>
      stageChange(p, { id: item.id, kind: 'field', field, value, was: currentValue(item, field) }, people(index), now))
    const stageAll = (field: string, value: string) => void bugsStage($, p => {
      let out = p
      for (const id of picked) {
        const item = index?.items.find(i => i.id === id)
        if (item) out = stageChange(out, { id, kind: 'field', field, value, was: currentValue(item, field) }, people(index), now)
      }
      return out
    })
    const tag = (id: number, kind: 'tagAdd' | 'tagRemove', value: string) => {
      const v = value.trim().replace(/;/g, ' ')
      if (!v) return
      void bugsStage($, p => stageChange(p, { id, kind, value: v }, people(index), now))
    }
    const comment = (id: number, text: string) => {
      const problem = commentProblem(text)
      if (problem) {
        $.ui.toast(problem)
        return
      }
      void (async () => {
        await bugsStage($, p => stageChange(p, { id, kind: 'comment', value: text.trim() }, people(index), now))
        await $.state.set(bugsEditS, null)
      })()
    }
    const edit = (key: string | null) => void $.state.set(bugsEditS, editing === key ? null : key)

    // `shown`: how many items the filters leave, once the list is worked out
    const drawHeader = (shown?: number) => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">🐞 Bugs and issues</Text>
          </Box>
          {busy && <Text color={C.now}>{`⟳ ${BUSY_WORD[busy] ?? busy}…`}</Text>}
          <Button key="bugs-sync" label="↻ Sync from ADO" onPress={sync} />
          <Button key="bugs-config" label="⚙ Config" onPress={openConfig} />
        </Box>
        {index && (
          <Text dimColor wrap="truncate-end">
            {`${countText(shown ?? index.count, index.count)} · ${index.org}${index.projects.length ? ` / ${index.projects.join(', ')}` : ''} · synced ${ago(index.syncedAt, now) || 'never'}${ago(index.syncedAt, now) && ago(index.syncedAt, now) !== 'now' ? ' ago' : ''}${index.me?.email ? ` · you are ${index.me.email}` : ''}`}
          </Text>
        )}
        {why && <Text color={C.now} wrap="wrap">{why}</Text>}
      </Box>
    )

    if (!index || !cfg) {
      return (
        <Box flexDirection="column" width={cols} gap={1}>
          {drawHeader()}
          <Text dimColor wrap="wrap">The bug manager reads the bugs and issues Sync pulls from ADO into the spec folder. Sync needs PowerShell and an az login.</Text>
        </Box>
      )
    }

    const team = people(index)
    // the items as they will be once the staged changes are saved, so the categories and their counts move as you stage
    const shownItems = index.items.map(i => withPending(i, pending, team))
    const cats = categorize(shownItems, cfg.categories ?? [], index.me, now)
    const list = sortItems(filterItems(shownItems, filter, cats, index.me, cfg.doneStates ?? [], devTeam), filter.sort)
    const size = Math.max(8, (e.viewport?.rows ?? 40) - 16)
    const start = from < list.length ? from : 0
    const page = list.slice(start, start + size)
    const chips = chipCounts(shownItems, filter, cats, index.me, cfg.doneStates ?? [], devTeam)  // chips and header follow the filters
    const groups = pendingByItem(pending)
    const problems = pending.filter(p => p.problem)
    const states = [...new Set(index.items.map(i => i.state))].sort()
    const allStates = [...new Set([...Object.values(cfg.states ?? {}).flat(), ...states])]
    const areas = pathOptions(index.items, 'area')
    const iterations = pathOptions(index.items, 'iteration')
    const stateColor = (st: string) => /resolv|done|deploy/i.test(st) ? C.done : /activ|progress|commit/i.test(st) ? C.now : /clos|remov/i.test(st) ? C.dim : C.work
    const opt = (values: string[], label = (v: string) => v) => values.map(v => ({ value: v, label: label(v) }))

    // ---- filters: words, order, type, state, mine, and the categories as chips
    const filters = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          {Input && (
            <Box flexGrow={1} flexShrink={1} minWidth={20}>
              <Input key="bugs-search" placeholder="Search id, title, tag, person, path" submitLabel="search" value={filter.text}
                onSubmit={v => setFilter({ text: v.trim() })} />
            </Box>
          )}
          {filter.text && <Button key="bugs-search-clear" label="✕ clear search" onPress={() => setFilter({ text: '' })} />}
          <Button key="bugs-mine" label={`${filter.mine ? '☑' : '☐'} Assigned to me`} variant={filter.mine ? 'primary' : undefined}
            onPress={() => setFilter({ mine: !filter.mine })} />
          <Button key="bugs-team" label={`${filter.team ? '☑' : '☐'} Dev team`} variant={filter.team ? 'primary' : undefined}
            onPress={() => {
              if (!filter.team && !devTeam) {
                $.ui.toast(`No dev team: ${cfg.developersFile} is missing, or names no developer and no area. It looks like { "areaPath": "A; A\\\\B\\\\*", "developers": ["Name", ...] }.`)
                return
              }
              setFilter({ team: !filter.team })
            }} />
          <Button key="bugs-open" label={`${filter.hideDone ? '☑' : '☐'} Hide resolved/closed`} variant={filter.hideDone ? 'primary' : undefined}
            onPress={() => setFilter({ hideDone: !filter.hideDone })} />
        </Box>
        {Select && (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Select key="bugs-sort" label="Sort" value={filter.sort} onSelect={v => setFilter({ sort: v as BugFilter['sort'] })}
              options={[{ value: 'priority', label: 'Priority' }, { value: 'severity', label: 'Severity' }, { value: 'changed', label: 'Last changed' },
                { value: 'created', label: 'Newest' }, { value: 'id', label: 'Id' }]} />
            <Select key="bugs-type" label="Type" value={filter.type || '*'} onSelect={v => setFilter({ type: v === '*' ? '' : v })}
              options={[{ value: '*', label: 'All' }, ...opt(cfg.types ?? [])]} />
            <Select key="bugs-state" label="State" value={filter.state || '*'} onSelect={v => setFilter({ state: v === '*' ? '' : v })}
              options={[{ value: '*', label: 'All' }, ...opt(states.includes(filter.state) || !filter.state ? states : [...states, filter.state])]} />
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="cat-all" label={`All ${chips.all}`} variant={filter.category === 'all' ? 'primary' : undefined} onPress={() => setFilter({ category: 'all' })} />
          {cats.map(c => (
            <Button key={`cat-${c.id}`} variant={filter.category === c.id ? 'primary' : undefined}
              onPress={() => setFilter({ category: filter.category === c.id ? 'all' : c.id })}>
              <Text color={filter.category === c.id ? undefined : c.color}>{c.icon}</Text>{` ${c.label} `}<Text dimColor={filter.category !== c.id}>{String(chips.by[c.id] ?? 0)}</Text>
            </Button>
          ))}
        </Box>
      </Box>
    )

    // ---- the staged changes: save them, revert them, all or some
    const staged = pending.length > 0 && (
      <Box flexDirection="column" borderStyle="round" borderColor={problems.length ? C.revoked : C.now} paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold color={C.now} wrap="truncate-end">
              {`✎ ${pending.length} unsaved change${pending.length === 1 ? '' : 's'} on ${groups.length} item${groups.length === 1 ? '' : 's'}${problems.length ? ` · ⚠ ${problems.length} not saved last time` : ''}`}
            </Text>
          </Box>
          <Button key="pend-review" label={review ? 'Hide list' : 'Review'} onPress={() => void $.state.set(bugsReviewS, !review)} />
          <Button key="pend-save" variant="primary" label="Save all to ADO" onPress={() => save()} />
          <Button key="pend-revert" label="Revert all" onPress={() => edit('revert-all')} />
        </Box>
        {editing === 'revert-all' && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color={C.revoked}>{`Drop all ${pending.length} staged changes? Nothing was sent to ADO.`}</Text>
            <Button key="pend-revert-yes" label="Yes, revert all" onPress={() => void (async () => {
              await bugsStage($, () => [])
              await $.state.set(bugsEditS, null)
              $.ui.toast('All staged changes reverted.')
            })()} />
            <Button key="pend-revert-no" label="Keep them" onPress={() => edit(null)} />
          </Box>
        )}
        {review && groups.map(g => {
          const item = index.items.find(i => i.id === g.id)
          return (
            <Box key={`pend-${g.id}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button key={`pend-open-${g.id}`} plain label={`${g.id} ${item?.title ?? '(not in the list any more)'}`}
                    onPress={() => void bugsToggle($, g.id, openId === g.id)} />
                </Box>
                <Button key={`pend-save-${g.id}`} label="Save item" onPress={() => save(g.id)} />
                <Button key={`pend-undo-${g.id}`} label="↶ Revert item" onPress={() => void bugsStage($, p => revertItem(p, g.id))} />
              </Box>
              {g.changes.map(c => (
                <Box key={`chg-${c.key}`} flexDirection="column" marginLeft={2}>
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Button key={`chg-undo-${c.key}`} plain label="↶" onPress={() => void bugsStage($, p => revertChange(p, c.key))} />
                    <Box flexGrow={1} flexShrink={1} minWidth={0}><Text wrap="truncate-end">{c.label}</Text></Box>
                    {c.problem?.kind === 'conflict' && (
                      <Button key={`chg-mine-${c.key}`} label="Keep mine" onPress={() => void bugsStage($, p => keepMine(p, c.key))} />
                    )}
                  </Box>
                  {c.problem && <Box marginLeft={2}><Text color={C.revoked} wrap="wrap">{`⚠ ${c.problem.text}`}</Text></Box>}
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )

    // ---- the items ticked for one change to all of them
    const bulk = picked.length > 0 && Select && (
      <Box flexDirection="column" borderStyle="round" borderColor={C.gate} paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1}><Text bold color={C.gate}>{`☑ ${picked.length} picked: change them all at once`}</Text></Box>
          <Button key="bulk-clear" label="Clear picks" onPress={() => void $.state.set(bugsPickedS, [])} />
        </Box>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Select key="bulk-state" label="State" value="*" options={[{ value: '*', label: '—' }, ...opt(allStates)]}
            onSelect={v => { if (v !== '*') stageAll(F.state, v) }} />
          <Select key="bulk-severity" label="Severity" value="*" options={[{ value: '*', label: '—' }, ...opt(cfg.severities ?? [])]}
            onSelect={v => { if (v !== '*') stageAll(F.severity, v) }} />
          <Select key="bulk-priority" label="Priority" value="*" options={[{ value: '*', label: '—' }, ...opt((cfg.priorities ?? []).map(String))]}
            onSelect={v => { if (v !== '*') stageAll(F.priority, v) }} />
          <Select key="bulk-assign" label="Assign" value="*"
            options={[{ value: '*', label: '—' }, { value: '-', label: 'Nobody' }, ...team.map(p => ({ value: p.email, label: p.email === index.me?.email ? `${p.name} (me)` : p.name }))]}
            onSelect={v => { if (v !== '*') stageAll(F.assigned, v === '-' ? '' : v) }} />
          <Select key="bulk-iteration" label="Iteration" value="*" options={[{ value: '*', label: '—' }, ...opt(iterations)]}
            onSelect={v => { if (v !== '*') stageAll(F.iteration, v) }} />
          <Select key="bulk-area" label="Area" value="*" options={[{ value: '*', label: '—' }, ...opt(areas)]}
            onSelect={v => { if (v !== '*') stageAll(F.area, v) }} />
        </Box>
        {Input && (
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}><Input key={`bulk-tag-${pending.length}`} placeholder="Add a tag to all picked" submitLabel="add tag" onSubmit={v => {
              for (const id of picked) tag(id, 'tagAdd', v)
            }} /></Box>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" width={cols} gap={1}>
        {drawHeader(list.length)}
        {filters}
        {staged}
        {bulk}
        <Box flexDirection="column">
          {list.length > 0 && (
            // the columns of the rows below, with the same widths
            <Box key="bugs-columns" flexDirection="row" gap={1} alignItems="center">
              <Button key="pick-page" plain label={page.every(i => picked.includes(i.id)) ? '☑' : '☐'} onPress={() => void update($, bugsPickedS, cur => {
                const ids = page.map(i => i.id)
                const all = ids.every(x => (cur ?? []).includes(x))
                return all ? (cur ?? []).filter(x => !ids.includes(x)) : [...new Set([...(cur ?? []), ...ids])]
              })} />
              <Text dimColor>{'● ⋯'}</Text>
              <Box width={7} flexShrink={0}><Text dimColor>Id</Text></Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{`Title · ${list.length} shown · ● severity 1 red, 2 orange, 3 amber`}</Text></Box>
              <Text dimColor>State</Text>
              <Box width={12} flexShrink={0}><Text dimColor>Assigned</Text></Box>
              <Box width={3} flexShrink={0}><Text dimColor>Pri</Text></Box>
              <Box width={4} flexShrink={0}><Text dimColor>Age</Text></Box>
            </Box>
          )}
          {list.length === 0 && <Text dimColor wrap="wrap">{index.items.length ? `Nothing matches these filters.${filter.hideDone ? ' Resolved and closed items are hidden: untick "Hide resolved/closed" to see them.' : ''}${filter.team ? ' Only the dev team\'s items (its developers\', and its area paths\') are shown: untick "Dev team" to see everyone\'s.' : ''}` : 'The query found no bugs or issues. Check "bugs.query" in .claude/sdd.json.'}</Text>}
          {page.map(item => drawRow(item))}
        </Box>
        {list.length > size && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>{`${start + 1}-${Math.min(list.length, start + size)} of ${list.length}`}</Text>
            {start > 0 && <Button key="bugs-prev" label="◀ Prev" onPress={() => void $.state.set(bugsOffS, Math.max(0, start - size))} />}
            {start + size < list.length && <Button key="bugs-next" label="Next ▶" onPress={() => void $.state.set(bugsOffS, start + size)} />}
          </Box>
        )}
      </Box>
    )

    function drawRow(item: BugRecord) {
      const isOpen = openId === item.id
      const isPicked = picked.includes(item.id)
      const mine = pending.filter(p => p.id === item.id)
      const bad = mine.some(p => p.problem)
      return (
        <Box key={`bugbox-${item.id}`} flexDirection="column">
          <Box key={`bugrow-${item.id}`} flexDirection="row" gap={1} alignItems="center" backgroundColor={isOpen ? tint : isPicked ? pickTint : undefined}>
            <Button key={`pick-${item.id}`} plain label={isPicked ? '☑' : '☐'}
              onPress={() => void update($, bugsPickedS, cur => isPicked ? (cur ?? []).filter(x => x !== item.id) : [...(cur ?? []), item.id])} />
            <Text color={severityColor(item.severity)}>●</Text>
            <Text>{typeIcon(item.type)}</Text>
            <Box width={7} flexShrink={0}><Text dimColor>{String(item.id)}</Text></Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`bug-${item.id}`} plain label={`${isOpen ? '▾' : '▸'} ${item.title}`} onPress={() => void bugsToggle($, item.id, isOpen)} />
            </Box>
            {mine.length > 0 && <Text bold color={bad ? C.revoked : C.now}>{`${bad ? '⚠' : '✎'}${mine.length}`}</Text>}
            <Text color={stateColor(item.state)}>{item.state}</Text>
            <Box width={12} flexShrink={0}><Text dimColor={!isMine(item, index!.me)} color={isMine(item, index!.me) ? C.work : undefined} wrap="truncate-end">{shortName(item.assigned)}</Text></Box>
            <Box width={3} flexShrink={0}><Text dimColor>{item.priority != null ? `P${item.priority}` : ''}</Text></Box>
            <Box width={4} flexShrink={0}><Text dimColor>{ago(item.changed, now)}</Text></Box>
          </Box>
          {isOpen && drawDetail(item, index!.items.find(i => i.id === item.id) ?? item)}
        </Box>
      )
    }

    /** The open item: its facts, triage, tags, comment, staged changes, links, text, probable cause and sdd. */
    function drawDetail(item: BugRecord, original: BugRecord) {
      const id = item.id
      const mine = pending.filter(p => p.id === id)
      const inCats = cats.filter(c => c.ids.includes(id))
      const d = detail && detail.id === id ? detail : null
      const ev = evidence && evidence.id === id ? evidence : null
      const a = analyses[String(id)]
      const fresh = !!a && a.key === analysisKey(original, ev)
      const flow = sddState(s, id)
      const more = editing === `more-${id}`
      const text = d?.text ?? {}
      const body = [['Repro steps', text.repro], ['Description', text.description], ['System info', text.systemInfo], ['Acceptance criteria', text.acceptance],
        ['Root cause', text.rootCause], ['Resolution', text.resolution]].filter(([, v]) => v) as Array<[string, string]>
      const longBody = body.reduce((n, [, v]) => n + v.length, 0) > 700
      // ADO's reason belongs to the state it holds: a staged state has none yet
      const facts = [item.type, item.reason && item.state === original.state ? `${item.state} (${item.reason})` : item.state, item.severity && `severity ${item.severity}`,
        item.priority != null && `priority ${item.priority}`, item.effort != null && `effort ${item.effort}`, item.boardColumn && `board: ${item.boardColumn}`,
        `created ${ago(item.created, now)} ago${item.createdBy ? ` by ${item.createdBy.name}` : ''}`, `changed ${ago(item.changed, now)} ago`].filter(Boolean).join(' · ')
      const pickPath = (field: string, values: string[], current: string, other: string) => Select && (
        <Select key={`${other}-${id}`} label={FIELD_NAME[field]} value={current}
          options={[...opt(values.includes(current) ? values : [current, ...values], v => v.split('\\').slice(1).join(' › ') || v), { value: '+other', label: 'Other…' }]}
          onSelect={v => v === '+other' ? edit(`${other}-${id}`) : stage(original, field, v)} />
      )
      return (
        <Box key={`bugdetail-${id}`} flexDirection="column" marginLeft={2} marginBottom={1} paddingX={1} gap={1} borderStyle="round" borderColor={C.line}>
          <Box flexDirection="column">
            <Text bold wrap="wrap">{`${typeIcon(item.type)} ${item.id} ${item.title}`}</Text>
            <Text dimColor wrap="wrap">{facts}</Text>
            {inCats.length > 0 && (
              <Box flexDirection="row" gap={2} flexWrap="wrap">
                {inCats.map(c => <Text key={`incat-${id}-${c.id}`} color={c.color}>{`${c.icon} ${c.label}`}</Text>)}
              </Box>
            )}
          </Box>

          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor wrap="wrap">{flow.note}</Text></Box>
            <Button key={`copy-${id}`} variant="primary" label={`📋 Copy ${sddCommand(id)}`} onPress={() => copyCommand(id)} />
            <Button key={`here-${id}`} label="In this chat" onPress={() => here(id)} />
          </Box>

          {Select && (
            <Box flexDirection="column" gap={1}>
              <Text bold>Triage</Text>
              <Box flexDirection="row" gap={2} flexWrap="wrap">
                <Select key={`state-${id}`} label="State" value={item.state} options={opt(stateOptions(cfg!, item))} onSelect={v => stage(original, F.state, v)} />
                <Select key={`sev-${id}`} label="Severity" value={item.severity || '*'}
                  options={[...(item.severity ? [] : [{ value: '*', label: '—' }]), ...opt((cfg!.severities ?? []).includes(item.severity) || !item.severity ? cfg!.severities ?? [] : [item.severity, ...(cfg!.severities ?? [])])]}
                  onSelect={v => { if (v !== '*') stage(original, F.severity, v) }} />
                <Select key={`prio-${id}`} label="Priority" value={item.priority != null ? String(item.priority) : '*'}
                  options={[...(item.priority != null ? [] : [{ value: '*', label: '—' }]),
                    ...opt([...new Set([...(item.priority != null ? [String(item.priority)] : []), ...(cfg!.priorities ?? []).map(String)])])]}
                  onSelect={v => { if (v !== '*') stage(original, F.priority, v) }} />
                <Select key={`assign-${id}`} label="Assigned to" value={item.assigned?.email || (item.assigned ? '+keep' : '-')}
                  options={[{ value: '-', label: 'Nobody' }, ...(item.assigned && !item.assigned.email ? [{ value: '+keep', label: item.assigned.name }] : []),
                    ...[...team, ...(item.assigned?.email && !team.some(p => p.email === item.assigned!.email) ? [item.assigned] : [])]
                      .map(p => ({ value: p.email, label: p.email === index!.me?.email ? `${p.name} (me)` : p.name })),
                    { value: '+other', label: 'Someone else…' }]}
                  onSelect={v => v === '+other' ? edit(`assign-${id}`) : v === '+keep' ? undefined : stage(original, F.assigned, v === '-' ? '' : v)} />
              </Box>
              <Box flexDirection="row" gap={2} flexWrap="wrap">
                {pickPath(F.area, areas, item.area, 'area')}
                {pickPath(F.iteration, iterations, item.iteration, 'iteration')}
              </Box>
              {Input && ['assign', 'area', 'iteration'].map(k => editing === `${k}-${id}` && (
                <Box key={`other-${k}-${id}`} flexDirection="row" gap={1} alignItems="center">
                  <Button key={`other-x-${k}-${id}`} label="X" role="dismiss" onPress={() => edit(null)} />
                  <Box flexGrow={1}>
                    <Input key={`other-in-${k}-${id}`} autoFocus submitLabel="stage"
                      placeholder={k === 'assign' ? 'Their e-mail, as ADO knows them' : `The full ${k} path, e.g. ${(k === 'area' ? item.area : item.iteration) || 'Project\\Team'}`}
                      onSubmit={v => {
                        const val = v.trim()
                        if (!val) return
                        if (k === 'assign' && !val.includes('@')) {
                          $.ui.toast('Type their e-mail address (ADO assigns by e-mail).')
                          return
                        }
                        stage(original, k === 'assign' ? F.assigned : k === 'area' ? F.area : F.iteration, k === 'assign' ? val.toLowerCase() : val)
                        edit(null)
                      }} />
                  </Box>
                </Box>
              ))}
            </Box>
          )}

          <Box flexDirection="column">
            <Text bold>Tags</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
              {item.tags.length === 0 && <Text dimColor>No tags.</Text>}
              {item.tags.map(tg => {
                const isNew = !original.tags.some(x => x.toLowerCase() === tg.toLowerCase())
                return <Button key={`tag-${id}-${tg}`} label={`${tg} ✕`} variant={isNew ? 'primary' : undefined} onPress={() => tag(id, 'tagRemove', tg)} />
              })}
              {original.tags.filter(tg => !item.tags.some(x => x.toLowerCase() === tg.toLowerCase())).map(tg => (
                <Button key={`untag-${id}-${tg}`} label={`↶ ${tg} (to remove)`} onPress={() => tag(id, 'tagAdd', tg)} />
              ))}
            </Box>
            {Input && (
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Box flexGrow={1}><Input key={`tag-in-${id}-${mine.filter(c => c.kind === 'tagAdd').length}`} placeholder={`Add a tag (${tagOptions(index!.items).slice(0, 4).join(', ') || 'e.g. Quick Win'})`} submitLabel="add tag" onSubmit={v => tag(id, 'tagAdd', v)} /></Box>
              </Box>
            )}
          </Box>

          {Input && (
            <Box flexDirection="column">
              <Text bold>Comment</Text>
              <Input key={`comment-${id}-${mine.filter(c => c.kind === 'comment').length}`} rows={3} placeholder="Write a comment. It is posted when you save the batch. Write ADO 1234, not #1234." submitLabel="stage comment"
                onSubmit={v => comment(id, v)} />
            </Box>
          )}

          {mine.length > 0 && (
            <Box flexDirection="column" borderStyle="round" borderColor={C.now} paddingX={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box flexGrow={1}><Text bold color={C.now}>{`✎ ${mine.length} staged on this item, not saved to ADO yet`}</Text></Box>
                <Button key={`item-save-${id}`} variant="primary" label="Save this item" onPress={() => save(id)} />
                <Button key={`item-undo-${id}`} label="↶ Revert item" onPress={() => void bugsStage($, p => revertItem(p, id))} />
              </Box>
              {mine.map(c => (
                <Box key={`ichg-${c.key}`} flexDirection="column">
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Button key={`ichg-undo-${c.key}`} plain label="↶" onPress={() => void bugsStage($, p => revertChange(p, c.key))} />
                    <Box flexGrow={1} flexShrink={1} minWidth={0}><Text wrap="truncate-end">{c.label}</Text></Box>
                    {c.problem?.kind === 'conflict' && <Button key={`ichg-mine-${c.key}`} label="Keep mine" onPress={() => void bugsStage($, p => keepMine(p, c.key))} />}
                  </Box>
                  {c.problem && <Box marginLeft={2}><Text color={C.revoked} wrap="wrap">{`⚠ ${c.problem.text}`}</Text></Box>}
                </Box>
              ))}
            </Box>
          )}

          <Box flexDirection="column">
            <Text bold>Links</Text>
            <Markdown text={itemLinks(original, index!.org).map(l => `- ${l}`).join('\n')} />
          </Box>

          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center">
              <Box flexGrow={1}><Text bold>Report</Text></Box>
              <Button key={`refresh-${id}`} label="↻ Read again from ADO" onPress={() => refresh(id)} />
            </Box>
            {body.length === 0 && <Text dimColor wrap="wrap">No repro steps or description were synced. Read it again from ADO.</Text>}
            {body.map(([label, v]) => (
              <Box key={`body-${id}-${label}`} flexDirection="column">
                <Text dimColor>{label}</Text>
                <Text wrap="wrap">{more || v.length <= 700 ? v : `${v.slice(0, 700)} …`}</Text>
              </Box>
            ))}
            {longBody && <Button key={`more-${id}`} plain label={more ? 'Show less' : 'Show all'} onPress={() => edit(`more-${id}`)} />}
            {(d?.comments ?? []).length > 0 && <Text dimColor>{`Latest comments (${Math.min(3, d!.comments.length)} of ${d!.comments.length})`}</Text>}
            {(d?.comments ?? []).slice(0, 3).map((c, n) => (
              <Box key={`cmt-${id}-${n}`} flexDirection="column">
                <Text dimColor>{`💬 ${c.by}${c.at ? ` · ${ago(c.at, now)} ago` : ''}`}</Text>
                <Text wrap="wrap">{c.text.length > 400 && !more ? `${c.text.slice(0, 400)} …` : c.text}</Text>
              </Box>
            ))}
          </Box>

          <Box flexDirection="column" borderStyle="round" borderColor={C.gate} paddingX={1}>
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Box flexGrow={1}><Text bold color={C.gate}>🔎 Probable cause</Text></Box>
              <Button key={`ev-${id}`} label="Evidence only (no tokens)" onPress={() => findEvidence(id)} />
              <Button key={`an-${id}`} variant={a ? undefined : 'primary'} label={a ? 'Analyse again' : `Find probable cause (${cfg!.analysis?.model || 'haiku'})`}
                onPress={() => analyse(original, d, ev)} />
            </Box>
            {!a && !ev && <Text dimColor wrap="wrap">Evidence searches the local repos with git: no tokens. The probable cause sends the report and that evidence to the model once, in a short prompt, and keeps the answer.</Text>}
            {a && (
              <Box flexDirection="column">
                <Markdown text={a.text} />
                <Text dimColor wrap="wrap">{analysisNote(a, fresh)}</Text>
              </Box>
            )}
            {ev && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor wrap="wrap">{`Searched ${ev.repos.join(', ') || 'no repos'} for ${ev.terms.join(', ') || 'nothing'} (${ev.seconds}s)`}</Text>
                {ev.hits.length === 0 && <Text dimColor>No match in the repos.</Text>}
                {ev.hits.slice(0, 6).map((hit, n) => (
                  <Text key={`hit-${id}-${n}`} wrap="truncate-end">{`· ${hit.repo}/${hit.path}:${hit.line}  ${hit.text}`}</Text>
                ))}
                {ev.linked.map((l, n) => <Text key={`lnk-${id}-${n}`} dimColor wrap="truncate-end">{`⎇ ${l.repo} ${l.commit}`}</Text>)}
              </Box>
            )}
          </Box>

        </Box>
      )
    }
  })

  on('session.start', async ($, e, next) => {
    await setupDesktop($)
    return next(e)
  })

  // the Desktop app can attach after the session started
  on('session.attach', async ($, e, next) => {
    if (e.surface === 'desktop') await setupDesktop($, true)
    return next(e)
  })

  // This chat's work item is the one it runs /sdd for. The view follows it, and opens by itself the
  // first time the chat takes one up (once per session; "view.autoOpen": false in sdd.json turns it off).
  for (const command of ['sdd', 'sdd:sdd'] as const) {
    on('command.run', { command }, async ($, e, next) => {
      if (!desktopReady) return next(e)
      const id = idFromArgs(e.args)
      if (id != null) {
        await $.state.set(mine, id)
        await $.state.set(home, id)
        await $.state.set(selected, id)
        const v = await loadView($, id, (await $.state.get(snap)).value ?? null, (await $.state.get(place)).value ?? null)
        await $.state.set(snap, v.out)
        await $.state.set(error, v.why)
        if (v.out && v.out.autoOpen !== false && !(await $.state.get(autoOpened)).value) {
          await $.state.set(autoOpened, true)
          await openPane($, id)
        }
      }
      return next(e)
    })
  }

  on('command.run', { command: 'sdd-view' }, async ($, e) => {
    if (!desktopReady) return { text: 'The sdd view works in the Claude Desktop app only.' }
    return { text: await openSddView($, e.args) }
  })

  on('ui.close', async ($, e, next) => {
    if (!desktopReady) return next(e)
    if (e.id === PANE) isOpen = false
    if (e.id === WT_PANE) wtOpen = false
    if (e.id === BUG_PANE) bugsPaneOpen = false
    return next(e)
  })

  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (!desktopReady) return next(e)
      const ran = await next(e)
      const cmd = String((e as { command?: unknown }).command ?? '')
      if (SCRIPT_RUN.test(cmd)) {
        const id = idFromScript(cmd)
        if (id != null && id !== ((await $.state.get(mine)).value ?? null)) {
          await $.state.set(mine, id)
          await $.state.set(selected, id)
        }
        // a chat that never ran /sdd belongs to the first item its scripts name
        if (id != null && (await $.state.get(home)).value == null) await $.state.set(home, id)
        const v = await loadView($, id ?? (await $.state.get(selected)).value ?? null, (await $.state.get(snap)).value ?? null, (await $.state.get(place)).value ?? null)
        await $.state.set(snap, v.out)
        await $.state.set(error, v.why)
        if (id != null && v.out && v.out.autoOpen !== false && !(await $.state.get(autoOpened)).value) {
          await $.state.set(autoOpened, true)
          await openPane($, id)
        }
      }
      return ran
    })
  }

  // Claude's questions about this chat's item are kept, so the stage's feedback box shows them as the
  // chat's dialog does. While that dialog is open, an answer from the view settles this call first:
  // the chat's dialog is dropped and Claude reads the answer as the tool's own result.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!desktopReady) return next(e)
    const own = (await $.state.get(mine)).value ?? null
    const questions = (e as { questions?: unknown }).questions
    if (own == null || !e.tool_use_id || !Array.isArray(questions)) return next(e)
    const ask: SddAsk = { id: own, at: new Date().toISOString(), toolUseId: e.tool_use_id, questions: questions as SddQuestion[], isOpen: true }
    const before = (await $.state.get(asked)).value ?? null
    await $.state.set(asked, ask)
    await $.state.set(picks, {})
    const fromView = new Promise<Record<string, string>>(resolve => answering.set(ask.toolUseId, resolve))
    const inChat = next(e)
    inChat.catch(() => undefined)  // dropped once the view answers
    let isAsked = true
    try {
      const first = await Promise.race([inChat.then(r => ({ r })), fromView.then(a => ({ a }))])
      if ('a' in first) return { result: { questions: ask.questions, answers: first.a } }
      // refused before it was shown (the question guard): nothing was asked
      if ('deny' in first.r && first.r.deny) isAsked = false
      return first.r
    } finally {
      answering.delete(ask.toolUseId)
      await $.state.set(asked, isAsked ? { ...ask, isOpen: false } : before)
    }
  })

  // a subagent's turn starts: the pane's agent rows may have a new one
  on('turn.start', async ($, e, next) => {
    if (!desktopReady) return next(e)
    if (!e.agentId) {
      if (staleBaseline) {
        staleBaseline = false
        await baseline($)
      }
      await flushCost($, (await $.state.get(place)).value ?? null)  // what the last turn left unrecorded goes to its own stage first
      // the main loop's turn: the stage the chat's item is in as it begins is the stage the turn is charged to
      const s = (await $.state.get(snap)).value ?? null
      // the item the chat took up with /sdd, not the one a script run last named
      const own = (await $.state.get(home)).value ?? (await $.state.get(mine)).value ?? null
      const item = s?.items.find(i => i.id === own)
      const flow = item ? s?.flows[item.flow] : undefined
      const key = item && flow ? phaseKey(flow, item.progress?.phase) : null
      turnOf = item && key ? { id: item.id, key } : null
      turnCounted = false
    }
    if (isOpen) $.ui.invalidate('ui.render')
    return next(e)
  })

  // after each turn: what the session spent over it goes to the stage the turn began in; the context fill is kept for the pane and band
  on('session.measure', async ($, e, next) => {
    if (!desktopReady) return next(e)
    if (e.context.percent != null) ctx = { percent: e.context.percent, window: e.context.window }
    const usd = e.cost?.usd
    if (usd == null && !pend.input && !pend.output) costWhy = 'the session reports no cost'
    if (usd != null) {
      const delta = lastUsd == null ? 0 : usd - lastUsd
      lastUsd = usd
      if (delta > 0) pend.usd += delta
    }
    if (await flushCost($, (await $.state.get(place)).value ?? null) && (isOpen || isWorkspace)) {
      // the pane and the stage rows show the new total at once, not at the next refresh
      const v = await loadView($, (await $.state.get(selected)).value ?? null, (await $.state.get(snap)).value ?? null, (await $.state.get(place)).value ?? null)
      await $.state.set(snap, v.out)
      await $.state.set(error, v.why)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // /clear, /resume and /branch end the session this mod measured: the session id and the cost total are another
  // session's from here. The new baseline is read as the next turn begins (session.end fires before the change).
  on('session.end', async ($, e, next) => {
    if (!desktopReady) return next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      staleBaseline = true
      turnOf = null
      pend = nothing()
      turnCounted = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!desktopReady) return next(e)
    // what the turn's responses used, for every loop: a sub-agent's tokens are part of what the item cost too
    const u = e.usage
    if (u) {
      pend.input += u.input_tokens ?? 0
      pend.output += u.output_tokens ?? 0
      pend.cacheRead += u.cache_read_input_tokens ?? 0
      pend.cacheWrite += u.cache_creation_input_tokens ?? 0
      pend.model = u.model || pend.model
    }
    await flushCost($, (await $.state.get(place)).value ?? null)
    if (isOpen || isWorkspace) {
      const v = await loadView($, (await $.state.get(selected)).value ?? null, (await $.state.get(snap)).value ?? null, (await $.state.get(place)).value ?? null)
      await $.state.set(snap, v.out)
      await $.state.set(error, v.why)
      // this chat's item waits on the person: one system notification per wait, for a person who looked away
      const own = (await $.state.get(mine)).value ?? null
      const item = v.out?.items.find(i => i.id === own)
      const turn = item ? yourTurn(v.out?.flows[item.flow], item) : null
      if (turn && turn.key !== notified) {
        notified = turn.key
        try {
          await $.ui.notify(turn.text)
        } catch {
          // no window to notify, or the app refused: the band and the pane already say it
        }
      }
    }
    return next(e)
  })

  // ---------------------------------------------------------------- the prompt box

  // after `/sdd ` the prompt box offers this workspace's open work items by id or by a word of the title
  on('prompt.autocomplete', async ($, e, next) => {
    if (!desktopReady) return next(e)
    const s = (await $.state.get(snap)).value ?? null
    const start = e.start ?? e.cursor - e.token.length
    const suggestions = s ? itemSuggestions(s, e.text.slice(0, start), e.token) : []
    return suggestions.length ? { suggestions } : next(e)
  })

  // ---------------------------------------------------------------- the spinner

  // while Claude works: this chat's item, its stage, and what it works toward, after the spinner's word
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const s = (await $.state.get(snap)).value ?? null
    const own = (await $.state.get(mine)).value ?? null
    const item = s?.items.find(i => i.id === own)
    const note = item && s ? spinnerNote(s.flows[item.flow], item, s.derived) : null
    if (!note) return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? ''}${note}` } })
  })

  // ---------------------------------------------------------------- band above the prompt

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const s = (await $.state.get(snap)).value ?? null
    paint(s?.colors)
    const own = (await $.state.get(mine)).value ?? null
    // this chat's item while its flow runs: always which flow and path, and loud when it waits on you
    const first = (s?.items ?? []).find(i => i.id === own && !!i.progress && !['done', 'abandoned'].includes(i.progress.status))
    if (!desktopReady || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // the launcher: always there, so a panel opens without typing a command
    const openWorktrees = () => openWorktreesPage($)
    const openRepowatch = () => showRepowatch($)
    const staged = ((await $.state.get(bugsPend)).value ?? []).length  // changes staged in the bug manager and not saved
    const launcher = (
      <Box flexShrink={0} flexDirection="row" gap={1}>
        <Button key="band-bugs" label={staged ? `Bugs ✎${staged}` : 'Bugs'} onPress={() => void openBugsPage($)} />
        <Button key="band-worktrees" label="Worktrees" onPress={openWorktrees} />
        <Button key="band-repowatch" label="repowatch" onPress={openRepowatch} />
      </Box>
    )
    if (!first) {
      return (
        <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
          <Box key="band-text" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden"><Text dimColor wrap="truncate-end">Open a panel</Text></Box>
          <Box flexShrink={0}>
            <Button key="band-open" label="sdd view" onPress={() => void openSddView($, '')} />
          </Box>
          {launcher}
        </Box>
      )
    }
    const tag = flowTag(s?.flows[first.flow], first)
    const waiting = first.progress?.status === 'waiting'
    return (
      <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
        {/* the tag keeps one line and its full width: the spaces in it do not break */}
        <Box key="band-tag" flexShrink={0}>
          <Text bold wrap="truncate-end" color={tag.open ? C.now : C.work}>{`[${tag.brief}]`.replace(/ /g, '\u00a0')}</Text>
        </Box>
        {/* the long text gives way to the button: it may shrink to nothing and is cut, never pushing the button off the edge */}
        <Box key="band-text" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          {waiting
            ? <Text color={C.now} wrap="truncate-end">
                {`${first.id} · ${phaseLabel(s?.flows[first.flow], first)} · waiting on you: ${first.progress?.gate || '—'}`}
              </Text>
            : <Text dimColor wrap="truncate-end">{`${first.id} · ${phaseLabel(s?.flows[first.flow], first)} · ${statusWord(first)}`}</Text>}
        </Box>
        {ctx && contextTone(ctx.percent) !== 'ok' && (
          <Text bold color={contextTone(ctx.percent) === 'high' ? C.revoked : C.now}>{`context ${ctx.percent}%`}</Text>
        )}
        <Box flexShrink={0}>
        <Button key="band-open" label="sdd view" onPress={() => void (async () => {
          await $.state.set(selected, first.id)
          await $.state.set(stage, null)
          await $.state.set(doc, null)
          await openPane($, first.id)
          const v = await loadView($, first.id, s, (await $.state.get(place)).value ?? null)
          await $.state.set(snap, v.out)
          await $.state.set(error, v.why)
        })()} />
        </Box>
        {launcher}
      </Box>
    )
  })

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = t
    const cols = e.props.bodyColumns
    const s = (await $.state.get(snap)).value ?? null
    paint(s?.colors)
    const why = (await $.state.get(error)).value ?? null
    const id = (await $.state.get(selected)).value ?? (await $.state.get(mine)).value ?? null
    // what the presses do; they run after the drawing, so they may write
    const sync = async (to: number | null, isAsked = false) => {
      const v = await loadView($, to, (await $.state.get(snap)).value ?? null, (await $.state.get(place)).value ?? null)
      await $.state.set(snap, v.out)
      await $.state.set(error, v.why)
      // a refresh the person asked for says so, since an item that did not change looks the same
      if (isAsked) $.ui.toast(v.out ? `Refreshed ${stamp(new Date().toISOString())}` : `Refresh failed: ${v.why ?? 'no answer from env.py'}`)
    }
    if (!s) {
      return (
        <Box flexDirection="column" width={cols}>
          <Text bold>sdd view</Text>
          <Text dimColor>{why ?? 'Reading the work items…'}</Text>
          <Text dimColor>The view reads .claude/sdd.json at or above the session folder.</Text>
          <Button key="retry" label="Try again" hotkey="r" onPress={() => void sync(id, true)} />
        </Box>
      )
    }

    const item = id != null ? (s.items.find(i => i.id === id) ?? s.done.find(i => i.id === id)) : undefined
    // a dropdown of the workspace's open work items: picking one makes the pane follow it (the chat's own item is not changed)
    const Select = 'Select' in t ? t.Select : undefined
    const { Svg } = t
    // the label is cut to the room the pane has, so the dropdown does not run off its right edge
    const options = itemOptions(s, item, Math.max(30, Math.min(90, (cols ?? 100) - 24)))
    const pick = (value: string) => void (async () => {
      const to = Number(value)
      if (!Number.isInteger(to)) return
      await $.state.set(selected, to)
      await $.state.set(stage, null)
      await $.state.set(gate, null)
      await $.state.set(doc, null)
      await $.state.set(feedback, null)
      await sync(to)
    })()
    const picker = (isHere: boolean) => Select && options.length > (isHere ? 1 : 0)
      ? <Select key="pick-item" label="Work item" options={options} value={id != null ? String(id) : undefined} onSelect={pick} />
      : null

    // ---- no work item for this chat yet
    if (!item) {
      return (
        <Box flexDirection="column" width={cols} gap={1}>
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}><Text bold>sdd view</Text></Box>
            <Button key="refresh" label="↻" hotkey="r" onPress={() => void sync(id, true)} />
          </Box>
          <Text wrap="wrap">{id != null ? `Work item ${id} is not in this workspace.` : 'This chat is not working on a work item yet.'}</Text>
          <Text dimColor wrap="wrap">Start one with /sdd &lt;id&gt;, or open one with /sdd-view &lt;id&gt;.</Text>
          {picker(false)}
        </Box>
      )
    }

    // ---- one item: a decision log you open row by row
    const flow = s.flows[item.flow]
    const tag = flowTag(flow, item)
    const p = item.progress
    const openGate = (await $.state.get(gate)).value ?? null  // 'gate:Design agreed'
    const open = (await $.state.get(stage)).value ?? null        // 'stage:Design'
    const shown = (await $.state.get(doc)).value ?? null
    const typing = (await $.state.get(feedback)).value ?? null   // the stage whose feedback box is open
    const isDone = p?.status === 'abandoned' || !!item.removed || (p?.status === 'done' && !!flow && flowFinished(flow, item))
    const isWaiting = p?.status === 'waiting'
    const pend = flow ? pendingGate(flow, item, s.derived) : null
    const waitKey = flow && isWaiting ? phaseKey(flow, p?.phase) : null
    // Claude's questions belong to the stage only while the item still waits on that stage
    const lastAsk = (await $.state.get(asked)).value ?? null
    const ask = lastAsk && waitKey && lastAsk.id === item.id && (lastAsk.isOpen || lastAsk.at >= (p?.at ?? '')) ? lastAsk : null
    const picked = (await $.state.get(picks)).value ?? {}
    const canOpen = e.surface !== 'mobile' && !!item.folder && !item.removed
    const hasInput = 'Input' in t
    const Input = hasInput ? t.Input : undefined
    const rows = flow ? stageRows(flow, item) : []
    // the stage the picture shows in detail: the one picked, else the one the item is at
    // a pick is kept as 'stage:KEY@AT', AT being the stage the item was at: once the item moves on, the pick lapses
    const [pickedKey, pickedAt] = open?.startsWith('stage:') ? open.slice('stage:'.length).split('@') : [null, null]
    const atKey = defaultStage(rows)
    // 'stage:@AT' is a pick that closed the stage: none is open
    const shownKey = pickedAt !== atKey ? atKey : pickedKey === '' ? null : rows.some(r => r.stage.key === pickedKey) ? pickedKey : atKey
    const agents = agentRows(await listAgents($))
    const spend = item.spend ?? {}
    agentsBusy = agents.some(a => a.isLive)
    const links = [item.url ? `[ADO ${item.id}](${item.url})` : `ADO ${item.id}`,
      ...Object.values(item.repos ?? {}).filter(r => r.pr).map(r => `[PR ${r.pr!.id}](${r.pr!.url})`)].join('  |  ')
    // a press on a stage opens its detail under it, with nothing of the last one left open; on the open stage it closes it
    const pickStage = (key: string | null) => void (async () => {
      if (!key) return
      await $.state.set(stage, `stage:${key === shownKey ? '' : key}@${defaultStage(rows)}`)
      await $.state.set(gate, null)
      await $.state.set(doc, null)
      await $.state.set(feedback, null)
    })()
    const toggle = (key: string) => void (async () => {
      await $.state.set(stage, open === key ? null : key)
      await $.state.set(gate, null)
      await $.state.set(doc, null)
      await $.state.set(feedback, null)
    })()
    // posted as the person's own message, so it shows in the chat; the flow skill takes it from there
    const post = (text: string, done: string) => void (async () => {
      await $.state.set(feedback, null)
      try {
        const sent = await $.prompt.submit({ text, asUser: true })
        if ('drop' in sent && sent.drop) throw new Error(String(sent.drop))
        $.ui.toast(done)
      } catch (err) {
        await $.prompt.fill({ text })
        $.ui.toast(`Not sent (${String(err).slice(0, 160)}). It is in the prompt box instead.`)
      }
    })()
    // the go-ahead at a spec flow stop: into the open dialog's call when it asks for it, else as the
    // person's own message "sdd approve for <id>, stage <stage>"
    const go = flow ? approveFor(flow, item) : null
    const approve = () => {
      if (!go) return
      if (ask?.isOpen) {
        const answers = approveAnswers(ask.questions, go.option)
        const resolve = answering.get(ask.toolUseId)
        if (!answers || !resolve) {
          $.ui.toast('Claude asked something else in the chat. Answer it there.')
          return
        }
        void $.state.set(picks, {})
        resolve(answers)
        $.ui.toast(`Approved: ${go.key}. Claude goes on.`)
        return
      }
      post(approveMessage(item.id, go.key), `Approved: ${go.key}. Claude goes on.`)
    }
    const refsLine = (refs: string[]) => refs.map(r => refLink(item, r)).filter(Boolean).join('   ')
    // pages and documents open in Claude Code as the app opens any link; only a code link with a line
    // is answered here, to open VS Code at that line, which the app cannot do
    const linkMd = (key: string, text: string) => {
      const files = fileLinks(text).filter(h => fileTarget(h)?.line)
      return files.length
        ? <Markdown key={key} text={text} pressableLinks={files} onLinkPress={link => {
            const target = fileTarget(link.href)
            if (target) void openFile($, target.path, target.line)
          }} />
        : <Markdown text={text} />
    }

    return (
      <Box flexDirection="column" width={cols} gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}><Text bold wrap="wrap">{`${item.id} ${item.title}`}</Text></Box>
            <Button key="refresh" label="↻" hotkey="r" onPress={() => void sync(id, true)} />
          </Box>
          {picker(true)}
          <Box flexDirection="row" gap={1}>
            <Text bold color={C.work}>{`[${tag.flow}]`}</Text>
            {tag.path && <Text bold color={tag.open ? C.now : C.gate}>{`[${tag.path}]`}</Text>}
            <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{`${item.type}, ${item.state} in ADO`}</Text></Box>
          </Box>
          <Markdown text={links} />
          {spendTotal(spend) <= 0 && !tokensLine(spendTokens(spend)) && (
            <Text dimColor wrap="wrap">{`No cost recorded for this item yet${costWhy ? `: ${costWhy}` : '. It shows after the next turn in a chat on this item.'}`}</Text>
          )}
          {tokensLine(spendTokens(spend)) && <Text dimColor wrap="wrap">{`${SPEND_ICON.tokens} Tokens: ${tokensLine(spendTokens(spend), true)}`}</Text>}
          {(spendTotal(spend) > 0 || ctx) && (
            <Box flexDirection="row" gap={2}>
              {spendTotal(spend) > 0 && <Text dimColor>{`${SPEND_ICON.money} Spent ${moneyText(spendTotal(spend))} on this item`}</Text>}
              {ctx && <Text color={{ ok: undefined, warn: C.now, high: C.revoked }[contextTone(ctx.percent)]} dimColor={contextTone(ctx.percent) === 'ok'}>
                {`${SPEND_ICON.context} Context ${ctx.percent}%${contextTone(ctx.percent) === 'ok' ? '' : ' full'}`}
              </Text>}
            </Box>
          )}
        </Box>

        {p && isWaiting && (
          <Box flexDirection="column" borderStyle="round" borderColor={C.now} paddingX={1}>
            <Text bold color={C.now} wrap="wrap">{`Your turn: ${p.gate || 'a decision'}`}</Text>
            {p.next && <Text wrap="wrap">{`Then: ${p.next}`}</Text>}
            {p.note && <Text dimColor wrap="wrap">{p.note}</Text>}
            {go && (
              <Box marginTop={1}>
                <Button key={`approve-${go.key}`} variant="primary" label={go.label} onPress={approve} />
              </Box>
            )}
          </Box>
        )}
        {p && !isWaiting && (
          <Text color={markColor(p.status as Mark)} wrap="wrap">
            {isDone ? `This item is ${p.status}${item.removed ? ` since ${when(item.removed)}` : ''}.` : `Now: ${phaseLabel(flow, item)}, ${statusWord(item)}.`}
          </Text>
        )}
        {flow && (() => {
          const missed = stageRows(flow, item).filter(r => r.mark === 'missed').map(r => stageName(r.stage))
          return missed.length > 0 && (
            <Text color={C.revoked} wrap="wrap">{`Never worked and not skipped by you: ${missed.join(', ')}.`}</Text>
          )
        })()}

        {agents.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Agents</Text>
            {agents.map(a => {
              const color = { working: C.work, waiting: C.now, done: C.done, failed: C.revoked, quiet: C.dim }[a.tone]
              return (
                <Box key={`agent-row-${a.id}`} flexDirection="row" gap={1} width="100%">
                  <Text color={color}>{AGENT_GLYPH[a.tone]}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">{a.text ? `${a.name} · ${a.text}` : a.name}</Text>
                  </Box>
                  <Text color={color}>{a.word}</Text>
                </Box>
              )
            })}
          </Box>
        )}

        {flow && (
          // the stage list: a rail picture and a button for each stage, joined into one rail; the picked stage opens under its own row
          <Box flexDirection="column">
            {rows.map((r, i) => {
              const key = r.stage.key
              const isOpen = key === shownKey
              const rail = railSlice({ mark: r.mark, prevMark: i > 0 ? rows[i - 1].mark : null, hasNext: i < rows.length - 1, conditional: r.stage.conditional, colors: C,
                open: isOpen, prevOpen: i > 0 && rows[i - 1].stage.key === shownKey })
              const word = stageWord(flow, item, r)
              const sum = stageSummary(flow, item, key)
              const tint = /^#[0-9a-f]{6}$/i.test(C.work) ? `${C.work}22` : undefined
              return (
                <Box key={`stagebox-${key}`} flexDirection="column">
                  <Box key={`stagerow-${key}`} flexDirection="row" gap={1} alignItems="center" paddingRight={2} backgroundColor={isOpen ? tint : undefined}>
                    <Svg source={rail.source} alt={rail.alt} width={rail.width} height={rail.height} />
                    <Box flexShrink={1} minWidth={0}>
                      <Button key={`row:${key}`} dimColor={r.mark === 'later'} label={stageName(r.stage)} onPress={() => pickStage(key)} />
                    </Box>
                    {word.text && (
                      <Box flexShrink={1} minWidth={0}>
                        <Text bold={r.mark === 'waiting'} wrap="truncate-end"
                          color={word.warn || r.mark === 'waiting' ? C.now : r.mark === 'missed' || r.mark === 'blocked' ? C.revoked : undefined}
                          dimColor={!(word.warn || ['waiting', 'missed', 'blocked'].includes(r.mark))}>{word.text}</Text>
                      </Box>
                    )}
                  </Box>
                  {isOpen && (
                    <Box key={`stagewrap-${key}`} flexDirection="row" alignItems="stretch">
                      {/* the rail runs on beside the detail: a bar of colour as tall as the detail, where the slices' line would be (a picture cannot stretch) */}
                      <Box key={`stagerail-${key}`} width={6} flexShrink={0} flexDirection="row">
                        {/* a bar 3 px wide, its middle 20 px in like the slices' rail: whole percentages of the 48 px column (the engine refuses px and fractions), a 39% gap and a 6% bar. If Desktop ignored them the bar would be gone, and a 1-column bar comes back */}
                        <Box key={`stagegap-${key}`} width="39%" flexShrink={0} />
                        <Box key={`stagebar-${key}`} width="6%" flexShrink={0} backgroundColor={railBarColor(r.mark, C)} />
                      </Box>
                      {/* no border: a frame would run over the rail */}
                      <Box key={`stagedetail-${key}`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} marginBottom={1}>
                        {sum.note && <Text dimColor wrap="wrap">{sum.note}</Text>}
                        {drawStageDetail(r)}
                      </Box>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        {Object.keys(item.repos ?? {}).length > 0 && (
          <Box flexDirection="column">
            {Object.entries(item.repos).map(([name, r]) => (
              <Box flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderColor={C.line} paddingX={1}>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text bold wrap="wrap">{`Worktree ${name}`}</Text>
                </Box>
                {canOpen && (
                  <Box flexDirection="row" gap={1} flexShrink={0}>
                    {/* icon buttons: 📋 copies the path, 📁 the file manager, </> VS Code, 🔧 repowatch on this worktree */}
                    <Button key={`open-${name}-copy`} label="📋" onPress={() => void copyPath($, `${item.folder}/${r.path}`)} />
                    <Button key={`open-${name}-files`} label="📁" onPress={() => void openIn($, 'files', `${item.folder}/${r.path}`)} />
                    <Button key={`open-${name}-code`} label="</>" onPress={() => void openIn($, 'code', `${item.folder}/${r.path}`)} />
                    <Button key={`open-${name}-repowatch`} label="🔧" onPress={() => void showWorktree($, `${item.folder}/${r.path}`)} />
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}

      </Box>
    )

    function entryRow(at: string, word: string, color: string | undefined, text: string, refs: string[]) {
      return (
        <Box flexDirection="row" gap={1}>
          <Box width={11} flexShrink={0}><Text dimColor>{when(at)}</Text></Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text color={color} wrap="wrap">{`${word}${text ? `  ${text}` : ''}`}</Text>
            {refs.length > 0 && linkMd(`refs-${at}-${word}`, refsLine(refs))}
          </Box>
        </Box>
      )
    }

    // pendKey: the stage of a gate that waits on the person now; it also lists what to read first
    /** What a stage holds when it is opened: its cost, its log, each gate with its story, and the actions of the stage.
     *  The picture's detail panel shows it for the picked stage; a card shows it in place. */
    function drawStageDetail(r: StageRow) {
      const gates = decidedGates(r.stage, s!.derived)
      const lkey = `log:${r.stage.key}`
      const lastStamp = shortStamp(stageSummary(flow, item, r.stage.key).lastAt)
      return (
        <Box flexDirection="column">
          {(spendHead(spend, r.stage.key) || lastStamp) && (
            <Box flexDirection="column" marginLeft={2}>
              {spendHead(spend, r.stage.key) && <Text dimColor wrap="wrap">{spendHead(spend, r.stage.key, true)}</Text>}
              {tokensLine(spendTokens(spend[r.stage.key] ?? [])) && <Text dimColor wrap="wrap">{tokensLine(spendTokens(spend[r.stage.key]), true)}</Text>}
              {lastStamp && <Text dimColor wrap="wrap">{`${SPEND_ICON.time} Last activity ${lastStamp}`}</Text>}
            </Box>
          )}
          <Box flexDirection="column" marginLeft={2}>
            <Box key={`row-${lkey}`} flexDirection="row" gap={1} width="100%">
              <Text hover={{ color: lighten(C.work) }} color={C.work}>≡</Text>
              {/* the whole line is the button: name and count in one label */}
              <Box flexGrow={1} flexShrink={1}>
                <Button hover={{ color: C.hoverText, dimColor: false }} key={lkey} plain dimColor
                  label="Stage log"
                  onPress={() => void $.state.set(gate, openGate === lkey ? null : lkey)} />
              </Box>
            </Box>
            {openGate === lkey && drawLog(r.stage.key, r.mark)}
          </Box>
          {gates.map(g => {
            const gkey = `gate:${g}`
            const isPending = pend?.gate === g && pend.key === r.stage.key
            const story = gateStory(item!, g, isPending ? { flow: flow!, key: r.stage.key } : undefined)
            const at = item!.gates?.[g]
            // the row shows the last recorded status only; earlier rounds are in the story
            const last = at ? 'passed' : story.length ? story[story.length - 1].kind : 'open'
            const lastAt = at ?? story[story.length - 1]?.at
            const tone = last === 'passed' ? C.done : last === 'revoked' ? C.revoked : last === 'asked' ? C.now : undefined
            return (
              <Box flexDirection="column" marginLeft={2}>
                <Box key={`row-${gkey}`} flexDirection="row" gap={1} width="100%">
                  <Text hover={{ color: lighten(tone ?? C.dim) }} color={tone ?? C.dim}>{at ? '◆' : '◇'}</Text>
                  {/* name left, time right: two buttons that do the same, so the whole line opens the gate */}
                  <Box flexGrow={1} flexShrink={1}>
                    <Button hover={{ color: C.hoverText, dimColor: false }} key={gkey} plain dimColor label={g}
                      onPress={() => void $.state.set(gate, openGate === gkey ? null : gkey)} />
                  </Box>
                  {stamp(lastAt) && (
                    <Button hover={{ color: C.hoverText, dimColor: false }} key={`${gkey}-at`} plain dimColor label={stamp(lastAt)}
                      onPress={() => void $.state.set(gate, openGate === gkey ? null : gkey)} />
                  )}
                </Box>
                {openGate === gkey && drawGate(story, isPending ? r.stage.key : null)}
              </Box>
            )
          })}
          {drawTools(r.stage.key)}
        </Box>
      )
    }

    function drawGate(story: ReturnType<typeof gateStory>, pendKey: string | null) {
      if (!story.length && !pendKey) return <Box marginLeft={3}><Text dimColor>Not asked yet.</Text></Box>
      const review = pendKey ? reviewLinks(item!, pendKey) : []
      const canAnswer = !!pendKey && (!!ask || !!item!.feedback?.[pendKey])
      return (
        <Box flexDirection="column" marginLeft={3} paddingLeft={1} borderStyle="single" borderColor={C.line}>
          {story.map((x, i) => entryRow(x.at,
            x.kind === 'asked' ? 'Asked' : x.kind === 'passed' ? 'Passed. Your answer:' : 'Revoked:',
            x.kind === 'passed' ? C.done : x.kind === 'revoked' ? C.revoked : undefined,
            // the open question's refs are the reading list below
            x.text, pendKey && i === story.length - 1 && x.kind === 'asked' ? [] : x.refs))}
          {pendKey && (
            <Box flexDirection="column" marginTop={story.length ? 1 : 0}>
              <Text bold color={C.now}>Read before you decide</Text>
              {review.length
                ? linkMd(`review-${pendKey}`, review.map(l => `- ${l}`).join('\n'))
                : <Text dimColor wrap="wrap">Claude named no documents with this question.</Text>}
              {canAnswer && (
                <Box marginTop={1}>
                  <Button key={`answer-${pendKey}`} variant="primary" label={ask ? 'Answer Claude\'s question' : `Give feedback on ${pendKey}`}
                    onPress={() => void (async () => {
                      await $.state.set(doc, null)
                      await $.state.set(feedback, pendKey)
                    })()} />
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    function drawLog(key: string, mark: Mark) {
      const hist = [...stageHistory(flow!, item!, key)].reverse()
      const word = (h: (typeof hist)[number]) => h.status === 'waiting' ? 'Asked' : h.status === 'done' ? 'Done'
        : h.status === 'skipped' ? 'Skipped' : h.status === 'blocked' ? 'Blocked' : h.status === 'abandoned' ? 'Abandoned' : 'Note'
      return (
        <Box flexDirection="column" marginLeft={3} paddingLeft={1} borderStyle="single" borderColor={C.line}>
          {hist.length === 0 && <Text dimColor>{mark === 'later' || mark === 'next' ? 'Not started yet.' : mark === 'missed' ? 'Never worked, and you did not agree to skip it.' : 'No log entries for this stage.'}</Text>}
          {hist.map(h => entryRow(h.at, word(h), h.status === 'waiting' ? C.now : h.status === 'blocked' ? C.revoked : undefined,
            [h.gate, h.confirmed ? `You said: "${h.confirmed}"` : '', h.note, h.caveat ? `Continued with ${h.openQuestions ?? 'some'} open: ${h.caveat}.` : '', h.gates?.passed?.length ? `Passed: ${h.gates.passed.join(', ')}.` : '',
              h.gates?.revoked?.length ? `Revoked: ${h.gates.revoked.join(', ')}.` : ''].filter(Boolean).join(' '),
            h.refs ?? []))}
        </Box>
      )
    }

    function drawTools(key: string) {
      const docs = stageDocs(item!, key)
      const st = flow!.stages.find(x => x.key === key)!
      // a review stage waiting on the PR's reviewers gets Approved / Merged / Rejected in place of feedback
      const isReview = !!st.reworkTo && phaseKey(flow!, item!.progress?.phase) === key && item!.progress?.status === 'waiting'
      const revokes = isReview ? undefined : item!.feedback?.[key]
      const rejecting = typing === `review:${key}`
      // the stage waits on the person and Claude asked about it: the box shows those questions
      const showAsk = !!ask && waitKey === key && !isReview
      const takesInput = !!revokes || showAsk
      if (!docs.length && !takesInput && !isReview) return null
      const answer = post
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={1} gap={1}>
          {isReview && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key={`rv-approved-${key}`} label="Approved"
                onPress={() => answer(`sdd review for ${item!.id}: approved`, 'Sent: the PR is approved.')} />
              <Button key={`rv-merged-${key}`} label="Merged"
                onPress={() => answer(`sdd review for ${item!.id}: merged`, 'Sent: the PR is merged.')} />
              <Button key={`rv-rejected-${key}`} label="Rejected" variant={rejecting ? 'primary' : undefined}
                onPress={() => void $.state.set(feedback, rejecting ? null : `review:${key}`)} />
            </Box>
          )}
          {isReview && rejecting && (
            <Box flexDirection="column" borderStyle="round" borderColor={C.revoked} paddingX={1}>
              {Input
                ? (
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Button key={`rv-cancel-${key}`} label="X" role="dismiss" onPress={() => void $.state.set(feedback, null)} />
                    <Box flexGrow={1} flexShrink={1}>
                      <Input key={`rv-why-${key}`} autoFocus submitLabel="Send to Claude"
                        placeholder={`Why was the PR rejected? The item goes back to ${st.reworkTo}.`}
                        onSubmit={v => {
                          const why = v.trim()
                          if (!why) { $.ui.toast('Say why the PR was rejected first'); return }
                          answer(`sdd review for ${item!.id}: rejected: ${why}`, `Sent: the PR was rejected. Back to ${st.reworkTo}.`)
                        }} />
                    </Box>
                  </Box>
                )
                : (
                  <Box flexDirection="row" gap={1}>
                    <Button key={`rv-cancel-${key}`} label="X" role="dismiss" onPress={() => void $.state.set(feedback, null)} />
                    <Button key={`rv-fill-${key}`} variant="primary" label="Write why in the prompt"
                      onPress={() => void $.prompt.fill({ text: `sdd review for ${item!.id}: rejected: ` })} />
                  </Box>
                )}
            </Box>
          )}
          {(docs.length > 0 || takesInput) && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {docs.map(d => (
                <Button key={`doc-${key}-${d}`} label={d} variant={shown?.name === d ? 'primary' : undefined}
                  onPress={() => void (async () => {
                    await $.state.set(feedback, null)  // and a file closes the feedback box
                    await $.state.set(doc, shown?.name === d ? null : await readDoc($, item!, d))
                  })()} />
              ))}
              {takesInput && (
                <Button key={`fb-open-${key}`} label={showAsk ? 'Answer Claude\'s question' : `Give feedback on ${stageName(flow!.stages.find(x => x.key === key)!)}`}
                  variant={typing === key ? 'primary' : undefined}
                  onPress={() => void (async () => {
                    // one thing at a time: the feedback box closes the open file
                    await $.state.set(doc, null)
                    await $.state.set(feedback, typing === key ? null : key)
                  })()} />
              )}
            </Box>
          )}
          {shown && docs.includes(shown.name) && (
            <Box flexDirection="column">
              <Markdown text={shown.text} />
              {shown.isCut && <Text dimColor>{`Cut at ${DOC_LIMIT} characters. Open the file for the rest.`}</Text>}
            </Box>
          )}
          {takesInput && typing === key && (() => {
            // an answer to Claude's question: into the open dialog's call when there is one, else as
            // the person's own message, which the sdd skill reads as the answer
            const sendAnswer = (other: string) => void (async () => {
              const a = ask!
              const answers = answersFor(a.questions, (await $.state.get(picks)).value ?? {}, other)
              if (!answers) {
                $.ui.toast('Pick an option for each question, or type your answer.')
                return
              }
              const resolve = a.isOpen ? answering.get(a.toolUseId) : undefined
              if (a.isOpen && !resolve) {
                $.ui.toast('The question is open in the chat. Answer it there.')
                return
              }
              await $.state.set(picks, {})
              if (resolve) {
                await $.state.set(feedback, null)
                resolve(answers)
                $.ui.toast('Answer sent to Claude.')
                return
              }
              answer(answerMessage(item!.id, key, a.questions, answers), 'Answer sent to Claude.')
            })()
            const pick = (q: SddQuestion, label: string) => void update($, picks, cur => {
              const was = (cur ?? {})[q.question] ?? []
              const isOn = was.includes(label)
              const now = q.multiSelect ? (isOn ? was.filter(l => l !== label) : [...was, label]) : (isOn ? [] : [label])
              return { ...(cur ?? {}), [q.question]: now }
            })
            const send = (v: string) => void (async () => {
              if (showAsk) {
                sendAnswer(v)
                return
              }
              const text = v.trim()
              if (!text) {
                $.ui.toast('Type your feedback first')
                return
              }
              // sent as the person's own message, so it shows in the chat as theirs; the sdd skill reads
              // "sdd feedback for <id>, stage <stage>: <text>" as its feedback route. A plugin may not
              // send a text that starts with "/", so this is plain words, not the slash command.
              const prompt = `sdd feedback for ${item!.id}, stage ${key}: ${text}`
              await $.state.set(feedback, null)
              try {
                const sent = await $.prompt.submit({ text: prompt, asUser: true })
                if ('drop' in sent && sent.drop) throw new Error(String(sent.drop))
                $.ui.toast(`Feedback on ${key} sent to Claude.`)
              } catch (err) {
                // not sent: leave it in the prompt box so nothing typed is lost, and say why
                await $.prompt.fill({ text: prompt })
                $.ui.toast(`Not sent (${String(err).slice(0, 160)}). It is in the prompt box instead.`)
              }
            })()
            const close = () => void $.state.set(feedback, null)
            const hint = showAsk
              ? 'Or type your own answer (as Other in the chat)'
              : `What should change in ${key}?` + (revokes?.length ? ` Sending revokes ${revokes.join(', ')}.` : '')
            return (
              <Box flexDirection="column" gap={1} borderStyle="round" borderColor={C.now} paddingX={1}>
                {showAsk && (
                  <Box flexDirection="column" gap={1}>
                    {ask!.questions.map((q, qi) => {
                      const chosen = picked[q.question] ?? []
                      return (
                        <Box flexDirection="column">
                          {q.header && <Text dimColor>{q.header}</Text>}
                          <Text bold wrap="wrap">{q.question}</Text>
                          {q.options.map((o, oi) => {
                            const isOn = chosen.includes(o.label)
                            const mark = q.multiSelect ? (isOn ? '[x]' : '[ ]') : (isOn ? '(•)' : '( )')
                            return (
                              <Box flexDirection="column">
                                <Button key={`ask-${key}-${qi}-${oi}`} plain dimColor={!isOn} hover={{ color: C.hoverText, dimColor: false }}
                                  label={`${mark} ${o.label}`} onPress={() => pick(q, o.label)} />
                                {o.description && <Box marginLeft={4}><Text dimColor wrap="wrap">{o.description}</Text></Box>}
                              </Box>
                            )
                          })}
                        </Box>
                      )
                    })}
                    <Text dimColor wrap="wrap">
                      {ask!.isOpen ? 'The same question is open in the chat. Answer here or there.' : 'Claude asked this earlier. Your answer goes to the chat as your message.'}
                    </Text>
                    <Box flexDirection="row" gap={1}>
                      <Button key={`ask-send-${key}`} variant="primary" label="Send answer" onPress={() => sendAnswer('')} />
                    </Box>
                  </Box>
                )}
                {Input
                  ? (
                    // the field's own submit button sends; X closes the box
                    <Box flexDirection="row" gap={1} alignItems="center">
                      <Button key={`fb-cancel-${key}`} label="X" role="dismiss" onPress={close} />
                      <Box flexGrow={1} flexShrink={1}>
                        <Input key={`fb-${key}`} autoFocus placeholder={hint} submitLabel="Send to Claude" onSubmit={send} />
                      </Box>
                    </Box>
                  )
                  : (
                    <Box flexDirection="column" gap={1}>
                      <Text dimColor wrap="wrap">{hint}</Text>
                      <Box flexDirection="row" gap={1}>
                        <Button key={`fb-cancel-${key}`} label="X" role="dismiss" onPress={close} />
                        <Button key={`fb-fill-${key}`} variant="primary" label="Write it in the prompt"
                          onPress={() => void $.prompt.fill({ text: showAsk ? `sdd answer for ${item!.id}, stage ${key}: ` : `/sdd:sdd ${item!.id} feedback ${key}: ` })} />
                      </Box>
                    </Box>
                  )}
              </Box>
            )
          })()}
        </Box>
      )
    }
  })
}
