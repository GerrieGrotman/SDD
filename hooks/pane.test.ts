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
  }, {
    id: 92100, type: 'Bug', title: 'Second thing', state: 'Active', project: 'P', flow: 'spec', slug: 'second', created: '2026-10-02T08:50:08Z',
    repos: {}, gates: { Claimed: '2026-10-02T08:50:08Z' },
    progress: { at: '2026-10-02T10:00:00Z', flow: 'spec', phase: 'Design', status: 'waiting', gate: 'Design agreed?' },
    history: [], met: ['Claimed'], url: 'https://dev.azure.com/o/P/_workitems/edit/92100',
  }],
} as never

const AGENTS = [
  { id: 'a1', type: 'sdd:investigator', status: 'completed', description: 'Find where tags are stored' },
  { id: 'a2', type: 'sdd:skeptic', status: 'running', description: 'Attack the design' },
]

type Cost = { id: number; stage: string; usd: number; session: string }
type Fake = { registered: string[]; viewed: unknown[]; denyView: boolean; usd: number | null; costs: Cost[]; costFails: boolean; toasts: string[]
  spend: Record<string, { usd: number; turns: number }>; spendOther: Record<string, { usd: number; turns: number }> }

function fake(on: (event: any, hook: (...a: never[]) => unknown) => void, agents = AGENTS): Fake {
  const f: Fake = { registered: [], viewed: [], denyView: false, usd: 1, costs: [], costFails: false, toasts: [], spend: {}, spendOther: {} }
  // env.py: `cost` records a turn (and the totals the next `view` reports); anything else is the view
  on('process.run', ((_$: unknown, e: { argv: string[] }) => {
    const done = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('cost')) {
      if (f.costFails) return done(2, '', 'error: no work item folder')
      const flag = (n: string) => e.argv[e.argv.indexOf(n) + 1]
      const c = { id: Number(flag('--id')), stage: flag('--stage'), usd: Number(flag('--usd')), session: flag('--session') }
      f.costs.push(c)
      const into = c.id === 92012 ? f.spend : f.spendOther
      const was = into[c.stage] ?? { usd: 0, turns: 0 }
      into[c.stage] = { usd: was.usd + c.usd, turns: was.turns + 1 }
      return done(0, `${c.id}: ${c.stage}`)
    }
    const snap = { ...(SNAP as any), items: (SNAP as any).items.map((i: any) => ({ ...i, spend: i.id === 92012 ? f.spend : f.spendOther })) }
    return done(0, JSON.stringify(snap))
  }) as never)
  on('tool.call' as never, (() => ({ result: 'ok' })) as never)  // a Bash run: the plugin only watches it
  on('session.cwd' as never, (() => ({ value: '/ws' })) as never)
  on('session.start' as never, ((_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  on('command.register' as never, ((_$: unknown, e: { name: string }) => { f.registered.push(e.name); return { value: { isRegistered: true } } }) as never)
  on('clock.every' as never, (() => ({ value: { id: 'tick' } })) as never)
  on('ui.open' as never, (() => ({ value: { isPlaced: true } })) as never)
  on('ui.toast' as never, ((_$: unknown, e: unknown) => { f.toasts.push(JSON.stringify(e)); return { value: undefined } }) as never)
  on('command.run' as never, (() => ({})) as never)  // /sdd is the skill's: the plugin only watches it run
  on('turn.start' as never, ((_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId })) as never)           // the engine echoes both
  on('session.measure' as never, ((_$: unknown, e: { changed: string[] }) => ({ changed: e.changed })) as never)
  on('prompt.autocomplete' as never, (() => ({ suggestions: [] })) as never)  // the engine's own answer: no rows
  // the engine's session id and usage, and a store that keeps what is set
  on('session.id' as never, (() => ({ value: 's1' })) as never)
  on('session.usage' as never, (() => ({ value: { context: { window: 1_000_000, percent: 10 }, rateLimits: [], ...(f.usd == null ? {} : { cost: { usd: f.usd } }) } })) as never)
  on('agent.list' as never, (() => ({ value: agents })) as never)
  on('ui.view' as never, ((_$: unknown, e: unknown) => { f.viewed.push(e); return { value: f.denyView ? { deny: 'not person-initiated' } : {} } }) as never)
  return f
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

const mountPane = async ($: any, f: Fake, surface: 'terminal' | 'desktop') => {
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

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the pane lists the session's agents, the working one first, without the plugin prefix`, async ($: any, on: any) => {
    const f = fake(on)
    const ui = await mountPane($, f, surface)
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
    const ui = await mountPane($, f, surface)
    if (!ui) return
    await ui.press({ key: 'agent-a2' })
    expect(f.viewed).toEqual([{ agentId: 'a2' }])
    await ui.press({ key: 'agent-main' })
    expect(f.viewed[1]).toEqual({})
  })

  test(`${surface}: a refused view says so in a toast and breaks nothing`, async ($: any, on: any) => {
    const f = fake(on)
    f.denyView = true
    const ui = await mountPane($, f, surface)
    if (!ui) return
    await ui.press({ key: 'agent-a1' })
    expect(f.viewed).toEqual([{ agentId: 'a1' }])
    expect(await texts(ui)).toContain('Agents')
  })

  test(`${surface}: no agents, no Agents section`, async ($: any, on: any) => {
    const f = fake(on, [])
    const ui = await mountPane($, f, surface)
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

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the dropdown lists the open items and picking one makes the pane follow it`, async ($: any, on: any) => {
    const f = fake(on, [])
    const ui = await mountPane($, f, surface)
    if (!ui) return
    expect(await texts(ui)).toContain('Author tags')
    const select = await ui.find({ type: 'Select' })
    expect(select).toBeTruthy()
    expect(select.props.options.map((o: { value: string }) => o.value)).toEqual(['92100', '92012'])   // 92100 waits on the person
    expect(select.props.value).toBe('92012')
    await ui.select({ key: 'pick-item', value: '92100' })
    for (let i = 0; i < 100 && !(await texts(ui)).includes('Second thing'); i++) await new Promise(r => setTimeout(r, 10))
    expect(await texts(ui)).toContain('Second thing')
    expect((await ui.find({ type: 'Select' })).props.value).toBe('92100')
  })
}

test('autocomplete: after /sdd the prompt box offers the open items, and nothing elsewhere', async ($: any, on: any) => {
  const f = fake(on, [])
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
  if (!f.registered.includes('sdd-view')) {
    await new Promise(r => setTimeout(r, 100))
    return
  }
  await $.command.run({ command: 'sdd-view', args: '92012' })   // reads the snapshot
  const ask = (text: string) => {
    const m = /\S*$/.exec(text)!
    return $.prompt.autocomplete({ text, cursor: text.length, token: m[0], start: m.index })
  }
  const after = await ask('/sdd 92')
  expect(after.suggestions.map((r: { text: string }) => r.text)).toEqual(['92100', '92012'])
  expect((await ask('fix 92')).suggestions ?? []).toEqual([])
})

// ---- cost and context per stage

/** One turn of the chat's item: it begins, then the session reports what it has spent so far. */
const turn = async ($: any, f: Fake, usd: number, percent = 12) => {
  await $.turn.start({ text: 'go', turnId: `t${usd}` })
  f.usd = usd
  await $.session.measure({ context: { window: 1_000_000, tokens: percent * 10_000, percent }, rateLimits: [], cost: { usd }, changed: ['cost', 'context'] })
}

/** The session starts with the chat on 92012, so the view knows the item and its stage (Design). */
const begin = async ($: any, f: Fake) => {
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
  if (!f.registered.includes('sdd-view')) {
    await new Promise(r => setTimeout(r, 100))
    return false
  }
  await $.command.run({ command: 'sdd', args: '92012' })
  return true
}

test('cost: a turn is recorded through env.py against the item and the stage it began in', async ($: any, on: any) => {
  const f = fake(on, [])
  if (!(await begin($, f))) return
  await turn($, f, 1.5)
  expect(f.costs).toEqual([{ id: 92012, stage: 'Design', usd: 0.5, session: 's1' }])      // 1.00 at the start, 1.50 after the turn
  await turn($, f, 2.25)
  expect(f.costs.map(c => c.usd)).toEqual([0.5, 0.75])
  expect(f.spend).toEqual({ Design: { usd: 1.25, turns: 2 } })
})

test('cost: nothing is recorded when the session keeps no ledger, or a turn cost nothing', async ($: any, on: any) => {
  const f = fake(on, [])
  f.usd = null                                       // no cost at the start: no baseline to measure from
  if (!(await begin($, f))) return
  await turn($, f, 3)
  await turn($, f, 3)                                // the same total again: the turn cost nothing
  expect(f.costs).toEqual([])
})

test('cost: it stays with the item the chat took up, not the one a script run last named', async ($: any, on: any) => {
  const f = fake(on, [])
  if (!(await begin($, f))) return
  await $.tool.call({ tool: 'Bash', command: 'python /p/scripts/env.py can --id 92100 --op phase --flow spec --phase Design' })   // a look at another item
  await turn($, f, 1.5)
  expect(f.costs.map(c => c.id)).toEqual([92012])
})

test('cost: a chat that never ran /sdd belongs to the first item its scripts name', async ($: any, on: any) => {
  const f = fake(on, [])
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
  if (!f.registered.includes('sdd-view')) {
    await new Promise(r => setTimeout(r, 100))
    return
  }
  await $.tool.call({ tool: 'Bash', command: 'python /p/scripts/env.py can --id 92100 --op phase --flow spec --phase Design' })
  await $.tool.call({ tool: 'Bash', command: 'python /p/scripts/env.py can --id 92012 --op phase --flow spec --phase Design' })
  await turn($, f, 1.5)
  expect(f.costs.map(c => c.id)).toEqual([92100])                                          // the first one named
})

test('cost: a failed record says so once, and the turn goes on', async ($: any, on: any) => {
  const f = fake(on, [])
  f.costFails = true
  if (!(await begin($, f))) return
  await turn($, f, 1.5)
  await turn($, f, 2)
  expect(f.toasts.filter(t => t.includes('Cost not recorded'))).toHaveLength(1)
  expect(f.toasts.find(t => t.includes('Cost not recorded'))).toContain('no work item folder')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the pane shows the item's cost, this stage's cost and the context, and another item's cost stays out`, async ($: any, on: any) => {
    const f = fake(on, [])
    f.spend = { Design: { usd: 2, turns: 3 }, Specify: { usd: 0.004, turns: 1 } }          // earlier turns, any chat
    f.spendOther = { Design: { usd: 50, turns: 1 } }                                         // another item's
    if (!(await begin($, f))) return
    const ui = await $.ui.mount({ plugin: 'sdd', surface, component: 'Pane', props: { title: 'sdd', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never,
      requestId: 'sdd-view', viewport: { columns: 100, rows: 40 } })
    for (let i = 0; i < 100 && !(await texts(ui)).includes('Spent'); i++) await new Promise(r => setTimeout(r, 10))
    expect(await texts(ui)).toContain('Spent $2.00 on this item')
    await turn($, f, 1.5)                                                                     // 0.50 more: the pane reads the new total at once
    for (let i = 0; i < 100 && !(await texts(ui)).includes('Spent $2.50'); i++) await new Promise(r => setTimeout(r, 10))
    const t = await texts(ui)
    expect(t).toContain('Spent $2.50 on this item')
    expect(t).toContain('$2.50')                         // the Design row
    expect(t).toContain('<$0.01')                        // the Specify row: a tiny cost still shows
    expect(t).toContain('Context 12%')
    expect(t).not.toContain('$50')
  })
}

test('context: from 80 percent the band says so', async ($: any, on: any) => {
  const f = fake(on, [])
  if (!(await begin($, f))) return
  const ui = await $.ui.mount({ plugin: 'sdd', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } as never,
    requestId: 'band', viewport: { columns: 100, rows: 40 } })
  const until = async (word: string) => { for (let i = 0; i < 100 && !(await texts(ui)).includes(word); i++) await new Promise(r => setTimeout(r, 10)) }
  await until('Author tags')
  await turn($, f, 1.5, 50)
  await new Promise(r => setTimeout(r, 50))
  expect(await texts(ui)).not.toContain('context')
  await turn($, f, 2, 85)
  await until('context 85%')
  expect(await texts(ui)).toContain('context 85%')
  await turn($, f, 2.5, 93)
  await until('context 93%')
  expect(await texts(ui)).toContain('context 93%')
})
