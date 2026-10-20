// The bug manager (/sdd-bugs), drawn and pressed through the engine's test kit. Nothing real runs: hooks beneath
// the plugin answer the files the scripts write (fs.read), keep what the pane writes (fs.write), answer the
// PowerShell scripts (process.run) and the one model call. What is checked is what the pane draws, stages,
// writes and asks for. Like pane.test.ts it only runs when sdd is the plugin under test.
import { expect, test } from 'claude-code/testing'

const ROOT = '/ws'
const DIR = '/ws/docs/spec/.bugs'
const ME = { name: 'Me Myself', email: 'me@x.co' }

function rec(id: number, over: Record<string, unknown> = {}) {
  return {
    id, rev: 3, type: 'Bug', title: `Bug ${id}`, state: 'New', reason: 'New', project: 'Proj', area: 'Proj\\Payments', iteration: 'Proj\\Sprint 20',
    tags: [], assigned: null, severity: '3 - Medium', priority: 2, effort: null, boardColumn: '', created: '2026-10-01T00:00:00Z',
    changed: '2026-10-10T00:00:00Z', createdBy: null, url: `https://dev.azure.com/Org/Proj/_workitems/edit/${id}`, parent: null,
    related: [], commits: [], prs: [], links: [], extra: {}, ...over,
  }
}

const INDEX = {
  version: 1, syncedAt: new Date().toISOString(), org: 'Org', projects: ['Proj'], me: ME, count: 3,
  items: [
    rec(701, { title: 'Totals lose cents', tags: ['1.1.0', 'Quick Win'], assigned: ME, severity: '2 - High', priority: 1,
      prs: [{ id: 77, repo: 'Gateway', url: 'https://dev.azure.com/Org/Proj/_git/Gateway/pullrequest/77', title: 'Fix the totals', status: 'active' }],
      commits: [{ sha: 'abc1234def', repo: 'Gateway', url: 'https://dev.azure.com/Org/Proj/_git/Gateway/commit/abc1234def' }] }),
    rec(702, { type: 'Issue', title: 'Login hangs', state: 'Active', assigned: { name: 'Ann Bee', email: 'ann@x.co' }, boardColumn: 'Dev In Progress' }),
    rec(703, { title: 'Header typo', state: 'Resolved', priority: 3, area: 'Proj\\Login' }),
  ],
}

const DEFAULTS = {
  folder: '.bugs', types: ['Bug', 'Issue'],
  query: { projects: [], excludeStates: ['Closed'], areaPaths: [], iterationPaths: [], where: '', top: 1000 },
  extraFields: [], developersFile: '.claude/developers.json', doneStates: ['Resolved', 'Closed', 'Done', 'Removed'], states: { Bug: ['New', 'Active', 'Resolved', 'Closed'], Issue: ['New', 'Active', 'Resolved', 'Closed'] },
  severities: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'], priorities: [1, 2, 3, 4],
  categories: [
    { id: 'quick-wins', label: 'Quick wins', icon: '⚡', any: [{ tags: ['Quick Win'] }] },
    { id: 'in-progress', label: 'In progress', icon: '▶', any: [{ states: ['Active'] }] },
    { id: 'version', label: 'Team branch {value}', icon: '🌿', eachTag: '^\\d+(\\.\\d+){1,3}$' },
  ],
  analysis: { model: 'haiku', maxTokens: 500, effort: 'low' }, me: '', powershell: '',
}

const PROPS = { title: 'sdd bugs', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as never

type World = { files: Record<string, string>; runs: string[][]; prompts: string[]; toasts: string[]; filled: string[]; registered: string[] }

function world(on: any, opts: { synced?: boolean; team?: boolean } = {}): World {
  const w: World = {
    files: {
      [`${ROOT}/.claude/sdd.json`]: JSON.stringify({ specRoot: 'docs/spec', ado: { org: 'Org', projects: ['Proj'] } }),
      [`/plugin/scripts/bugs/defaults.json`]: JSON.stringify(DEFAULTS),
      [`${DIR}/items/701.json`]: JSON.stringify({ id: 701, rev: 3, text: { repro: 'Export shows 12 not 12.40' }, comments: [{ by: 'Ann', at: '', text: 'Seen on prod' }] }),
    },
    runs: [], prompts: [], toasts: [], filled: [], registered: [],
  }
  if (opts.synced !== false) w.files[`${DIR}/index.json`] = JSON.stringify(INDEX)
  // the dev team's file, as the workspace keeps it: display names (an area path is a gate: the tests that use one write their own)
  if (opts.team !== false) w.files[`${ROOT}/.claude/developers.json`] = JSON.stringify({ developers: ['ann bee', 'Raj Patel'] })
  const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ((_$: unknown, e: { argv: string[] }) => {
    w.runs.push(e.argv)
    const script = e.argv.find(a => a.endsWith('.ps1')) ?? ''
    if (e.argv[0] === 'sh') return done('')                                              // the clipboard
    if (script.endsWith('Sync-Bugs.ps1')) {
      w.files[`${DIR}/index.json`] = JSON.stringify(INDEX)
      return done('{"ok":true,"count":3,"added":3,"changed":0,"removed":0,"seconds":1.5}')
    }
    if (script.endsWith('Save-BugChanges.ps1')) {
      const pending = JSON.parse(w.files[`${DIR}/pending.json`] ?? '{"changes":[]}').changes
      // the first change is a conflict, the rest are saved
      const left = pending.slice(0, 1).map((c: object) => ({ ...c, problem: { kind: 'conflict', text: "changed in ADO since you staged it: it is now 'Active'", current: 'Active' } }))
      w.files[`${DIR}/pending.json`] = JSON.stringify({ version: 1, changes: left })
      return done(JSON.stringify({ ok: true, saved: pending.length - 1, conflicts: 1, errors: 0, results: [] }))
    }
    if (script.endsWith('Find-BugEvidence.ps1')) {
      return done(JSON.stringify({ ok: true, id: 701, rev: 3, terms: ['Totals.cs'], repos: ['Gateway'], seconds: 0.3, history: [], linked: [],
        hits: [{ repo: 'Gateway', path: 'Billing/Totals.cs', line: 42, text: 'decimal Round()', term: 'Totals.cs' }] }))
    }
    if (script.endsWith('Get-BugDetail.ps1')) return done('{"ok":true,"id":701,"text":{"repro":"Fresh repro"},"comments":[]}')
    return done('{"ok":false,"error":"unknown"}', 1)
  }) as never)
  on('fs.read', ((_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/^.*\/scripts\/bugs\//, '/plugin/scripts/bugs/')
    if (!(p in w.files)) throw new Error(`ENOENT: no such file ${e.path}`)
    return { value: w.files[p] }
  }) as never)
  on('fs.write', ((_$: unknown, e: { path: string; text: string }) => { w.files[e.path] = e.text; return { value: undefined } }) as never)
  on('model.complete', ((_$: unknown, e: { prompt: string }) => {
    w.prompts.push(e.prompt)
    return { value: { isAnswered: true, text: '**Probable cause** Totals.Round drops the cents.', usage: { input_tokens: 900, output_tokens: 120 } } }
  }) as never)
  on('session.cwd', (() => ({ value: ROOT })) as never)
  on('session.surfaces' as never, (() => ({ value: ['desktop'] })) as never)
  on('session.start', ((_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  on('session.id' as never, (() => ({ value: 's1' })) as never)
  on('session.usage' as never, (() => ({ value: { context: { window: 1_000_000, percent: 10 }, rateLimits: [] } })) as never)
  on('command.register', ((_$: unknown, e: { name: string }) => { w.registered.push(e.name); return { value: { isRegistered: true } } }) as never)
  on('clock.every', (() => ({ value: { id: 'tick' } })) as never)
  on('ui.open', (() => ({ value: { isPlaced: true } })) as never)
  on('ui.toast', ((_$: unknown, e: unknown) => { w.toasts.push(JSON.stringify(e)); return { value: undefined } }) as never)
  on('prompt.fill', ((_$: unknown, e: { text: string }) => { w.filled.push(e.text); return { isFilled: true } }) as never)
  return w
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
// a Button's label, or the text of its children (the category chips)
const labels = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ props?: { label?: string }; children?: unknown[]; text?: string }>> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.props?.label ?? b.text ?? flat(b.children))
const flat = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(flat).join('')
  : n && typeof n === 'object' ? flat((n as { children?: unknown }).children ?? (n as { props?: { children?: unknown } }).props?.children) : ''

async function mount($: any, w: World, args = '') {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  if (!w.registered.includes('sdd-bugs')) {
    await new Promise(r => setTimeout(r, 100))
    return null
  }
  await $.command.run({ command: 'sdd-bugs', args })
  const ui = await $.ui.mount({ plugin: 'sdd', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'sdd-bugs', viewport: { columns: 120, rows: 60 } })
  for (let i = 0; i < 100 && !/ items?\b|Sync/.test(await texts(ui)); i++) await new Promise(r => setTimeout(r, 10))
  return ui
}

async function settle(ui: any, want: RegExp) {
  for (let i = 0; i < 100 && !want.test(await texts(ui) + '\n' + (await labels(ui)).join('\n')); i++) await new Promise(r => setTimeout(r, 10))
  const seen = await texts(ui) + '\n' + (await labels(ui)).join('\n')
  if (!want.test(seen)) throw new Error(`never saw ${want}:\n${seen.slice(0, 1500)}`)
}

test('desktop: the list shows the synced items, the categories and the filters', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  const t = await texts(ui)
  expect(t).toContain('3 items · Org / Proj')
  expect(t).toContain('you are me@x.co')
  const b = await labels(ui)
  expect(b).toContain('▸ Totals lose cents')
  expect(b).toContain('▸ Login hangs')
  expect(b).toContain('⚡ Quick wins 1')
  expect(b).toContain('🌿 Team branch 1.1.0 1')
  expect(b).toContain('All 3')
  await ui.press({ key: 'cat-in-progress' })
  await settle(ui, /^(?![\s\S]*▸ Totals lose cents)/)
  let names = await labels(ui)
  expect(names).toContain('▸ Login hangs')
  expect(names).not.toContain('▸ Totals lose cents')
  await ui.press({ key: 'cat-all' })
  await ui.press({ key: 'bugs-mine' })
  await settle(ui, /☑ Assigned to me/)
  names = await labels(ui)
  expect(names).toContain('▸ Totals lose cents')
  expect(names).not.toContain('▸ Login hangs')
  await ui.input({ key: 'bugs-search', text: 'nothing like this', kind: 'submit' })
  await settle(ui, /Nothing matches/)
  expect(await texts(ui)).toContain('Nothing matches these filters.')
})

for (const synced of [true, false]) {
  test(`desktop: the Config button opens the settings panel, and Back returns (${synced ? 'synced' : 'not synced yet'})`, async ($: any, on: any) => {
    const w = world(on, { synced })
    const ui = await mount($, w)
    if (!ui) return
    expect(await labels(ui)).toContain('⚙ Config')
    await ui.press({ key: 'bugs-config' })
    await settle(ui, /⚙ Settings/)
    expect(await labels(ui)).toEqual(expect.arrayContaining(['← Back to the list', 'Open sdd.json', 'Open developers.json', '▸ Dev team', '▸ Categories']))
    // nothing is edited, so there is nothing to save
    expect(await labels(ui)).not.toContain('Save settings')
    await ui.press({ key: 'bugs-config' })
    await settle(ui, /^(?![\s\S]*⚙ Settings)/)
    expect(await labels(ui)).toContain('⚙ Config')
  })
}

test('desktop: the panel opens the two files on a press', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /⚙ Settings/)
  await ui.press({ key: 'cfg-open-sdd' })
  await ui.press({ key: 'cfg-open-dev' })
  for (let i = 0; i < 100 && w.runs.filter(r => r[0] === 'open').length < 2; i++) await new Promise(r => setTimeout(r, 10))
  expect(w.runs.filter(r => r[0] === 'open')).toEqual([['open', `${ROOT}/.claude/sdd.json`], ['open', `${ROOT}/.claude/developers.json`]])
})

test('desktop: the dev team is edited, and Save writes only what changed to the two files', async ($: any, on: any) => {
  const w = world(on)
  w.files[`${ROOT}/.claude/sdd.json`] = JSON.stringify({ specRoot: 'docs/spec', ado: { org: 'Org', projects: ['Proj'] }, bugs: { me: 'me@x.co' } })
  w.files[`${ROOT}/.claude/developers.json`] = JSON.stringify({ note: 'keep me', developers: ['ann bee', 'Raj Patel'] })
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /⚙ Settings/)
  await ui.press({ key: 'secopen-team' })
  await settle(ui, /Display names as ADO shows them/)
  expect(await labels(ui)).toEqual(expect.arrayContaining(['ann bee ✕', 'Raj Patel ✕']))
  await ui.input({ key: 'add-developers-2', text: 'Kim Lee', kind: 'submit' })
  await settle(ui, /Kim Lee ✕/)
  await ui.press({ key: 'rm-developers-Raj Patel' })
  await settle(ui, /^(?![\s\S]*Raj Patel ✕)/)
  await ui.input({ key: 'add-areas-0', text: 'Proj\\Payments\\*', kind: 'submit' })
  await settle(ui, /Proj\\Payments\\\* ✕/)
  await settle(ui, /2 settings changed, not saved yet/)
  // nothing is written until Save
  expect(JSON.parse(w.files[`${ROOT}/.claude/sdd.json`]).bugs).toEqual({ me: 'me@x.co' })
  await ui.press({ key: 'cfg-save' })
  await settle(ui, /^(?![\s\S]*not saved yet)/)
  expect(JSON.parse(w.files[`${ROOT}/.claude/sdd.json`])).toEqual({ specRoot: 'docs/spec', ado: { org: 'Org', projects: ['Proj'] }, bugs: { me: 'me@x.co' } })
  expect(JSON.parse(w.files[`${ROOT}/.claude/developers.json`])).toEqual({ note: 'keep me', areaPath: 'Proj\\Payments\\*', developers: ['ann bee', 'Kim Lee'] })
  expect(w.toasts.join('\n')).toContain('Settings saved to')
})

test('desktop: a choice is saved as the only key written, next to the ones already there', async ($: any, on: any) => {
  const w = world(on)
  w.files[`${ROOT}/.claude/sdd.json`] = JSON.stringify({ specRoot: 'docs/spec', bugs: { me: 'me@x.co' } })
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /⚙ Settings/)
  await ui.press({ key: 'secopen-analysis' })
  await settle(ui, /The model call behind/)
  await ui.select({ key: 'sel-bugs.analysis.model', value: 'opus' })
  await settle(ui, /1 setting changed, not saved yet/)
  await ui.press({ key: 'cfg-save' })
  await settle(ui, /^(?![\s\S]*not saved yet)/)
  expect(JSON.parse(w.files[`${ROOT}/.claude/sdd.json`])).toEqual({ specRoot: 'docs/spec', bugs: { me: 'me@x.co', analysis: { model: 'opus' } } })
  expect(JSON.parse(w.files[`${ROOT}/.claude/developers.json`])).toEqual({ developers: ['ann bee', 'Raj Patel'] })   // not touched
})

test('desktop: Revert drops the edits, and a number that is not one is refused', async ($: any, on: any) => {
  const w = world(on)
  const before = w.files[`${ROOT}/.claude/sdd.json`]
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /⚙ Settings/)
  await ui.press({ key: 'secopen-sync' })
  await settle(ui, /The most items one Sync reads/)
  await ui.input({ key: 'val-bugs.query.top-1000', text: 'many', kind: 'submit' })
  await new Promise(r => setTimeout(r, 50))
  expect(await labels(ui)).not.toContain('Save settings')                              // refused: the draft is as it was
  expect(w.toasts.join('\n')).toMatch(/whole number/i)
  await ui.input({ key: 'val-bugs.query.top-1000', text: '250', kind: 'submit' })
  await settle(ui, /1 setting changed, not saved yet/)
  expect(await texts(ui)).toContain('shows after the next Sync')                        // a change to what Sync pulls
  await ui.press({ key: 'cfg-revert' })
  await settle(ui, /^(?![\s\S]*not saved yet)/)
  expect(w.files[`${ROOT}/.claude/sdd.json`]).toBe(before)
  expect(w.toasts.join('\n')).toContain('Settings changes dropped')
})

test('desktop: a category is added, opened, given a rule and an alternative, moved and removed; Save writes the list', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /⚙ Settings/)
  await ui.press({ key: 'secopen-categories' })
  await settle(ui, /Quick wins/)
  await ui.input({ key: 'catnew-3', text: 'Urgent ones', kind: 'submit' })
  await settle(ui, /Alternative|Rules/)                                                // the new category opens
  expect(await labels(ui)).toContain('▾ Urgent ones')
  await ui.select({ key: 'radd-urgent-ones-base-0', value: 'tags' })
  await settle(ui, /Has any of these tags/)
  await ui.input({ key: 'rin-urgent-ones-base-tags-', text: 'Urgent', kind: 'submit' })
  await settle(ui, /Urgent/)
  await ui.press({ key: 'altadd-urgent-ones' })
  await settle(ui, /Alternative 1/)
  await ui.select({ key: 'radd-urgent-ones-0-0', value: 'tags' })
  await ui.input({ key: 'rin-urgent-ones-0-tags-', text: 'Hot', kind: 'submit' })
  await settle(ui, /not saved yet/)
  await ui.press({ key: 'catup-urgent-ones' })
  await ui.press({ key: 'catrm-in-progress' })
  await settle(ui, /^(?![\s\S]*▸ In progress)/)
  await ui.press({ key: 'cfg-save' })
  await settle(ui, /^(?![\s\S]*not saved yet)/)
  const saved = JSON.parse(w.files[`${ROOT}/.claude/sdd.json`]).bugs.categories
  expect(saved.map((c: any) => c.id)).toEqual(['quick-wins', 'urgent-ones', 'version'])
  expect(saved[1]).toMatchObject({ label: 'Urgent ones', tags: ['Urgent'], any: [{ tags: ['Hot'] }] })
  // the list follows the saved categories after a re-read
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /^(?![\s\S]*⚙ Settings)/)
  expect(await labels(ui)).toEqual(expect.arrayContaining(['● Urgent ones 0']))
})

test('desktop: a problem blocks Save, and a developers.json that cannot be read is not overwritten', async ($: any, on: any) => {
  const w = world(on)
  w.files[`${ROOT}/.claude/developers.json`] = '{ not json'
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-config' })
  await settle(ui, /⚙ Settings/)
  await ui.press({ key: 'secopen-team' })
  await settle(ui, /Display names as ADO shows them/)
  await ui.input({ key: 'add-developers-0', text: 'Kim Lee', kind: 'submit' })
  await settle(ui, /1 setting changed/)
  await ui.press({ key: 'cfg-save' })
  for (let i = 0; i < 100 && !w.toasts.some(t => t.includes('Not saved')); i++) await new Promise(r => setTimeout(r, 10))
  expect(w.toasts.join('\n')).toContain('Not saved')
  expect(w.files[`${ROOT}/.claude/developers.json`]).toBe('{ not json')
  expect(await labels(ui)).toContain('Save settings')                                   // still there to fix and try again
})

test('desktop: Hide resolved/closed shows all the rest, and says so when nothing is left', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  expect(await labels(ui)).toContain('▸ Header typo')                                  // 703 is resolved
  await ui.press({ key: 'bugs-open' })
  await settle(ui, /☑ Hide resolved\/closed/)
  let names = await labels(ui)
  expect(names).toEqual(expect.arrayContaining(['▸ Totals lose cents', '▸ Login hangs']))
  expect(names).not.toContain('▸ Header typo')
  await ui.input({ key: 'bugs-search', text: 'typo', kind: 'submit' })                 // only a resolved one matches
  await settle(ui, /Nothing matches/)
  expect(await texts(ui)).toContain('Resolved and closed items are hidden: untick "Hide resolved/closed" to see them.')
  await ui.press({ key: 'bugs-open' })
  await settle(ui, /☐ Hide resolved\/closed/)
  expect(await labels(ui)).toContain('▸ Header typo')
})

test('desktop: the Assigned to dropdown shows one person\'s items, or the unassigned ones, and the counts follow', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  expect(await ui.find({ key: 'bugs-assignee' })).toBeTruthy()
  await ui.select({ key: 'bugs-assignee', value: 'ann@x.co' })
  await settle(ui, /1 of 3 items/)
  let names = await labels(ui)
  expect(names).toContain('▸ Login hangs')
  expect(names).not.toContain('▸ Totals lose cents')
  await ui.select({ key: 'bugs-assignee', value: '__unassigned__' })
  await settle(ui, /▸ Header typo/)
  names = await labels(ui)
  expect(names).toEqual(expect.arrayContaining(['▸ Header typo', 'All 1']))
  expect(names).not.toContain('▸ Login hangs')
  await ui.select({ key: 'bugs-assignee', value: '*' })
  await settle(ui, /3 items/)
  expect(await labels(ui)).toEqual(expect.arrayContaining(['▸ Totals lose cents', '▸ Login hangs', '▸ Header typo']))
})

test('desktop: the header and the chips follow the filters', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  expect(await texts(ui)).toContain('3 items · Org / Proj')
  expect(await labels(ui)).toEqual(expect.arrayContaining(['All 3', '⚡ Quick wins 1', '▶ In progress 1']))
  await ui.press({ key: 'bugs-mine' })                                                  // only 701 is mine
  await settle(ui, /1 of 3 items/)
  expect(await texts(ui)).toContain('1 of 3 items · Org / Proj')
  expect(await labels(ui)).toEqual(expect.arrayContaining(['All 1', '⚡ Quick wins 1', '▶ In progress 0']))
  await ui.press({ key: 'cat-in-progress' })                                            // an empty chip: the other chips do not move
  await settle(ui, /Nothing matches/)
  expect(await labels(ui)).toEqual(expect.arrayContaining(['All 1', '⚡ Quick wins 1']))
  expect(await texts(ui)).toContain('0 of 3 items')
  await ui.press({ key: 'bugs-mine' })
  await ui.press({ key: 'cat-in-progress' })
  await settle(ui, /3 items · Org/)
  expect(await labels(ui)).toEqual(expect.arrayContaining(['All 3', '▶ In progress 1']))
})

test('desktop: Dev team shows only the developers of developers.json', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-team' })
  await settle(ui, /☑ Dev team/)
  const names = await labels(ui)
  expect(names).toContain('▸ Login hangs')                                              // 702 is Ann Bee's
  expect(names).not.toContain('▸ Totals lose cents')                                    // Me Myself is not on the team
  expect(names).not.toContain('▸ Header typo')                                          // nobody's, in Proj\Payments, is not either
  await ui.press({ key: 'bugs-mine' })                                                  // with "Assigned to me": nothing is both
  await settle(ui, /Nothing matches/)
  expect(await texts(ui)).toContain('Only the dev team\'s developers\' items are shown: untick "Dev team" to see everyone\'s.')
  await ui.press({ key: 'bugs-team' })
  await ui.press({ key: 'bugs-mine' })
  await settle(ui, /☐ Dev team/)
  expect(await labels(ui)).toContain('▸ Header typo')
})

test('desktop: the area paths of developers.json decide what is shown at all', async ($: any, on: any) => {
  const w = world(on)
  // 703 is in Proj\Login; 701 and 702 are in Proj\Payments. Only Proj\Login and what is under Proj\Payments\Core count.
  w.files[`${ROOT}/.claude/developers.json`] = JSON.stringify({ areaPath: 'Proj.Other; Proj\\Login', developers: ['ann bee'] })
  const ui = await mount($, w)
  if (!ui) return
  await settle(ui, /1 item/)
  const all = await labels(ui)
  expect(all).toContain('▸ Header typo')                                                // in Proj\Login: shown, with no filter on
  expect(all).not.toContain('▸ Login hangs')                                            // Ann Bee's, but in Proj\Payments: never shown
  expect(all).not.toContain('▸ Totals lose cents')
  expect(await texts(ui)).toContain('1 item (2 outside the area path hidden)')
  expect(all).toEqual(expect.arrayContaining(['All 1']))                                // the counts are of what is shown
  // no filter brings them back: not the search, not the team, not the state
  await ui.input({ key: 'bugs-search', text: 'hangs', kind: 'submit' })                // a word only the hidden item has
  await settle(ui, /Nothing matches/)
  expect(await labels(ui)).not.toContain('▸ Login hangs')
  await ui.press({ key: 'bugs-search-clear' })
  await settle(ui, /^(?![\s\S]*Nothing matches)/)
  await ui.press({ key: 'bugs-team' })                                                  // Dev team: Ann Bee's items, of those inside the area: none
  await settle(ui, /Nothing matches/)
  expect(await labels(ui)).not.toContain('▸ Login hangs')
  expect(await labels(ui)).not.toContain('▸ Header typo')                               // unassigned: not a developer's
})

test('desktop: Dev team shows only the items of the developers, not anyone else\'s in the area', async ($: any, on: any) => {
  const w = world(on)
  w.files[`${ROOT}/.claude/developers.json`] = JSON.stringify({ areaPath: 'Proj\\Payments\\*; Proj\\Login', developers: ['ann bee'] })
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-team' })
  await settle(ui, /☑ Dev team/)
  const names = await labels(ui)
  expect(names).toContain('▸ Login hangs')                                              // Ann Bee's
  expect(names).not.toContain('▸ Totals lose cents')                                    // in the area, assigned to someone who is not a developer
  expect(names).not.toContain('▸ Header typo')                                          // in the area, assigned to nobody
  expect(await labels(ui)).toEqual(expect.arrayContaining(['All 1']))
})

test('desktop: without a developers.json the Dev team button says what the file is', async ($: any, on: any) => {
  const w = world(on, { team: false })
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-team' })
  for (let i = 0; i < 100 && !w.toasts.join('').includes('No dev team'); i++) await new Promise(r => setTimeout(r, 10))
  expect(w.toasts.join('\n')).toContain('No dev team: .claude/developers.json is missing, or lists no developers.')
  expect(await texts(ui)).not.toContain('Nothing matches')                              // the filter did not turn on
  expect(await labels(ui)).toContain('☐ Dev team')
})

test('desktop: not synced yet says so, and Sync runs the script and shows the list', async ($: any, on: any) => {
  const w = world(on, { synced: false })
  const ui = await mount($, w)
  if (!ui) return
  expect(await texts(ui)).toContain('Not synced yet. Press Sync')
  await ui.press({ key: 'bugs-sync' })
  await settle(ui, /3 items/)
  const run = w.runs.find(r => r.some(a => a.endsWith('Sync-Bugs.ps1')))!
  expect(run.slice(1, 6)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
  expect(run.slice(-2)).toEqual(['-Root', ROOT])
  expect(await texts(ui)).toContain('3 items')
  expect(w.toasts.join('\n')).toContain('Synced 3 bugs and issues in 1.5s: 3 new, 0 changed, 0 gone.')
})

test('desktop: changes are staged, written to pending.json, reverted, and saved as a batch', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bug-701' })
  await settle(ui, /Triage/)
  let t = await texts(ui)
  expect(t).toContain('Export shows 12 not 12.40')
  expect(t).toContain('Seen on prod')
  await ui.select({ key: 'state-701', value: 'Active' })
  await settle(ui, /1 unsaved change/)
  let pending = JSON.parse(w.files[`${DIR}/pending.json`]).changes
  expect(pending.map((c: any) => [c.id, c.field, c.value, c.was, c.label])).toEqual([[701, 'System.State', 'Active', 'New', 'State → Active']])
  await ui.select({ key: 'assign-701', value: 'ann@x.co' })
  await ui.input({ key: 'tag-in-701-0', text: 'Urgent', kind: 'submit' })
  await ui.press({ key: 'tag-701-Quick Win' })
  await ui.input({ key: 'comment-701-0', text: 'Same as #702', kind: 'submit' })    // refused: a mention, the field stays
  await ui.input({ key: 'comment-701-0', text: 'Same as ADO 702', kind: 'submit' })
  await settle(ui, /5 unsaved changes/)
  pending = JSON.parse(w.files[`${DIR}/pending.json`]).changes
  expect(pending.map((c: any) => c.label)).toEqual(['State → Active', 'Assigned to → Ann Bee', '+ tag Urgent', '− tag Quick Win', 'Comment: Same as ADO 702'])
  expect(w.toasts.join('\n')).toContain('Write \\"ADO 702\\" instead')
  // the staged tag removal looks staged, and the categories follow it before anything is saved: 701 leaves Quick wins
  expect(await labels(ui)).toEqual(expect.arrayContaining(['↶ Quick Win (to remove)', '⚡ Quick wins 0']))
  expect(await texts(ui)).toContain('staged on this item, not saved to ADO yet')
  expect(await texts(ui)).not.toContain('⚡ Quick wins')                                  // no longer listed among the open item's categories
  // the list shows the item as it will be
  t = await texts(ui)
  expect(t).toContain('5 staged on this item')
  expect(await labels(ui)).toContain('Urgent ✕')
  expect(await ui.find({ key: 'comment-701-1' })).toBeTruthy()                        // a fresh, empty field for the next one
  expect(await ui.find({ key: 'tag-in-701-1' })).toBeTruthy()
  // revert one, then review and revert another from the list of all
  const undo = pending.find((c: any) => c.kind === 'tagRemove').key
  await ui.press({ key: `ichg-undo-${undo}` })
  await settle(ui, /4 unsaved changes/)
  await ui.press({ key: 'pend-review' })
  await settle(ui, /Hide list/)
  const assign = pending.find((c: any) => c.field === 'System.AssignedTo').key
  await ui.press({ key: `chg-undo-${assign}` })
  await settle(ui, /3 unsaved changes/)
  expect(JSON.parse(w.files[`${DIR}/pending.json`]).changes.length).toBe(3)
  // save: one comes back as a conflict, and Keep mine measures it from what ADO holds now
  await ui.press({ key: 'pend-save' })
  await settle(ui, /1 unsaved change/)
  expect(w.runs.some(r => r.some(a => a.endsWith('Save-BugChanges.ps1')))).toBe(true)
  expect(w.toasts.join('\n')).toContain('Saved 2 changes to ADO. 1 could not be saved')
  t = await texts(ui)
  expect(t).toContain("⚠ changed in ADO since you staged it: it is now 'Active'")
  const left = JSON.parse(w.files[`${DIR}/pending.json`]).changes[0]
  await ui.press({ key: `chg-mine-${left.key}` })
  await settle(ui, /^(?![\s\S]*⚠ changed in ADO)/)
  expect(JSON.parse(w.files[`${DIR}/pending.json`]).changes[0]).toMatchObject({ was: 'Active' })
  // revert all asks first
  await ui.press({ key: 'pend-revert' })
  await settle(ui, /Drop all 1 staged/)
  await ui.press({ key: 'pend-revert-yes' })
  await settle(ui, /^(?![\s\S]*unsaved change)/)
  expect(JSON.parse(w.files[`${DIR}/pending.json`]).changes).toEqual([])
})

test('desktop: pick several and change them all at once', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'pick-701' })
  await ui.press({ key: 'pick-703' })
  await settle(ui, /2 picked/)
  await ui.press({ key: 'pick-page' })                                                 // the header's box: every row on the page
  await settle(ui, /3 picked/)
  await ui.press({ key: 'pick-page' })                                                 // and again: none
  await settle(ui, /^(?![\s\S]*picked:)/)
  await ui.press({ key: 'pick-701' })
  await ui.press({ key: 'pick-703' })
  await settle(ui, /2 picked/)
  await ui.select({ key: 'bulk-iteration', value: 'Proj\\Sprint 20' })              // already there: nothing staged
  await ui.select({ key: 'bulk-priority', value: '4' })
  await settle(ui, /2 unsaved changes on 2 items/)
  const pending = JSON.parse(w.files[`${DIR}/pending.json`]).changes
  expect(pending.map((c: any) => [c.id, c.value, c.was])).toEqual([[701, '4', '1'], [703, '4', '3']])
  // the band's Bugs button counts what is staged and not saved
  const band = await $.ui.mount({ plugin: 'sdd', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } as never, requestId: 'band', viewport: { columns: 100, rows: 40 } })
  for (let i = 0; i < 100 && !(await labels(band)).includes('Bugs ✎2'); i++) await new Promise(r => setTimeout(r, 10))
  expect(await labels(band)).toContain('Bugs ✎2')
})

test('desktop: links, evidence, the probable cause and the /sdd command to copy', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bug-701' })
  await settle(ui, /Triage/)
  const md = (await ui.findAll({ type: 'Markdown' })).map((m: any) => m.props?.text ?? m.text ?? '').join('\n')
  expect(md).toContain('[Open Bug 701 in ADO](https://dev.azure.com/Org/Proj/_workitems/edit/701)')
  expect(md).toContain('[PR 77 · Fix the totals](https://dev.azure.com/Org/Proj/_git/Gateway/pullrequest/77) · active · Gateway')
  expect(md).toContain('[Commit abc1234d](https://dev.azure.com/Org/Proj/_git/Gateway/commit/abc1234def)')
  await ui.press({ key: 'ev-701' })
  await settle(ui, /Billing\/Totals.cs:42/)
  expect(w.prompts.length).toBe(0)                                                    // evidence costs no tokens
  await ui.press({ key: 'an-701' })
  await settle(ui, /tokens in/)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('Bug 701: Totals lose cents')
  expect(w.prompts[0]).toContain('- Gateway/Billing/Totals.cs:42 [Totals.cs] decimal Round()')
  expect(await texts(ui)).toContain('haiku · 900 tokens in, 120 out')
  expect(JSON.parse(w.files[`${DIR}/items/701.analysis.json`]).text).toContain('Totals.Round drops the cents')
  expect(w.runs.filter(r => r.some(a => a.endsWith('Find-BugEvidence.ps1'))).length).toBe(1)   // the evidence was reused
  // the command for a new chat goes on the clipboard (the test workspace is no Windows one: sh with pbcopy, wl-copy or xclip)
  await ui.press({ key: 'copy-701' })
  for (let i = 0; i < 100 && !w.toasts.join('').includes('Copied'); i++) await new Promise(r => setTimeout(r, 10))
  const copy = w.runs.find(r => r[0] === 'sh' && r.join(' ').includes('/sdd 701'))
  expect(copy?.[2]).toBe("printf %s '/sdd 701' | (pbcopy 2>/dev/null || wl-copy 2>/dev/null || xclip -selection clipboard)")
  expect(w.toasts.join('\n')).toContain('Copied \\"/sdd 701\\". Paste it in a new chat to start sdd.')
  expect(w.runs.some(r => r.some(a => a.endsWith('Start-SddChat.ps1')))).toBe(false)           // no launcher any more
  await ui.press({ key: 'here-701' })
  expect(w.filled).toContain('/sdd 701')
})

test('desktop: /sdd-bugs mine opens on the items assigned to the person', async ($: any, on: any) => {
  const w = world(on)
  const ui = await mount($, w, 'mine')
  if (!ui) return
  await settle(ui, /☑ Assigned to me/)
  const names = await labels(ui)
  expect(names).toContain('▸ Totals lose cents')
  expect(names).not.toContain('▸ Header typo')
})
