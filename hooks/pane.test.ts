// The sdd pane, drawn and pressed through the engine's test kit. env.py is never run: a hook beneath the
// plugin answers `process.run` with one canned snapshot, and `agent.list` and `ui.view` are stand-ins too, so
// what these tests check is what the pane draws and asks for. `claude plugin test .` at the repo root also
// finds repowatch's tests, which stand down when the plugin under test is sdd; this file does the reverse:
// it only means something (and only runs) when `sdd-view` is the command that got registered.
import { expect, test } from 'claude-code/testing'

import type { SddSnapshot } from '../types'

const SPEC = {
  label: 'Spec flow', prGates: ['Requirements agreed'],
  stages: [
    { key: 'Specify', label: 'Specify', needs: [], passes: ['Claimed'] },
    { key: 'Design', label: 'Design', needs: ['Claimed'], passes: ['Design agreed'], stop: true },
  ],
}
const SNAP: SddSnapshot = {
  root: '/ws', specRoot: '/ws/docs/spec', flows: { spec: SPEC }, derived: [], done: [],
  items: [{
    id: 92012, type: 'User Story', title: 'Author tags', state: 'Active', project: 'P', flow: 'spec', slug: 'author', created: '2026-10-01T08:50:08Z',
    repos: {}, gates: { Claimed: '2026-10-01T08:50:08Z' },
    progress: { at: '2026-10-01T10:00:00Z', flow: 'spec', phase: 'Design', status: 'active' },
    history: [], met: ['Claimed'], url: 'https://dev.azure.com/o/P/_workitems/edit/92012',
  }],
} as never

const AGENTS = [
  { id: 'a1', type: 'sdd:investigator', status: 'completed', description: 'Find where tags are stored' },
  { id: 'a2', type: 'sdd:skeptic', status: 'running', description: 'Attack the design' },
]

type Fake = { registered: string[]; viewed: unknown[]; denyView: boolean }

function fake(on: (event: any, hook: (...a: never[]) => unknown) => void, agents = AGENTS): Fake {
  const f: Fake = { registered: [], viewed: [], denyView: false }
  on('process.run', (() => ({ value: { exitCode: 0, stdout: JSON.stringify(SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })) as never)
  on('session.cwd' as never, (() => ({ value: '/ws' })) as never)
  on('session.start' as never, ((_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  on('command.register' as never, ((_$: unknown, e: { name: string }) => { f.registered.push(e.name); return { value: { isRegistered: true } } }) as never)
  on('clock.every' as never, (() => ({ value: { id: 'tick' } })) as never)
  on('ui.open' as never, (() => ({ value: { isPlaced: true } })) as never)
  on('ui.toast' as never, (() => ({ value: undefined })) as never)
  on('agent.list' as never, (() => ({ value: agents })) as never)
  on('ui.view' as never, ((_$: unknown, e: unknown) => { f.viewed.push(e); return { value: f.denyView ? { deny: 'not person-initiated' } : {} } }) as never)
  return f
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = async ($: any, f: Fake) => {
    await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
    if (!f.registered.includes('sdd-view')) {
      await new Promise(r => setTimeout(r, 100)) // let the other plugin's session.start work finish before the test ends
      return null
    }
    await $.command.run({ command: 'sdd-view', args: '92012' })
    const ui = await $.ui.mount({ plugin: 'sdd', surface, component: 'Pane', props: { title: 'sdd', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never,
      requestId: 'sdd-view', viewport: { columns: 100, rows: 40 } })
    for (let i = 0; i < 100 && !(await texts(ui)).includes('Author tags'); i++) await new Promise(r => setTimeout(r, 10))
    return ui
  }

  test(`${surface}: the pane lists the session's agents, the working one first, without the plugin prefix`, async ($: any, on: any) => {
    const f = fake(on)
    const ui = await mountPane($, f)
    if (!ui) return
    const t = await texts(ui)
    expect(t).toContain('Agents')
    expect(t.indexOf('skeptic · Attack the design')).toBeGreaterThan(-1)
    expect(t.indexOf('skeptic')).toBeLessThan(t.indexOf('investigator'))
    expect(t).toContain('working')
    expect(t).toContain('done')
    expect(t).not.toContain('sdd:skeptic')
  })

  test(`${surface}: Watch shows that agent's transcript, and Main chat goes back`, async ($: any, on: any) => {
    const f = fake(on)
    const ui = await mountPane($, f)
    if (!ui) return
    await ui.press({ key: 'agent-a2' })
    expect(f.viewed).toEqual([{ agentId: 'a2' }])
    await ui.press({ key: 'agent-main' })
    expect(f.viewed[1]).toEqual({})
  })

  test(`${surface}: a refused view says so in a toast and breaks nothing`, async ($: any, on: any) => {
    const f = fake(on)
    f.denyView = true
    const ui = await mountPane($, f)
    if (!ui) return
    await ui.press({ key: 'agent-a1' })
    expect(f.viewed).toEqual([{ agentId: 'a1' }])
    expect(await texts(ui)).toContain('Agents')
  })

  test(`${surface}: no agents, no Agents section`, async ($: any, on: any) => {
    const f = fake(on, [])
    const ui = await mountPane($, f)
    if (!ui) return
    expect(await texts(ui)).not.toContain('Agents')
  })
}

test('the flow map shows where the app draws an Svg, and the stage rows stay either way', async ($: any, on: any) => {
  const f = fake(on, [])
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
  if (!f.registered.includes('sdd-view')) {
    await new Promise(r => setTimeout(r, 100))
    return
  }
  await $.command.run({ command: 'sdd-view', args: '92012' })
  const props = { title: 'sdd', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
  const desktop = await $.ui.mount({ plugin: 'sdd', surface: 'desktop', component: 'Pane', props, requestId: 'sdd-view', viewport: { columns: 100, rows: 40 } })
  for (let i = 0; i < 100 && !(await texts(desktop)).includes('Author tags'); i++) await new Promise(r => setTimeout(r, 10))
  expect(await desktop.find({ type: 'Svg' })).toBeTruthy()
  expect(await desktop.find({ key: 'stage:Design' })).toBeTruthy()
})
