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
  analysis: { model: 'haiku', maxTokens: 500, effort: 'low' }, newChat: { mode: 'terminal', url: '' }, me: '', powershell: '',
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
  // the dev team's file, as the workspace keeps it: an area path and display names
  if (opts.team !== false) w.files[`${ROOT}/.claude/developers.json`] = JSON.stringify({ areaPath: 'Proj.Other; Proj\\Billing\\*', developers: ['ann bee', 'Raj Patel'] })
  const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ((_$: unknown, e: { argv: string[] }) => {
    w.runs.push(e.argv)
    const script = e.argv.find(a => a.endsWith('.ps1')) ?? ''
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
    if (script.endsWith('Start-SddChat.ps1')) return done('{"ok":true,"how":"Claude Desktop","prompt":"/sdd:sdd 701"}')
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
  for (let i = 0; i < 100 && !/items ·|Sync/.test(await texts(ui)); i++) await new Promise(r => setTimeout(r, 10))
  return ui
}

async function settle(ui: any, want: RegExp) {
  for (let i = 0; i < 100 && !want.test(await texts(ui) + '\n' + (await labels(ui)).join('\n')); i++) await new Promise(r => setTimeout(r, 10))
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
  test(`desktop: the Config button opens the workspace's sdd.json (${synced ? 'synced' : 'not synced yet'})`, async ($: any, on: any) => {
    const w = world(on, { synced })
    const ui = await mount($, w)
    if (!ui) return
    expect(await labels(ui)).toContain('⚙ Config')
    await ui.press({ key: 'bugs-config' })
    for (let i = 0; i < 100 && !w.runs.some(r => r.includes(`${ROOT}/.claude/sdd.json`)); i++) await new Promise(r => setTimeout(r, 10))
    expect(w.runs.find(r => r.includes(`${ROOT}/.claude/sdd.json`))).toEqual(['open', `${ROOT}/.claude/sdd.json`])
  })
}

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
  expect(await texts(ui)).toContain('Only the dev team\'s items (its developers\', and its area paths\') are shown: untick "Dev team" to see everyone\'s.')
  await ui.press({ key: 'bugs-team' })
  await ui.press({ key: 'bugs-mine' })
  await settle(ui, /☐ Dev team/)
  expect(await labels(ui)).toContain('▸ Header typo')
})

test('desktop: Dev team also shows what is in the team\'s area paths', async ($: any, on: any) => {
  const w = world(on)
  w.files[`${ROOT}/.claude/developers.json`] = JSON.stringify({ areaPath: 'Proj; Proj\\Login\\*', developers: ['ann bee'] })
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-team' })
  await settle(ui, /☑ Dev team/)
  const names = await labels(ui)
  expect(names).toContain('▸ Login hangs')                                              // Ann Bee's
  expect(names).toContain('▸ Header typo')                                              // unassigned, in Proj\Login
  expect(names).not.toContain('▸ Totals lose cents')                                    // Me Myself's, in Proj\Payments
})

test('desktop: without a developers.json the Dev team button says what the file is', async ($: any, on: any) => {
  const w = world(on, { team: false })
  const ui = await mount($, w)
  if (!ui) return
  await ui.press({ key: 'bugs-team' })
  for (let i = 0; i < 100 && !w.toasts.join('').includes('No dev team'); i++) await new Promise(r => setTimeout(r, 10))
  expect(w.toasts.join('\n')).toContain('No dev team: .claude/developers.json is missing, or names no developer and no area.')
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

test('desktop: links, evidence, the probable cause and sdd in a new chat', async ($: any, on: any) => {
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
  await ui.press({ key: 'chat-701' })
  for (let i = 0; i < 100 && !w.toasts.join('').includes('New chat'); i++) await new Promise(r => setTimeout(r, 10))
  expect(w.runs.some(r => r.includes('-Id') && r.some(a => a.endsWith('Start-SddChat.ps1')))).toBe(true)
  expect(w.toasts.join('\n')).toContain('New chat opened (Claude Desktop) with /sdd:sdd 701 in its prompt box: confirm the folder, then press Enter.')
  await ui.press({ key: 'here-701' })
  expect(w.filled).toContain('/sdd:sdd 701')
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
