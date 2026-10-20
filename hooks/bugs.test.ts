// The bug manager's pure helpers (hooks/view/bugs.ts): settings, categories, the list, staged changes, links, the prompt.
import { expect, test } from 'claude-code/testing'

import type { BugCategory, BugIndex, BugRecord, BugsConfig, SddSnapshot } from '../types'
import { F, NO_FILTER, analysisKey, analysisPrompt, ago, bugsConfig, categorize, changeLabel, commentProblem, conditionHolds, currentValue,
  filterItems, isMine, itemLinks, keepMine, leaf, pathOptions, pendingByItem, people, powershellCandidates, revertChange, revertItem,
  scriptAnswer, scriptArgv, sddState, severityRank, shortName, sortItems, stageChange, stateOptions, tagOptions, withPending } from './view/bugs'

const DEFAULTS = {
  folder: '.bugs', types: ['Bug', 'Issue'],
  query: { projects: [], excludeStates: ['Closed'], areaPaths: [], iterationPaths: [], where: '', top: 1000 },
  extraFields: [], states: { Bug: ['New', 'Active', 'Resolved', 'Closed'], Issue: ['New', 'Active', 'Resolved', 'Closed'] },
  severities: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'], priorities: [1, 2, 3, 4],
  categories: [
    { id: 'quick-wins', label: 'Quick wins', icon: '⚡', notStates: ['Resolved', 'Closed'], any: [{ tags: ['Quick Win'] }, { maxEffort: 2 }] },
    { id: 'high-severity', label: 'High severity', icon: '🔥', notStates: ['Resolved', 'Closed'], any: [{ severity: ['1', '2'] }, { priority: [1] }] },
    { id: 'in-progress', label: 'In progress', any: [{ states: ['Active'] }, { boardColumns: ['Dev In Progress'] }] },
    { id: 'ready', label: 'Ready for deployment', any: [{ states: ['Resolved'] }, { tags: ['Ready for Deployment'] }] },
    { id: 'version', label: 'Team branch {value}', eachTag: '^\\d+(\\.\\d+){1,3}$' },
  ],
  analysis: { model: 'haiku', maxTokens: 500, effort: 'low' }, newChat: { mode: 'terminal', url: '' }, me: '', powershell: '',
} as BugsConfig

const ME = { name: 'Me Myself', email: 'me@x.co' }
const NOW = Date.parse('2026-10-20T12:00:00Z')

function rec(id: number, over: Partial<BugRecord> = {}): BugRecord {
  return {
    id, rev: 1, type: 'Bug', title: `Bug ${id}`, state: 'New', reason: '', project: 'Proj', area: 'Proj\\Payments', iteration: 'Proj\\Sprint 20',
    tags: [], assigned: null, severity: '3 - Medium', priority: 2, effort: null, boardColumn: '', created: '2026-10-01T00:00:00Z',
    changed: '2026-10-10T00:00:00Z', createdBy: null, url: `https://dev.azure.com/Org/Proj/_workitems/edit/${id}`, parent: null,
    related: [], commits: [], prs: [], links: [], extra: {}, ...over,
  }
}

const ITEMS = [
  rec(1, { tags: ['Quick Win', '1.1.0'], assigned: ME, priority: 3 }),
  rec(2, { severity: '1 - Critical', state: 'Active', assigned: { name: 'Ann Bee', email: 'ann@x.co' }, tags: ['1.2.0'], changed: '2026-10-12T00:00:00Z' }),
  rec(3, { state: 'Resolved', effort: 1, tags: ['1.1.0'], priority: 1 }),
  rec(4, { type: 'Issue', boardColumn: 'Dev In Progress', effort: 2, priority: null, created: '2026-01-01T00:00:00Z' }),
]

test('the settings: an object one level down is merged, a list replaces the default', () => {
  const c = bugsConfig(DEFAULTS, { query: { top: 5 }, categories: [{ id: 'x', label: 'X' }], analysis: { model: 'sonnet' } })
  expect(c.query.top).toBe(5)
  expect(c.query.excludeStates).toEqual(['Closed'])
  expect(c.categories).toEqual([{ id: 'x', label: 'X' }])
  expect(c.analysis).toEqual({ model: 'sonnet', maxTokens: 500, effort: 'low' })
  expect(bugsConfig(DEFAULTS, 'off').folder).toBe('.bugs')
})

test('a rule holds when every key it gives holds', () => {
  const i = ITEMS[1]
  expect(conditionHolds(i, {}, ME)).toBe(true)
  expect(conditionHolds(i, { severity: ['1'] }, ME)).toBe(true)
  expect(conditionHolds(i, { severity: ['1'], states: ['New'] }, ME)).toBe(false)
  expect(conditionHolds(i, { assigned: 'me' }, ME)).toBe(false)
  expect(conditionHolds(ITEMS[0], { assigned: 'me' }, ME)).toBe(true)
  expect(conditionHolds(ITEMS[2], { assigned: 'none' }, ME)).toBe(true)
  expect(conditionHolds(i, { areaUnder: ['proj'] }, ME)).toBe(true)
  expect(conditionHolds(i, { areaUnder: ['Proj\\Pay'] }, ME)).toBe(false)           // a path, not a prefix of a name
  expect(conditionHolds(i, { titleMatches: '^bug \\d$' }, ME)).toBe(true)
  expect(conditionHolds(i, { titleMatches: '(' }, ME)).toBe(false)                  // a bad pattern matches nothing
  expect(conditionHolds(ITEMS[3], { olderThanDays: 200 }, ME, NOW)).toBe(true)
  expect(conditionHolds(ITEMS[3], { newerThanDays: 30 }, ME, NOW)).toBe(false)
  expect(conditionHolds(rec(9, { extra: { 'Custom.Team': 'Blue' } }), { fields: { 'Custom.Team': ['blue'] } }, ME)).toBe(true)
  expect(conditionHolds(ITEMS[0], { hasPullRequest: false, allTags: ['quick win', '1.1.0'] }, ME)).toBe(true)
})

test('the default categories sort the list, and a team version becomes one category each', () => {
  const cats = categorize(ITEMS, DEFAULTS.categories, ME, NOW)
  const by = Object.fromEntries(cats.map(c => [c.id, c.ids]))
  expect(by['quick-wins']).toEqual([1, 4])            // the tag, or effort 2 or less; 3 is resolved
  expect(by['high-severity']).toEqual([2])
  expect(by['in-progress']).toEqual([2, 4])
  expect(by['ready']).toEqual([3])
  expect(cats.filter(c => c.id.startsWith('version:')).map(c => c.label)).toEqual(['Team branch 1.2.0', 'Team branch 1.1.0'])
  expect(by['version:1.1.0']).toEqual([1, 3])
  expect(categorize(ITEMS, [{ id: 'bad', label: 'B', eachTag: '(' } as BugCategory], ME).length).toBe(0)
  expect(categorize(ITEMS, [{ id: 'team', label: 'Team', eachField: 'type' } as BugCategory], ME).map(c => c.label)).toEqual(['Team Issue', 'Team Bug'])
})

test('the filters: category, mine, type, state and words', () => {
  const cats = categorize(ITEMS, DEFAULTS.categories, ME, NOW)
  const ids = (f: Partial<typeof NO_FILTER>) => filterItems(ITEMS, { ...NO_FILTER, ...f }, cats, ME).map(i => i.id)
  expect(ids({})).toEqual([1, 2, 3, 4])
  expect(ids({ category: 'quick-wins' })).toEqual([1, 4])
  expect(ids({ mine: true })).toEqual([1])
  expect(ids({ type: 'issue' })).toEqual([4])
  expect(ids({ state: 'Resolved' })).toEqual([3])
  expect(ids({ text: 'ann active' })).toEqual([2])
  expect(ids({ text: '1.2.0' })).toEqual([2])
  expect(ids({ category: 'gone' })).toEqual([1, 2, 3, 4])                          // a category that left the list: all
  expect(isMine(rec(5, { assigned: { name: 'Me Myself', email: '' } }), ME)).toBe(true)        // no e-mail: by name
  expect(isMine(rec(5, { assigned: { name: 'Me Myself', email: 'other@x.co' } }), ME)).toBe(false)
  expect(isMine(rec(5, { assigned: { name: 'me myself', email: '' } }), { name: 'Me Myself', email: '' })).toBe(true)
})

test('the order: priority, severity, changed, created, id', () => {
  expect(sortItems(ITEMS, 'priority').map(i => i.id)).toEqual([3, 2, 1, 4])
  expect(sortItems(ITEMS, 'severity').map(i => i.id)).toEqual([2, 3, 1, 4])
  expect(sortItems(ITEMS, 'changed').map(i => i.id)).toEqual([2, 1, 3, 4])
  expect(sortItems(ITEMS, 'created').map(i => i.id)).toEqual([1, 2, 3, 4])
  expect(sortItems(ITEMS, 'id').map(i => i.id)).toEqual([4, 3, 2, 1])
  expect(severityRank('2 - High')).toBe(2)
  expect(severityRank('')).toBe(9)
})

test('staging: one change per field, set back drops it, a tag added and removed cancels out', () => {
  const people = [ME, { name: 'Ann Bee', email: 'ann@x.co' }]
  let p = stageChange([], { id: 1, kind: 'field', field: F.state, value: 'Active', was: 'New' }, people, NOW)
  expect(p.length).toBe(1)
  expect(p[0].label).toBe('State → Active')
  const key = p[0].key
  p = stageChange(p, { id: 1, kind: 'field', field: F.state, value: 'Resolved', was: 'Active' }, people, NOW)
  expect(p.length).toBe(1)
  expect(p[0]).toMatchObject({ key, value: 'Resolved', was: 'New' })                 // the first "was" stays
  p = stageChange(p, { id: 1, kind: 'field', field: F.state, value: 'New', was: 'Resolved' }, people, NOW)
  expect(p).toEqual([])                                                              // back where it was: nothing to save
  p = stageChange(p, { id: 1, kind: 'tagAdd', value: 'Urgent' }, people, NOW)
  p = stageChange(p, { id: 1, kind: 'tagAdd', value: 'urgent' }, people, NOW)
  expect(p.length).toBe(1)
  p = stageChange(p, { id: 1, kind: 'tagRemove', value: 'URGENT' }, people, NOW)
  expect(p).toEqual([])
  p = stageChange(p, { id: 1, kind: 'field', field: F.assigned, value: 'ann@x.co', was: 'me@x.co' }, people, NOW)
  p = stageChange(p, { id: 2, kind: 'comment', value: 'Looks like the rounding' }, people, NOW)
  p = stageChange(p, { id: 2, kind: 'comment', value: 'and the export' }, people, NOW)
  expect(p.map(c => c.label)).toEqual(['Assigned to → Ann Bee', 'Comment: Looks like the rounding', 'Comment: and the export'])
  expect(pendingByItem(p).map(g => [g.id, g.changes.length])).toEqual([[1, 1], [2, 2]])
  expect(revertChange(p, p[1].key).length).toBe(2)
  expect(revertItem(p, 2).map(c => c.id)).toEqual([1])
  expect(new Set(p.map(c => c.key)).size).toBe(3)
})

test('keep mine: a conflict is measured from what ADO holds now', () => {
  const p = [{ key: 'k', id: 1, kind: 'field' as const, field: F.state, value: 'Resolved', was: 'New', label: 'x', at: '',
    problem: { kind: 'conflict' as const, text: 'changed', current: 'Active' } }]
  expect(keepMine(p, 'k')[0]).toMatchObject({ was: 'Active', problem: undefined })
  expect(keepMine(p, 'other')[0].was).toBe('New')
})

test('labels, comments and the record with its staged changes', () => {
  expect(changeLabel({ kind: 'field', field: F.area, value: 'Proj\\Login' })).toBe('Area → Login')
  expect(changeLabel({ kind: 'field', field: F.assigned, value: '' })).toBe('Assigned to → nobody')
  expect(changeLabel({ kind: 'tagRemove', value: 'x' })).toBe('− tag x')
  expect(commentProblem('Same as #1234')).toContain('Write "ADO 1234" instead')
  expect(commentProblem('See AB#1234 and ADO 1234')).toBe(null)
  expect(commentProblem('  ')).toBe('Type the comment first.')
  const people = [{ name: 'Ann Bee', email: 'ann@x.co' }]
  const p = [
    { key: 'a', id: 1, kind: 'field' as const, field: F.state, value: 'Active', was: 'New', label: '', at: '' },
    { key: 'b', id: 1, kind: 'field' as const, field: F.assigned, value: 'ann@x.co', was: 'me@x.co', label: '', at: '' },
    { key: 'c', id: 1, kind: 'tagRemove' as const, value: 'quick win', label: '', at: '' },
    { key: 'd', id: 1, kind: 'field' as const, field: F.priority, value: '1', was: '3', label: '', at: '' },
  ]
  const after = withPending(ITEMS[0], p, people)
  expect([after.state, after.assigned?.name, after.tags, after.priority]).toEqual(['Active', 'Ann Bee', ['1.1.0'], 1])
  expect(ITEMS[0].tags).toEqual(['Quick Win', '1.1.0'])                               // the record itself is left as it is
  expect(withPending(ITEMS[1], p)).toBe(ITEMS[1])
  expect(currentValue(ITEMS[0], F.assigned)).toBe('me@x.co')
  expect(currentValue(ITEMS[3], F.priority)).toBe('')
})

test('pickers: people, paths, states and tags', () => {
  const index = { me: ME, items: ITEMS } as BugIndex
  expect(people(index).map(p => p.email)).toEqual(['ann@x.co', 'me@x.co'])
  expect(pathOptions([...ITEMS, rec(9, { area: 'Proj\\Login' })], 'area')).toEqual(['Proj\\Payments', 'Proj\\Login'])
  expect(stateOptions(DEFAULTS, rec(9, { state: 'Triage' }))).toEqual(['Triage', 'New', 'Active', 'Resolved', 'Closed'])
  expect(stateOptions(DEFAULTS, rec(9, { type: 'Task' }))).toEqual(['New', 'Active', 'Resolved', 'Closed'])
  expect(tagOptions(ITEMS)).toEqual(['1.1.0', '1.2.0', 'Quick Win'])
  expect(leaf('Proj\\Sprint 20')).toBe('Sprint 20')
  expect(shortName({ name: 'Ann Bee', email: '' })).toBe('Ann B.')
  expect(shortName(null)).toBe('unassigned')
  expect(ago('2026-10-20T09:00:00Z', NOW)).toBe('3h')
  expect(ago('', NOW)).toBe('')
})

test('links back to ADO: the item, its PRs, commits, links and related items', () => {
  const i = rec(7, {
    prs: [{ id: 77, repo: 'Gateway', url: 'https://x/pr/77', title: 'Fix [totals]', status: 'active' }],
    commits: [{ sha: 'abc1234def567', repo: 'Gateway', url: 'https://x/commit/abc' }],
    links: [{ name: 'Runbook', url: 'https://wiki/x' }], related: [{ name: 'Parent', id: 600 }],
  })
  expect(itemLinks(i, 'Org')).toEqual([
    '[Open Bug 7 in ADO](https://dev.azure.com/Org/Proj/_workitems/edit/7)',
    '[PR 77 · Fix totals](https://x/pr/77) · active · Gateway',
    '[Commit abc1234d](https://x/commit/abc) · Gateway',
    '[Runbook](https://wiki/x)',
    'Parent: [ADO 600](https://dev.azure.com/Org/Proj/_workitems/edit/600)',
  ])
})

test('sdd: start, or continue where the flow stands', () => {
  const snap = { items: [{ id: 5, progress: { phase: 'Phase 6', status: 'waiting', gate: 'Approval' } }], done: [] } as unknown as SddSnapshot
  expect(sddState(snap, 5)).toEqual({ label: 'Continue sdd', note: 'sdd: Phase 6, waiting (Approval).' })
  expect(sddState(snap, 6).label).toBe('Start sdd')
  expect(sddState(null, 6).label).toBe('Start sdd')
})

test('the probable-cause prompt is short lines, and its key follows the item and the evidence', () => {
  const ev = { id: 1, rev: 1, terms: ['Totals.cs'], repos: ['Gateway'], seconds: 0.4,
    hits: [{ repo: 'Gateway', path: 'Billing/Totals.cs', line: 42, text: 'decimal Round()', term: 'Totals.cs' }],
    history: [{ repo: 'Gateway', path: 'Billing/Totals.cs', commits: ['abc 2026-10-01 Dev: Round'] }],
    linked: [{ repo: 'Gateway', commit: 'abc 2026-10-01 Dev: Round', files: ['Billing/Totals.cs'] }] }
  const d = { id: 1, text: { repro: 'Export shows 12\n\n\n\nnot 12.40', description: 'x'.repeat(2000) }, comments: [{ by: 'Ann', at: '', text: 'prod too' }] }
  const text = analysisPrompt(ITEMS[0], d, ev)
  expect(text).toContain('Bug 1: Bug 1')
  expect(text).toContain('Repro steps:\nExport shows 12\n\nnot 12.40')
  expect(text).toContain('- Gateway/Billing/Totals.cs:42 [Totals.cs] decimal Round()')
  expect(text).toContain('- Ann: prod too')
  expect(text).not.toContain('{')
  expect(text.length).toBeLessThan(1500)                                             // the description is cut
  expect(analysisPrompt(ITEMS[0], null, null)).toContain('No code evidence was gathered.')
  expect(analysisKey(ITEMS[0], ev)).toBe('1|Billing/Totals.cs:42,abc')
  expect(analysisKey({ ...ITEMS[0], rev: 2 }, ev)).not.toBe(analysisKey(ITEMS[0], ev))
})

test('running a script: which PowerShell, the argv, and its answer', () => {
  expect(powershellCandidates('', true)).toEqual(['pwsh', 'powershell'])
  expect(powershellCandidates('C:/ps/pwsh.exe', false)).toEqual(['C:/ps/pwsh.exe', 'pwsh'])
  expect(scriptArgv('pwsh', '/p', 'Sync-Bugs.ps1', '/ws', ['-Id', '5'])).toEqual(
    ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '/p/scripts/bugs/Sync-Bugs.ps1', '-Root', '/ws', '-Id', '5'])
  expect(scriptAnswer<{ ok: boolean }>('warning\n{"ok":true}\n')).toEqual({ ok: true })
  expect(scriptAnswer('\uFEFF{"ok":1}')).toEqual({ ok: 1 })                            // a BOM is dropped
  expect(scriptAnswer('ok: done')).toEqual(null)
  expect(scriptAnswer('{"ok":false}\n{broken')).toEqual({ ok: false })
  expect(scriptAnswer('')).toBe(null)
})
