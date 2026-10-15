// repowatch: a pane and a status line for many git repos. It reads .claude/repowatch/state.json, which
// `repowatch.py scan` writes; the scan itself runs on a timer (local facts every minute, a few fetches
// every few minutes). Scan and Fetch only read or fetch. A clean-up (remove a worktree, prune) runs
// only when the person presses its button, and only after the pane has shown the plan and been
// confirmed: `repowatch.py plan` builds it from the live repo, `repowatch.py apply` checks again.
import type { EngineInterface, Register } from 'claude-code'

import type { RwGraph, RwPlan, RwResult, RwState } from '../types'
import {
  actionArgs, ago, baseText, branchText, bulkRows, classLabel, conflictToast, dedupePrune, flagLabel, forecastText, isUrgent,
  fixGlyph, fixLine, hopKey, hopLine, hopRows, mergeAskText, page, planArgs, planGist, resolveAskText, resultLine, sddRemoveText,
  statusText, stepText, syncArgs, undoArgs, undoLabel, visibleRepos, worktreeRows,
  commitMeta, graphArgs, agoShort, clipboardArgv, wtCounts, wtFacts, wtWord, parseHistoryArgs, parseWorktreeArgs, graphSegments, graphWidth, hopHistory, refNames, repoHistory, sideLegend, worktreeHistory,
} from './view/model'
import type { GraphTarget } from './view/model'

const PANE = 'repowatch'
const state = { plugin: 'repowatch', key: 'state' } as const
const error = { plugin: 'repowatch', key: 'error' } as const
const note = { plugin: 'repowatch', key: 'note' } as const
const onlyAttention = { plugin: 'repowatch', key: 'onlyAttention' } as const
const focus = { plugin: 'repowatch', key: 'focus' } as const
const wtOpen = { plugin: 'repowatch', key: 'wtOpen' } as const
const offset = { plugin: 'repowatch', key: 'offset' } as const
const open = { plugin: 'repowatch', key: 'open' } as const
const busy = { plugin: 'repowatch', key: 'busy' } as const
const view = { plugin: 'repowatch', key: 'view' } as const
const plans = { plugin: 'repowatch', key: 'plans' } as const
const graph = { plugin: 'repowatch', key: 'graph' } as const
const commit = { plugin: 'repowatch', key: 'commit' } as const

const SCAN_EVERY_MS = 60_000
const FETCH_EVERY_SCANS = 5
const COLORS = { urgent: '#c0503f', warn: '#c98a12', ok: '#3f9a63', dim: '#7b8794' }
const LANE_COLORS = ['#4a7fc4', '#3f9a63', '#c98a12', '#8a73c9', '#c0503f', '#2aa5a5']
const SIDE_COLOR = { branch: '#3f9a63', base: '#4a7fc4', both: undefined } as const
const REF_COLOR: Record<string, string> = { head: '#c98a12', local: '#3f9a63', remote: '#4a7fc4', tag: '#8a73c9' }
const GRAPH_STEP = 40
const CLASS_COLOR: Record<string, string> = { safe: COLORS.ok, prune: COLORS.warn, review: COLORS.warn, keep: COLORS.urgent, ok: COLORS.dim }

let python = 'python'  // module state: lost on reload, which is fine

/** Runs repowatch.py with the arguments and returns its output, or throws with why it failed. */
async function run($: EngineInterface, args: string[], timeoutMs: number): Promise<string> {
  const cwd = await $.session.cwd()
  let why = 'could not run python'
  for (const exe of [python, 'python3', 'py']) {
    try {
      const r = await $.process.run([exe, `${$.plugin.root}/scripts/repowatch.py`, ...args], { cwd, timeoutMs })
      python = exe
      // plan and apply answer in JSON on stdout even when they refuse (exit 2)
      if (r.exitCode === 0 || (r.exitCode === 2 && r.stdout.trim().startsWith('{'))) return r.stdout
      throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || `repowatch.py exited ${r.exitCode}`)
    } catch (err) {
      why = String(err instanceof Error ? err.message : err)
      if (!/spawn|ENOENT|not found|could not/i.test(why)) break
    }
  }
  throw new Error(why)
}

async function load($: EngineInterface): Promise<RwState | null> {
  const out = await run($, ['status', '--json'], 20_000)
  const parsed = JSON.parse(out) as RwState
  return Object.keys(parsed.repos).length ? parsed : null
}

type Sweep = { s: RwState | null; why: string | null }

/** Scans (and sometimes fetches), then reads the state back. The hooks store the result: $.state is theirs. */
async function refresh($: EngineInterface, fetch: boolean, withSync: boolean = fetch): Promise<Sweep> {
  try {
    await run($, fetch ? ['scan', '--fetch', '--json'] : ['scan', '--json'], fetch ? 300_000 : 120_000)
    if (withSync) await run($, ['sync', '--json'], 300_000)
    return { s: await load($), why: null }
  } catch (err) {
    return { s: null, why: String(err instanceof Error ? err.message : err) }
  }
}

/** Asks for the plans of some actions. A plan that could not be made is a blocked one that says why. */
async function makePlans($: EngineInterface, argLists: string[][]): Promise<RwPlan[]> {
  const out: RwPlan[] = []
  for (const args of argLists) {
    try {
      out.push(JSON.parse(await run($, ['plan', ...args], 60_000)) as RwPlan)
    } catch (err) {
      out.push({ action: args[0] as RwPlan['action'], repo: args[2] ?? '?', path: null, branch: null, level: 'blocked',
        blocked: [String(err instanceof Error ? err.message : err)], reasons: [], atRisk: [], steps: [], restore: [] })
    }
  }
  return out
}

/** Applies confirmed plans one by one; one failing does not stop the rest. Review plans were confirmed by the person. */
async function applyPlans($: EngineInterface, todo: RwPlan[]): Promise<RwResult[]> {
  const out: RwResult[] = []
  for (const p of todo) {
    try {
      const args = [...planArgs(p), ...(p.level === 'review' ? ['--allow-review'] : [])]
      out.push(JSON.parse(await run($, ['apply', ...args], 180_000)) as RwResult)
    } catch (err) {
      out.push({ ok: false, error: String(err instanceof Error ? err.message : err), done: [], plan: p })
    }
  }
  return out
}

/** Copies a path to the clipboard with the computer's own tool; the toast says how it went. */
async function copyPath($: EngineInterface, path: string): Promise<void> {
  try {
    const r = await $.process.run(clipboardArgv(path), { timeoutMs: 10_000 })
    if (r.exitCode === 0) $.ui.toast('Path copied')
    else $.ui.toast(`Could not copy the path: ${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.exitCode}`}`)
  } catch (err) {
    $.ui.toast(`Could not copy the path: ${String(err).slice(0, 160)}`)
  }
}

/** The history of some refs, read-only. A refusal (no such branch) comes back as the error it is. */
async function loadGraph($: EngineInterface, g: { repo: string; refs: string[]; withBase: boolean; limit: number; firstParent: boolean }): Promise<{ rows: RwGraph['rows']; more: boolean }> {
  const out = JSON.parse(await run($, graphArgs(g), 120_000)) as { rows?: RwGraph['rows']; more?: boolean; error?: string }
  if (out.error || !out.rows) throw new Error(out.error ?? 'no history')
  return { rows: out.rows, more: !!out.more }
}

/** One commit's message and changed files, read-only. */
async function loadCommit($: EngineInterface, repo: string, sha: string): Promise<{ sha: string; text: string }> {
  const out = JSON.parse(await run($, ['show', '--repo', repo, '--sha', sha], 60_000)) as { text?: string; error?: string }
  if (out.error || out.text == null) throw new Error(out.error ?? 'no such commit')
  return { sha, text: out.text }
}

function resultText(rs: RwResult[]): string {
  const ok = rs.filter(r => r.ok).length
  const bad = rs.filter(r => !r.ok)
  if (rs.length === 1) return resultLine(rs[0]).slice(0, 240)
  return `${ok} done${bad.length ? `, ${bad.length} not done: ${bad.map(r => r.error ?? '?').join(' | ').slice(0, 200)}` : ''}`
}

export const register: Register = on => {
  let scans = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'repowatch',
      description: 'Show the git repos of this workspace in a pane; "worktrees" lists every worktree, "sync" the team branch sync, "history <repo> <branch> [<base>]" draws a branch, "scan" or "fetch" refreshes',
      argumentHint: '[worktrees|sync|scan|fetch|history <repo> <branch> [<base>]]',
    })
    const sync = async (fetch: boolean) => {
      const before = (await $.state.get(state)).value ?? null
      const r = await refresh($, fetch)
      const toast = conflictToast(before, r.s)
      if (toast) $.ui.toast(toast)
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      $.ui.status(statusText(r.s?.summary, r.s?.sync?.summary))
    }
    void sync(false)
    $.clock.every(SCAN_EVERY_MS, () => {
      scans += 1
      void sync(scans % FETCH_EVERY_SCANS === 0)
    })
    return next(e)
  })

  on('command.run', { command: 'repowatch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    await $.ui.open({ id: PANE, title: 'repowatch', closeOnEscape: true, columns: 110 })
    if (arg === 'history' || arg.startsWith('history ')) {
      // another plugin (sdd's Worktrees page) asks this way, or a person types it
      const target = parseHistoryArgs(e.args.trim().slice('history'.length))
      if (!target) return { text: 'Usage: /repowatch history <repo> <branch> [<base>]' }
      const next = { repo: target.repo, refs: target.refs, withBase: target.refs.length > 1, firstParent: false, limit: GRAPH_STEP }
      try {
        const r = await loadGraph($, next)
        await $.state.set(graph, { ...next, ...r, title: target.title, back: 'repos' })
        await $.state.set(commit, null)
        await $.state.set(view, 'graph')
        await $.state.set(offset, 0)
        await $.state.set(note, null)
      } catch (err) {
        const why = String(err instanceof Error ? err.message : err)
        await $.state.set(note, why)
        return { text: why }
      }
      return { text: `History of ${target.title} opened.` }
    }
    if (arg === 'worktree' || arg.startsWith('worktree ')) {
      // sdd's spanner button asks this way: the Worktrees list, on that one worktree
      const path = parseWorktreeArgs(e.args.trim().slice('worktree'.length))
      if (!path) return { text: 'Usage: /repowatch worktree <path>' }
      await $.state.set(focus, path)
      await $.state.set(view, 'worktrees')
      await $.state.set(offset, 0)
      await $.state.set(note, null)
      return { text: `Worktree ${path} shown.` }
    }
    if (arg === 'worktrees' || arg === 'sync') {
      await $.state.set(focus, null)
      await $.state.set(view, arg)
      await $.state.set(offset, 0)
    }
    if (arg === 'scan' || arg === 'fetch') {
      await $.state.set(busy, arg)
      const r = await refresh($, arg === 'fetch')
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      await $.state.set(busy, null)
      $.ui.status(statusText(r.s?.summary, r.s?.sync?.summary))
    }
    return { text: 'repowatch opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = 'Input' in t ? t.Input : undefined
    const s = (await $.state.get(state)).value ?? null
    const why = (await $.state.get(error)).value ?? null
    const said = (await $.state.get(note)).value ?? null
    const only = (await $.state.get(onlyAttention)).value ?? true
    const focused = (await $.state.get(focus)).value ?? null
    const wtOpened = (await $.state.get(wtOpen)).value ?? null
    const from = (await $.state.get(offset)).value ?? 0
    const opened = (await $.state.get(open)).value ?? null
    const working = (await $.state.get(busy)).value ?? null
    const mode = (await $.state.get(view)).value ?? 'repos'
    const pending = (await $.state.get(plans)).value ?? null
    const g = (await $.state.get(graph)).value ?? null
    const shown = (await $.state.get(commit)).value ?? null
    const now = Math.floor(Date.now() / 1000)

    // what the presses do; they run after the drawing, so they may write
    const sync = async (fetch: boolean, label: string) => {
      await $.state.set(busy, label)
      const r = await refresh($, fetch, fetch || label === 'sync')
      const toast = conflictToast(s, r.s)
      if (toast) $.ui.toast(toast)
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      await $.state.set(busy, null)
      $.ui.status(statusText(r.s?.summary, r.s?.sync?.summary))
    }
    // a button asks for the plan; nothing runs until the person confirms it
    const propose = (argLists: string[][]) => async () => {
      await $.state.set(busy, 'planning')
      await $.state.set(plans, await makePlans($, argLists))
      await $.state.set(busy, null)
    }
    // `reason` is the person's own words for a skipped commit; the plan's default stands when they typed none
    // a History button: read the history of some refs and switch to it; Back returns to where it was opened
    const openGraph = (target: GraphTarget | null) => async () => {
      if (!target) return
      const next = { repo: target.repo, refs: target.refs, withBase: target.refs.length > 1, firstParent: false, limit: GRAPH_STEP }
      await $.state.set(busy, 'reading history')
      try {
        const r = await loadGraph($, next)
        await $.state.set(graph, { ...next, ...r, title: target.title, back: mode === 'graph' ? 'repos' : mode })
        await $.state.set(commit, null)
        await $.state.set(view, 'graph')
        await $.state.set(offset, 0)
        await $.state.set(note, null)
      } catch (err) {
        await $.state.set(note, String(err instanceof Error ? err.message : err))
      }
      await $.state.set(busy, null)
    }
    // the same history with another setting (more rows, first parent only, without the base)
    const regraph = (patch: Partial<Pick<RwGraph, 'withBase' | 'firstParent' | 'limit'>>) => async () => {
      if (!g) return
      const next = { ...g, ...patch }
      await $.state.set(busy, 'reading history')
      try {
        const r = await loadGraph($, next)
        await $.state.set(graph, { ...next, ...r })
        await $.state.set(note, null)
      } catch (err) {
        await $.state.set(note, String(err instanceof Error ? err.message : err))
      }
      await $.state.set(busy, null)
    }
    const showCommit = (repo: string, sha: string) => async () => {
      if (shown?.sha === sha) {
        await $.state.set(commit, null)
        return
      }
      try {
        await $.state.set(commit, await loadCommit($, repo, sha))
      } catch (err) {
        await $.state.set(note, String(err instanceof Error ? err.message : err))
      }
    }
    const confirm = (todo: RwPlan[], reason?: string) => async () => {
      await $.state.set(busy, 'cleaning up')
      const withReason = reason ? todo.map(p => (p.decision ? { ...p, decision: { ...p.decision, reason } } : p)) : todo
      const results = await applyPlans($, withReason)
      await $.state.set(plans, null)
      const r = await refresh($, false, false)
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      await $.state.set(busy, null)
      $.ui.status(statusText(r.s?.summary, r.s?.sync?.summary))
      $.ui.toast(resultText(results))
    }

    const header = (
      <Box flexDirection="column">
        <Box>
          <Button key="repos" label={mode === 'repos' ? '[Repos]' : 'Repos'} onPress={async () => {
            await $.state.set(view, 'repos')
            await $.state.set(offset, 0)
          }} />
          <Text> </Text>
          <Button key="worktrees" label={mode === 'worktrees' ? '[Worktrees]' : 'Worktrees'} onPress={async () => {
            await $.state.set(view, 'worktrees')
            await $.state.set(offset, 0)
          }} />
          <Text> </Text>
          <Button key="sync" label={mode === 'sync' ? '[Sync]' : 'Sync'} onPress={async () => {
            await $.state.set(view, 'sync')
            await $.state.set(offset, 0)
          }} />
          <Text>   </Text>
          <Button key="scan" label="Scan" onPress={() => sync(false, 'scan')} />
          <Text> </Text>
          <Button key="fetch" label="Fetch a few" onPress={() => sync(true, 'fetch')} />
          <Text> </Text>
          <Button key="filter" label={only ? 'Show all' : 'Needs attention'} onPress={async () => {
            await $.state.set(onlyAttention, !only)
            await $.state.set(offset, 0)
          }} />
        </Box>
        {working && <Text color={COLORS.warn}>{working === 'fetch' ? 'Fetching…' : working === 'scan' ? 'Scanning…' : `${working[0].toUpperCase()}${working.slice(1)}…`}</Text>}
        {why && <Text color={COLORS.urgent}>{why}</Text>}
        {said && <Text color={COLORS.urgent}>{said}</Text>}
      </Box>
    )

    if (!s) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{why ? '' : 'No repos found yet. Run from a folder that holds git repos, or list them in .claude/repowatch.json.'}</Text>
        </Box>
      )
    }

    const sum = s.summary
    const size = Math.max(3, (e.viewport?.rows ?? 30) - 10)

    // ---- the plan waiting for a confirm: what will run, what is at risk, how to undo
    const confirmPanel = pending && (() => {
      const g = planGist(pending)
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{g.run.length ? `Do this for ${g.run.length} item${g.run.length === 1 ? '' : 's'}?` : 'Nothing can be done now.'}</Text>
          {pending.map((p, i) => (
            <Box key={`plan-${i}`} flexDirection="column" marginLeft={2}>
              <Text color={p.level === 'blocked' ? COLORS.urgent : p.level === 'review' ? COLORS.warn : COLORS.ok}>
                {p.repo}{p.branch ? ` · ${p.branch}` : ''}  [{p.level === 'blocked' ? 'skipped' : p.level}]
              </Text>
              {(p.level === 'blocked' ? p.blocked : p.reasons).map((r, j) => <Text key={`r${j}`} dimColor>  {r}</Text>)}
              {p.steps.map((st, j) => <Text key={`s${j}`} dimColor>  {st[0] === 'git' ? `$ git -C ${p.repo} ${stepText(st.slice(1))}` : `→ ${st.join(' ')}`}</Text>)}
              {p.atRisk.length > 0 && <Text color={COLORS.warn}>  Commits that exist only here:</Text>}
              {p.atRisk.map((c, j) => <Text key={`c${j}`} color={COLORS.warn}>    {c}</Text>)}
              {p.level !== 'blocked' && p.restore.length > 0 && <Text dimColor>  To undo: {p.restore.join(' && ')}</Text>}
            </Box>
          ))}
 {Input && g.run.some(p => p.action === 'sync-skip') && (
            <Box marginLeft={2}>
              <Input key="skip-why" placeholder="Why is it not taken? Enter confirms; leave empty for the default" submitLabel="Do not take"
                onSubmit={v => confirm(g.run, v.trim())()} />
            </Box>
          )}
          <Box>
            {g.run.length > 0 && <Button key="confirm" label={g.review ? `Confirm (${g.review} to review)` : 'Confirm'} onPress={confirm(g.run)} />}
            <Text> </Text>
            <Button key="cancel" label="Cancel" onPress={() => $.state.set(plans, null)} />
          </Box>
        </Box>
      )
    })()

    // ---- the history of a branch, drawn as git draws it (read-only)
    if (mode === 'graph' && g) {
      const width = graphWidth(g.rows)
      const legend = sideLegend(g)
      return (
        <Box flexDirection="column">
          {header}
          <Box>
            <Button key="graph-back" label="‹ Back" onPress={async () => {
              await $.state.set(note, null)
              await $.state.set(view, g.back)
            }} />
            <Text bold>  {g.title}</Text>
          </Box>
          <Box>
            {g.refs.length > 1 && <Button key="graph-base" label={g.withBase ? 'Without base' : 'With base'} onPress={regraph({ withBase: !g.withBase })} />}
            <Text> </Text>
            <Button key="graph-fp" label={g.firstParent ? 'All parents' : 'First parent only'} onPress={regraph({ firstParent: !g.firstParent })} />
          </Box>
          {legend && <Text dimColor>{legend}</Text>}
          {g.rows.map((r, i) => (
            <Box key={`g${i}`} flexDirection="column">
              <Box>
                {graphSegments(r, width).map((seg, j) => (
                  <Text key={`s${j}`} color={seg.lane >= 0 ? LANE_COLORS[seg.lane] : undefined}>{seg.text}</Text>
                ))}
                {r.sha && <Button key={`c-${r.sha.slice(0, 7)}`} label={r.sha.slice(0, 7)} onPress={showCommit(g.repo, r.sha)} />}
                {r.sha && refNames(r).map(x => <Text key={`${r.sha}-${x.name}`} color={REF_COLOR[x.kind]} bold={x.kind === 'head'}> [{x.name}]</Text>)}
                {r.sha && <Text color={SIDE_COLOR[r.side ?? 'both']} dimColor={r.side === 'both'}> {(r.subject ?? '').slice(0, 72)}</Text>}
                {r.sha && <Text dimColor>  {commitMeta(r, now)}</Text>}
              </Box>
              {r.sha && shown?.sha === r.sha && (
                <Box flexDirection="column" marginLeft={width + 2}>
                  {shown.text.split('\n').slice(0, 30).map((line, k) => <Text key={`d${k}`} dimColor>{line}</Text>)}
                </Box>
              )}
            </Box>
          ))}
          {g.more && <Button key="graph-more" label={`Show ${GRAPH_STEP} more`} onPress={regraph({ limit: g.limit + GRAPH_STEP })} />}
        </Box>
      )
    }

    // ---- the team branches: what each older one has that the next newer one lacks (read-only)
    if (mode === 'sync') {
      const sy = s.sync
      const rows = hopRows(sy, only)
      const p = page(rows, from, Math.max(2, Math.floor(size / 2)))
      return (
        <Box flexDirection="column">
          {header}
          {sy ? (
            <Text dimColor>
              {sy.summary.repos} repos with a team chain · {sy.summary.hopsPending} hops to sync · {sy.summary.fixesPending} fixes · {sy.summary.conflictHops} would conflict · read {ago(sy.generated, now)}
            </Text>
          ) : <Text dimColor>Branch sync has not been read yet.</Text>}
          <Button key="refresh-sync" label="Refresh sync" onPress={() => sync(false, 'sync')} />
          {confirmPanel}
          {sy && p.rows.length === 0 && <Text color={COLORS.ok}>{only ? 'Every team branch has what the older ones have.' : 'No repo has two team branches.'}</Text>}
          {p.rows.map(r => {
            const key = hopKey(r)
            const isOpen = opened === key
            const conflict = forecastText(r.hop.forecast)
            return (
              <Box key={key} flexDirection="column">
                <Box>
                  <Button key={`hop-${key}`} label={`${isOpen ? '▾' : '▸'} ${r.repo}  ${r.hop.from} → ${r.hop.to}`}
                    onPress={() => $.state.set(open, isOpen ? null : key)} />
                  <Text color={r.hop.missing ? COLORS.warn : COLORS.dim}>  {hopLine(r.hop)}  </Text>
                  {r.hop.mode === 'cherry-pick' && <Text dimColor>cherry-pick hop  </Text>}
                  <Button key={`hist-${key}`} label="History" onPress={openGraph(hopHistory(r.repo, r.hop))} />
                </Box>
                {conflict && <Text color={COLORS.urgent}>      {conflict}</Text>}
                {r.hop.inProgress ? (
                  <Box marginLeft={6}>
                    <Text color={COLORS.warn}>{r.hop.inProgress.state === 'conflict' ? 'stopped on conflicts' : 'resolved, ready to finish'} in {r.hop.inProgress.path}  </Text>
                    {r.hop.inProgress.state === 'conflict' && !pending && (
                      <Button key={`ask-${key}`} label="Ask Claude to resolve" onPress={() => $.prompt.fill({ text: resolveAskText(r) })} />
                    )}
                    {!pending && <Button key={`fin-${key}`} label="Finish…" onPress={propose([syncArgs('sync-finish', r.repo, r.hop)])} />}
                    {!pending && <Button key={`abt-${key}`} label="Abort…" onPress={propose([syncArgs('sync-abort', r.repo, r.hop)])} />}
                  </Box>
                ) : r.hop.pushed ? (
                  <Text dimColor>      {r.hop.pushed} is on origin: open its pull request, or merge it</Text>
                ) : r.hop.missing && !pending ? (
                  <Box marginLeft={6}>
                    <Button key={`go-${key}`} label="Sync…" onPress={propose([syncArgs('sync-hop', r.repo, r.hop)])} />
                  </Box>
                ) : null}
                {isOpen && (r.hop.fixes ?? []).map(f => (
                  <Box key={`${key}-${f.key}`} flexDirection="column" marginLeft={4}>
                    <Text color={f.state === 'skipped' ? COLORS.dim : COLORS.warn}>{fixGlyph(f)} {fixLine(f)}</Text>
                    {f.commits.filter(c => c.state !== 'applied').map(c => (
                      <Box key={c.sha} marginLeft={4}>
                        <Text dimColor>{c.sha.slice(0, 8)} {c.subject.slice(0, 60)}{c.state === 'skipped' ? `  (skipped: ${c.reason ?? 'no reason given'})` : ''}  </Text>
                        {!pending && !r.hop.inProgress && (
                          <Button key={`sk-${c.sha}`} label={c.state === 'skipped' ? 'Take again…' : 'Do not take…'}
                            onPress={propose([syncArgs(c.state === 'skipped' ? 'sync-unskip' : 'sync-skip', r.repo, r.hop, c.sha)])} />
                        )}
                      </Box>
                    ))}
                  </Box>
                ))}
                {isOpen && r.hop.truncated && <Text dimColor>    more fixes than are listed</Text>}
                {isOpen && (r.hop.outsideWindow ?? 0) > 0 && <Text dimColor>    {r.hop.outsideWindow} older commits are outside the window</Text>}
              </Box>
            )
          })}
          {p.total > p.rows.length && (
            <Box>
              <Text dimColor>{p.from}-{p.to} of {p.total}  </Text>
              {from > 0 && <Button key="prev" label="Prev" onPress={() => $.state.set(offset, Math.max(0, from - p.rows.length))} />}
              <Text> </Text>
              {p.to < p.total && <Button key="next" label="Next" onPress={() => $.state.set(offset, from + p.rows.length)} />}
            </Box>
          )}
        </Box>
      )
    }

    // ---- every worktree, the ones to act on first
    if (mode === 'worktrees') {
      const rows = worktreeRows(s, only, focused)
      const p = page(rows, from, size)
      const bulk = dedupePrune(bulkRows(rows))
      const wtn = wtCounts(worktreeRows(s, false))
      return (
        <Box flexDirection="column">
          {header}
          {sum && (
            <Box gap={2}>
              {wtn.safe > 0 && <Text color={COLORS.ok}>● {wtn.safe} safe</Text>}
              {wtn.review > 0 && <Text color={COLORS.warn}>● {wtn.review} review</Text>}
              {wtn.conflict > 0 && <Text color={COLORS.urgent}>● {wtn.conflict} conflict</Text>}
              {wtn.broken > 0 && <Text color={COLORS.warn}>● {wtn.broken} broken</Text>}
              <Text color={COLORS.dim}>● {wtn.ok} in use</Text>
              <Text dimColor>scanned {ago(s.generated, now)}</Text>
            </Box>
          )}
          {!pending && sum && sum.removable > 0 && (
            <Button key="bulk" label={`Remove all safe (${bulk.length})`}
              onPress={propose(bulk.map(r => actionArgs(r)).filter((a): a is string[] => !!a))} />
          )}
          {!pending && (s.undoable ?? []).length > 0 && (
            <Button key="undo" label={undoLabel((s.undoable ?? [])[0])} onPress={propose([undoArgs((s.undoable ?? [])[0])])} />
          )}
          {confirmPanel}
          {focused && (
            <Box>
              <Text dimColor>Showing one worktree.  </Text>
              <Button key="show-all-wt" label="Show all worktrees" onPress={async () => {
                await $.state.set(focus, null)
                await $.state.set(offset, 0)
              }} />
            </Box>
          )}
          {p.rows.length === 0 && <Text color={COLORS.ok}>{focused ? 'repowatch does not know that worktree yet. Scan, then try again.' : only ? 'No worktree needs a look.' : 'No worktrees.'}</Text>}
          {p.rows.map(r => {
            const args = actionArgs(r)
            const w = r.wt
            const isOpen = !!focused || wtOpened === w.path
            const tone = w.forecast?.state === 'conflict' ? COLORS.urgent : CLASS_COLOR[w.class]
            const fc = forecastText(w.forecast)
            return (
              <Box key={`${r.repo}-${w.path}`} flexDirection="column">
                <Box gap={1} alignItems="center">
                  <Text color={tone}>●</Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Button key={`wt-${w.path}`} label={`${r.repo} · ${w.branch ?? '(detached)'}${w.owner === 'sdd' ? ` · sdd ${w.workItem ?? ''}` : ''}`}
                      onPress={() => $.state.set(wtOpen, wtOpened === w.path ? null : w.path)} />
                  </Box>
                  <Text color={tone}>{wtWord(w)}</Text>
                  <Text dimColor>{agoShort(w.lastCommit, now).padStart(4)}</Text>
                </Box>
                {isOpen && (
                  <Box flexDirection="row" alignItems="stretch">
                    <Box key={`wtrail-${w.path}`} width={2} flexShrink={0} flexDirection="row">
                      <Box width="25%" flexShrink={0} />
                      <Box width="20%" flexShrink={0} backgroundColor={tone} />
                    </Box>
                    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} marginBottom={1}>
                      <Text dimColor wrap="wrap">{wtFacts(w, now).join(' · ')}</Text>
                      {w.owner === 'sync' && <Text dimColor>branch sync</Text>}
                      {fc && <Text color={COLORS.urgent} wrap="wrap">{fc}</Text>}
                      <Box gap={1} flexWrap="wrap">
                        <Button key={`copy-${w.path}`} label="📋" onPress={() => copyPath($, w.path)} />
                        <Button key={`hist-${w.path}`} label="History" onPress={openGraph(worktreeHistory(r))} />
                        {args && !pending && (
                          <Button key={`act-${w.path}`} label={w.class === 'prune' ? 'Prune' : w.class === 'review' ? 'Review…' : 'Remove…'} onPress={propose([args])} />
                        )}
                        {w.owner === 'sdd' && (w.class === 'safe' || w.class === 'review') && (
                          <Button key={`sdd-${w.path}`} label="Ask sdd to remove" onPress={() => $.prompt.fill({ text: sddRemoveText(w.workItem) })} />
                        )}
                        {fc && <Button key={`merge-${w.path}`} label="Ask Claude to merge" onPress={() => $.prompt.fill({ text: mergeAskText(r) })} />}
                      </Box>
                    </Box>
                  </Box>
                )}
              </Box>
            )
          })}
          {p.total > size && (
            <Box>
              <Text dimColor>{p.from}-{p.to} of {p.total}  </Text>
              {from > 0 && <Button key="prev" label="Prev" onPress={() => $.state.set(offset, Math.max(0, from - size))} />}
              <Text> </Text>
              {p.to < p.total && <Button key="next" label="Next" onPress={() => $.state.set(offset, from + size)} />}
            </Box>
          )}
        </Box>
      )
    }

    // ---- the repos
    const rows = visibleRepos(s, only)
    const p = page(rows, from, size)

    return (
      <Box flexDirection="column">
        {header}
        {sum && (
          <Text dimColor>
            {sum.repos} repos · {sum.attention} need attention · {sum.worktrees} worktrees · scanned {ago(s.generated, now)}
          </Text>
        )}
        {confirmPanel}
        {p.rows.length === 0 && <Text color={COLORS.ok}>{only ? 'Nothing needs attention.' : 'No repos.'}</Text>}
        {p.rows.map(r => {
          const isOpen = opened === r.name
          return (
            <Box key={r.name} flexDirection="column">
              <Box>
                <Button key={`row-${r.name}`} label={`${isOpen ? '▾' : '▸'} ${r.name}`}
                  onPress={() => $.state.set(open, isOpen ? null : r.name)} />
                <Text dimColor>  {branchText(r)}  </Text>
                {r.flags.map(f => (
                  <Text key={f} color={isUrgent(f) ? COLORS.urgent : f === 'stale-fetch' ? COLORS.dim : COLORS.warn}>{flagLabel(f)}  </Text>
                ))}
              </Box>
              {isOpen && (
                <Box flexDirection="column" marginLeft={3}>
                  <Box>
                    <Text dimColor>{r.path}  </Text>
                    {repoHistory(r) && <Button key={`hist-${r.name}`} label="History" onPress={openGraph(repoHistory(r))} />}
                  </Box>
                  <Text dimColor>
                    default {r.defaultBranch ?? '?'} · fetched {ago(r.lastFetch, now)} · {r.dirty ?? 0} uncommitted · {r.stashes ?? 0} stashes · {r.branches ?? 0} branches
                  </Text>
                  {r.error && <Text color={COLORS.urgent}>{r.error}</Text>}
                  {r.fetchError && <Text color={COLORS.warn}>fetch: {r.fetchError}</Text>}
                  {forecastText(r.forecast) && <Text color={COLORS.urgent}>diverged from {r.upstream}: {forecastText(r.forecast)}</Text>}
                  {(r.goneBranches ?? []).map(b => (
                    <Box key={`gone-${b}`}>
                      <Text dimColor>upstream gone: {b}  </Text>
                      {!pending && <Button key={`del-${b}`} label="Delete…" onPress={propose([['delete-branch', '--repo', r.name, '--branch', b]])} />}
                    </Box>
                  ))}
                  {(r.worktrees ?? []).map(w => (
                    <Text key={w.path} dimColor>
                      worktree {w.branch ?? '(detached)'} · {classLabel(w.class)} · {w.dirty ? `${w.dirty} uncommitted` : 'clean'} · last commit {ago(w.lastCommit, now)}{w.missing ? ' · folder missing' : ''}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
        {p.total > size && (
          <Box>
            <Text dimColor>{p.from}-{p.to} of {p.total}  </Text>
            {from > 0 && <Button key="prev" label="Prev" onPress={() => $.state.set(offset, Math.max(0, from - size))} />}
            <Text> </Text>
            {p.to < p.total && <Button key="next" label="Next" onPress={() => $.state.set(offset, from + size)} />}
          </Box>
        )}
      </Box>
    )
  })
}
