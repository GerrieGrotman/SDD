// Pure helpers of the bug manager's settings panel: which settings there are, how an edit is read, what is wrong with a
// draft, and how a draft is merged into .claude/sdd.json and the dev team file. No engine calls, so bugs.test.ts runs them as
// they are. register.tsx draws the panel and does the reading and writing of the files.
import type { BugCategory, BugCondition, BugSettings, BugSettingsDraft, BugsConfig, BugTeam } from '../../types'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const low = (s: string) => s.trim().toLowerCase()

// ---------------------------------------------------------------- the draft

export function settingsOf(cfg: BugsConfig, team: BugTeam | null): BugSettings {
  return clone({ bugs: cfg, developers: team?.developers ?? [], areas: team?.areas ?? [] })
}

export function startDraft(cfg: BugsConfig, team: BugTeam | null): BugSettingsDraft {
  const base = settingsOf(cfg, team)
  return { base, now: clone(base) }
}

export function isDirty(d: BugSettingsDraft | null): boolean {
  return !!d && !same(d.base, d.now)
}

export function revertDraft(d: BugSettingsDraft): BugSettingsDraft {
  return { base: d.base, now: clone(d.base) }
}

/** Reads a value of the settings by its path (`['bugs', 'query', 'top']`). */
export function getAt(s: BugSettings, path: readonly string[]): unknown {
  let v: unknown = s
  for (const k of path) v = isObj(v) ? v[k] : undefined
  return v
}

/** The settings with one value set, the rest shared as they were. */
export function setAt(s: BugSettings, path: readonly string[], value: unknown): BugSettings {
  const go = (node: unknown, i: number): unknown => {
    if (i === path.length) return value
    const o = isObj(node) ? node : {}
    return { ...o, [path[i]]: go(o[path[i]], i + 1) }
  }
  return go(s, 0) as BugSettings
}

// ---------------------------------------------------------------- the plain settings

export type FieldKind = 'list' | 'numlist' | 'number' | 'text' | 'select'

export type Field = {
  /** The section it is under. */
  section: string
  /** Where it is in BugSettings. */
  path: string[]
  label: string
  kind: FieldKind
  options?: string[]
  /** Numbers: the range. */
  min?: number
  max?: number
  /** One line of what it does. */
  help: string
  /** A change needs a Sync to show: what Sync pulls. */
  needsSync?: boolean
}

export const SECTIONS: Array<{ id: string; label: string; where: string; help: string }> = [
  { id: 'team', label: 'Dev team', where: 'developers.json', help: 'Who the Dev team filter shows, and the area paths everything shown must be under.' },
  { id: 'sync', label: 'What Sync pulls', where: 'sdd.json', help: 'Which bugs and issues Sync reads from ADO. A change shows after the next Sync.' },
  { id: 'categories', label: 'Categories', where: 'sdd.json', help: 'The chips that sort the list. Each is a rule on the items.' },
  { id: 'pickers', label: 'Filters and pickers', where: 'sdd.json', help: 'The states Hide resolved/closed hides, and what the triage pickers offer.' },
  { id: 'analysis', label: 'Probable cause', where: 'sdd.json', help: 'The model call behind Find probable cause.' },
  { id: 'other', label: 'You and PowerShell', where: 'sdd.json', help: 'Who you are in ADO, and which PowerShell runs the scripts.' },
]

export const FIELDS: Field[] = [
  { section: 'team', path: ['developers'], label: 'Developers', kind: 'list', help: 'Display names as ADO shows them, or e-mails. The Dev team filter shows their items.' },
  { section: 'team', path: ['areas'], label: 'Area paths', kind: 'list', help: 'Everything shown is under one of them, whatever the filters say. A is that area only; A\\B\\* is that area and everything under it. None: no limit.' },
  { section: 'team', path: ['bugs', 'developersFile'], label: 'File', kind: 'text', help: 'Where the dev team file is, from the workspace root.' },
  { section: 'sync', path: ['bugs', 'query', 'projects'], label: 'Projects', kind: 'list', needsSync: true, help: 'None: the projects in ado.projects of sdd.json.' },
  { section: 'sync', path: ['bugs', 'types'], label: 'Work item types', kind: 'list', needsSync: true, help: 'Bug and Issue by default.' },
  { section: 'sync', path: ['bugs', 'query', 'excludeStates'], label: 'Leave out these states', kind: 'list', needsSync: true, help: 'Items in them are not pulled.' },
  { section: 'sync', path: ['bugs', 'query', 'areaPaths'], label: 'Only these area paths (UNDER)', kind: 'list', needsSync: true, help: 'None: every area of the projects.' },
  { section: 'sync', path: ['bugs', 'query', 'iterationPaths'], label: 'Only these iteration paths (UNDER)', kind: 'list', needsSync: true, help: 'None: every iteration.' },
  { section: 'sync', path: ['bugs', 'query', 'where'], label: 'More WIQL', kind: 'text', needsSync: true, help: 'A clause added with AND, e.g. [Microsoft.VSTS.Common.Priority] <= 2.' },
  { section: 'sync', path: ['bugs', 'query', 'top'], label: 'At most', kind: 'number', min: 1, max: 20000, needsSync: true, help: 'The most items one Sync reads per project.' },
  { section: 'sync', path: ['bugs', 'extraFields'], label: 'Keep these fields', kind: 'list', needsSync: true, help: 'ADO reference names a category rule can look at (rule "field").' },
  { section: 'pickers', path: ['bugs', 'doneStates'], label: 'Resolved and closed states', kind: 'list', help: 'The states Hide resolved/closed hides.' },
  { section: 'pickers', path: ['bugs', 'states', 'Bug'], label: 'States of a Bug', kind: 'list', help: 'The State picker of a Bug.' },
  { section: 'pickers', path: ['bugs', 'states', 'Issue'], label: 'States of an Issue', kind: 'list', help: 'The State picker of an Issue.' },
  { section: 'pickers', path: ['bugs', 'severities'], label: 'Severities', kind: 'list', help: 'The Severity picker, as ADO spells them: 2 - High.' },
  { section: 'pickers', path: ['bugs', 'priorities'], label: 'Priorities', kind: 'numlist', help: 'The Priority picker.' },
  { section: 'analysis', path: ['bugs', 'analysis', 'model'], label: 'Model', kind: 'select', options: ['haiku', 'sonnet', 'opus'], help: 'haiku is the cheapest; opus is the most careful.' },
  { section: 'analysis', path: ['bugs', 'analysis', 'maxTokens'], label: 'Answer at most (tokens)', kind: 'number', min: 100, max: 4000, help: 'The longest probable cause it writes.' },
  { section: 'analysis', path: ['bugs', 'analysis', 'effort'], label: 'Effort', kind: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max'], help: 'How hard it thinks: more costs more.' },
  { section: 'other', path: ['bugs', 'me'], label: 'Your ADO e-mail', kind: 'text', help: 'For Assigned to me, when git config user.email is not it.' },
  { section: 'other', path: ['bugs', 'powershell'], label: 'PowerShell', kind: 'text', help: 'The program that runs the scripts. None: pwsh, else powershell.' },
]

export function fieldsOf(section: string): Field[] {
  return FIELDS.filter(f => f.section === section)
}

export const fieldKey = (f: Field) => f.path.join('.')

/** A value as the text of its field: a list is its items one by one, so this is for a number, a text or a choice. */
export function valueText(v: unknown): string {
  return v == null ? '' : String(v)
}

/** Text typed for a list, in pieces: split at a comma, a semicolon or a new line; blank and repeated pieces (case aside) are dropped. */
export function parseList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[,;\n]/)) {
    const t = part.trim()
    if (t && !seen.has(low(t))) {
      seen.add(low(t))
      out.push(t)
    }
  }
  return out
}

/** An area path as the dev team file keeps it: forward slashes become backslashes. */
export function areaPath(text: string): string {
  return text.trim().replace(/\//g, '\\')
}

export function parseNumber(text: string, min = -Infinity, max = Infinity): number | null {
  const t = text.trim()
  if (!/^-?\d+$/.test(t)) return null
  const n = Number(t)
  return n >= min && n <= max ? n : null
}

/** Adds what was typed to a list field: several at once (a, b), each once. Says why when nothing could be added. */
export function addToField(s: BugSettings, f: Field, text: string): { settings: BugSettings } | { error: string } {
  const have = (getAt(s, f.path) as unknown[] | undefined) ?? []
  let pieces = parseList(text)
  if (f.kind === 'numlist') {
    const nums = pieces.map(p => parseNumber(p))
    if (nums.some(n => n == null)) return { error: `${f.label}: type whole numbers.` }
    pieces = nums.map(String)
  }
  if (f.path.join('.') === 'areas') pieces = pieces.map(areaPath)
  if (!pieces.length) return { error: `${f.label}: type something to add.` }
  const out = [...have]
  for (const p of pieces) {
    const v = f.kind === 'numlist' ? Number(p) : p
    if (!out.some(x => low(String(x)) === low(String(v)))) out.push(v)
  }
  return { settings: setAt(s, f.path, out) }
}

export function removeFromField(s: BugSettings, f: Field, value: string | number): BugSettings {
  const have = (getAt(s, f.path) as unknown[] | undefined) ?? []
  return setAt(s, f.path, have.filter(x => String(x) !== String(value)))
}

/** Sets a number, a text or a choice from what was typed. */
export function setField(s: BugSettings, f: Field, text: string): { settings: BugSettings } | { error: string } {
  if (f.kind === 'number') {
    const n = parseNumber(text, f.min, f.max)
    return n == null ? { error: `${f.label}: a whole number from ${f.min ?? 0} to ${f.max ?? 'any'}.` } : { settings: setAt(s, f.path, n) }
  }
  if (f.kind === 'select') {
    return f.options?.includes(text) ? { settings: setAt(s, f.path, text) } : { error: `${f.label}: pick one of ${f.options?.join(', ')}.` }
  }
  return { settings: setAt(s, f.path, text.trim()) }
}

// ---------------------------------------------------------------- categories

export type ConditionKey = { key: keyof BugCondition; label: string; kind: 'list' | 'numlist' | 'number' | 'text' | 'choice'; options?: string[]; help: string }

/** What a category rule can look at, in the order the panel offers them. Every key given must hold. */
export const CONDITION_KEYS: ConditionKey[] = [
  { key: 'states', label: 'State is one of', kind: 'list', help: 'Active, In Progress' },
  { key: 'notStates', label: 'State is none of', kind: 'list', help: 'Resolved, Closed' },
  { key: 'types', label: 'Type is one of', kind: 'list', help: 'Bug' },
  { key: 'boardColumns', label: 'Board column is one of', kind: 'list', help: 'Dev In Progress' },
  { key: 'tags', label: 'Has any of these tags', kind: 'list', help: 'Quick Win, QuickWin' },
  { key: 'allTags', label: 'Has all of these tags', kind: 'list', help: 'Cosmetic, Rule C' },
  { key: 'severity', label: 'Severity starts with', kind: 'list', help: '1, 2 (for 1 - Critical and 2 - High)' },
  { key: 'priority', label: 'Priority is one of', kind: 'numlist', help: '1, 2' },
  { key: 'assigned', label: 'Assigned', kind: 'choice', options: ['me', 'none', 'anyone'], help: 'to me, to nobody, or to anyone' },
  { key: 'areaUnder', label: 'Area is under', kind: 'list', help: 'Proj\\Payments' },
  { key: 'iterationUnder', label: 'Iteration is under', kind: 'list', help: 'Proj\\Sprint 20' },
  { key: 'maxEffort', label: 'Effort is at most', kind: 'number', help: '2' },
  { key: 'minEffort', label: 'Effort is at least', kind: 'number', help: '5' },
  { key: 'titleMatches', label: 'Title matches (regex)', kind: 'text', help: 'crash|hang' },
  { key: 'hasPullRequest', label: 'Has a pull request', kind: 'choice', options: ['yes', 'no'], help: 'yes or no' },
  { key: 'hasCommits', label: 'Has commits', kind: 'choice', options: ['yes', 'no'], help: 'yes or no' },
  { key: 'olderThanDays', label: 'Created more than (days) ago', kind: 'number', help: '30' },
  { key: 'newerThanDays', label: 'Created within (days)', kind: 'number', help: '7' },
]

const KEY = (k: string) => CONDITION_KEYS.find(c => c.key === k)

/** One condition key's value, as the text its field shows. */
export function conditionText(c: BugCondition, key: string): string {
  const v = (c as Record<string, unknown>)[key]
  const spec = KEY(key)
  if (spec?.kind === 'choice' && typeof v === 'boolean') return v ? 'yes' : 'no'
  return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)
}

/** The keys a condition has, in the panel's order, with their text. */
export function conditionRows(c: BugCondition): Array<{ spec: ConditionKey; text: string }> {
  return CONDITION_KEYS.filter(k => k.key in c).map(spec => ({ spec, text: conditionText(c, spec.key) }))
}

/** The keys a condition does not have yet: what "Add a rule" offers. */
export function freeKeys(c: BugCondition): ConditionKey[] {
  return CONDITION_KEYS.filter(k => !(k.key in c))
}

/** What a new rule starts as: no values yet (the draft is not valid until it has some), or the first choice. */
export function seedFor(spec: ConditionKey): unknown {
  return spec.kind === 'list' || spec.kind === 'numlist' ? [] : spec.kind === 'number' ? 0 : spec.kind === 'choice' ? (spec.options![0] === 'yes' ? true : spec.options![0]) : ''
}

/** Sets one rule of a condition from what was typed, or says what was wrong with it. */
export function setConditionKey(c: BugCondition, key: string, text: string): { cond: BugCondition } | { error: string } {
  const spec = KEY(key)
  if (!spec) return { error: `${key}: not a rule` }
  const out = { ...c } as Record<string, unknown>
  if (spec.kind === 'list') out[key] = parseList(text)
  else if (spec.kind === 'numlist') {
    const nums = parseList(text).map(p => parseNumber(p))
    if (nums.some(n => n == null)) return { error: `${spec.label}: type whole numbers, like 1, 2.` }
    out[key] = nums
  } else if (spec.kind === 'number') {
    const n = parseNumber(text, 0)
    if (n == null) return { error: `${spec.label}: a whole number, 0 or more.` }
    out[key] = n
  } else if (spec.kind === 'choice') {
    if (!spec.options!.includes(text)) return { error: `${spec.label}: pick one of ${spec.options!.join(', ')}.` }
    out[key] = spec.options![0] === 'yes' ? text === 'yes' : text
  } else {
    if (key === 'titleMatches') {
      try {
        new RegExp(text, 'i')
      } catch {
        return { error: `${spec.label}: that is not a valid pattern.` }
      }
    }
    out[key] = text.trim()
  }
  return { cond: out as BugCondition }
}

export function removeConditionKey(c: BugCondition, key: string): BugCondition {
  const out = { ...c } as Record<string, unknown>
  delete out[key]
  return out as BugCondition
}

/** A condition in words: "State is none of Resolved, Closed; Has any of these tags Quick Win". */
export function describeCondition(c: BugCondition): string {
  const rows = conditionRows(c)
  return rows.length ? rows.map(r => `${r.spec.label} ${r.text || '…'}`).join('; ') : 'any item'
}

/** A category's rule in words, for its row in the list. */
export function describeCategory(cat: BugCategory): string {
  const { id: _id, label: _label, icon: _icon, color: _color, any, eachTag, eachField, ...base } = cat
  const parts: string[] = []
  if (eachTag) parts.push(`one chip for each tag matching ${eachTag}`)
  if (eachField) parts.push(`one chip for each value of ${eachField}`)
  const b = describeCondition(base as BugCondition)
  if (b !== 'any item' || (!any?.length && !eachTag && !eachField)) parts.push(b)
  if (any?.length) parts.push(`and one of: ${any.map(a => `(${describeCondition(a)})`).join(' or ')}`)
  return parts.join('; ')
}

export const CATEGORY_TEXT_FIELDS = ['label', 'icon', 'color', 'eachTag', 'eachField'] as const
export type CategoryTextField = (typeof CATEGORY_TEXT_FIELDS)[number]

/** An id nobody has: the label as a slug, then -2, -3. */
export function newCategoryId(label: string, have: readonly string[]): string {
  const base = low(label).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'category'
  let id = base
  for (let n = 2; have.includes(id); n++) id = `${base}-${n}`
  return id
}

export function addCategory(s: BugSettings, label: string): { settings: BugSettings; id: string } | { error: string } {
  const text = label.trim()
  if (!text) return { error: 'Type the new category\'s name first.' }
  const have = s.bugs.categories ?? []
  const id = newCategoryId(text, have.map(c => c.id))
  return { id, settings: setAt(s, ['bugs', 'categories'], [...have, { id, label: text, icon: '●', color: '#4a7fc4' }]) }
}

export function removeCategory(s: BugSettings, id: string): BugSettings {
  return setAt(s, ['bugs', 'categories'], (s.bugs.categories ?? []).filter(c => c.id !== id))
}

export function moveCategory(s: BugSettings, id: string, by: -1 | 1): BugSettings {
  const list = [...(s.bugs.categories ?? [])]
  const i = list.findIndex(c => c.id === id)
  const j = i + by
  if (i < 0 || j < 0 || j >= list.length) return s
  ;[list[i], list[j]] = [list[j], list[i]]
  return setAt(s, ['bugs', 'categories'], list)
}

/** Changes one category by id. */
export function updateCategory(s: BugSettings, id: string, change: (c: BugCategory) => BugCategory): BugSettings {
  return setAt(s, ['bugs', 'categories'], (s.bugs.categories ?? []).map(c => (c.id === id ? change(c) : c)))
}

/** Sets the label, icon, colour, tag pattern or field of a category; empty text removes the optional ones. */
export function setCategoryText(s: BugSettings, id: string, field: CategoryTextField, text: string): { settings: BugSettings } | { error: string } {
  const t = field === 'icon' ? text.trim() : text.trim()
  if (field === 'label' && !t) return { error: 'A category needs a name.' }
  if (field === 'color' && t && !/^#[0-9a-f]{6}$/i.test(t)) return { error: 'A colour is #rrggbb, like #3f9a63.' }
  if (field === 'eachTag' && t) {
    try {
      new RegExp(t, 'i')
    } catch {
      return { error: 'That is not a valid pattern.' }
    }
  }
  return {
    settings: updateCategory(s, id, c => {
      const out = { ...c } as Record<string, unknown>
      if (t) out[field] = t
      else delete out[field]
      return out as BugCategory
    }),
  }
}

/** The condition at a place of a category: the category's own rule (`null`) or one of its alternatives (`any`). */
export function conditionOf(c: BugCategory, alt: number | null): BugCondition {
  if (alt == null) {
    const { id: _id, label: _label, icon: _icon, color: _color, any: _any, eachTag: _eachTag, eachField: _eachField, ...base } = c
    return base as BugCondition
  }
  return c.any?.[alt] ?? {}
}

/** Replaces the condition at a place of a category. */
export function withCondition(c: BugCategory, alt: number | null, cond: BugCondition): BugCategory {
  if (alt == null) {
    const { id, label, icon, color, any, eachTag, eachField } = c
    const out: Record<string, unknown> = { ...cond, id, label }
    if (icon != null) out.icon = icon
    if (color != null) out.color = color
    if (any) out.any = any
    if (eachTag) out.eachTag = eachTag
    if (eachField) out.eachField = eachField
    return out as BugCategory
  }
  const any = [...(c.any ?? [])]
  any[alt] = cond
  return { ...c, any }
}

export function addAlternative(c: BugCategory): BugCategory {
  return { ...c, any: [...(c.any ?? []), {}] }
}

export function removeAlternative(c: BugCategory, alt: number): BugCategory {
  const any = (c.any ?? []).filter((_, i) => i !== alt)
  const out = { ...c }
  if (any.length) out.any = any
  else delete out.any
  return out
}

// ---------------------------------------------------------------- what is wrong with a draft

const conditionProblems = (where: string, c: BugCondition): string[] => {
  const out: string[] = []
  for (const r of conditionRows(c)) {
    const v = (c as Record<string, unknown>)[r.spec.key]
    if ((r.spec.kind === 'list' || r.spec.kind === 'numlist') && Array.isArray(v) && !v.length) out.push(`${where}: "${r.spec.label}" has no values.`)
    if (r.spec.kind === 'text' && !String(v ?? '').trim()) out.push(`${where}: "${r.spec.label}" is empty.`)
  }
  return out
}

/** Everything that stops a draft from being saved, in words. */
export function settingsProblems(s: BugSettings): string[] {
  const out: string[] = []
  for (const f of FIELDS) {
    const v = getAt(s, f.path)
    if (f.kind === 'number' && !(typeof v === 'number' && v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity))) out.push(`${f.label}: a whole number from ${f.min} to ${f.max}.`)
    if (f.kind === 'select' && !f.options?.includes(String(v))) out.push(`${f.label}: pick one of ${f.options?.join(', ')}.`)
    if (f.path.join('.') === 'bugs.developersFile' && !String(v ?? '').trim()) out.push('Dev team file: where is it?')
  }
  const ids = new Set<string>()
  for (const c of s.bugs.categories ?? []) {
    const where = `Category "${c.label || c.id}"`
    if (!c.id) out.push(`${where}: no id.`)
    if (ids.has(c.id)) out.push(`${where}: two categories have the id ${c.id}.`)
    ids.add(c.id)
    if (!c.label?.trim()) out.push(`${where}: a category needs a name.`)
    if (c.color && !/^#[0-9a-f]{6}$/i.test(c.color)) out.push(`${where}: the colour is #rrggbb.`)
    out.push(...conditionProblems(where, conditionOf(c, null)))
    ;(c.any ?? []).forEach((a, i) => {
      if (!conditionRows(a).length) out.push(`${where}: alternative ${i + 1} has no rules, so it matches everything.`)
      out.push(...conditionProblems(`${where}, alternative ${i + 1}`, a))
    })
  }
  return out
}

/** How many settings differ from the files: for the "N changes" the panel says. */
export function changeCount(d: BugSettingsDraft | null): number {
  if (!d) return 0
  let n = FIELDS.filter(f => !same(getAt(d.base, f.path), getAt(d.now, f.path))).length
  if (!same(d.base.bugs.categories, d.now.bugs.categories)) n++
  return n
}

/** Does the draft change something in this section? */
export function sectionDirty(d: BugSettingsDraft | null, section: string): boolean {
  if (!d) return false
  if (section === 'categories') return !same(d.base.bugs.categories, d.now.bugs.categories)
  return fieldsOf(section).some(f => !same(getAt(d.base, f.path), getAt(d.now, f.path)))
}

/** Does a change of the draft show only after the next Sync (what Sync pulls)? */
export function needsSync(d: BugSettingsDraft | null): boolean {
  return !!d && FIELDS.some(f => f.needsSync && !same(getAt(d.base, f.path), getAt(d.now, f.path)))
}

/** Puts a section's settings back to what the plugin ships. The dev team has no default: it is emptied. */
export function resetSection(s: BugSettings, defaults: BugsConfig, section: string): BugSettings {
  let out = s
  if (section === 'categories') return setAt(out, ['bugs', 'categories'], clone(defaults.categories))
  for (const f of fieldsOf(section)) {
    const v = f.path[0] === 'bugs' ? getAt({ bugs: defaults, developers: [], areas: [] }, f.path) : []
    out = setAt(out, f.path, clone(v ?? (f.kind === 'text' ? '' : [])))
  }
  return out
}

// ---------------------------------------------------------------- writing the files

/** The sdd.json with the `bugs` settings of the draft that differ from the file merged in: a setting is written only when it was
 *  changed in the panel, and left out when it now equals what the plugin ships, so a plugin update still reaches it. Every other key,
 *  and every `bugs` setting the panel did not touch, stays as it is. */
export function applyToSdd(sdd: unknown, d: BugSettingsDraft, defaults: BugsConfig): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(sdd) ? clone(sdd) : {}
  const bugs: Record<string, unknown> = isObj(out.bugs) ? { ...out.bugs } : {}
  const now = d.now.bugs as unknown as Record<string, unknown>
  const base = d.base.bugs as unknown as Record<string, unknown>
  const def = defaults as unknown as Record<string, unknown>
  for (const k of Object.keys(now)) {
    if (same(base[k], now[k])) continue
    if (isObj(now[k]) && isObj(def[k])) {
      // an object is merged key by key: write the keys that changed
      const cur: Record<string, unknown> = isObj(bugs[k]) ? { ...(bugs[k] as Record<string, unknown>) } : {}
      const b = isObj(base[k]) ? (base[k] as Record<string, unknown>) : {}
      const n = now[k] as Record<string, unknown>
      for (const sk of Object.keys(n)) {
        if (same(b[sk], n[sk])) continue
        if (same(n[sk], (def[k] as Record<string, unknown>)[sk])) delete cur[sk]
        else cur[sk] = n[sk]
      }
      if (Object.keys(cur).length) bugs[k] = cur
      else delete bugs[k]
    } else if (same(now[k], def[k])) {
      delete bugs[k]
    } else {
      bugs[k] = now[k]
    }
  }
  if (Object.keys(bugs).length) out.bugs = bugs
  else delete out.bugs
  return out
}

/** The dev team file with the draft's developers and area paths in it; its other keys stay. A plain list file becomes an object. */
export function applyToDevelopers(existing: unknown, d: BugSettingsDraft): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(existing) ? clone(existing) : {}
  out.developers = [...d.now.developers]
  if (d.now.areas.length) out.areaPath = d.now.areas.join('; ')
  else delete out.areaPath
  return out
}

/** What to write, if anything: the files that change. */
export function filesToWrite(d: BugSettingsDraft): { sdd: boolean; developers: boolean } {
  const bugsChanged = !same(d.base.bugs, d.now.bugs)
  // the dev team file is written too when it is moved: the new place gets the team
  const moved = d.base.bugs.developersFile !== d.now.bugs.developersFile
  return { sdd: bugsChanged, developers: moved || !same(d.base.developers, d.now.developers) || !same(d.base.areas, d.now.areas) }
}
