// repowatch: a pane and a status line for many git repos. It reads .claude/repowatch/state.json, which
// `repowatch.py scan` writes; the scan itself runs on a timer (local facts every minute, a few fetches
// every few minutes). Scan and Fetch only read or fetch. A clean-up (remove a worktree, prune) runs
// only when the person presses its button, and only after the pane has shown the plan and been
// confirmed: `repowatch.py plan` builds it from the live repo, `repowatch.py apply` checks again.
import type { EngineInterface, Register } from 'claude-code'

import type { RwPlan, RwResult, RwState } from '../types'
import {
  actionArgs, ago, baseText, branchText, bulkRows, classLabel, conflictToast, dedupePrune, flagLabel, forecastText, isUrgent,
  fixGlyph, fixLine, hopKey, hopLine, hopRows, mergeAskText, page, planArgs, planGist, resolveAskText, resultLine, sddRemoveText,
  statusText, stepText, syncArgs, undoArgs, undoLabel, visibleRepos, worktreeRows,
} from './view/model'

const PANE = 'repowatch'
const state = { plugin: 'repowatch', key: 'state' } as const
const error = { plugin: 'repowatch', key: 'error' } as const
const onlyAttention = { plugin: 'repowatch', key: 'onlyAttention' } as const
const offset = { plugin: 'repowatch', key: 'offset' } as const
const open = { plugin: 'repowatch', key: 'open' } as const
const busy = { plugin: 'repowatch', key: 'busy' } as const
const view = { plugin: 'repowatch', key: 'view' } as const
const plans = { plugin: 'repowatch', key: 'plans' } as const

const SCAN_EVERY_MS = 60_000
const FETCH_EVERY_SCANS = 5
const COLORS = { urgent: '#c0503f', warn: '#c98a12', ok: '#3f9a63', dim: '#7b8794' }
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
      description: 'Show the git repos of this workspace in a pane; "worktrees" lists every worktree, "sync" the team branch sync, "scan" or "fetch" refreshes',
      argumentHint: '[worktrees|sync|scan|fetch]',
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
    if (arg === 'worktrees' || arg === 'sync') {
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = (await $.state.get(state)).value ?? null
    const why = (await $.state.get(error)).value ?? null
    const only = (await $.state.get(onlyAttention)).value ?? true
    const from = (await $.state.get(offset)).value ?? 0
    const opened = (await $.state.get(open)).value ?? null
    const working = (await $.state.get(busy)).value ?? null
    const mode = (await $.state.get(view)).value ?? 'repos'
    const pending = (await $.state.get(plans)).value ?? null
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
    const confirm = (todo: RwPlan[]) => async () => {
      await $.state.set(busy, 'cleaning up')
      const results = await applyPlans($, todo)
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
          <Box>
            {g.run.length > 0 && <Button key="confirm" label={g.review ? `Confirm (${g.review} to review)` : 'Confirm'} onPress={confirm(g.run)} />}
            <Text> </Text>
            <Button key="cancel" label="Cancel" onPress={() => $.state.set(plans, null)} />
          </Box>
        </Box>
      )
    })()

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
      const rows = worktreeRows(s, only)
      const p = page(rows, from, size)
      const bulk = dedupePrune(bulkRows(rows))
      return (
        <Box flexDirection="column">
          {header}
          {sum && <Text dimColor>{sum.worktrees} worktrees · {sum.removable} to remove · {sum.toReview} to review · scanned {ago(s.generated, now)}</Text>}
          {!pending && sum && sum.removable > 0 && (
            <Button key="bulk" label={`Remove all safe (${bulk.length})`}
              onPress={propose(bulk.map(r => actionArgs(r)).filter((a): a is string[] => !!a))} />
          )}
          {!pending && (s.undoable ?? []).length > 0 && (
            <Button key="undo" label={undoLabel((s.undoable ?? [])[0])} onPress={propose([undoArgs((s.undoable ?? [])[0])])} />
          )}
          {confirmPanel}
          {p.rows.length === 0 && <Text color={COLORS.ok}>{only ? 'No worktree needs a look.' : 'No worktrees.'}</Text>}
          {p.rows.map(r => {
            const args = actionArgs(r)
            const w = r.wt
            return (
              <Box key={`${r.repo}-${w.path}`} flexDirection="column">
                <Box>
                  <Text color={CLASS_COLOR[w.class]}>{classLabel(w.class).padEnd(15)}</Text>
                  <Text>{r.repo} · {w.branch ?? '(detached)'}  </Text>
                  {w.owner === 'sdd' && <Text dimColor>sdd {w.workItem ?? ''}  </Text>}
                  {w.owner === 'sync' && <Text dimColor>branch sync  </Text>}
                  {args && !pending && (
                    <Button key={`act-${w.path}`} label={w.class === 'prune' ? 'Prune' : w.class === 'review' ? 'Review…' : 'Remove…'} onPress={propose([args])} />
                  )}
                  {w.owner === 'sdd' && (w.class === 'safe' || w.class === 'review') && (
                    <Button key={`sdd-${w.path}`} label="Ask sdd to remove" onPress={() => $.prompt.fill({ text: sddRemoveText(w.workItem) })} />
                  )}
                </Box>
                <Text dimColor>                 {w.reasons.join('; ') || 'in use'}{w.missing ? '' : ` · last commit ${ago(w.lastCommit, now)}`}{baseText(w) ? ` · ${baseText(w)}` : ''}</Text>
                {forecastText(w.forecast) && (
                  <Box>
                    <Text color={COLORS.urgent}>                 {forecastText(w.forecast)}  </Text>
                    <Button key={`merge-${w.path}`} label="Ask Claude to merge" onPress={() => $.prompt.fill({ text: mergeAskText(r) })} />
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
                  <Text dimColor>{r.path}</Text>
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
