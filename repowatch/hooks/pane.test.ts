// The pane, drawn and pressed through the engine's test kit. repowatch.py is never run: a hook beneath the
// plugin answers `process.run` with canned output and records the command, so what these tests check is
// what the pane asks for and when, above all that no clean-up or sync runs before its Confirm.
import { expect, test } from 'claude-code/testing'

import type { RwPlan, RwState } from '../types'

const WT = (extra: Record<string, unknown>) => ({
  path: '/w/x', branch: 'x', head: 'abc', detached: false, locked: false, prunable: false, missing: false,
  class: 'ok', reasons: [], dirty: 0, lastCommit: 1_700_000_000, ...extra,
})

const STATE: RwState = {
  version: 1, generated: 1_700_000_100,
  summary: { repos: 2, attention: 2, behind: 0, dirty: 0, unpushed: 0, worktrees: 4, removable: 1, toReview: 1, conflicts: 1, errors: 0 },
  undoable: [{ id: '17', at: 1, action: 'remove-worktree', repo: 'app', path: '/w/old', branch: 'feat/old' }],
  repos: {
    app: {
      name: 'app', path: '/ws/app', scannedAt: 1, branch: 'main', defaultBranch: 'main', ahead: 0, behind: 0, dirty: 0,
      goneBranches: ['feat/gone'], flags: ['removable-worktree', 'old-worktree', 'will-conflict'],
      worktrees: [
        WT({ path: '/w/merged', branch: 'feat/merged', class: 'safe', reasons: ['merged into main'] }),
        WT({ path: '/w/squash', branch: 'feat/squash', class: 'review', reasons: ['its upstream branch was deleted and 1 commit is on no remote (a squash merge?)'] }),
        WT({ path: '/w/clash', branch: 'feat/clash', class: 'ok', baseRef: 'origin/main', behindBase: 2, aheadBase: 1,
          forecast: { state: 'conflict', base: 'origin/main', files: ['a.cs'] } }),
        WT({ path: '/w/sdd', branch: 'dev/x/7', class: 'safe', owner: 'sdd', workItem: 7, reasons: ['merged into main'] }),
      ],
    },
    web: { name: 'web', path: '/ws/web', scannedAt: 1, branch: 'main', defaultBranch: 'main', flags: [] },
  },
  sync: {
    generated: 1_700_000_100,
    summary: { repos: 1, hopsPending: 2, fixesPending: 2, conflictHops: 1 },
    repos: { app: { branches: ['team/0.0.1', 'team/0.0.2', 'team/0.0.3'], hops: [
      { from: 'team/0.0.1', to: 'team/0.0.2', missing: 1, applied: 0, skipped: 0, mode: 'merge',
        fixes: [{ key: 'ADO 4471', workItems: [4471], title: 'Fix the thing', state: 'missing',
          commits: [{ sha: 'aaaaaaaa11112222', time: 1, author: 'x', subject: 'Fix the thing', state: 'missing', workItems: [4471] }] }] },
      { from: 'team/0.0.2', to: 'team/0.0.3', missing: 1, applied: 0, skipped: 0, mode: 'merge',
        forecast: { state: 'conflict', base: 'origin/team/0.0.2', files: ['shared.txt'] },
        inProgress: { path: '/ws/.claude/repowatch/sync/app/0.0.2-0.0.3', branch: 'sync/0.0.2-0.0.3', state: 'conflict' },
        fixes: [{ key: 'ADO 6000', workItems: [6000], title: 'Fix shared', state: 'missing',
          commits: [{ sha: 'bbbbbbbb11112222', time: 1, author: 'x', subject: 'Fix shared', state: 'missing', workItems: [6000] }] }] },
    ] } },
  },
}

const PROPS = { title: 'repowatch', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never

// `claude plugin test .` at the repo root also finds this file and runs it against the sdd plugin. The plugin
// under test registers its own commands at session start, so a test can tell: these tests only mean something
// (and only run) when `repowatch` is the one registered.
const registered: string[] = []

/** Records every command the plugin runs; plan and apply answer from the arguments they were given. */
function fakeScript(on: (event: 'process.run', hook: (...a: never[]) => unknown) => void, level: RwPlan['level'] = 'safe') {
  const calls: string[][] = []
  on('process.run', ((_$: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(2)
    calls.push(args)
    const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
    let out = '{}'
    // another plugin's script (sdd's env.py view, when this file runs at the repo root) gets an empty snapshot
    if (!String(e.argv[1]).endsWith('repowatch.py')) out = JSON.stringify({ root: '/ws', specRoot: 'docs/spec', flows: {}, derived: [], items: [], done: [] })
    const mine = String(e.argv[1]).endsWith('repowatch.py')
    if (mine && args[0] === 'status') out = JSON.stringify(STATE)
    if (mine && (args[0] === 'plan' || args[0] === 'apply')) {
      const plan: RwPlan = {
        action: args[1] as RwPlan['action'], repo: flag('--repo') ?? '', path: flag('--path'), branch: flag('--branch'),
        level, blocked: [], reasons: ['merged into main'], atRisk: level === 'review' ? ['abc1234 a commit only here'] : [],
        steps: [['git', 'worktree', 'remove', flag('--path') ?? ''], ...(args.includes('--delete-branch') ? [['git', 'branch', '-D', 'feat/merged']] : [])],
        restore: [], restoreSteps: [],
        hop: flag('--hop') ? (flag('--hop') as string).split(':') as [string, string] : undefined,
        decision: flag('--sha') ? { sha: flag('--sha') as string, subject: 's', reason: flag('--reason') ?? 'r' } : undefined,
      }
      out = JSON.stringify(args[0] === 'plan' ? plan : { ok: true, done: [], plan, state: 'pr', pr: { id: 9, url: 'u' }, branch: 'sync/x' })
    }
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }) as never)
  // the engine beneath the plugin: it takes a command registration, a timer, a pane to open, a status line and a toast
  on('session.cwd' as never, (() => ({ value: '/ws' })) as never)
  on('session.start' as never, ((_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  registered.length = 0
  on('command.register' as never, ((_$: unknown, e: { name: string }) => { registered.push(e.name); return { value: { isRegistered: true } } }) as never)
  on('clock.every' as never, (() => ({ value: { id: 'tick' } })) as never)
  on('ui.open' as never, (() => ({ value: { isPlaced: true } })) as never)
  on('ui.status' as never, (() => ({ value: undefined })) as never)
  on('ui.toast' as never, (() => ({ value: undefined })) as never)
  return calls
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = async ($: any, view: string) => {
    // the way a person gets here: the session starts and reads the repos, the pane opens, a tab is pressed
    await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
    if (!registered.includes('repowatch')) {
      await new Promise(r => setTimeout(r, 100)) // let the other plugin's session.start work finish before the test ends
      return null
    }
    const ui = await $.ui.mount({ plugin: 'repowatch', surface, component: 'Pane', props: PROPS, requestId: 'repowatch', viewport: { columns: 110, rows: 40 } })
    for (let i = 0; i < 100 && !(await texts(ui)).includes('2 repos'); i++) await new Promise(r => setTimeout(r, 10))
    if (view !== 'repos') await ui.press({ key: view })
    return ui
  }

  test(`${surface}: the repos view lists the repo that needs attention first`, async ($: any, on: any) => {
    fakeScript(on)
    const ui = await mountPane($, 'repos')
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('2 repos')
    expect(t).toContain('will conflict')
    expect(await ui.find({ key: 'row-app' })).toBeTruthy()
    expect(await ui.find({ key: 'row-web' })).toBe(undefined) // clean, hidden by the attention filter
  })

  test(`${surface}: a clean-up shows its plan and runs nothing until Confirm`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees')
    if (!ui) return
    await ui.press({ key: 'act-/w/merged' })
    expect(calls.some(c => c[0] === 'plan' && c[1] === 'remove-worktree' && c.includes('/w/merged') && c.includes('--delete-branch'))).toBe(true)
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    expect(await texts(ui)).toContain('Do this for 1 item?')
    // Cancel runs nothing and closes the panel
    await ui.press({ key: 'cancel' })
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    expect(await texts(ui)).not.toContain('Do this for')
    // plan again, then Confirm applies the same arguments, without the review override
    await ui.press({ key: 'act-/w/merged' })
    await ui.press({ key: 'confirm' })
    const apply = calls.find(c => c[0] === 'apply')
    expect(apply).toEqual(['apply', 'remove-worktree', '--repo', 'app', '--path', '/w/merged', '--delete-branch'])
  })

  test(`${surface}: a review plan lists the commits at risk and applies with the override only after Confirm`, async ($: any, on: any) => {
    const calls = fakeScript(on, 'review')
    const ui = await mountPane($, 'worktrees')
    if (!ui) return
    await ui.press({ key: 'act-/w/squash' })
    const t = await texts(ui)
    expect(t).toContain('Commits that exist only here')
    expect(t).toContain('a commit only here')
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    await ui.press({ key: 'confirm' })
    expect(calls.find(c => c[0] === 'apply')).toContain('--allow-review')
  })

  test(`${surface}: sdd's own worktree has no Remove button, only the ask`, async ($: any, on: any) => {
    fakeScript(on)
    const ui = await mountPane($, 'worktrees')
    if (!ui) return
    expect(await ui.find({ key: 'act-/w/sdd' })).toBe(undefined)
    expect(await ui.find({ key: 'sdd-/w/sdd' })).toBeTruthy()
  })

  test(`${surface}: bulk remove plans only the safe rows that are not sdd's`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees')
    if (!ui) return
    await ui.press({ key: 'bulk' })
    const plans = calls.filter(c => c[0] === 'plan')
    expect(plans.length).toBe(1)
    expect(plans[0]).toContain('/w/merged')
  })

  test(`${surface}: a conflicting worktree offers to ask Claude, which only fills the prompt`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    let filled = ''
    on('prompt.fill', ((_$: unknown, e: { text: string }) => { filled = e.text; return { isFilled: true } }) as never)
    const ui = await mountPane($, 'worktrees')
    if (!ui) return
    expect(await texts(ui)).toContain('would conflict in a.cs')
    await ui.press({ key: 'merge-/w/clash' })
    expect(filled).toContain('merge origin/main in and resolve the conflicts in a.cs')
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: Undo is offered and goes through a plan first`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees')
    if (!ui) return
    await ui.press({ key: 'undo' })
    expect(calls.some(c => c[0] === 'plan' && c[1] === 'undo' && c.includes('17'))).toBe(true)
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: a gone branch's Delete… plans first`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos')
    if (!ui) return
    await ui.press({ key: 'row-app' })
    await ui.press({ key: 'del-feat/gone' })
    expect(calls.find(c => c[0] === 'plan')).toEqual(['plan', 'delete-branch', '--repo', 'app', '--branch', 'feat/gone'])
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: the sync view plans a hop, and a stopped one offers resolve, finish and abort`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    let filled = ''
    on('prompt.fill', ((_$: unknown, e: { text: string }) => { filled = e.text; return { isFilled: true } }) as never)
    const ui = await mountPane($, 'sync')
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('2 hops to sync')
    // the clean hop: Sync… asks for a plan; nothing is applied
    await ui.press({ key: 'go-app:team/0.0.1' })
    expect(calls.find(c => c[0] === 'plan')).toEqual(['plan', 'sync-hop', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2'])
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    await ui.press({ key: 'cancel' })
    // the stopped hop: no Sync… button, but resolve / finish / abort
    expect(await ui.find({ key: 'go-app:team/0.0.2' })).toBe(undefined)
    await ui.press({ key: 'ask-app:team/0.0.2' })
    expect(filled).toContain('stopped on conflicts in shared.txt')
    expect(filled).toContain('Do not push')
    await ui.press({ key: 'fin-app:team/0.0.2' })
    expect(calls.filter(c => c[0] === 'plan').pop()).toEqual(['plan', 'sync-finish', '--repo', 'app', '--hop', 'team/0.0.2:team/0.0.3'])
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: the reason typed for a skipped commit is the one applied`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'sync')
    if (!ui) return
    await ui.press({ key: 'hop-app:team/0.0.1' })
    await ui.press({ key: 'sk-aaaaaaaa11112222' })
    expect(await ui.find({ key: 'skip-why' })).toBeTruthy()
    await ui.input({ key: 'skip-why', text: 'only for 0.0.1' })
    const apply = calls.find(c => c[0] === 'apply')
    expect(apply?.slice(0, 2)).toEqual(['apply', 'sync-skip'])
    expect(apply?.slice(apply.indexOf('--reason'))).toEqual(['--reason', 'only for 0.0.1'])
  })

  test(`${surface}: skipping a commit asks for a plan with that commit, and Confirm applies it`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'sync')
    if (!ui) return
    await ui.press({ key: 'hop-app:team/0.0.1' })
    await ui.press({ key: 'sk-aaaaaaaa11112222' })
    expect(calls.find(c => c[0] === 'plan')).toEqual(
      ['plan', 'sync-skip', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2', '--sha', 'aaaaaaaa11112222'])
    await ui.press({ key: 'confirm' })
    const apply = calls.find(c => c[0] === 'apply')
    expect(apply?.slice(0, 2)).toEqual(['apply', 'sync-skip'])
    expect(apply).toContain('aaaaaaaa11112222')
  })
}
