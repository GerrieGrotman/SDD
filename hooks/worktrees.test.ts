// The sdd Worktrees page, drawn and pressed through the engine's test kit. Nothing real runs: a hook
// beneath the plugin answers `env.py view` with a snapshot and the file read with repowatch's state.
import { expect, test } from 'claude-code/testing'

const SNAP = {
  root: '/ws', specRoot: 'docs/spec', flows: {}, derived: [], done: [],
  items: [{
    id: 1, type: 'Bug', title: 'Fix the thing', state: 'Active', project: 'P', flow: 'bug', slug: 'a', created: '2026-10-01T00:00:00Z',
    folder: '/ws/.claude/worktrees/1-a', gates: {}, met: [], url: null, spec: null,
    repos: { Repo: { base: 'team/0.0.1', branch: 'dev/x/1', path: 'src/Repo', pr: { id: 55, url: 'u' } } },
    progress: { at: '2026-10-01T00:00:00Z', flow: 'bug', phase: 'Phase 6', status: 'active' },
  }],
}

const LIVE = {
  version: 1, generated: 1_700_000_100,
  repos: { Repo: { worktrees: [{
    path: '/ws/.claude/worktrees/1-a/src/Repo', branch: 'dev/x/1', class: 'safe', reasons: ['merged into main'], dirty: 0,
    lastCommit: 1_700_000_000, baseRef: 'origin/team/0.0.1', behindBase: 4, aheadBase: 2,
    forecast: { state: 'conflict', base: 'origin/team/0.0.1', files: ['a.cs'] },
  }] } },
}

const PROPS = { title: 'sdd worktrees', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const ok = (value: unknown) => ({ value })

function engine(on: any, liveFile = true) {
  const reads: string[] = []
  const opened: string[] = []
  const commands: Array<{ command: string; args: string }> = []
  let filled = ''
  on('process.run', (() => ok({ exitCode: 0, stdout: JSON.stringify(SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false })) as never)
  on('fs.read', ((_$: unknown, e: { path: string }) => {
    reads.push(e.path)
    if (!liveFile) throw new Error('ENOENT')
    return ok(JSON.stringify(LIVE))
  }) as never)
  on('session.cwd', (() => ok('/ws')) as never)
  on('session.surfaces' as never, (() => ok(['desktop'])) as never)   // the page is for the Desktop app
  on('session.start', ((_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  on('command.register', (() => ok({ isRegistered: true })) as never)
  on('clock.every', (() => ok({ id: 'tick' })) as never)
  on('ui.open', ((_$: unknown, e: { id: string }) => { opened.push(e.id); return ok({ isPlaced: true }) }) as never)
  on('ui.toast', (() => ok(undefined)) as never)
  on('command.run', ((_$: unknown, e: { command: string; args: string }) => { commands.push({ command: e.command, args: e.args }); return { text: 'History opened.' } }) as never)
  on('prompt.fill', ((_$: unknown, e: { text: string }) => { filled = e.text; return { isFilled: true } }) as never)
  return { reads, opened, commands, filled: () => filled }
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

for (const surface of ['desktop'] as const) {
  const mountPage = async ($: any) => {
    await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'sdd', surface, component: 'Pane', props: PROPS, requestId: 'sdd-worktrees', viewport: { columns: 110, rows: 40 } })
    for (let i = 0; i < 100 && !(await texts(ui)).includes('1 work items'); i++) await new Promise(r => setTimeout(r, 10))
    return ui
  }

  test(`${surface}: the page joins a work item to repowatch's scan and shows what to do`, async ($: any, on: any) => {
    const world = engine(on)
    const ui = await mountPage($)
    await ui.press({ key: 'reload' })
    expect(world.reads).toContain('/ws/.claude/repowatch/state.json')
    const t = await texts(ui)
    expect(t).toContain('1 work items')
    expect(t).toContain('Fix the thing')
    expect(t).toContain('from team/0.0.1')
    expect(t).toContain('PR 55')
    expect(t).toContain('4 behind origin/team/0.0.1')
    expect(t).toContain('can be removed: merged into main')
    expect(t).toContain('merging origin/team/0.0.1 in would conflict in a.cs')
  })

  test(`${surface}: before repowatch has scanned, the page says so instead of guessing`, async ($: any, on: any) => {
    engine(on, false)
    const ui = await mountPage($)
    await ui.press({ key: 'reload' })
    const t = await texts(ui)
    expect(t).toContain('repowatch has not scanned this workspace yet')
    expect(t).toContain('repowatch has not seen it')
  })

  test(`${surface}: the item button opens that item's sdd view, and the page only reads`, async ($: any, on: any) => {
    const world = engine(on)
    const ui = await mountPage($)
    await ui.press({ key: 'open-1' })
    expect(world.opened).toContain('sdd-view')
    await ui.press({ key: 'rw' })
    expect(world.filled()).toBe('/repowatch worktrees')
  })

  test(`${surface}: History asks repowatch's command for that branch against its recorded base, and changes nothing`, async ($: any, on: any) => {
    const world = engine(on)
    const ui = await mountPage($)
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'hist-1-Repo' })
    expect(world.commands.length).toBe(1)
    expect(world.commands[0].command).toBe('repowatch')
    expect(world.commands[0].args.startsWith('history {')).toBe(true)
    const sent = JSON.parse(world.commands[0].args.slice('history '.length))
    expect(sent.repo).toBe('Repo')
    expect(sent.refs).toEqual(['dev/x/1', 'origin/team/0.0.1'])
    expect(world.opened).not.toContain('repowatch') // the pane is repowatch's to open
  })
}
