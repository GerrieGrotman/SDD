import { expect, test } from 'claude-code/testing'

import type { SddItem, SddSnapshot } from '../types'
import { flowMap, flowTag, questionBadge, answerMessage, answersFor, approveAnswers, approveFor, approveMessage, fileLinks, flowFinished, fileTarget, gateStory, idFromArgs, idFromScript, pendingGate, reviewLinks, stamp, phaseKey, refLink, stageRows, stageSummary } from './view/model'
import type { SddLiveState } from '../types'
import { historyArgs, historyRefs, agoText, cleanupNote, conflictNote, counts, groupByItem, joinWorktrees, lineFacts, pathKey, sortLines } from './view/worktrees'

const SPEC = {
  label: 'Spec flow',
  prGates: ['Requirements agreed', 'Ready to PR'],
  stages: [
    { key: 'Specify', label: 'Specify', needs: [], passes: ['Claimed'] },
    { key: 'Open Questions', label: 'Open Questions', needs: ['Claimed'], passes: ['Open questions'], stop: true, conditional: true },
    { key: 'Requirements', label: 'Requirements', needs: ['Claimed'], passes: ['Requirements agreed'], stop: true, inferFromGates: true },
    { key: 'Design', label: 'Design', needs: ['Claimed', 'Requirements agreed'], passes: ['Worktree', 'Design agreed'], stop: true },
    { key: 'Decompose', label: 'Decompose', needs: [], passes: ['Tasks written'], stop: true },
    { key: 'Implement', label: 'Implement', needs: [], passes: ['Tasks done'] },
    { key: 'Verify', label: 'Verify', needs: ['Tasks done'], passes: ['Ready to PR', 'PR raised'], stop: true },
  ],
}
const BUG = {
  label: 'Bug flow',
  prGates: ['Approval'],
  stages: ['1', '2', '6', '10', '11', '12'].map(n => ({ key: `Phase ${n}`, label: `step ${n}`, needs: [], passes: n === '6' ? ['Approval'] : [] })),
}

const ITEM: SddItem = {
  id: 92012, type: 'User Story', title: 'Author and normalise free-text tags', state: 'Active',
  project: 'Internal_DevOps', flow: 'spec', slug: 'author', created: '2026-10-01T08:50:08Z',
  repos: { Repo: { base: 'team/0.0.1', branch: 'dev/x/92012-author', path: 'src/Repo', pr: { id: 34479, url: 'https://dev.azure.com/o/p/_git/Repo/pullrequest/34479' } } },
  gates: { Claimed: '2026-10-01T08:50:08Z', 'Requirements agreed': '2026-10-01T12:41:15Z', 'Design agreed': '2026-10-01T12:41:15Z', 'Ready to PR': '2026-10-01T13:55:23Z' },
  progress: { at: '2026-10-01T13:56:47Z', flow: 'spec', phase: 'Verify', status: 'waiting', gate: 'PR status', next: 'Dev Completed', note: 'PR 34479 open', refs: ['ado'] },
  folder: 'C:/ws/.claude/worktrees/92012-author',
  spec: { folder: 'docs/spec/92012-US-author', path: 'C:/ws/docs/spec/92012-US-author', files: ['design.md', 'requirements.md', 'tasks.md'], tasks_done: 20, tasks_total: 20 },
  met: ['Claimed', 'Design agreed', 'PR raised', 'Ready to PR', 'Requirements agreed', 'Tasks done', 'Tasks written', 'Worktree'],
  url: 'https://dev.azure.com/o/Internal_DevOps/_workitems/edit/92012',
  history: [
    { at: '2026-10-01T10:41:54Z', flow: 'spec', phase: 'Requirements', status: 'waiting', gate: 'Requirements agreed?', refs: ['visuals/requirements.html'] },
    { at: '2026-10-01T12:24:36Z', flow: 'spec', phase: 'Requirements', status: 'done', gates: { passed: ['Requirements agreed'], revoked: [] } },
    { at: '2026-10-01T12:35:44Z', flow: 'spec', phase: 'Design', status: 'active', gates: { passed: [], revoked: ['Requirements agreed'] } },
    { at: '2026-10-01T12:41:15Z', flow: 'spec', phase: 'Decompose', status: 'active', gates: { passed: ['Requirements agreed', 'Design agreed'], revoked: [] } },
  ],
}

const SNAP: SddSnapshot = {
  root: 'C:/ws', specRoot: 'C:/ws/docs/spec', flows: { spec: SPEC, bug: BUG },
  derived: ['Worktree', 'PR raised', 'Tasks written', 'Tasks done'], items: [ITEM], done: [],
}

test('the flow tag names the flow, and the path of the spec flow', () => {
  const SPEC_PATHS = { ...SPEC, paths: { choose: 'Specify', full: { label: 'Full' }, short: { label: 'Short' } } }
  expect(flowTag(BUG, { ...ITEM, flow: 'bug' })).toEqual(
    { flow: 'Bug flow', path: null, text: 'Bug flow', brief: 'bug', open: false })
  expect(flowTag(SPEC_PATHS, { ...ITEM, path: 'short' })).toEqual(
    { flow: 'Spec flow', path: 'short path', text: 'Spec flow · short path', brief: 'spec · short', open: false })
  expect(flowTag(SPEC_PATHS, { ...ITEM, path: 'full' }).brief).toBe('spec · full')
  const open = flowTag(SPEC_PATHS, { ...ITEM, path: null })
  expect([open.path, open.brief, open.open]).toEqual(['path not chosen', 'spec · path?', true])
  expect(flowTag(SPEC_PATHS, { ...ITEM, path: 'sideways' }).open).toBe(true)      // not a path the flow has
  expect(flowTag(SPEC, ITEM).path).toBe(null)                                    // a flow without paths
  expect(flowTag(undefined, { ...ITEM, flow: 'bug' }).text).toBe('bug flow')     // an old snapshot
})

test('phase keys match env.py', () => {
  expect(phaseKey(BUG, 'Phase 11 — Manual verification')).toBe('Phase 11')
  expect(phaseKey(BUG, 'Phase 12')).toBe('Phase 12')
  expect(phaseKey(BUG, 'Phase 2')).toBe('Phase 2')
  expect(phaseKey(SPEC, 'Implement (task 3/7)')).toBe('Implement')
  expect(phaseKey(SPEC, 'removed')).toBe(null)
})

test('stages: done before the current one, the current one waiting', () => {
  // Specify, Open Questions, Requirements, Design, Decompose, Implement before Verify, which waits
  expect(stageRows(SPEC, ITEM).map(r => r.mark)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'waiting'])
  const done = { ...ITEM, progress: { ...ITEM.progress!, phase: 'removed', status: 'done' as const } }
  expect(stageRows(SPEC, done).every(r => r.mark === 'done')).toBe(true)
})

test('stages: a jumped stage shows as missed, a skip the user agreed to as skipped', () => {
  const t = '2026-10-05T06:22:42Z'
  const item: SddItem = {
    ...ITEM, flow: 'bug',
    progress: { at: t, flow: 'bug', phase: 'Phase 12 — Pull request', status: 'done' },
    stages: { 'Phase 1': { at: t, status: 'done' }, 'Phase 6': { at: t, status: 'done' },
      'Phase 10': { at: t, status: 'skipped', confirmed: 'skip it' }, 'Phase 11': { at: t, status: 'done' },
      'Phase 12': { at: t, status: 'done' } },
  }
  expect(stageRows(BUG, item).map(r => r.mark)).toEqual(['done', 'missed', 'done', 'skipped', 'done', 'done'])
  expect(flowFinished(BUG, item)).toBe(false)
  expect(flowFinished(BUG, { ...item, stages: { ...item.stages, 'Phase 2': { at: t, status: 'skipped', confirmed: 'ok' } } })).toBe(true)
})


test('refs become links', () => {
  expect(refLink(ITEM, 'ado')).toBe(`[ADO 92012](${ITEM.url})`)
  expect(refLink(ITEM, 'visuals/design.html')).toBe('[design.html](file:///C:/ws/docs/spec/92012-US-author/visuals/design.html)')
  expect(refLink(ITEM, 'src/Repo/A b.cs:43-82')).toBe('[A b.cs:43-82](file:///C:/ws/.claude/worktrees/92012-author/src/Repo/A%20b.cs#L43)')
})


// The pane itself is checked live: this build's `claude plugin test` gives the plugin no $.state
// (the kit's own pane example fails the same way), while a real session does.


test('a gate reads as one decision: in time order', () => {
  const item = { ...ITEM, history: [
    { at: '2026-10-01T10:41:54Z', flow: 'spec', phase: 'Requirements', status: 'waiting' as const, gate: 'Requirements agreed?', refs: ['visuals/requirements.html'] },
    { at: '2026-10-01T12:24:36Z', flow: 'spec', phase: 'Requirements', status: 'done' as const, note: 'AC 4-6 added', gates: { passed: ['Requirements agreed'], revoked: [] } },
    { at: '2026-10-01T12:29:10Z', flow: 'spec', phase: 'Design', status: 'waiting' as const, gate: 'Design agreed?' },
    { at: '2026-10-01T12:35:44Z', flow: 'spec', phase: 'Design', status: 'active' as const, note: 'tags moved', gates: { passed: [], revoked: ['Requirements agreed'] } },
    { at: '2026-10-01T12:38:01Z', flow: 'spec', phase: 'Design', status: 'waiting' as const, gate: 'Re-approve rev 2' },
    { at: '2026-10-01T12:41:15Z', flow: 'spec', phase: 'Decompose', status: 'active' as const, note: 'D1=B', gates: { passed: ['Requirements agreed', 'Design agreed'], revoked: [] } },
  ] }
  expect(gateStory(item, 'Requirements agreed').map(x => `${x.kind} ${x.text}`)).toEqual([
    'asked Requirements agreed?', 'passed AC 4-6 added', 'asked Design agreed?',
    'revoked tags moved', 'asked Re-approve rev 2', 'passed D1=B'])
  expect(gateStory(item, 'Design agreed').map(x => x.kind)).toEqual(['asked', 'asked', 'passed'])
  expect(gateStory(item, 'Ready to PR')).toEqual([])
})

test('a stage row counts its entries and shows its latest note', () => {
  expect(stageSummary(SPEC, ITEM, 'Requirements')).toEqual({ count: 2, note: '', lastAt: '2026-10-01T12:24:36Z' })
  const withNote = { ...ITEM, history: [...ITEM.history!, { at: '2026-10-01T12:50:00Z', flow: 'spec', phase: 'Decompose', status: 'active' as const, note: '20 tasks' }] }
  expect(stageSummary(SPEC, withNote, 'Decompose')).toEqual({ count: 2, note: '20 tasks', lastAt: '2026-10-01T12:50:00Z' })
})

test('a file link comes back as a path and a line', () => {
  const md = `${refLink(ITEM, 'src/Repo/A b.cs:43-82')}   ${refLink(ITEM, 'visuals/design.html')}   ${refLink(ITEM, 'ado')}`
  const files = fileLinks(md)
  expect(files.length).toBe(2)
  expect(fileTarget(files[0])).toEqual({ path: 'C:/ws/.claude/worktrees/92012-author/src/Repo/A b.cs', line: 43 })
  expect(fileTarget(files[1])).toEqual({ path: 'C:/ws/docs/spec/92012-US-author/visuals/design.html', line: undefined })
  expect(fileTarget('https://dev.azure.com/x')).toBe(null)
})

test('a row shows the time of its last activity as MM/DD/YYYY HHhMM', () => {
  expect(stamp('2026-10-01T12:41:15')).toBe('10/01/2026 12h41')
  expect(stamp(undefined)).toBe('')
})

test("the chat's work item comes from /sdd and from sdd script runs", () => {
  expect(idFromArgs('92012')).toBe(92012)
  expect(idFromArgs('spec 92012')).toBe(92012)
  expect(idFromArgs('92012 feedback Design: more')).toBe(92012)
  expect(idFromArgs('help')).toBe(null)
  expect(idFromArgs('sync all')).toBe(null)
  expect(idFromScript('python C:/p/scripts/env.py progress --flow spec --id 92012 --status waiting')).toBe(92012)
  expect(idFromScript('python "C:/x y/scripts/spec.py" sync --id 5')).toBe(5)
  expect(idFromScript('python C:/p/scripts/env.py doctor --json')).toBe(null)
})

// An item waiting at Design: Claude asked "Design agreed?" with the design page and design.md.
const AT_DESIGN: SddItem = {
  ...ITEM,
  gates: { Claimed: '2026-10-01T08:50:08Z', 'Requirements agreed': '2026-10-01T12:24:36Z' },
  progress: { at: '2026-10-01T12:29:10Z', flow: 'spec', phase: 'Design', status: 'waiting', gate: 'Design agreed?', refs: ['visuals/design.html', 'design.md', 'src/Repo/A.cs:43-82'] },
  history: [
    { at: '2026-10-01T12:24:36Z', flow: 'spec', phase: 'Requirements', status: 'done', gates: { passed: ['Requirements agreed'], revoked: [] } },
    { at: '2026-10-01T12:29:10Z', flow: 'spec', phase: 'Design', status: 'waiting', gate: 'Design agreed?', refs: ['visuals/design.html', 'design.md', 'src/Repo/A.cs:43-82'] },
  ],
  spec: { ...ITEM.spec!, files: ['design.md', 'questions.md', 'requirements.md'] },
}

test('the gate an item waits on is the first one its waiting stage has not passed', () => {
  expect(pendingGate(SPEC, AT_DESIGN, SNAP.derived)).toEqual({ gate: 'Design agreed', key: 'Design' })
  expect(pendingGate(SPEC, ITEM, SNAP.derived)).toBe(null)  // Verify: Ready to PR passed, PR raised is derived
})

test('a pending gate shows the question it waits on', () => {
  expect(gateStory(AT_DESIGN, 'Design agreed')).toEqual([])
  const story = gateStory(AT_DESIGN, 'Design agreed', { flow: SPEC, key: 'Design' })
  expect(story.map(x => `${x.kind} ${x.text}`)).toEqual(['asked Design agreed?'])
})

test('the reading list: the refs given with the question, then the stage docs not among them', () => {
  expect(reviewLinks(AT_DESIGN, 'Design')).toEqual([
    '[design.html](file:///C:/ws/docs/spec/92012-US-author/visuals/design.html)',
    '[design.md](file:///C:/ws/docs/spec/92012-US-author/design.md)',
    '[A.cs:43-82](file:///C:/ws/.claude/worktrees/92012-author/src/Repo/A.cs#L43)',
    '[questions.md](file:///C:/ws/docs/spec/92012-US-author/questions.md)',
  ])
  expect(reviewLinks({ ...AT_DESIGN, progress: { ...AT_DESIGN.progress!, status: 'active' } }, 'Design'))
    .toEqual(['[design.md](file:///C:/ws/docs/spec/92012-US-author/design.md)', '[questions.md](file:///C:/ws/docs/spec/92012-US-author/questions.md)'])
})

test('answers read as the chat dialog gives them', () => {
  const qs = [
    { question: 'Design agreed?', header: 'Design gate', options: [{ label: 'Approve' }, { label: 'Needs changes' }] },
    { question: 'Which tests?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'Integration' }] },
  ]
  expect(answersFor(qs, { 'Design agreed?': ['Approve'] }, '')).toBe(null)
  expect(answersFor(qs, { 'Design agreed?': ['Approve'], 'Which tests?': ['Unit', 'Integration'] }, ''))
    .toEqual({ 'Design agreed?': 'Approve', 'Which tests?': 'Unit, Integration' })
  expect(answersFor(qs, { 'Design agreed?': ['Approve'] }, ' only smoke ')).toEqual({ 'Design agreed?': 'Approve', 'Which tests?': 'only smoke' })
  expect(answersFor(qs, { 'Design agreed?': ['Gone'] }, '')).toBe(null)
  expect(answerMessage(92012, 'Design', qs, { 'Design agreed?': 'Approve', 'Which tests?': 'Unit' }))
    .toBe('sdd answer for 92012, stage Design: "Design agreed?" = "Approve"; "Which tests?" = "Unit"')
})

test('the Approve button shows at the four spec stops and picks the go-ahead', () => {
  const at = (phase: string, status: 'waiting' | 'active' = 'waiting'): SddItem => ({ ...ITEM, progress: { ...ITEM.progress!, phase, status } })
  expect(approveFor(SPEC, at('Requirements'))).toEqual({ key: 'Requirements', label: 'Approve Spec', option: 'Approve — start Design' })
  expect(approveFor(SPEC, at('Design'))).toEqual({ key: 'Design', label: 'Approve Design', option: 'Approve — start Decompose' })
  expect(approveFor(SPEC, at('Decompose'))).toEqual({ key: 'Decompose', label: 'Approve Task List', option: 'Approve — start Implement' })
  expect(approveFor(SPEC, at('Verify'))).toEqual({ key: 'Verify', label: 'Raise PR', option: 'Raise the PR' })
  expect(approveFor(SPEC, at('Implement (task 3/7)'))).toBe(null)
  expect(approveFor(SPEC, at('Design', 'active'))).toBe(null)
  expect(approveFor(BUG, { ...at('Phase 6'), flow: 'bug' })).toBe(null)

  const gate = [{ question: 'Ready?', options: [{ label: 'Raise the PR' }, { label: 'Make changes' }] }]
  expect(approveAnswers(gate, 'Raise the PR')).toEqual({ 'Ready?': 'Raise the PR' })
  const loose = [{ question: 'Design agreed?', options: [{ label: 'Needs changes' }, { label: 'Approve' }] }]
  expect(approveAnswers(loose, 'Approve — start Decompose')).toEqual({ 'Design agreed?': 'Approve' })
  const other = [{ question: 'Which tech stories?', multiSelect: true, options: [{ label: 'TS-1' }, { label: 'TS-2' }] }]
  expect(approveAnswers(other, 'Approve — start Decompose')).toBe(null)
  expect(approveMessage(92012, 'Decompose')).toBe('sdd approve for 92012, stage Decompose')
})

test('Open Questions: skipped when nothing was asked, badged while questions stay open or were left open', () => {
  const done = { at: '2026-10-01T10:00:00Z', status: 'done' as const }
  const base: SddItem = { ...ITEM, gates: { Claimed: 'x' }, progress: { ...ITEM.progress!, phase: 'Requirements', status: 'waiting' },
    stages: { Specify: done }, spec: { ...ITEM.spec!, questions_open: 0, questions_total: 0 } }
  const mark = (i: SddItem) => stageRows(SPEC, i).find(r => r.stage.key === 'Open Questions')!.mark
  expect(mark(base)).toBe('skipped')
  expect(questionBadge(SPEC, base, 'Open Questions')).toBe(null)
  expect(questionBadge(SPEC, base, 'Specify')).toBe(null)
  const asked = { ...base, spec: { ...base.spec!, questions_open: 2, questions_total: 3 } }
  expect(mark(asked)).toBe('missed')
  expect(questionBadge(SPEC, asked, 'Open Questions')).toEqual({ text: '2 open', warn: true })
  const caveat = { ...asked, gates: { ...asked.gates, 'Open questions': 'y' }, stages: { ...asked.stages, 'Open Questions': done },
    history: [{ at: '2026-10-01T11:00:00Z', flow: 'spec', phase: 'Open Questions', status: 'done' as const, caveat: 'Q2 region', openQuestions: 2 }] }
  expect(mark(caveat)).toBe('done')
  expect(questionBadge(SPEC, caveat, 'Open Questions')).toEqual({ text: 'continued with 2 open', warn: true })
  const answered = { ...base, spec: { ...base.spec!, questions_open: 0, questions_total: 3 }, stages: { ...base.stages, 'Open Questions': done } }
  expect(questionBadge(SPEC, answered, 'Open Questions')).toEqual({ text: '3 answered', warn: false })
  // an item started before the stages existed: Requirements agreed is passed, so Requirements is not "missed"
  const legacy = { ...base, gates: { Claimed: 'x', 'Requirements agreed': 'y' } }
  expect(stageRows(SPEC, { ...legacy, progress: { ...legacy.progress!, phase: 'Design' } }).find(r => r.stage.key === 'Requirements')!.mark).toBe('done')
})

const COLORS = { done: '#3f9a63', now: '#c98a12', work: '#4a7fc4', revoked: '#c0503f', gate: '#8a73c9', dim: '#7b8794', line: '#5c6670', hoverText: '#ffffff' }
const SPEC_REWORK = { ...SPEC, stages: [...SPEC.stages, { key: 'Review', label: 'Review', needs: ['PR raised'], passes: ['PR approved'], stop: true, reworkTo: 'Implement' }] }

test('the flow map draws one box per stage, in a snake of four, with the way back for a rejected review', () => {
  const item: SddItem = { ...ITEM, progress: { ...ITEM.progress!, phase: 'Design', status: 'waiting' }, gates: { Claimed: '2026-10-01T08:50:08Z', 'Requirements agreed': '2026-10-01T12:41:15Z' } }
  const rows = stageRows(SPEC_REWORK, item)
  const pend = pendingGate(SPEC_REWORK, item, SNAP.derived)
  const m = flowMap(SPEC_REWORK, item, rows, SNAP.derived, COLORS, pend)
  expect(m.source.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(m.source.endsWith('</svg>')).toBe(true)
  expect(m.source.length).toBeLessThan(131072)                              // the Svg element's limit
  expect(m.source.match(/<rect /g)?.length).toBe(8 + 1)                      // a box each, and the ring round the stage the item is at
  expect(m.source).toContain('stroke-dasharray="5 4"')                       // Review goes back to Implement
  expect(m.source).toContain('rework → Implement')
  expect(m.alt).toBe('Spec flow, 8 stages: Specify (done), Open Questions (done), Requirements (done), Design (waiting on you), Decompose (next), Implement, Verify, Review.')
  // the second row runs right to left: Decompose (stage 5) sits under Design (stage 4)
  const xs = [...m.source.matchAll(/<rect x="(\d+)" y="(\d+)" width="126"/g)].map(x => [Number(x[1]), Number(x[2])])
  expect(xs[3][0]).toBe(xs[4][0])
  expect(xs[4][1]).toBeGreaterThan(xs[3][1])
  expect(xs[7][0]).toBe(xs[0][0])                                            // Review ends under Specify
})

test('the flow map: a flow of phases, no way back drawn when the target is not behind, and text is escaped', () => {
  const bug = { ...BUG, stages: [...BUG.stages.slice(0, 3), { key: 'Phase 15', label: 'PR <review> & "more"', needs: [], passes: [], stop: true, reworkTo: 'Phase 99' }] }
  const item: SddItem = { ...ITEM, flow: 'bug', progress: { ...ITEM.progress!, phase: 'Phase 6', status: 'active' } }
  const m = flowMap(bug, item, stageRows(bug, item), [], COLORS, null)
  expect(m.source).not.toContain('stroke-dasharray="5 4"')                  // reworkTo names no stage: nothing drawn
  expect(m.source).toContain('Phase 15')
  expect(m.source).toContain('PR &lt;review&gt; &amp; &quot;more&quot;')
  expect(m.source).not.toContain('<review>')
})

// ---- the Worktrees page

const wtItem = (id: number, folder: string | null, extra: Partial<SddItem> = {}): SddItem => ({
  ...ITEM, id, folder, repos: { Repo: { base: 'team/0.0.1', branch: `dev/x/${id}`, path: 'src/Repo', pr: id === 1 ? { id: 55, url: 'u' } : undefined } },
  progress: { ...ITEM.progress!, status: 'active' },
  ...extra,
})
const LIVE: SddLiveState = { generated: 1000, repos: { Repo: { worktrees: [
  { path: 'C:/ws/.claude/worktrees/1-a/src/Repo', branch: 'dev/x/1', class: 'safe', reasons: ['merged into main'], dirty: 0, lastCommit: 1000 - 86400 * 4 },
  { path: 'C:/ws/.claude/worktrees/2-b/src/Repo', branch: 'dev/x/2', class: 'ok', reasons: [], dirty: 3, ahead: 1, behind: 2, lastCommit: 1000 - 7200 },
] } } }

test('a path key ignores slashes and the case of a drive path', () => {
  expect(pathKey('C:\\ws\\a\\')).toBe('c:/ws/a')
  expect(pathKey('/home/Me/a/')).toBe('/home/Me/a')
})

test('each work item repo is joined to its live worktree by path', () => {
  const lines = joinWorktrees([wtItem(1, 'c:\\ws\\.claude\\worktrees\\1-a'), wtItem(2, 'C:/ws/.claude/worktrees/2-b'), wtItem(3, 'C:/ws/.claude/worktrees/3-c'),
    wtItem(4, null), wtItem(5, 'C:/ws/x', { removed: '2026-10-01' })], LIVE)
  expect(lines.map(l => [l.item.id, l.live?.class ?? null])).toEqual([[1, 'safe'], [2, 'ok'], [3, null]])
  expect(joinWorktrees([wtItem(1, 'C:/ws/.claude/worktrees/1-a')], null)[0].live).toBe(null)
})

test('lines to clean up come first, then work waiting on the person', () => {
  const waiting = wtItem(3, 'C:/ws/.claude/worktrees/3-c', { progress: { ...ITEM.progress!, status: 'waiting' } })
  const lines = sortLines(joinWorktrees([wtItem(2, 'C:/ws/.claude/worktrees/2-b'), waiting, wtItem(1, 'C:/ws/.claude/worktrees/1-a')], LIVE))
  expect(lines.map(l => l.item.id)).toEqual([1, 3, 2])
  expect(groupByItem([...lines, ...lines]).map(b => [b.item.id, b.lines.length])).toEqual([[1, 2], [3, 2], [2, 2]])
})

test('a line says where it came from and how the worktree is', () => {
  const [one, two, three] = joinWorktrees([wtItem(1, 'C:/ws/.claude/worktrees/1-a'), wtItem(2, 'C:/ws/.claude/worktrees/2-b'), wtItem(3, 'C:/ws/.claude/worktrees/3-c')], LIVE)
  expect(lineFacts(one, 1000)).toEqual(['from team/0.0.1', 'PR 55', 'clean', 'last commit 4d ago'])
  expect(lineFacts(two, 1000)).toEqual(['from team/0.0.1', '3 uncommitted', '+1/-2 upstream', 'last commit 2h ago'])
  expect(lineFacts(three, 1000)).toEqual(['from team/0.0.1', 'repowatch has not seen it'])
  expect(cleanupNote(one)).toBe('can be removed: merged into main')
  expect(cleanupNote(two)).toBe('')
  expect(cleanupNote(three)).toBe('')
  expect(counts([one, two, three])).toEqual({ items: 3, worktrees: 3, cleanup: 1, dirty: 1, conflicts: 0 })
  expect(agoText(undefined, 5)).toBe('no commits')
})

test('the Worktrees page shows how far behind the base a branch is and what would conflict', () => {
  const live: SddLiveState = { generated: 1000, repos: { Repo: { worktrees: [
    { path: 'C:/ws/.claude/worktrees/1-a/src/Repo', branch: 'dev/x/1', class: 'ok', reasons: [], dirty: 0, lastCommit: 1000 - 7200,
      baseRef: 'origin/team/0.0.1', behindBase: 4, aheadBase: 2, forecast: { state: 'conflict', base: 'origin/team/0.0.1', files: ['a.cs', 'b.cs'] } },
  ] } } }
  const [line] = joinWorktrees([wtItem(1, 'C:/ws/.claude/worktrees/1-a')], live)
  expect(lineFacts(line, 1000)).toContain('4 behind origin/team/0.0.1')
  expect(conflictNote(line)).toBe('merging origin/team/0.0.1 in would conflict in a.cs, b.cs')
  expect(counts([line]).conflicts).toBe(1)
  expect(sortLines(joinWorktrees([wtItem(2, 'C:/ws/.claude/worktrees/2-b'), wtItem(1, 'C:/ws/.claude/worktrees/1-a')], live))[0].item.id).toBe(1)
})

test('the Worktrees page asks repowatch for a line\'s history: its branch against the recorded base', () => {
  const live: SddLiveState = { generated: 1, repos: { 'my app': { worktrees: [
    { path: 'C:/ws/.claude/worktrees/1-a/src/Repo', branch: 'dev/x/1', class: 'ok', reasons: [], baseRef: 'origin/team/0.0.1' }] } } }
  const [seen] = joinWorktrees([wtItem(1, 'C:/ws/.claude/worktrees/1-a')], live)
  expect(seen.repoName).toBe('my app') // repowatch's name for the repo, which may differ from the work item's
  expect(historyRefs(seen)).toEqual(['dev/x/1', 'origin/team/0.0.1'])
  expect(JSON.parse(historyArgs(seen).slice('history '.length))).toEqual(
    { repo: 'my app', refs: ['dev/x/1', 'origin/team/0.0.1'], title: '1 · my app · dev/x/1 against origin/team/0.0.1' })
  // not seen by repowatch yet: the work item's own names and its recorded base
  const [unseen] = joinWorktrees([wtItem(2, 'C:/ws/.claude/worktrees/2-b')], null)
  expect(unseen.repoName).toBe('Repo')
  expect(historyRefs(unseen)).toEqual(['dev/x/2', 'origin/team/0.0.1'])
})
