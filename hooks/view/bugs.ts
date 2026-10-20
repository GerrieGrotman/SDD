// Pure helpers of the bug manager (/sdd-bugs): its settings, the categories, the list's filters and order,
// the staged changes (stage, revert, keep mine), the links and the probable-cause prompt. No engine calls,
// so bugs.test.ts runs them as they are. The scripts in scripts/bugs/ do everything that touches ADO or git.
import type { BugAnalysis, BugCategory, BugChange, BugCondition, BugDetail, BugEvidence, BugFilter, BugIndex, BugPerson, BugRecord, BugsConfig, SddSnapshot } from '../../types'

export const F = {
  state: 'System.State',
  assigned: 'System.AssignedTo',
  area: 'System.AreaPath',
  iteration: 'System.IterationPath',
  severity: 'Microsoft.VSTS.Common.Severity',
  priority: 'Microsoft.VSTS.Common.Priority',
} as const

export const FIELD_NAME: Record<string, string> = {
  [F.state]: 'State', [F.assigned]: 'Assigned to', [F.area]: 'Area', [F.iteration]: 'Iteration',
  [F.severity]: 'Severity', [F.priority]: 'Priority',
}

export const NO_FILTER: BugFilter = { category: 'all', mine: false, hideDone: false, team: false, text: '', sort: 'priority', type: '', state: '' }

// ---------------------------------------------------------------- settings

/** sdd.json "bugs" over scripts/bugs/defaults.json: an object one level down is merged key by key, a list
 *  replaces the default whole (sddlib.merge_bugs and Merge-BugsConfig do the same). */
export function bugsConfig(defaults: BugsConfig, given: unknown): BugsConfig {
  const g = given && typeof given === 'object' && !Array.isArray(given) ? given as Record<string, unknown> : {}
  const out: Record<string, unknown> = { ...defaults, ...g }
  for (const [k, v] of Object.entries(defaults)) {
    const mine = g[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && mine && typeof mine === 'object' && !Array.isArray(mine)) out[k] = { ...v, ...mine }
  }
  return out as BugsConfig
}

/** A file's text as JSON: a BOM (Windows PowerShell 5.1 writes one) is dropped first. */
export function parseJson<T>(text: string): T {
  return JSON.parse(text.replace(/^﻿/, '')) as T
}

// ---------------------------------------------------------------- categories

const low = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()
const has = (list: readonly string[] | undefined, v: string) => (list ?? []).some(x => low(x) === low(v))
const under = (paths: readonly string[] | undefined, v: string) =>
  (paths ?? []).some(p => low(v) === low(p) || low(v).startsWith(low(p).replace(/\\+$/, '') + '\\'))

/** Is this the person running the view? By e-mail, else by name. */
export function isMine(item: BugRecord, me: BugPerson | null | undefined): boolean {
  const a = item.assigned
  if (!a || !me) return false
  if (me.email && a.email) return low(a.email) === low(me.email)
  return !!me.name && low(a.name) === low(me.name)
}

/** The developers of the dev team file: `{ "developers": [...] }` or a plain list; a name or an e-mail each; null when it holds none. */
export function parseTeam(text: string): string[] | null {
  let v: unknown
  try {
    v = parseJson<unknown>(text)
  } catch {
    return null
  }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? (v as { developers?: unknown }).developers : null
  if (!Array.isArray(list)) return null
  return list.map(x => typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as { email?: string; name?: string }).email ?? (x as { name?: string }).name ?? '') : '')
    .map(x => x.trim()).filter(Boolean)
}

/** Is the item assigned to a developer of the team? By display name or by e-mail, whatever the file lists, case aside. */
export function isTeam(item: BugRecord, team: readonly string[] | null | undefined): boolean {
  const a = item.assigned
  if (!a || !team?.length) return false
  const names = new Set(team.map(low))
  return names.has(low(a.name)) || (!!a.email && names.has(low(a.email)))
}

const DAY = 86_400_000

/** Does one rule hold for the item? Every key the rule gives must hold; a rule with no keys holds. */
export function conditionHolds(item: BugRecord, c: BugCondition, me: BugPerson | null | undefined, now = Date.now()): boolean {
  if (c.states && !has(c.states, item.state)) return false
  if (c.notStates && has(c.notStates, item.state)) return false
  if (c.types && !has(c.types, item.type)) return false
  if (c.boardColumns && !has(c.boardColumns, item.boardColumn)) return false
  if (c.tags && !c.tags.some(t => has(item.tags, t))) return false
  if (c.allTags && !c.allTags.every(t => has(item.tags, t))) return false
  if (c.severity && !c.severity.some(s => low(item.severity).startsWith(low(s)))) return false
  if (c.priority && (item.priority == null || !c.priority.includes(item.priority))) return false
  if (c.assigned === 'me' && !isMine(item, me)) return false
  if (c.assigned === 'none' && item.assigned) return false
  if (c.assigned === 'anyone' && !item.assigned) return false
  if (c.areaUnder && !under(c.areaUnder, item.area)) return false
  if (c.iterationUnder && !under(c.iterationUnder, item.iteration)) return false
  if (c.maxEffort != null && (item.effort == null || item.effort > c.maxEffort)) return false
  if (c.minEffort != null && (item.effort == null || item.effort < c.minEffort)) return false
  if (c.titleMatches) {
    try {
      if (!new RegExp(c.titleMatches, 'i').test(item.title)) return false
    } catch {
      return false
    }
  }
  if (c.hasPullRequest != null && (item.prs.length > 0) !== c.hasPullRequest) return false
  if (c.hasCommits != null && (item.commits.length > 0) !== c.hasCommits) return false
  const age = item.created ? (now - Date.parse(item.created)) / DAY : NaN
  if (c.olderThanDays != null && !(age > c.olderThanDays)) return false
  if (c.newerThanDays != null && !(age <= c.newerThanDays)) return false
  if (c.fields) {
    for (const [name, values] of Object.entries(c.fields)) {
      const v = fieldValue(item, name)
      if (!values.some(x => low(String(x)) === low(v))) return false
    }
  }
  return true
}

/** A field of the record by its key (`area`) or by an "extraFields" reference name, as text. */
export function fieldValue(item: BugRecord, name: string): string {
  const v = name in item ? (item as unknown as Record<string, unknown>)[name] : item.extra?.[name]
  if (v == null) return ''
  if (typeof v === 'object') return 'name' in (v as object) ? String((v as BugPerson).name) : JSON.stringify(v)
  return String(v)
}

export type Category = { id: string; label: string; icon: string; color: string | undefined; ids: number[] }

/** The categories, each with its items: the dynamic ones (eachTag, eachField) become one per value found. */
export function categorize(items: BugRecord[], categories: BugCategory[], me: BugPerson | null | undefined, now = Date.now()): Category[] {
  const out: Category[] = []
  for (const cat of categories ?? []) {
    if (!cat || !cat.id) continue
    const base = items.filter(i => conditionHolds(i, cat, me, now) && (!cat.any?.length || cat.any.some(c => conditionHolds(i, c, me, now))))
    const one = (id: string, label: string, ids: number[]) => out.push({ id, label, icon: cat.icon ?? '●', color: cat.color, ids })
    if (cat.eachTag || cat.eachField) {
      let re: RegExp | null = null
      try {
        re = cat.eachTag ? new RegExp(cat.eachTag, 'i') : null
      } catch {
        continue
      }
      const groups = new Map<string, number[]>()
      for (const i of base) {
        const values = re ? i.tags.filter(t => re!.test(t)) : [fieldValue(i, cat.eachField!)].filter(Boolean)
        for (const v of values) groups.set(v, [...(groups.get(v) ?? []), i.id])
      }
      const keys = [...groups.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const v of keys) one(`${cat.id}:${v}`, (cat.label.includes('{value}') ? cat.label : `${cat.label} {value}`).replace('{value}', v), groups.get(v)!)
      continue
    }
    one(cat.id, cat.label, base.map(i => i.id))
  }
  return out
}

// ---------------------------------------------------------------- the list

export function severityRank(s: string): number {
  const m = /^\s*(\d+)/.exec(s ?? '')
  return m ? Number(m[1]) : 9
}

/** The items the person asked to see: in the category, theirs only, not done (`doneStates`, when `hideDone`), of the type and state, with the words. */
export function filterItems(items: BugRecord[], f: BugFilter, cats: Category[], me: BugPerson | null | undefined, doneStates: readonly string[] = [], team: readonly string[] | null = null): BugRecord[] {
  const cat = f.category && f.category !== 'all' ? cats.find(c => c.id === f.category) : undefined
  const inCat = cat ? new Set(cat.ids) : null
  const words = low(f.text).split(/\s+/).filter(Boolean)
  return items.filter(i => {
    if (inCat && !inCat.has(i.id)) return false
    if (f.mine && !isMine(i, me)) return false
    if (f.hideDone && has(doneStates, i.state)) return false
    if (f.team && !isTeam(i, team)) return false
    if (f.type && low(i.type) !== low(f.type)) return false
    if (f.state && low(i.state) !== low(f.state)) return false
    if (words.length) {
      const hay = low(`${i.id} ${i.title} ${i.tags.join(' ')} ${i.assigned?.name ?? ''} ${i.area} ${i.iteration} ${i.state}`)
      if (!words.every(w => hay.includes(w))) return false
    }
    return true
  })
}

export function sortItems(items: BugRecord[], sort: BugFilter['sort']): BugRecord[] {
  const p = (i: BugRecord) => i.priority ?? 9
  const by: Record<BugFilter['sort'], (a: BugRecord, b: BugRecord) => number> = {
    priority: (a, b) => p(a) - p(b) || severityRank(a.severity) - severityRank(b.severity) || b.changed.localeCompare(a.changed),
    severity: (a, b) => severityRank(a.severity) - severityRank(b.severity) || p(a) - p(b) || b.changed.localeCompare(a.changed),
    changed: (a, b) => b.changed.localeCompare(a.changed),
    created: (a, b) => b.created.localeCompare(a.created),
    id: (a, b) => b.id - a.id,
  }
  return [...items].sort((a, b) => (by[sort] ?? by.priority)(a, b) || a.id - b.id)
}

/** The colour of a severity: red for 1, orange for 2, amber for 3, grey otherwise. */
export function severityColor(s: string): string {
  return ({ 1: '#c0503f', 2: '#d9783a', 3: '#c98a12' } as Record<number, string>)[severityRank(s)] ?? '#7b8794'
}

export function typeIcon(type: string): string {
  return low(type) === 'issue' ? '❗' : low(type) === 'bug' ? '🐞' : '•'
}

/** A name in a few characters: first name and the initial of the last. */
export function shortName(p: BugPerson | null | undefined): string {
  if (!p) return 'unassigned'
  const parts = (p.name || p.email).replace(/<.*>/, '').trim().split(/\s+/)
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0]
}

/** How long ago, in a few characters: `now`, `5m`, `3h`, `9d`, `4mo`; '' when unknown. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!iso || Number.isNaN(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 90) return 'now'
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 129_600) return `${Math.round(s / 3600)}h`
  if (s < 86_400 * 60) return `${Math.round(s / 86_400)}d`
  return `${Math.round(s / (86_400 * 30))}mo`
}

/** The last part of an area or iteration path. */
export function leaf(path: string): string {
  return (path ?? '').split('\\').filter(Boolean).pop() ?? ''
}

// ---------------------------------------------------------------- staged changes

/** What the field holds on the record, the way a change records it ("was"). */
export function currentValue(item: BugRecord, field: string): string {
  switch (field) {
    case F.state: return item.state
    case F.assigned: return item.assigned ? (item.assigned.email || low(item.assigned.name)) : ''
    case F.area: return item.area
    case F.iteration: return item.iteration
    case F.severity: return item.severity
    case F.priority: return item.priority == null ? '' : String(item.priority)
    default: return fieldValue(item, field)
  }
}

/** A change in a few words: "State → Active", "+ tag Urgent", "Comment: Seen on…". */
export function changeLabel(c: Pick<BugChange, 'kind' | 'field' | 'value'>, people: BugPerson[] = []): string {
  if (c.kind === 'tagAdd') return `+ tag ${c.value}`
  if (c.kind === 'tagRemove') return `− tag ${c.value}`
  if (c.kind === 'comment') {
    const t = c.value.replace(/\s+/g, ' ').trim()
    return `Comment: ${t.length > 48 ? t.slice(0, 48) + '…' : t}`
  }
  const name = FIELD_NAME[c.field ?? ''] ?? c.field ?? ''
  if (c.field === F.assigned) {
    const who = people.find(p => low(p.email) === low(c.value))
    return `${name} → ${c.value ? (who?.name || c.value) : 'nobody'}`
  }
  if (c.field === F.area || c.field === F.iteration) return `${name} → ${leaf(c.value) || c.value}`
  return `${name} → ${c.value || '(empty)'}`
}

export const MENTION = /(?<![\w#&/])#\d{3,}\b/

/** Why a comment cannot be staged, or null. ADO reads `#123` as a mention and posts on that item. */
export function commentProblem(text: string): string | null {
  if (!text.trim()) return 'Type the comment first.'
  const m = MENTION.exec(text)
  return m ? `${m[0]} posts a mention on that item in ADO. Write "ADO ${m[0].slice(1)}" instead.` : null
}

let seq = 0
/** A key no other change has, in the order they were made. */
export function changeKey(id: number, now = Date.now()): string {
  seq = (seq + 1) % 1000
  return `${id}-${now.toString(36)}-${seq}`
}

/** Stages one change. A field changed twice keeps one change (the first "was", the last value); a field set back
 *  to what it held drops its change; a tag added and then removed (or the reverse) drops both. */
export function stageChange(pending: BugChange[], c: Omit<BugChange, 'key' | 'at' | 'label'> & { key?: string; at?: string; label?: string }, people: BugPerson[] = [], now = Date.now()): BugChange[] {
  const full: BugChange = { ...c, key: c.key ?? changeKey(c.id, now), at: c.at ?? new Date(now).toISOString(), label: c.label ?? changeLabel(c, people) } as BugChange
  if (full.kind === 'field') {
    const old = pending.find(p => p.id === full.id && p.kind === 'field' && p.field === full.field)
    const was = old ? old.was : full.was
    const rest = pending.filter(p => p !== old)
    if ((was ?? '') === (full.value ?? '')) return rest
    return [...rest, { ...full, was, key: old?.key ?? full.key, problem: undefined }]
  }
  if (full.kind === 'tagAdd' || full.kind === 'tagRemove') {
    const other = full.kind === 'tagAdd' ? 'tagRemove' : 'tagAdd'
    const undo = pending.find(p => p.id === full.id && p.kind === other && low(p.value) === low(full.value))
    if (undo) return pending.filter(p => p !== undo)
    if (pending.some(p => p.id === full.id && p.kind === full.kind && low(p.value) === low(full.value))) return pending
  }
  return [...pending, full]
}

export function revertChange(pending: BugChange[], key: string): BugChange[] {
  return pending.filter(p => p.key !== key)
}

export function revertItem(pending: BugChange[], id: number): BugChange[] {
  return pending.filter(p => p.id !== id)
}

/** Overwrite what someone else changed: the change is measured from what ADO holds now, and saved again. */
export function keepMine(pending: BugChange[], key: string): BugChange[] {
  return pending.map(p => p.key === key && p.problem?.kind === 'conflict' ? { ...p, was: p.problem.current ?? '', problem: undefined } : p)
}

/** The staged changes by item, in the order the items were first changed. */
export function pendingByItem(pending: BugChange[]): Array<{ id: number; changes: BugChange[] }> {
  const out: Array<{ id: number; changes: BugChange[] }> = []
  for (const p of pending) {
    const g = out.find(x => x.id === p.id)
    if (g) g.changes.push(p)
    else out.push({ id: p.id, changes: [p] })
  }
  return out
}

/** The record as it will be once its staged changes are saved: what the list and the detail show. */
export function withPending(item: BugRecord, pending: BugChange[], people: BugPerson[] = []): BugRecord {
  const mine = pending.filter(p => p.id === item.id)
  if (!mine.length) return item
  const out: BugRecord = { ...item, tags: [...item.tags] }
  for (const p of mine) {
    if (p.kind === 'tagAdd' && !has(out.tags, p.value)) out.tags.push(p.value)
    if (p.kind === 'tagRemove') out.tags = out.tags.filter(t => low(t) !== low(p.value))
    if (p.kind !== 'field') continue
    if (p.field === F.state) out.state = p.value
    if (p.field === F.area) out.area = p.value
    if (p.field === F.iteration) out.iteration = p.value
    if (p.field === F.severity) out.severity = p.value
    if (p.field === F.priority) out.priority = p.value === '' ? null : Number(p.value)
    if (p.field === F.assigned) {
      out.assigned = p.value ? (people.find(x => low(x.email) === low(p.value)) ?? { name: p.value, email: p.value }) : null
    }
  }
  return out
}

/** Everyone the list names (assignees and authors) and the person running it: who an item can be given to. */
export function people(index: BugIndex | null): BugPerson[] {
  const out = new Map<string, BugPerson>()
  const add = (p: BugPerson | null | undefined) => {
    if (!p || !p.email || !p.email.includes('@')) return
    if (!out.has(low(p.email))) out.set(low(p.email), { name: p.name || p.email, email: low(p.email) })
  }
  add(index?.me ? { name: index.me.name || index.me.email, email: index.me.email } : null)
  for (const i of index?.items ?? []) {
    add(i.assigned)
    add(i.createdBy)
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Distinct values of a path field across the list, most used first, for the area and iteration pickers. */
export function pathOptions(items: BugRecord[], key: 'area' | 'iteration'): string[] {
  const n = new Map<string, number>()
  for (const i of items) if (i[key]) n.set(i[key], (n.get(i[key]) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0])
}

/** The states an item of this type can be moved to: the configured list, with its own state kept. */
export function stateOptions(cfg: BugsConfig, item: BugRecord): string[] {
  const list = cfg.states?.[item.type] ?? cfg.states?.Bug ?? ['New', 'Active', 'Resolved', 'Closed']
  return has(list, item.state) ? [...list] : [item.state, ...list]
}

/** All tags the list uses, for the tag picker. */
export function tagOptions(items: BugRecord[]): string[] {
  const out = new Map<string, string>()
  for (const i of items) for (const t of i.tags) if (!out.has(low(t))) out.set(low(t), t)
  return [...out.values()].sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------- links

/** Markdown links back to ADO: the item, its pull requests, its commits, its links and related items. */
export function itemLinks(item: BugRecord, org: string): string[] {
  const out = [`[Open ${item.type} ${item.id} in ADO](${item.url})`]
  for (const pr of item.prs) out.push(`[PR ${pr.id}${pr.title ? ` · ${pr.title.replace(/[[\]]/g, '')}` : ''}](${pr.url})${pr.status ? ` · ${pr.status}` : ''} · ${pr.repo}`)
  for (const c of item.commits) out.push(`[Commit ${c.sha.slice(0, 8)}](${c.url}) · ${c.repo}`)
  for (const l of item.links) out.push(`[${l.name.replace(/[[\]]/g, '') || l.url}](${l.url})`)
  const base = org ? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(item.project)}/_workitems/edit/` : ''
  for (const r of item.related) out.push(base ? `${r.name}: [ADO ${r.id}](${base}${r.id})` : `${r.name}: ADO ${r.id}`)
  return out
}

// ---------------------------------------------------------------- sdd and the probable cause

/** Where the sdd flow stands on the item: "Continue sdd" when it has a record in this workspace. */
export function sddState(snap: SddSnapshot | null, id: number): { label: string; note: string } {
  const item = snap?.items.find(i => i.id === id) ?? snap?.done.find(i => i.id === id)
  if (!item || !item.progress) return { label: 'Start sdd', note: 'No sdd flow on this item yet.' }
  const st = item.progress.status
  return { label: 'Continue sdd', note: `sdd: ${item.progress.phase}, ${st}${st === 'waiting' && item.progress.gate ? ` (${item.progress.gate})` : ''}.` }
}

const cut = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > n ? t.slice(0, n) + ' …' : t
}

/** The key an analysis is kept under: the item's revision and what the evidence found. A newer item or other
 *  evidence makes the kept analysis stale (it is still shown, marked so). */
export function analysisKey(item: BugRecord, ev: BugEvidence | null): string {
  const found = ev ? [...ev.hits.map(h => `${h.path}:${h.line}`), ...ev.linked.map(l => l.commit.split(' ')[0])].join(',') : ''
  return `${item.rev}|${found}`
}

export const ANALYSIS_SYSTEM = 'You find the probable cause of a software bug from its report and code evidence found by grep and git. '
  + 'Be brief and concrete; never invent files or lines. Answer in Markdown with exactly these parts: '
  + '**Probable cause** (1-3 sentences), **Confidence** (low, medium or high, and why, one line), '
  + '**Where to look** (up to 4 bullets: path:line and why), **Next step** (one line). '
  + 'If the evidence is thin, say so and name what to check first.'

/** The one message the model reads: the report and the evidence as short lines, no JSON (fewer tokens). */
export function analysisPrompt(item: BugRecord, d: BugDetail | null, ev: BugEvidence | null): string {
  const t = d?.text ?? {}
  const lines = [
    `${item.type} ${item.id}: ${item.title}`,
    [item.state, item.severity && `severity ${item.severity}`, item.priority != null && `priority ${item.priority}`, item.area && `area ${item.area}`]
      .filter(Boolean).join(', '),
  ]
  if (t.repro) lines.push('', 'Repro steps:', cut(t.repro, 1200))
  if (t.description) lines.push('', 'Description:', cut(t.description, 600))
  if (t.systemInfo) lines.push('', 'System info:', cut(t.systemInfo, 300))
  const notes = (d?.comments ?? []).slice(0, 2)
  if (notes.length) lines.push('', 'Latest comments:', ...notes.map(c => `- ${c.by}: ${cut(c.text, 300)}`))
  if (ev) {
    lines.push('', `Code evidence (searched ${ev.repos.join(', ') || 'no repos'} for: ${ev.terms.join(', ') || 'nothing'}):`)
    lines.push(...(ev.hits.length ? ev.hits.map(h => `- ${h.repo}/${h.path}:${h.line} [${h.term}] ${h.text}`) : ['- no match in the repos']))
    if (ev.history.length) lines.push('', 'Recent history of those files:', ...ev.history.map(h => `- ${h.path}: ${h.commits.join(' | ')}`))
    if (ev.linked.length) lines.push('', 'Commits linked to the item:', ...ev.linked.map(l => `- ${l.repo} ${l.commit}: ${l.files.join(', ')}`))
  } else {
    lines.push('', 'No code evidence was gathered.')
  }
  return lines.join('\n')
}

/** The cost line under an analysis. */
export function analysisNote(a: BugAnalysis, fresh: boolean): string {
  return `${a.model} · ${a.input.toLocaleString('en-US')} tokens in, ${a.output.toLocaleString('en-US')} out · ${a.at.slice(0, 16).replace('T', ' ')}${fresh ? '' : ' · the item or the evidence changed since'}`
}

/** The PowerShell to run a script with: the setting, else pwsh, else Windows PowerShell. */
export function powershellCandidates(setting: string | undefined, isWindows: boolean): string[] {
  const list = [setting, 'pwsh', isWindows ? 'powershell' : ''].filter((x): x is string => !!x)
  return [...new Set(list)]
}

/** The argv of one bug script. */
export function scriptArgv(exe: string, pluginRoot: string, script: string, root: string, args: string[] = []): string[] {
  return [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/scripts/bugs/${script}`, '-Root', root, ...args]
}

/** The last line of a script's output that is a JSON object: what the script answered. */
export function scriptAnswer<T>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return parseJson<T>(lines[i])
    } catch {
      // not JSON after all: try the line before
    }
  }
  return null
}
