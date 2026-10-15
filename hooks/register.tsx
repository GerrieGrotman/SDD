// The sdd view: a pane that shows where a work item is in its flow, a band when one waits on the
// person, and a toast when a gate passes. It reads `env.py view` (local files, no ADO) and the spec
// documents. The one thing it writes is what each turn cost (`env.py cost`: one appended line in the item's
// folder). It never passes a gate or runs any other state-changing command; "Resume" only fills the
// prompt box with `/sdd <id>` for the person to send.
import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SddAsk, SddColors, SddLiveState, SddDoc, SddItem, SddQuestion, SddSnapshot, SddStage } from '../types'
import { GLYPH, agentRows, contextTone, moneyText, spendLine, spendTokens, spendTotal, tokensLine, answerMessage, answersFor, approveAnswers, approveFor, approveMessage,decidedGates, fileLinks, defaultStage, flowFinished, flowPicture, flowTag, MARK_WORD, stepStage, idFromArgs, idFromScript, itemOptions, itemSuggestions, pendingGate, reviewLinks, stamp, fileTarget, gateStory, phaseKey, phaseLabel, refLink, stageDocs, stageHistory, stageRows, stageSummary, spinnerNote, statusWord, when, yourTurn } from './view/model'
import type { AgentInfoLike, AgentTone, Mark, StageRow } from './view/model'
import { agoText, cleanupNote, conflictNote, counts, groupByItem, historyArgs, joinWorktrees, lineFacts, sortLines } from './view/worktrees'

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
const PX_PER_COLUMN = 8
const WT_PANE = 'sdd-worktrees'
const WT_COLORS = { urgent: '#c0503f', warn: '#c98a12', ok: '#3f9a63', dim: '#7b8794', work: '#4a7fc4' }
const WT_REFRESH_MS = 30_000
const live = { plugin: 'sdd', key: 'wtLive' } as const
const liveError = { plugin: 'sdd', key: 'wtError' } as const
const offset = { plugin: 'sdd', key: 'wtOffset' } as const
let wtOpen = false
let wtTimer = false

type Live = { state: SddLiveState | null; why: string | null }

/** Reads repowatch's state file in the workspace. Missing = repowatch has not scanned yet. */
async function wtReadLive($: EngineInterface, root: string | null): Promise<Live> {
  if (!root) return { state: null, why: 'No sdd workspace found from this folder.' }
  try {
    const parsed = JSON.parse(await $.fs.read(`${root}/.claude/repowatch/state.json`)) as SddLiveState
    return { state: parsed, why: null }
  } catch {
    return { state: null, why: 'repowatch has not scanned this workspace yet. It scans by itself once a minute; /repowatch scan does it now.' }
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
  if (!turnOf || !sessionId) return false
  const turns = turnCounted ? 0 : 1
  turnCounted = true
  const why = await recordCost($, folder, turnOf.id, turnOf.key, p, turns)
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

export const register: Register = on => {
  // ---------------------------------------------------------------- the Worktrees page (/sdd-worktrees)
  // It lives in this file: older engines follow `$` into a function of the same file only.

  on('command.run', { command: 'sdd-worktrees' }, async ($, e) => {
    if (!desktopReady) return { text: 'The sdd worktrees page works in the Claude Desktop app only.' }
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
    return { text: 'sdd worktrees opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: WT_PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s: SddSnapshot | null = (await $.state.get(snap)).value ?? null
    const liveState = (await $.state.get(live)).value ?? null
    const why = (await $.state.get(liveError)).value ?? null
    const from = (await $.state.get(offset)).value ?? 0
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
        <Text dimColor>
          {c.items} work items · {c.worktrees} worktrees · {c.cleanup} to clean up · {c.conflicts} will conflict · {c.dirty} with uncommitted files
          {liveState ? ` · scanned ${agoText(liveState.generated, now).replace('last commit ', '')}` : ''}
        </Text>
        {blocks.length === 0 && <Text dimColor>No work item has a worktree folder.</Text>}
        {shown.map(b => {
          const flow = s.flows[b.item.flow]
          return (
            <Box key={`item-${b.item.id}`} flexDirection="column">
              <Box>
                <Button key={`open-${b.item.id}`} label={`${b.item.id}`} onPress={openItem(b.item.id)} />
                <Text>  {b.item.title.slice(0, 60)}  </Text>
                <Text color={b.item.progress?.status === 'waiting' ? WT_COLORS.warn : WT_COLORS.dim}>
                  {phaseLabel(flow, b.item) || 'not started'} · {statusWord(b.item)}
                </Text>
              </Box>
              {b.lines.map(l => {
                const note = cleanupNote(l)
                const clash = conflictNote(l)
                return (
                  <Box key={`${l.item.id}-${l.repo}`} flexDirection="column" marginLeft={4}>
                    <Box>
                      <Text>{l.repo} · {l.branch}  </Text>
                      <Button key={`hist-${l.item.id}-${l.repo}`} label="History" onPress={showHistory(historyArgs(l))} />
                    </Box>
                    <Text dimColor>  {lineFacts(l, now).join(' · ')}</Text>
                    {note && <Text color={WT_COLORS.warn}>  {note}</Text>}
                    {clash && <Text color={WT_COLORS.urgent}>  {clash}</Text>}
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
    const [, num, rest] = /^(\d+)?\s*(.*)$/s.exec(e.args.trim()) ?? []
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
    return { text: `sdd view${id != null ? ` of ${id}` : ''} opened${where ? ` on ${where}` : ''}.` }
  })

  on('ui.close', async ($, e, next) => {
    if (!desktopReady) return next(e)
    if (e.id === PANE) isOpen = false
    if (e.id === WT_PANE) wtOpen = false
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
    if (e.props.hasSurvey || !first) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
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
        <Button key="band-open" label="Open sdd view" onPress={() => void (async () => {
          await $.state.set(selected, first.id)
          await $.state.set(stage, null)
          await $.state.set(doc, null)
          await openPane($, first.id)
          const v = await loadView($, first.id, s, (await $.state.get(place)).value ?? null)
          await $.state.set(snap, v.out)
          await $.state.set(error, v.why)
        })()} />
        </Box>
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
    const options = itemOptions(s, item)
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
    const shownKey = pickedAt === atKey && rows.some(r => r.stage.key === pickedKey) ? pickedKey : atKey
    const agents = agentRows(await listAgents($))
    const spend = item.spend ?? {}
    agentsBusy = agents.some(a => a.isLive)
    const links = [item.url ? `[ADO ${item.id}](${item.url})` : `ADO ${item.id}`,
      ...Object.values(item.repos ?? {}).filter(r => r.pr).map(r => `[PR ${r.pr!.id}](${r.pr!.url})`)].join('  |  ')
    // the picture's stage picker: show that stage's detail, with nothing of the last one left open
    const pickStage = (key: string | null) => void (async () => {
      if (!key) return
      await $.state.set(stage, `stage:${key}@${defaultStage(rows)}`)
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
          {tokensLine(spendTokens(spend)) && <Text dimColor wrap="wrap">{`Tokens: ${tokensLine(spendTokens(spend))}`}</Text>}
          {(spendTotal(spend) > 0 || ctx) && (
            <Box flexDirection="row" gap={2}>
              {spendTotal(spend) > 0 && <Text dimColor>{`Spent ${moneyText(spendTotal(spend))} on this item`}</Text>}
              {ctx && <Text color={{ ok: undefined, warn: C.now, high: C.revoked }[contextTone(ctx.percent)]} dimColor={contextTone(ctx.percent) === 'ok'}>
                {`Context ${ctx.percent}%${contextTone(ctx.percent) === 'ok' ? '' : ' full'}`}
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

        {flow && (() => {
          // the picture is the stage list; the picker under it chooses the stage whose detail shows below, one at a time
          const pic = flowPicture({ flow, item, rows, derived: s.derived, colors: C, pending: pend, spend, selected: shownKey,
            width: Math.round((e.props.bodyColumns ?? 100) * PX_PER_COLUMN) })
          const row = rows.find(r => r.stage.key === shownKey)
          const prevKey = stepStage(rows, shownKey, -1)
          const nextKey = stepStage(rows, shownKey, 1)
          const labelOf = (k: string | null) => rows.find(r => r.stage.key === k)?.stage.label ?? ''
          return (
            <Box flexDirection="column" gap={1}>
              <Svg source={pic.source} alt={pic.alt} width={pic.width} height={pic.height} isInteractive />
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                <Button key="stage-prev" hotkey="p" plain dimColor={prevKey === shownKey} label={`◀ ${labelOf(prevKey)}`} onPress={() => pickStage(prevKey)} />
                {Select && (
                  <Select key="pick-stage" label="Stage" value={shownKey ?? undefined} onSelect={pickStage}
                    options={rows.map(r => ({ value: r.stage.key, label: `${stageName(r.stage)}${MARK_WORD[r.mark] ? ` · ${MARK_WORD[r.mark]}` : ''}` }))} />
                )}
                <Button key="stage-next" hotkey="n" plain dimColor={nextKey === shownKey} label={`${labelOf(nextKey)} ▶`} onPress={() => pickStage(nextKey)} />
              </Box>
              {row && (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1} width="100%">
                    <Text color={markColor(row.mark)}>{GLYPH[row.mark]}</Text>
                    <Text bold wrap="truncate-end">{stageName(row.stage)}</Text>
                    {MARK_WORD[row.mark] && <Text color={markColor(row.mark)}>{MARK_WORD[row.mark]}</Text>}
                  </Box>
                  {stageSummary(flow, item, row.stage.key).note && <Text dimColor wrap="wrap">{stageSummary(flow, item, row.stage.key).note}</Text>}
                  {drawStageDetail(row)}
                </Box>
              )}
            </Box>
          )
        })()}

        {Object.keys(item.repos ?? {}).length > 0 && (
          <Box flexDirection="column">
            {Object.entries(item.repos).map(([name, r]) => (
              <Box flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderColor={C.line} paddingX={1}>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text bold wrap="wrap">{`Worktree ${name}`}</Text>
                  <Text dimColor wrap="wrap">{`${r.branch} from ${r.base}`}</Text>
                </Box>
                {canOpen && (
                  <Box flexDirection="row" gap={1} flexShrink={0}>
                    {/* icon buttons: 📁 the file manager, </> VS Code, 🔧 repowatch on this worktree */}
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
      return (
        <Box flexDirection="column">
          {spendLine(spend, r.stage.key) && (
            <Box marginLeft={2}><Text dimColor wrap="wrap">{`Spent ${spendLine(spend, r.stage.key)}`}</Text></Box>
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
