// The settings panel's pure helpers (hooks/view/settings.ts): what the settings are, how an edit is read, what is wrong with a draft,
// and how a draft is merged into .claude/sdd.json and the dev team file.
import { expect, test } from 'claude-code/testing'

import type { BugCategory, BugsConfig } from '../types'
import { bugsConfig } from './view/bugs'
import { FIELDS, SECTIONS, addAlternative, addCategory, addToField, applyToDevelopers, applyToSdd, areaPath, changeCount, conditionOf, conditionRows, conditionText, describeCategory,
  describeCondition, fieldsOf, filesToWrite, needsSync, sectionDirty, freeKeys, getAt, isDirty, moveCategory, newCategoryId, parseList, parseNumber, removeAlternative, removeCategory, removeConditionKey,
  removeFromField, resetSection, revertDraft, seedFor, setAt, setCategoryText, setConditionKey, setField, settingsProblems, startDraft, withCondition, CONDITION_KEYS } from './view/settings'

const DEFAULTS = {
  folder: '.bugs', types: ['Bug', 'Issue'],
  query: { projects: [], excludeStates: ['Closed', 'Removed', 'Done'], areaPaths: [], iterationPaths: [], where: '', top: 1000 },
  developersFile: '.claude/developers.json', doneStates: ['Resolved', 'Closed', 'Done', 'Removed'], extraFields: [],
  states: { Bug: ['New', 'Active', 'Resolved', 'Closed'], Issue: ['New', 'Active', 'Resolved', 'Closed'] },
  severities: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'], priorities: [1, 2, 3, 4],
  categories: [
    { id: 'quick-wins', label: 'Quick wins', icon: '⚡', color: '#3f9a63', notStates: ['Resolved', 'Closed'], any: [{ tags: ['Quick Win'] }, { maxEffort: 2 }] },
    { id: 'in-progress', label: 'In progress', icon: '▶', color: '#4a7fc4', any: [{ states: ['Active'] }, { boardColumns: ['Dev In Progress'] }] },
    { id: 'version', label: 'Team branch {value}', icon: '🌿', color: '#c98a12', eachTag: '^\\d+(\\.\\d+){1,3}$' },
  ],
  analysis: { model: 'haiku', maxTokens: 500, effort: 'low' }, me: '', powershell: '',
} as unknown as BugsConfig

const draft = (team = { developers: ['Ann Bee'], areas: ['Proj\\Pay\\*'] }) => startDraft(DEFAULTS, team)
const field = (key: string) => FIELDS.find(f => f.path.join('.') === key)!
const ok = <T extends object>(r: T | { error: string }): T => {
  if ('error' in r) throw new Error(r.error)
  return r
}

test('the draft starts from the files, is dirty once edited, and reverts', () => {
  const d = draft()
  expect(d.now).toEqual(d.base)
  expect(d.now.developers).toEqual(['Ann Bee'])
  expect(isDirty(d)).toBe(false)
  expect(isDirty(null)).toBe(false)
  const edited = { ...d, now: setAt(d.now, ['bugs', 'query', 'top'], 50) }
  expect(isDirty(edited)).toBe(true)
  expect(getAt(edited.now, ['bugs', 'query', 'top'])).toBe(50)
  expect(getAt(edited.base, ['bugs', 'query', 'top'])).toBe(1000)                       // the base is left alone
  expect(edited.now.bugs.query.projects).toBe(d.now.bugs.query.projects)                // and what was not edited is shared
  expect(isDirty(revertDraft(edited))).toBe(false)
  expect(startDraft(DEFAULTS, null).now).toMatchObject({ developers: [], areas: [] })
})

test('every setting is somewhere: in a section, with a path the settings have', () => {
  const ids = SECTIONS.map(s => s.id)
  expect(new Set(ids).size).toBe(ids.length)
  const d = draft()
  for (const f of FIELDS) {
    expect(ids.includes(f.section)).toBe(true)
    expect(getAt(d.now, f.path)).not.toBe(undefined)                                    // the defaults give each one a value
    if (f.kind === 'select') expect(f.options!.includes(String(getAt(d.now, f.path)))).toBe(true)
  }
  expect(new Set(FIELDS.map(f => f.path.join('.'))).size).toBe(FIELDS.length)
  expect(fieldsOf('team').map(f => f.label)).toEqual(['Developers', 'Area paths', 'File'])
})

test('lists: what is typed is split, each once, case aside; numbers are whole; area paths take a slash', () => {
  expect(parseList('a, B;c\n a ,, ')).toEqual(['a', 'B', 'c'])
  expect(parseNumber('42')).toBe(42)
  expect(parseNumber('4.5')).toBe(null)
  expect(parseNumber('x')).toBe(null)
  expect(parseNumber('0', 1, 10)).toBe(null)
  expect(areaPath(' Proj/Pay/* ')).toBe('Proj\\Pay\\*')
  let s = draft().now
  s = ok(addToField(s, field('developers'), 'raj patel, ann bee, Bob'))
    .settings
  expect(s.developers).toEqual(['Ann Bee', 'raj patel', 'Bob'])                           // Ann Bee was there: once
  s = ok(addToField(s, field('areas'), 'Proj/Login; Proj\\Pay\\*')).settings
  expect(s.areas).toEqual(['Proj\\Pay\\*', 'Proj\\Login'])
  s = ok(addToField(s, field('bugs.priorities'), '5, 6')).settings
  expect(s.bugs.priorities).toEqual([1, 2, 3, 4, 5, 6])
  expect('error' in addToField(s, field('bugs.priorities'), 'high')).toBe(true)
  expect('error' in addToField(s, field('developers'), ' , ')).toBe(true)
  expect(removeFromField(s, field('developers'), 'raj patel').developers).toEqual(['Ann Bee', 'Bob'])
  expect(removeFromField(s, field('bugs.priorities'), 1).bugs.priorities).toEqual([2, 3, 4, 5, 6])
})

test('a number, a text and a choice are set from what is typed, or refused', () => {
  const s = draft().now
  expect(ok(setField(s, field('bugs.query.top'), '250')).settings.bugs.query.top).toBe(250)
  expect('error' in setField(s, field('bugs.query.top'), '0')).toBe(true)
  expect('error' in setField(s, field('bugs.query.top'), '99999')).toBe(true)
  expect('error' in setField(s, field('bugs.query.top'), 'many')).toBe(true)
  expect(ok(setField(s, field('bugs.analysis.model'), 'sonnet')).settings.bugs.analysis.model).toBe('sonnet')
  expect('error' in setField(s, field('bugs.analysis.model'), 'gpt')).toBe(true)
  expect(ok(setField(s, field('bugs.me'), '  me@x.co ')).settings.bugs.me).toBe('me@x.co')
  expect(ok(setField(s, field('bugs.query.where'), '')).settings.bugs.query.where).toBe('')
})

test('rules: each key is read as its kind, and a wrong value is refused', () => {
  let c = {} as Record<string, unknown>
  c = ok(setConditionKey(c, 'states', 'Active, In Progress')).cond as never
  c = ok(setConditionKey(c as never, 'priority', '1, 2')).cond as never
  c = ok(setConditionKey(c as never, 'maxEffort', '2')).cond as never
  c = ok(setConditionKey(c as never, 'assigned', 'me')).cond as never
  c = ok(setConditionKey(c as never, 'hasPullRequest', 'no')).cond as never
  c = ok(setConditionKey(c as never, 'titleMatches', 'crash|hang')).cond as never
  expect(c).toEqual({ states: ['Active', 'In Progress'], priority: [1, 2], maxEffort: 2, assigned: 'me', hasPullRequest: false, titleMatches: 'crash|hang' })
  expect(conditionText(c as never, 'states')).toBe('Active, In Progress')
  expect(conditionText(c as never, 'hasPullRequest')).toBe('no')
  expect(conditionText(c as never, 'priority')).toBe('1, 2')
  expect(conditionRows(c as never).map(r => r.spec.key)).toEqual(['states', 'priority', 'assigned', 'maxEffort', 'titleMatches', 'hasPullRequest'])   // the panel's order
  expect('error' in setConditionKey({}, 'priority', 'high')).toBe(true)
  expect('error' in setConditionKey({}, 'maxEffort', '-1')).toBe(true)
  expect('error' in setConditionKey({}, 'assigned', 'everyone')).toBe(true)
  expect('error' in setConditionKey({}, 'titleMatches', '(')).toBe(true)
  expect('error' in setConditionKey({}, 'nonsense', 'x')).toBe(true)
  expect(removeConditionKey(c as never, 'states')).not.toHaveProperty('states')
  expect(freeKeys({ states: ['a'] }).map(k => k.key)).not.toContain('states')
  expect(freeKeys({}).length).toBe(CONDITION_KEYS.length)
  // a new rule starts as nothing yet, which the draft will not let be saved
  expect(seedFor(CONDITION_KEYS.find(k => k.key === 'states')!)).toEqual([])
  expect(seedFor(CONDITION_KEYS.find(k => k.key === 'hasCommits')!)).toBe(true)
  expect(seedFor(CONDITION_KEYS.find(k => k.key === 'assigned')!)).toBe('me')
})

test('a rule is told in words', () => {
  expect(describeCondition({})).toBe('any item')
  expect(describeCondition({ notStates: ['Resolved', 'Closed'], maxEffort: 2 })).toBe('State is none of Resolved, Closed; Effort is at most 2')
  const [quick, progress, version] = DEFAULTS.categories as BugCategory[]
  expect(describeCategory(quick)).toBe('State is none of Resolved, Closed; and one of: (Has any of these tags Quick Win) or (Effort is at most 2)')
  expect(describeCategory(progress)).toBe('and one of: (State is one of Active) or (Board column is one of Dev In Progress)')
  expect(describeCategory(version)).toBe('one chip for each tag matching ^\\d+(\\.\\d+){1,3}$')
  expect(describeCategory({ id: 'x', label: 'X' })).toBe('any item')
})

test('categories: add (an id of its own), move, remove, rename, and edit a rule or an alternative', () => {
  expect(newCategoryId('Quick wins!', ['quick-wins'])).toBe('quick-wins-2')
  expect(newCategoryId('  ', [])).toBe('category')
  let s = draft().now
  const added = ok(addCategory(s, 'Needs QA'))
  expect(added.id).toBe('needs-qa')
  s = added.settings
  expect(s.bugs.categories.map(c => c.id)).toEqual(['quick-wins', 'in-progress', 'version', 'needs-qa'])
  expect(s.bugs.categories[3]).toMatchObject({ label: 'Needs QA', icon: '●' })
  expect('error' in addCategory(s, '   ')).toBe(true)
  s = moveCategory(s, 'needs-qa', -1)
  expect(s.bugs.categories.map(c => c.id)).toEqual(['quick-wins', 'in-progress', 'needs-qa', 'version'])
  expect(moveCategory(s, 'quick-wins', -1)).toBe(s)                                      // at the top: nothing moves
  expect(moveCategory(s, 'version', 1)).toBe(s)
  s = removeCategory(s, 'in-progress')
  expect(s.bugs.categories.map(c => c.id)).toEqual(['quick-wins', 'needs-qa', 'version'])
  s = ok(setCategoryText(s, 'needs-qa', 'label', 'Waiting for QA')).settings
  s = ok(setCategoryText(s, 'needs-qa', 'color', '#8a73c9')).settings
  s = ok(setCategoryText(s, 'needs-qa', 'icon', '🧪')).settings
  expect(s.bugs.categories[1]).toMatchObject({ id: 'needs-qa', label: 'Waiting for QA', color: '#8a73c9', icon: '🧪' })
  expect('error' in setCategoryText(s, 'needs-qa', 'label', ' ')).toBe(true)
  expect('error' in setCategoryText(s, 'needs-qa', 'color', 'green')).toBe(true)
  expect('error' in setCategoryText(s, 'version', 'eachTag', '(')).toBe(true)
  expect(ok(setCategoryText(s, 'needs-qa', 'color', '')).settings.bugs.categories[1]).not.toHaveProperty('color')   // empty clears an optional one
  // the rule: the category's own, then its alternatives
  let cat = s.bugs.categories[1]
  cat = withCondition(cat, null, ok(setConditionKey(conditionOf(cat, null), 'states', 'Resolved')).cond)
  cat = addAlternative(cat)
  cat = withCondition(cat, 0, ok(setConditionKey(conditionOf(cat, 0), 'tags', 'Needs QA')).cond)
  cat = addAlternative(cat)
  expect(cat).toMatchObject({ id: 'needs-qa', label: 'Waiting for QA', states: ['Resolved'], any: [{ tags: ['Needs QA'] }, {}] })
  expect(conditionOf(cat, null)).toEqual({ states: ['Resolved'] })                       // no id, label or alternatives in it
  expect(conditionOf(cat, 1)).toEqual({})
  cat = removeAlternative(cat, 1)
  expect(cat.any).toEqual([{ tags: ['Needs QA'] }])
  expect(removeAlternative(cat, 0)).not.toHaveProperty('any')
  expect(describeCategory(cat)).toBe('State is one of Resolved; and one of: (Has any of these tags Needs QA)')
})

test('what stops a draft from being saved', () => {
  expect(settingsProblems(draft().now)).toEqual([])
  let s = draft().now
  s = setAt(s, ['bugs', 'query', 'top'], 0)
  s = setAt(s, ['bugs', 'analysis', 'effort'], 'extreme')
  s = setAt(s, ['bugs', 'developersFile'], ' ')
  expect(settingsProblems(s)).toEqual(expect.arrayContaining([
    expect.stringContaining('At most: a whole number'), expect.stringContaining('Effort: pick one of'), 'Dev team file: where is it?']))
  let c = ok(addCategory(draft().now, 'Mine')).settings
  c = setAt(c, ['bugs', 'categories'], [
    ...c.bugs.categories,
    { id: 'mine', label: 'Again', color: 'red', states: [], any: [{}, { tags: [] }] },
  ] as BugCategory[])
  const problems = settingsProblems(c)
  expect(problems).toEqual(expect.arrayContaining([
    'Category "Again": two categories have the id mine.',
    'Category "Again": the colour is #rrggbb.',
    'Category "Again": "State is one of" has no values.',
    'Category "Again": alternative 1 has no rules, so it matches everything.',
    'Category "Again", alternative 2: "Has any of these tags" has no values.',
  ]))
})

test('what is written: only what the panel changed, only where it differs from the plugin\'s own, nothing else touched', () => {
  const sdd = { specRoot: 'docs/spec', ado: { org: 'Org', projects: ['P'] }, bugs: { me: 'me@x.co', query: { top: 50, where: 'x' } } }
  let d = draft()
  expect(applyToSdd(sdd, d, DEFAULTS)).toEqual(sdd)                                      // nothing changed: nothing written
  // a changed key is written; an untouched override stays; an object is merged key by key
  d = { ...d, now: setAt(setAt(d.now, ['bugs', 'query', 'top'], 250), ['bugs', 'doneStates'], ['Closed']) }
  let out = applyToSdd(sdd, d, DEFAULTS) as { bugs: Record<string, unknown>; specRoot: string; ado: unknown }
  expect(out.bugs).toEqual({ me: 'me@x.co', query: { top: 250, where: 'x' }, doneStates: ['Closed'] })
  expect(out.specRoot).toBe('docs/spec')
  expect(out.ado).toEqual(sdd.ado)
  expect(sdd.bugs.query.top).toBe(50)                                                    // the input is not changed
  // set back to the plugin's own value: the override goes, so a plugin update still reaches it
  const base = startDraft(bugsConfig(DEFAULTS, sdd.bugs), null)
  const back = { base: base.base, now: setAt(setAt(base.now, ['bugs', 'query', 'top'], 1000), ['bugs', 'me'], '') }
  expect(applyToSdd(sdd, back, DEFAULTS).bugs).toEqual({ query: { where: 'x' } })
  // the last override gone: no empty "bugs" left
  const gone = { base: base.base, now: setAt(setAt(setAt(base.now, ['bugs', 'query', 'top'], 1000), ['bugs', 'me'], ''), ['bugs', 'query', 'where'], '') }
  expect(applyToSdd(sdd, gone, DEFAULTS)).toEqual({ specRoot: 'docs/spec', ado: sdd.ado })
  // a file with no bugs key, or no file at all
  expect(applyToSdd({ specRoot: 'x' }, d, DEFAULTS)).toEqual({ specRoot: 'x', bugs: { query: { top: 250 }, doneStates: ['Closed'] } })
  expect(applyToSdd(null, d, DEFAULTS)).toEqual({ bugs: { query: { top: 250 }, doneStates: ['Closed'] } })
  // categories are a list: written whole
  const cats = ok(addCategory(d.now, 'Needs QA')).settings
  out = applyToSdd({}, { base: d.base, now: cats }, DEFAULTS) as never
  expect((out.bugs.categories as BugCategory[]).map(c => c.id)).toEqual(['quick-wins', 'in-progress', 'version', 'needs-qa'])
})

test('what the panel wrote reads back as what the panel showed', () => {
  // the invariant: the settings read from the saved file, through the pane's own merge, are the draft's
  const sdd = { specRoot: 'docs/spec', bugs: { query: { top: 50 }, analysis: { model: 'sonnet' } } }
  const effective = bugsConfig(DEFAULTS, sdd.bugs)
  let d = startDraft(effective, null)
  let s = d.now
  s = setAt(s, ['bugs', 'query', 'projects'], ['Spesnet.Lumina', 'HealthCodeIndex_V2'])
  s = setAt(s, ['bugs', 'query', 'top'], 1000)                                            // back to the plugin's own
  s = setAt(s, ['bugs', 'analysis', 'maxTokens'], 800)
  s = setAt(s, ['bugs', 'states', 'Bug'], ['New', 'Active', 'Approved', 'Resolved'])
  s = ok(addCategory(s, 'Waiting for QA')).settings
  s = moveCategory(s, 'waiting-for-qa', -1)
  s = removeCategory(s, 'in-progress')
  d = { ...d, now: s }
  const written = applyToSdd(sdd, d, DEFAULTS) as { bugs: unknown }
  expect(bugsConfig(DEFAULTS, written.bugs)).toEqual(d.now.bugs)
  // and again from what was written, with nothing changed: nothing more to write
  const next = startDraft(bugsConfig(DEFAULTS, written.bugs), null)
  expect(applyToSdd(written, next, DEFAULTS)).toEqual(written)
})

test('the dev team file: the developers and the area paths, its other keys kept', () => {
  let d = draft({ developers: ['Ann Bee'], areas: ['Proj\\Pay'] })
  d = { ...d, now: { ...d.now, developers: ['Ann Bee', 'Raj Patel'], areas: ['Proj\\Pay', 'Proj\\Pay\\Core\\*'] } }
  expect(applyToDevelopers({ areaPath: 'Proj\\Pay', developers: ['Ann Bee'], note: 'keep me' }, d))
    .toEqual({ areaPath: 'Proj\\Pay; Proj\\Pay\\Core\\*', developers: ['Ann Bee', 'Raj Patel'], note: 'keep me' })
  expect(applyToDevelopers(['Ann Bee'], d)).toEqual({ developers: ['Ann Bee', 'Raj Patel'], areaPath: 'Proj\\Pay; Proj\\Pay\\Core\\*' })   // a plain list becomes an object
  expect(applyToDevelopers(null, d)).toEqual({ developers: ['Ann Bee', 'Raj Patel'], areaPath: 'Proj\\Pay; Proj\\Pay\\Core\\*' })
  d = { ...d, now: { ...d.now, areas: [] } }
  expect(applyToDevelopers({ areaPath: 'Proj', developers: [] }, d)).toEqual({ developers: ['Ann Bee', 'Raj Patel'] })        // no area paths: no key, no limit
  // which files are written
  expect(filesToWrite(draft())).toEqual({ sdd: false, developers: false })
  expect(filesToWrite({ ...draft(), now: setAt(draft().now, ['bugs', 'me'], 'x') })).toEqual({ sdd: true, developers: false })
  expect(filesToWrite({ ...d, base: draft().base })).toEqual({ sdd: false, developers: true })
  // moving the file writes the team to its new place, and says so in sdd.json
  const moved = { ...draft(), now: setAt(draft().now, ['bugs', 'developersFile'], '.claude/team.json') }
  expect(filesToWrite(moved)).toEqual({ sdd: true, developers: true })
  expect(applyToSdd({}, moved, DEFAULTS)).toEqual({ bugs: { developersFile: '.claude/team.json' } })
})

test('a section says it changed, and a change to what Sync pulls says it needs a Sync', () => {
  const d = draft()
  expect(sectionDirty(d, 'sync')).toBe(false)
  expect(needsSync(d)).toBe(false)
  const top = { ...d, now: setAt(d.now, ['bugs', 'query', 'top'], 5) }
  expect([sectionDirty(top, 'sync'), sectionDirty(top, 'team'), sectionDirty(top, 'categories'), needsSync(top)]).toEqual([true, false, false, true])
  const dev = { ...d, now: setAt(d.now, ['developers'], ['Raj Patel']) }
  expect([sectionDirty(dev, 'team'), needsSync(dev)]).toEqual([true, false])               // the team shows at once
  const cat = { ...d, now: ok(addCategory(d.now, 'More')).settings }
  expect([sectionDirty(cat, 'categories'), needsSync(cat)]).toEqual([true, false])
  expect(sectionDirty(null, 'sync')).toBe(false)
  expect(needsSync(null)).toBe(false)
})

test('changes are counted, and a section goes back to the plugin\'s own', () => {
  let d = draft()
  expect(changeCount(d)).toBe(0)
  expect(changeCount(null)).toBe(0)
  d = { ...d, now: setAt(setAt(d.now, ['bugs', 'query', 'top'], 5), ['developers'], ['Ann Bee', 'Raj Patel']) }
  d = { ...d, now: ok(addCategory(d.now, 'More')).settings }
  expect(changeCount(d)).toBe(3)                                                          // two settings and the categories
  const reset = resetSection(d.now, DEFAULTS, 'sync')
  expect(reset.bugs.query.top).toBe(1000)
  expect(reset.developers).toEqual(['Ann Bee', 'Raj Patel'])                              // another section: untouched
  expect(resetSection(d.now, DEFAULTS, 'categories').bugs.categories).toEqual(DEFAULTS.categories)
  expect(resetSection(d.now, DEFAULTS, 'team')).toMatchObject({ developers: [], areas: [] })
  expect(resetSection(d.now, DEFAULTS, 'team').bugs.developersFile).toBe('.claude/developers.json')
})
