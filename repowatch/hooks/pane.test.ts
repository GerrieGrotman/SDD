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

const NOW = Math.floor(Date.now() / 1000)
const HISTORY = [
  { graph: '*', sha: 'aaaaaaa111122223333', parents: ['b'], author: 'Ann', time: NOW - 3600, subject: 'feature two', merge: false, side: 'branch',
    refs: [{ name: 'HEAD', kind: 'head' }, { name: 'feat/clash', kind: 'local' }] },
  { graph: '*', sha: 'bbbbbbb111122223333', parents: ['c', 'd'], author: 'Bob', time: NOW - 7200, subject: 'Merge main', merge: true, side: 'branch', refs: [] },
  { graph: '|\\' },
  { graph: '| *', sha: 'ccccccc111122223333', parents: ['d'], author: 'Cy', time: NOW - 9000, subject: 'main three', merge: false, side: 'base',
    refs: [{ name: 'origin/main', kind: 'remote' }] },
  { graph: '*', sha: 'ddddddd111122223333', parents: [], author: 'Di', time: NOW - 86400 * 3, subject: 'shared root', merge: false, side: 'both',
    refs: [{ name: 'v1', kind: 'tag' }] },
]

const PROPS = { title: 'repowatch', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never

// `claude plugin test .` at the repo root also finds this file and runs it against the sdd plugin. The plugin
// under test registers its own commands at session start, so a test can tell: these tests only mean something
// (and only run) when `repowatch` is the one registered. Tests may run interleaved, so everything a stand-in
// remembers lives on the stand-in of its own test, never in the module.
type Fake = string[][] & { registered: string[]; graphError: string | null }

/** Records every command the plugin runs; plan and apply answer from the arguments they were given. */
function fakeScript(on: (event: 'process.run', hook: (...a: never[]) => unknown) => void, level: RwPlan['level'] = 'safe'): Fake {
  const calls = Object.assign([] as string[][], { registered: [] as string[], graphError: null as string | null })
  on('process.run', ((_$: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(2)
    calls.push(args)
    const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
    let out = '{}'
    // another plugin's script (sdd's env.py view, when this file runs at the repo root) gets an empty snapshot
    if (!String(e.argv[1]).endsWith('repowatch.py')) out = JSON.stringify({ root: '/ws', specRoot: 'docs/spec', flows: {}, derived: [], items: [], done: [] })
    const mine = String(e.argv[1]).endsWith('repowatch.py')
    if (mine && (args[0] === 'status' || (args[0] === 'scan' && args.includes('--auto')))) out = JSON.stringify(STATE)
    let exitCode = 0
    if (mine && args[0] === 'graph') {
      out = calls.graphError ? JSON.stringify({ error: calls.graphError }) : JSON.stringify({ repo: flag('--repo'), rows: HISTORY, more: true })
      if (calls.graphError) exitCode = 2
    }
    if (mine && args[0] === 'show') out = JSON.stringify({ sha: flag('--sha'), text: 'main three\n\n m3.txt | 1 +\n 1 file changed' })
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
    return { value: { exitCode, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }) as never)
  // the engine beneath the plugin: it takes a command registration, a timer, a pane to open, a status line and a toast
  on('session.cwd' as never, (() => ({ value: '/ws' })) as never)
  on('session.start' as never, ((_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  on('command.register' as never, ((_$: unknown, e: { name: string }) => { calls.registered.push(e.name); return { value: { isRegistered: true } } }) as never)
  on('clock.every' as never, (() => ({ value: { id: 'tick' } })) as never)
  on('ui.open' as never, (() => ({ value: { isPlaced: true } })) as never)
  on('ui.status' as never, (() => ({ value: undefined })) as never)
  on('ui.toast' as never, (() => ({ value: undefined })) as never)
  return calls
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = async ($: any, view: string, fake: Fake) => {
    // the way a person gets here: the session starts and reads the repos, the pane opens, a tab is pressed
    await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
    if (!fake.registered.includes('repowatch')) {
      await new Promise(r => setTimeout(r, 100)) // let the other plugin's session.start work finish before the test ends
      return null
    }
    const ui = await $.ui.mount({ plugin: 'repowatch', surface, component: 'Pane', props: PROPS, requestId: 'repowatch', viewport: { columns: 110, rows: 40 } })
    for (let i = 0; i < 100 && !(await texts(ui)).includes('2 repos'); i++) await new Promise(r => setTimeout(r, 10))
    if (view !== 'repos') await ui.press({ key: view })
    return ui
  }

  test(`${surface}: the session's timer runs only scan --auto, which decides what is due`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos', calls)
    if (!ui) return
    expect(calls.some(c => c[0] === 'scan' && c[1] === '--auto')).toBe(true)
    expect(calls.some(c => c[0] === 'scan' && !c.includes('--auto'))).toBe(false)
    expect(calls.some(c => c[0] === 'status' || c[0] === 'sync')).toBe(false)
  })

  test(`${surface}: the repos view lists the repo that needs attention first`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos', calls)
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('2 repos')
    expect(t).toContain('will conflict')
    expect(await ui.find({ key: 'row-app' })).toBeTruthy()
    expect(await ui.find({ key: 'row-web' })).toBe(undefined) // clean, hidden by the attention filter
  })

  test(`${surface}: a repo is one line, and a press opens its details and buttons under it`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos', calls)
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('● 1 conflict')
    expect(t).toContain('will conflict')
    expect(await ui.find({ key: 'copy-app' })).toBe(undefined)
    expect(await ui.find({ key: 'del-feat/gone' })).toBe(undefined)
    await ui.press({ key: 'row-app' })
    expect(await ui.find({ key: 'copy-app' })).toBeTruthy()
    expect(await ui.find({ key: 'del-feat/gone' })).toBeTruthy()
    await ui.press({ key: 'row-app' })
    expect(await ui.find({ key: 'copy-app' })).toBe(undefined)
  })

  test(`${surface}: a clean-up shows its plan and runs nothing until Confirm`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    await ui.press({ key: 'wt-/w/merged' })
    await ui.press({ key: 'act-/w/merged' })
    expect(calls.some(c => c[0] === 'plan' && c[1] === 'remove-worktree' && c.includes('/w/merged') && c.includes('--delete-branch'))).toBe(true)
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    expect(await texts(ui)).toContain('Do this for 1 item?')
    // Cancel runs nothing and closes the panel
    await ui.press({ key: 'cancel' })
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    expect(await texts(ui)).not.toContain('Do this for')
    // plan again (the row stays open), then Confirm applies the same arguments, without the review override
    await ui.press({ key: 'act-/w/merged' })
    await ui.press({ key: 'confirm' })
    const apply = calls.find(c => c[0] === 'apply')
    expect(apply).toEqual(['apply', 'remove-worktree', '--repo', 'app', '--path', '/w/merged', '--delete-branch'])
  })

  test(`${surface}: a review plan lists the commits at risk and applies with the override only after Confirm`, async ($: any, on: any) => {
    const calls = fakeScript(on, 'review')
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    await ui.press({ key: 'wt-/w/squash' })
    await ui.press({ key: 'act-/w/squash' })
    const t = await texts(ui)
    expect(t).toContain('Commits that exist only here')
    expect(t).toContain('a commit only here')
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    await ui.press({ key: 'confirm' })
    expect(calls.find(c => c[0] === 'apply')).toContain('--allow-review')
  })

  test(`${surface}: sdd's own worktree has no Remove button, only the ask`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    expect(await ui.find({ key: 'sdd-/w/sdd' })).toBe(undefined) // a closed row shows no buttons
    await ui.press({ key: 'wt-/w/sdd' })
    expect(await ui.find({ key: 'act-/w/sdd' })).toBe(undefined)
    expect(await ui.find({ key: 'sdd-/w/sdd' })).toBeTruthy()
  })

  test(`${surface}: bulk remove plans only the safe rows that are not sdd's`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
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
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    expect(await texts(ui)).not.toContain('would conflict in a.cs') // only an open row says it
    await ui.press({ key: 'wt-/w/clash' })
    expect(await texts(ui)).toContain('would conflict in a.cs')
    await ui.press({ key: 'merge-/w/clash' })
    expect(filled).toContain('merge origin/main in and resolve the conflicts in a.cs')
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: a worktree is one line, and a press opens its facts and buttons under it`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('● 2 safe')
    expect(t).toContain('● 1 conflict')
    expect(await ui.find({ key: 'hist-/w/merged' })).toBe(undefined)
    expect(await ui.find({ key: 'copy-/w/merged' })).toBe(undefined)
    await ui.press({ key: 'wt-/w/merged' })
    expect(await ui.find({ key: 'copy-/w/merged' })).toBeTruthy()
    expect(await ui.find({ key: 'hist-/w/clash' })).toBe(undefined) // one open at a time
    await ui.press({ key: 'wt-/w/clash' })
    expect(await ui.find({ key: 'copy-/w/merged' })).toBe(undefined)
    expect(await ui.find({ key: 'copy-/w/clash' })).toBeTruthy()
    await ui.press({ key: 'wt-/w/clash' }) // pressing the open one closes it
    expect(await ui.find({ key: 'copy-/w/clash' })).toBe(undefined)
  })

  test(`${surface}: the copy button runs the computer's clipboard tool with the path`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    await ui.press({ key: 'wt-/w/merged' })
    await ui.press({ key: 'copy-/w/merged' })
    expect(calls.some(c => c.join(' ').includes('/w/merged') && /pbcopy|Set-Clipboard/.test(c.join(' ')))).toBe(true)
  })

  test(`${surface}: Undo is offered and goes through a plan first`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    await ui.press({ key: 'undo' })
    expect(calls.some(c => c[0] === 'plan' && c[1] === 'undo' && c.includes('17'))).toBe(true)
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: a gone branch's Delete… plans first`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos', calls)
    if (!ui) return
    await ui.press({ key: 'row-app' })
    await ui.press({ key: 'del-feat/gone' })
    expect(calls.find(c => c[0] === 'plan')).toEqual(['plan', 'delete-branch', '--repo', 'app', '--branch', 'feat/gone'])
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
  })

  test(`${surface}: History draws a worktree's branch against its base, and its commits open on a press`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    await ui.press({ key: 'wt-/w/clash' })
    await ui.press({ key: 'hist-/w/clash' })
    expect(calls.find(c => c[0] === 'graph')).toEqual(['graph', '--repo', 'app', '--ref=feat/clash', '--ref=origin/main', '--limit', '40'])
    const t = await texts(ui)
    expect(t).toContain('app · feat/clash against origin/main')
    for (const wanted of ['feature two', 'Merge main', 'main three', 'shared root', '[HEAD]', '[feat/clash]', '[origin/main]', '[v1]', '●', '◆', '╲', '│'])
      expect(t).toContain(wanted)
    expect(t).toContain('green: only on feat/clash · blue: only on origin/main · grey: on both')
    expect(await ui.find({ key: 'graph-more' })).toBeTruthy()
    // a long subject is cut to the pane, never pushing the age off it
    const subjects = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props.minWidth === 0 && b.props.overflow === 'hidden')
    expect(subjects.length).toBeGreaterThan(3)
    expect((await ui.findAll({ type: 'Text' })).some((x: any) => x.props.wrap === 'truncate-end')).toBe(true)
    // a commit's details open on a press and close on the next
    await ui.press({ key: 'c-ccccccc' })
    expect(calls.find(c => c[0] === 'show')).toEqual(['show', '--repo', 'app', '--sha', 'ccccccc111122223333'])
    expect(await texts(ui)).toContain('m3.txt | 1 +')
    await ui.press({ key: 'c-ccccccc' })
    expect(await texts(ui)).not.toContain('m3.txt | 1 +')
    // nothing in the history view changes a repo
    expect(calls.some(c => c[0] === 'apply' || c[0] === 'plan')).toBe(false)
  })

  test(`${surface}: /repowatch history opens a branch's history, from words or from another plugin's JSON`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos', calls)
    if (!ui) return
    const json = JSON.stringify({ repo: 'app', refs: ['feat/x', 'origin/team/1'], title: 'app · feat/x against origin/team/1' })
    const res = await $.command.run({ command: 'repowatch', args: 'history ' + json })
    expect(res.text).toContain('History of app · feat/x against origin/team/1 opened')
    expect(calls.find(c => c[0] === 'graph')).toEqual(['graph', '--repo', 'app', '--ref=feat/x', '--ref=origin/team/1', '--limit', '40'])
    const t = await texts(ui)
    expect(t).toContain('app · feat/x against origin/team/1')
    expect(t).toContain('feature two')
    // by hand: words
    await $.command.run({ command: 'repowatch', args: 'history app main' })
    expect(calls.filter(c => c[0] === 'graph').pop()).toEqual(['graph', '--repo', 'app', '--ref=main', '--limit', '40'])
    // an option-looking ref and a missing branch never reach the script, or come back as a message
    const before = calls.filter(c => c[0] === 'graph').length
    expect((await $.command.run({ command: 'repowatch', args: 'history app --all' })).text).toContain('Usage:')
    expect(calls.filter(c => c[0] === 'graph').length).toBe(before)
    calls.graphError = 'no such branch or commit: nope'
    expect((await $.command.run({ command: 'repowatch', args: 'history app nope' })).text).toContain('no such branch or commit: nope')
  })

  test(`${surface}: /repowatch worktree shows that one worktree, and Show all brings the list back`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'repos', calls)
    if (!ui) return
    const res = await $.command.run({ command: 'repowatch', args: 'worktree ' + JSON.stringify({ path: '/w/clash' }) })
    expect(res.text).toContain('/w/clash shown')
    const t = await texts(ui)
    expect(t).toContain('Showing one worktree')
    expect(await ui.find({ key: 'wt-/w/clash' })).toBeTruthy()   // in use, and still shown: the attention filter does not hide a focused one
    expect(await ui.find({ key: 'hist-/w/clash' })).toBeTruthy() // and open, with no press
    expect(await ui.find({ key: 'wt-/w/merged' })).toBe(undefined)
    await ui.press({ key: 'show-all-wt' })
    const all = await texts(ui)
    expect(all).not.toContain('Showing one worktree')
    expect(await ui.find({ key: 'wt-/w/merged' })).toBeTruthy()
    // a path that names no worktree says so; no path is a usage line; an option-looking path is refused
    await $.command.run({ command: 'repowatch', args: 'worktree /nowhere' })
    expect(await texts(ui)).toContain('does not know that worktree')
    expect((await $.command.run({ command: 'repowatch', args: 'worktree' })).text).toContain('Usage:')
    expect((await $.command.run({ command: 'repowatch', args: 'worktree --all' })).text).toContain('Usage:')
    // the plain Worktrees command clears the focus
    await $.command.run({ command: 'repowatch', args: 'worktrees' })
    expect(await texts(ui)).not.toContain('Showing one worktree')
  })

  test(`${surface}: History can drop the base, follow first parents only, show more, and go back`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    await ui.press({ key: 'wt-/w/clash' })
    await ui.press({ key: 'hist-/w/clash' })
    await ui.press({ key: 'graph-base' })
    expect(calls.filter(c => c[0] === 'graph').pop()).toEqual(['graph', '--repo', 'app', '--ref=feat/clash', '--limit', '40'])
    expect(await texts(ui)).not.toContain('green: only on')
    await ui.press({ key: 'graph-fp' })
    expect(calls.filter(c => c[0] === 'graph').pop()).toContain('--first-parent')
    await ui.press({ key: 'graph-more' })
    expect(calls.filter(c => c[0] === 'graph').pop()).toEqual(['graph', '--repo', 'app', '--ref=feat/clash', '--limit', '80', '--first-parent'])
    await ui.press({ key: 'graph-back' })
    expect(await ui.find({ key: 'wt-/w/merged' })).toBeTruthy() // the Worktrees view again
  })

  test(`${surface}: History opens from a repo and from a sync hop`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    let ui = await mountPane($, 'repos', calls)
    if (!ui) return
    await ui.press({ key: 'row-app' })
    await ui.press({ key: 'hist-app' })
    expect(calls.find(c => c[0] === 'graph')).toEqual(['graph', '--repo', 'app', '--ref=main', '--limit', '40'])
    await ui.press({ key: 'graph-back' })
    expect(await ui.find({ key: 'row-app' })).toBeTruthy() // back to the repos view
    await ui.press({ key: 'sync' })
    await ui.press({ key: 'hop-app:team/0.0.1' })
    await ui.press({ key: 'hist-app:team/0.0.1' })
    expect(calls.filter(c => c[0] === 'graph').pop()).toEqual(
      ['graph', '--repo', 'app', '--ref=origin/team/0.0.2', '--ref=origin/team/0.0.1', '--limit', '40'])
    expect(await texts(ui)).toContain('app · team/0.0.1 → team/0.0.2')
  })

  test(`${surface}: a history that cannot be read says why and keeps the view you were in`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    const ui = await mountPane($, 'worktrees', calls)
    if (!ui) return
    calls.graphError = 'no such branch or commit: feat/clash'
    await ui.press({ key: 'wt-/w/clash' })
    await ui.press({ key: 'hist-/w/clash' })
    expect(await texts(ui)).toContain('no such branch or commit: feat/clash')
    expect(await ui.find({ key: 'wt-/w/merged' })).toBeTruthy()
  })

  test(`${surface}: the sync view plans a hop, and a stopped one offers resolve, finish and abort`, async ($: any, on: any) => {
    const calls = fakeScript(on)
    let filled = ''
    on('prompt.fill', ((_$: unknown, e: { text: string }) => { filled = e.text; return { isFilled: true } }) as never)
    const ui = await mountPane($, 'sync', calls)
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('2 hops to sync')
    expect(await ui.find({ key: 'go-app:team/0.0.1' })).toBe(undefined)   // a closed row shows no buttons
    // the clean hop: Sync… asks for a plan; nothing is applied
    await ui.press({ key: 'hop-app:team/0.0.1' })
    await ui.press({ key: 'go-app:team/0.0.1' })
    expect(calls.find(c => c[0] === 'plan')).toEqual(['plan', 'sync-hop', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2'])
    expect(calls.some(c => c[0] === 'apply')).toBe(false)
    await ui.press({ key: 'cancel' })
    // the stopped hop: no Sync… button, but resolve / finish / abort
    await ui.press({ key: 'hop-app:team/0.0.2' })
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
    const ui = await mountPane($, 'sync', calls)
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
    const ui = await mountPane($, 'sync', calls)
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
