// repowatch: a pane and a status line for many git repos. It reads .claude/repowatch/state.json, which
// `repowatch.py scan` writes; the scan itself runs on a timer (local facts every minute, a few fetches
// every few minutes). Nothing here changes a repo: Scan and Fetch only read or fetch.
import type { EngineInterface, Register } from 'claude-code'

import type { RwState } from '../types'
import { ago, branchText, flagLabel, isUrgent, page, statusText, visibleRepos } from './view/model'

const PANE = 'repowatch'
const state = { plugin: 'repowatch', key: 'state' } as const
const error = { plugin: 'repowatch', key: 'error' } as const
const onlyAttention = { plugin: 'repowatch', key: 'onlyAttention' } as const
const offset = { plugin: 'repowatch', key: 'offset' } as const
const open = { plugin: 'repowatch', key: 'open' } as const
const busy = { plugin: 'repowatch', key: 'busy' } as const

const SCAN_EVERY_MS = 60_000
const FETCH_EVERY_SCANS = 5
const COLORS = { urgent: '#c0503f', warn: '#c98a12', ok: '#3f9a63', dim: '#7b8794' }

let python = 'python'  // module state: lost on reload, which is fine

/** Runs repowatch.py with the arguments and returns its last line of output, or throws with why it failed. */
async function run($: EngineInterface, args: string[], timeoutMs: number): Promise<string> {
  const cwd = await $.session.cwd()
  let why = 'could not run python'
  for (const exe of [python, 'python3', 'py']) {
    try {
      const r = await $.process.run([exe, `${$.plugin.root}/scripts/repowatch.py`, ...args], { cwd, timeoutMs })
      python = exe
      if (r.exitCode === 0) return r.stdout
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
async function refresh($: EngineInterface, fetch: boolean): Promise<Sweep> {
  try {
    await run($, fetch ? ['scan', '--fetch', '--json'] : ['scan', '--json'], fetch ? 300_000 : 120_000)
    return { s: await load($), why: null }
  } catch (err) {
    return { s: null, why: String(err instanceof Error ? err.message : err) }
  }
}

export const register: Register = on => {
  let scans = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'repowatch',
      description: 'Show the git repos of this workspace in a pane; "scan" or "fetch" refreshes them',
      argumentHint: '[scan|fetch]',
    })
    const sync = async (fetch: boolean) => {
      const r = await refresh($, fetch)
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      $.ui.status(statusText(r.s?.summary))
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
    if (arg === 'scan' || arg === 'fetch') {
      await $.state.set(busy, arg)
      const r = await refresh($, arg === 'fetch')
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      await $.state.set(busy, null)
      $.ui.status(statusText(r.s?.summary))
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
    const now = Math.floor(Date.now() / 1000)

    const act = (kind: 'scan' | 'fetch') => async () => {
      await $.state.set(busy, kind)
      const r = await refresh($, kind === 'fetch')
      if (r.s) await $.state.set(state, r.s)
      await $.state.set(error, r.why)
      await $.state.set(busy, null)
      $.ui.status(statusText(r.s?.summary))
    }

    const header = (
      <Box flexDirection="column">
        <Box>
          <Button key="scan" label="Scan" onPress={act('scan')} />
          <Text> </Text>
          <Button key="fetch" label="Fetch a few" onPress={act('fetch')} />
          <Text> </Text>
          <Button key="filter" label={only ? 'Show all' : 'Needs attention'} onPress={async () => {
            await $.state.set(onlyAttention, !only)
            await $.state.set(offset, 0)
          }} />
        </Box>
        {working && <Text color={COLORS.warn}>{working === 'fetch' ? 'Fetching…' : 'Scanning…'}</Text>}
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

    const rows = visibleRepos(s, only)
    const size = Math.max(3, (e.viewport?.rows ?? 30) - 8)
    const p = page(rows, from, size)
    const sum = s.summary

    return (
      <Box flexDirection="column">
        {header}
        {sum && (
          <Text dimColor>
            {sum.repos} repos · {sum.attention} need attention · {sum.worktrees} worktrees · scanned {ago(s.generated, now)}
          </Text>
        )}
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
                  {(r.goneBranches ?? []).length > 0 && <Text dimColor>upstream gone: {(r.goneBranches ?? []).join(', ')}</Text>}
                  {(r.worktrees ?? []).map(w => (
                    <Text key={w.path} dimColor>
                      worktree {w.branch ?? '(detached)'} · {w.dirty ? `${w.dirty} uncommitted` : 'clean'} · last commit {ago(w.lastCommit, now)}{w.missing ? ' · folder missing' : ''}
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
