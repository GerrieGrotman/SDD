// What the view shows, worked out from one env.py view snapshot. No $ here: plain functions.
import type { SddColors, SddFlow, SddItem, SddProgress, SddQuestion, SddSnapshot, SddStage } from '../../types'

// skipped = the user agreed to skip it; missed = never worked and never skipped (the flow jumped it)
export type Mark = 'done' | 'skipped' | 'missed' | 'active' | 'waiting' | 'blocked' | 'abandoned' | 'next' | 'later'

export type StageRow = { stage: SddStage; mark: Mark }

/** One glyph per mark, so the terminal and a colour-blind reader get the same word the colour gives. */
export const GLYPH: Record<Mark, string> = { done: '✓', skipped: '↷', missed: '!', active: '●', waiting: '●', blocked: '✕', abandoned: '–', next: '○', later: '·' }


/** Which flow an item runs, and for a flow with paths (the spec flow) which one the user chose.
 *  `text` for the pane ("Spec flow · short path"), `brief` for the one-line band ("spec · short");
 *  `open` while the user has not chosen a path yet. */
export type FlowTag = { flow: string; path: string | null; text: string; brief: string; open: boolean }

export function flowTag(flow: SddFlow | undefined, item: SddItem): FlowTag {
  const name = flow?.label ?? `${item.flow} flow`
  const word = name.replace(/\s*flow$/i, '').toLowerCase()
  if (!flow?.paths) return { flow: name, path: null, text: name, brief: word, open: false }
  const chosen = item.path && item.path !== 'choose' && flow.paths[item.path] ? item.path : null
  const path = chosen ? `${chosen} path` : 'path not chosen'
  return { flow: name, path, text: `${name} · ${path}`, brief: `${word} · ${chosen ?? 'path?'}`, open: !chosen }
}

/** 'Phase 12 — Pull request' -> 'Phase 12'; 'Implement (task 3/7)' -> 'Implement'. As env.py phase_key. */
export function phaseKey(flow: SddFlow, name: string | undefined): string | null {
  const phase = (name ?? '').trim()
  const bug = /^Phase\s+(\d+)\b/i.exec(phase)
  if (bug) {
    const key = `Phase ${bug[1].toLowerCase()}`
    return flow.stages.some(s => s.key === key) ? key : null
  }
  const hit = flow.stages.find(s => phase.toLowerCase().startsWith(s.key.toLowerCase()))
  return hit ? hit.key : null
}

/** A stage behind the current one, from its record. An old snapshot without records counts it done.
 *  A conditional stage with no record and no open question was never needed: it shows as skipped.
 *  A stage added after the item started (inferFromGates) counts as done once its gates are passed. */
function pastMark(item: SddItem, stage: SddStage): Mark {
  if (!item.stages) return 'done'
  const r = item.stages[stage.key]
  if (!r && stage.conditional && !(item.spec?.questions_open ?? 0)) return 'skipped'
  if (!r && stage.inferFromGates && stage.passes.every(g => item.gates?.[g])) return 'done'
  return !r ? 'missed' : r.status === 'skipped' ? 'skipped' : 'done'
}

/** The note beside a conditional stage: the questions still open, or the caveat the person continued with. */
export function questionBadge(flow: SddFlow, item: SddItem, key: string): { text: string; warn: boolean } | null {
  const stage = flow.stages.find(s => s.key === key)
  if (!stage?.conditional) return null
  const open = item.spec?.questions_open ?? 0
  const gate = stage.passes.every(g => item.gates?.[g])
  const caveat = stageHistory(flow, item, key).find(h => h.caveat)
  if (gate && caveat && open) return { text: `continued with ${open} open`, warn: true }
  if (open) return { text: `${open} open`, warn: true }
  const total = item.spec?.questions_total ?? 0
  return total ? { text: `${total} answered`, warn: false } : null
}

export function stageRows(flow: SddFlow, item: SddItem): StageRow[] {
  const p = item.progress
  if (p?.status === 'done' && phaseKey(flow, p.phase) === null) {
    return flow.stages.map(stage => ({ stage, mark: pastMark(item, stage) }))
  }
  const cur = flow.stages.findIndex(s => s.key === phaseKey(flow, p?.phase))
  return flow.stages.map((stage, i) => {
    if (cur < 0) return { stage, mark: i === 0 ? 'next' : 'later' }
    if (i < cur) return { stage, mark: pastMark(item, stage) }
    if (i === cur && item.stages?.[stage.key]?.status === 'skipped') return { stage, mark: 'skipped' }
    if (i === cur) return { stage, mark: (p?.status ?? 'active') as Mark }
    return { stage, mark: i === cur + 1 ? 'next' : 'later' }
  })
}


/** The flow is finished: every stage done, or skipped with the user's yes. */
export function flowFinished(flow: SddFlow, item: SddItem): boolean {
  if (item.removed) return true
  return stageRows(flow, item).every(r => r.mark === 'done' || r.mark === 'skipped')
}

/** The history rows of one stage, newest first. */
export function stageHistory(flow: SddFlow, item: SddItem, key: string): SddProgress[] {
  return (item.history ?? []).filter(h => phaseKey(flow, h.phase) === key).reverse()
}

const DOCS: Record<string, string[]> = {
  Specify: ['requirements.md', 'questions.md', 'impact.md'],
  'Open Questions': ['questions.md', 'impact.md'],
  Requirements: ['requirements.md', 'questions.md', 'impact.md'],
  Design: ['design.md', 'questions.md'],
  Decompose: ['tasks.md'],
  Implement: ['tasks.md'],
  Verify: ['tasks.md', 'design.md'],
  'Phase 1': ['requirements.md'],
  'Phase 3': ['requirements.md', 'questions.md'],
  'Phase 5': ['design.md'],
}

/** The spec documents a stage reads, those that exist. */
export function stageDocs(item: SddItem, key: string): string[] {
  const have = item.spec?.files ?? []
  return (DOCS[key] ?? []).filter(d => have.includes(d))
}

/** 2026-10-01T13:56:47Z -> 10-01 13:56 (UTC, as env.py writes it). */
export function when(at: string | undefined): string {
  return at ? at.slice(5, 16).replace('T', ' ') : ''
}

/** An absolute Windows or POSIX path as a file:/// URL. */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, '/')
  return encodeURI(`file://${p.startsWith('/') ? '' : '/'}${p}`).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

function join(base: string, rel: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
}

/** A progress ref as a markdown link: `ado`, a spec file, a path under the work item folder, or absolute. */
export function refLink(item: SddItem, ref: string): string | null {
  if (ref === 'ado') return item.url ? `[ADO ${item.id}](${item.url})` : null
  const [, path, lines] = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(ref) ?? [ref, ref, undefined]
  const label = `${path.split(/[\\/]/).pop()}${lines ? `:${lines}` : ''}`
  let abs: string | null = null
  if (/^([A-Za-z]:)?[\\/]/.test(path)) abs = path
  else if (/^src[\\/]/.test(path) && item.folder) abs = join(item.folder, path)
  else if (item.spec) abs = join(item.spec.path, path)
  return abs ? `[${label}](${fileUrl(abs)}${lines ? `#L${lines.split('-')[0]}` : ''})` : `\`${ref}\``
}

/** A file: link the view drew -> the path on this computer and the line to open at, if any. */
export function fileTarget(href: string): { path: string; line?: number } | null {
  const m = /^file:\/\/\/?([^#]*)(?:#L(\d+))?$/.exec(href)
  if (!m) return null
  const path = decodeURI(m[1]).replace(/%23/g, '#').replace(/%3F/g, '?')
  return { path: /^[A-Za-z]:/.test(path) ? path : `/${path}`, line: m[2] ? Number(m[2]) : undefined }
}

/** The file: links in a piece of markdown, so a Markdown element answers only those itself. */
export function fileLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\((file:[^)\s]+)\)/g)].map(x => x[1])
}

export function statusWord(item: SddItem): string {
  const p = item.progress
  if (!p) return 'not started'
  if (p.status === 'waiting') return 'waiting on you'
  return p.status
}

/** The note after the spinner's word while Claude works: the item, its stage, and what it works toward
 *  (the next gate a person decides, or the task count while it implements). Null when there is nothing to say. */
export function spinnerNote(flow: SddFlow | undefined, item: SddItem, derived: string[]): string | null {
  const p = item.progress
  if (!flow || !p || ['done', 'abandoned'].includes(p.status)) return null
  const stage = flow.stages.find(s => s.key === phaseKey(flow, p.phase))
  if (!stage) return null
  const gate = decidedGates(stage, derived).find(g => !item.gates?.[g])
  const total = item.spec?.tasks_total ?? 0
  const goal = gate ? `gate: ${gate}` : stage.key === 'Implement' && total ? `task ${item.spec?.tasks_done ?? 0}/${total}` : ''
  return ` · ${item.id} ${stage.label}${goal ? ` · ${goal}` : ''}`
}

/** The item waits on the person: the text for a notification, and a key that is the same for the whole wait,
 *  so the person is told once. Null while the item does not wait. */
export function yourTurn(flow: SddFlow | undefined, item: SddItem): { key: string; text: string } | null {
  const p = item.progress
  if (p?.status !== 'waiting') return null
  const stage = flow?.stages.find(s => s.key === phaseKey(flow, p.phase))
  const what = p.gate || 'a decision'
  return { key: `${item.id}|${p.at}|${what}`, text: `${item.id} ${stage?.label ?? p.phase}: your turn. ${what}`.slice(0, 200) }
}

export function phaseLabel(flow: SddFlow | undefined, item: SddItem): string {
  const p = item.progress
  if (!p) return ''
  if (!flow) return p.phase
  const key = phaseKey(flow, p.phase)
  const stage = flow.stages.find(s => s.key === key)
  if (!stage) return p.status === 'done' ? 'Done' : p.phase
  return stage.key === stage.label ? stage.label : `${stage.key} · ${stage.label}`
}


export type StoryEvent = { at: string; kind: 'asked' | 'passed' | 'revoked'; text: string; refs: string[] }

/** One gate as a decision, oldest first: each question asked before it passed, the pass with its
 *  note (the answer), and every revoke with why. A waiting row belongs to the gate the next pass passes.
 *  `open` names the stage of a gate still waiting on the person: its questions asked since the last
 *  pass are in the story too, so the gate shows what it waits on. */
export function gateStory(item: SddItem, gate: string, open?: { flow: SddFlow; key: string }): StoryEvent[] {
  const out: StoryEvent[] = []
  const asked = (a: SddProgress): StoryEvent => ({ at: a.at, kind: 'asked', text: [a.gate, a.note].filter(Boolean).join('. '), refs: a.refs ?? [] })
  let asks: SddProgress[] = []
  for (const h of item.history ?? []) {
    if (h.status === 'waiting') asks.push(h)
    const passed = h.gates?.passed ?? []
    if (passed.includes(gate)) {
      for (const a of asks) out.push(asked(a))
      out.push({ at: h.at, kind: 'passed', text: h.note ?? '', refs: h.refs ?? [] })
    }
    if ((h.gates?.revoked ?? []).includes(gate)) out.push({ at: h.at, kind: 'revoked', text: h.note ?? '', refs: [] })
    if (passed.length) asks = []
  }
  if (open) {
    for (const a of asks) if (phaseKey(open.flow, a.phase) === open.key) out.push(asked(a))
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** The gate the item waits on the person for: the first gate its waiting stage passes that is not
 *  passed yet. Null when it waits on nothing, or on a go-ahead that passes no gate. */
export function pendingGate(flow: SddFlow, item: SddItem, derived: string[]): { gate: string; key: string } | null {
  const p = item.progress
  if (p?.status !== 'waiting') return null
  const stage = flow.stages.find(s => s.key === phaseKey(flow, p.phase))
  const gate = stage ? decidedGates(stage, derived).find(g => !item.gates?.[g]) : undefined
  return stage && gate ? { gate, key: stage.key } : null
}

/** What to read before answering the question the item waits on, as markdown links: the refs Claude
 *  gave with the question first, then the stage's spec documents not among them. */
export function reviewLinks(item: SddItem, key: string): string[] {
  const refs = item.progress?.status === 'waiting' ? item.progress.refs ?? [] : []
  const named = new Set(refs.map(r => r.replace(/:\d[\d-]*$/, '').split(/[\\/]/).pop()))
  const docs = stageDocs(item, key).filter(d => !named.has(d))
  return [...refs, ...docs].map(r => refLink(item, r)).filter((x): x is string => !!x)
}

/** The answers AskUserQuestion returns, per question text: the picked labels (comma-joined, as the
 *  chat's dialog joins a multi-select) or else the typed text, as under "Other". Null while a
 *  question has neither. */
export function answersFor(questions: SddQuestion[], picks: Record<string, string[]>, other: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const q of questions) {
    const picked = (picks[q.question] ?? []).filter(l => q.options.some(o => o.label === l))
    const text = picked.length ? picked.join(', ') : other.trim()
    if (!text) return null
    out[q.question] = text
  }
  return out
}

/** The answers as the person's own message, for when the chat's dialog is no longer open. The sdd
 *  skill reads "sdd answer for <id>, stage <stage>: …" as the answer to the gate question. */
export function answerMessage(id: number, key: string, questions: SddQuestion[], answers: Record<string, string>): string {
  return `sdd answer for ${id}, stage ${key}: ` + questions.map(q => `"${q.question}" = "${answers[q.question]}"`).join('; ')
}

/** A stage's row: how many log entries it has, its latest note, and when it last moved. */
export function stageSummary(flow: SddFlow, item: SddItem, key: string): { count: number; note: string; lastAt?: string } {
  const rows = stageHistory(flow, item, key)  // newest first
  return { count: rows.length, note: rows.find(r => r.note)?.note ?? '', lastAt: rows[0]?.at }
}

/** The gates a stage records that a person decides (not read from disk), in flow order. */
export function decidedGates(stage: SddStage, derived: string[]): string[] {
  return stage.passes.filter(g => !derived.includes(g))
}

/** 2026-10-01T12:41:15Z -> 10/01/2026 12h41, in this computer's time zone: the stamp a row's label carries. */
export function stamp(at: string | undefined): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${d.getFullYear()} ${two(d.getHours())}h${two(d.getMinutes())}`
}

/** `/sdd 92012`, `/sdd spec 92012`, `/sdd 92012 feedback …` -> 92012; `/sdd help`, `/sdd sync` -> null. */
export function idFromArgs(args: string): number | null {
  const m = /^\s*(?:(?:bug|spec|status|done|abandon|impact)\s+)?(\d+)\b/i.exec(args)
  return m ? Number(m[1]) : null
}

/** The work item an env.py / spec.py run names with --id. */
export function idFromScript(cmd: string): number | null {
  const m = /scripts[\\/]+(?:env|spec)\.py["']?\s+\w+[^\n]*?--id\s+(\d+)/.exec(cmd)
  return m ? Number(m[1]) : null
}

/** The spec flow stops the view approves with one button: the button's label, and the go-ahead
 *  option each one's gate question offers, as the spec skill's gate table names it. */
const APPROVE: Record<string, { label: string; option: string }> = {
  Requirements: { label: 'Approve Spec', option: 'Approve — start Design' },
  Design: { label: 'Approve Design', option: 'Approve — start Decompose' },
  Decompose: { label: 'Approve Task List', option: 'Approve — start Implement' },
  Verify: { label: 'Raise PR', option: 'Raise the PR' },
}

/** The go-ahead the Approve button gives: the stage it approves, its label and the option it picks.
 *  Null unless the item is in the spec flow and waits on the person at one of those stops. */
export function approveFor(flow: SddFlow, item: SddItem): { key: string; label: string; option: string } | null {
  const p = item.progress
  if (item.flow !== 'spec' || p?.status !== 'waiting') return null
  const key = phaseKey(flow, p.phase)
  return key && APPROVE[key] ? { key, ...APPROVE[key] } : null
}

/** The go-ahead as answers to an open question: per question, the option named `option`, else the
 *  one that starts with "Approve". Null when a question has neither: Claude asked something else. */
export function approveAnswers(questions: SddQuestion[], option: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const q of questions) {
    const hit = q.options.find(o => o.label === option) ?? q.options.find(o => /^approve\b/i.test(o.label))
    if (!hit) return null
    out[q.question] = hit.label
  }
  return out
}

/** The go-ahead as the person's own message. The sdd skill reads "sdd approve for <id>, stage <stage>"
 *  as the go-ahead option of that stage's gate question. */
export function approveMessage(id: number, key: string): string {
  return `sdd approve for ${id}, stage ${key}`
}


// ---------------------------------------------------------------- the vertical flow

/** A word for each mark, for the line of a stage's card. A stage not reached yet has none. */
export const MARK_WORD: Record<Mark, string> = { done: 'done', skipped: 'skipped', missed: 'never worked', active: 'working', waiting: 'waiting on you',
  blocked: 'blocked', abandoned: 'abandoned', next: 'next', later: '' }

export type GateChip = { gate: string; state: 'passed' | 'pending' | 'revoked' | 'open'; at?: string }

/** The gates a stage holds that a person decides, each as a chip on the stage's card: passed (with when), the one the
 *  item waits on now, one a revoke took back, or still open. In the flow's order. */
export function gateChips(item: SddItem, stage: SddStage, derived: string[], pending: { gate: string; key: string } | null): GateChip[] {
  return decidedGates(stage, derived).map(gate => {
    const at = item.gates?.[gate]
    if (at) return { gate, state: 'passed', at }
    if (pending?.gate === gate && pending.key === stage.key) return { gate, state: 'pending' }
    const last = gateStory(item, gate).slice(-1)[0]
    return { gate, state: last?.kind === 'revoked' ? 'revoked' : 'open' }
  })
}

// ---------------------------------------------------------------- the flow picture
// The flow as one vertical picture for the apps that draw an SVG: a node per stage on a rail, with its state, cost,
// last activity, latest note and gates on its row, and the picked stage outlined. The pane lays it out for the width it
// has, so a resize re-draws it: wide gets cost bars and times, narrow keeps the essentials and shortens the text.
// It only shows. The stage picker under it, and the detail of the picked stage, are what a person presses.

export type FlowPicture = { source: string; alt: string; width: number; height: number }

/** The stage the pane opens on: the one the item works at or waits on, else the next, else the last it finished. */
export function defaultStage(rows: StageRow[]): string | null {
  const now = rows.find(r => r.mark === 'waiting' || r.mark === 'blocked' || r.mark === 'active')
  const next = rows.find(r => r.mark === 'next')
  const lastDone = [...rows].reverse().find(r => r.mark === 'done' || r.mark === 'skipped')
  return (now ?? next ?? lastDone ?? rows[0])?.stage.key ?? null
}

/** The stage before (-1) or after (1) `key`, held at the first and the last. */
export function stepStage(rows: StageRow[], key: string | null, dir: -1 | 1): string | null {
  if (!rows.length) return null
  const i = rows.findIndex(r => r.stage.key === key)
  return rows[Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))].stage.key
}

/** 2026-10-01T12:41:15Z -> 10/01 12:41 in this computer's time zone. */
export function shortStamp(at: string | undefined): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** A rail picture is this wide and this high: the rows are as high as the slice, so the slices join into one rail. */
export const RAIL = { w: 40, h: 46, mid: 23, x: 20 }
const PIC_FONT = '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif'
const PIC_BG = '#1d2126'

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const stageTone = (m: Mark, colors: SddColors): string => ({ done: colors.done, skipped: colors.dim, missed: colors.revoked, active: colors.work, waiting: colors.now,
  blocked: colors.revoked, abandoned: colors.dim, next: colors.work, later: colors.line })[m]

/** A rail line is solid green behind the work, dashed ahead of it. */
const behind = (m: Mark): boolean => m === 'done' || m === 'skipped'

/** One stage's piece of the rail: the node, and the line to the stage above and below. Rows as high as the slice join up. */
export function railSlice(input: { mark: Mark; prevMark: Mark | null; hasNext: boolean; conditional?: boolean; colors: SddColors }): FlowPicture {
  const { mark, prevMark, hasNext, colors } = input
  const col = stageTone(mark, colors)
  const quiet = mark === 'later' || mark === 'next'
  const line = (y1: number, y2: number, done: boolean) =>
    `<line x1="${RAIL.x}" y1="${y1}" x2="${RAIL.x}" y2="${y2}" stroke="${done ? colors.done : colors.line}" stroke-width="3"${done ? '' : ' stroke-dasharray="4 4"'}/>`
  const parts = [
    prevMark ? line(0, RAIL.mid, behind(prevMark)) : '',
    hasNext ? line(RAIL.mid, RAIL.h, behind(mark)) : '',
    mark === 'waiting' || mark === 'active' || mark === 'blocked' ? `<circle cx="${RAIL.x}" cy="${RAIL.mid}" r="14" fill="none" stroke="${col}" stroke-width="2" opacity="0.5"/>` : '',
    `<circle cx="${RAIL.x}" cy="${RAIL.mid}" r="10" fill="${quiet ? PIC_BG : col}" stroke="${col}" stroke-width="2"${input.conditional || mark === 'skipped' || mark === 'missed' ? ' stroke-dasharray="3 2"' : ''}/>`,
    `<text x="${RAIL.x}" y="${RAIL.mid + 4}" text-anchor="middle" font-family="${PIC_FONT}" font-size="11" font-weight="700" fill="${quiet ? col : '#ffffff'}">${xml(GLYPH[mark])}</text>`,
  ]
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${RAIL.w}" height="${RAIL.h}" viewBox="0 0 ${RAIL.w} ${RAIL.h}">${parts.join('')}</svg>`,
    alt: MARK_WORD[mark] || 'not reached yet', width: RAIL.w, height: RAIL.h }
}

/** The small bar that shows what a stage cost against the dearest stage. */
export function costBar(input: { usd: number; max: number; mark: Mark; colors: SddColors }): FlowPicture {
  const { usd, max, mark, colors } = input
  const bw = max > 0 ? Math.max(3, Math.round((usd / max) * 64)) : 0
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="6" viewBox="0 0 64 6"><rect width="64" height="6" rx="3" fill="${colors.dim}" opacity="0.25"/>`
    + `<rect width="${bw}" height="6" rx="3" fill="${stageTone(mark, colors)}"/></svg>`, alt: moneyText(usd), width: 64, height: 6 }
}

/** The word after a stage's name: its state, and the open-question count. Done and next say nothing: the colour does. */
export function stageWord(flow: SddFlow, item: SddItem, r: StageRow): { text: string; mark: Mark; warn: boolean } {
  const badge = questionBadge(flow, item, r.stage.key)
  return { text: [r.mark === 'done' || r.mark === 'next' ? '' : MARK_WORD[r.mark], badge?.text].filter(Boolean).join(' · '), mark: r.mark, warn: !!badge?.warn }
}

/** The tooltip-less summary of the flow, for a screen reader: each stage and its state. */
export function flowAlt(flow: SddFlow, rows: StageRow[]): string {
  return `${flow.label}, ${rows.length} stages, top to bottom: ` + rows.map(r => `${r.stage.label}${MARK_WORD[r.mark] ? ` (${MARK_WORD[r.mark]})` : ''}`).join(', ') + '.'
}

// ---------------------------------------------------------------- the agents

/** What `$.agent.list()` returns for one agent loop of the session: a subagent or a teammate. */
export type AgentInfoLike = { id: string; description: string; type: string; status: string; parentId?: string }

export type AgentTone = 'working' | 'waiting' | 'done' | 'failed' | 'quiet'

export type AgentRow = { id: string; name: string; text: string; word: string; tone: AgentTone; isLive: boolean }

const AGENT_TONE: Record<string, { word: string; tone: AgentTone }> = {
  running: { word: 'working', tone: 'working' },
  waiting: { word: 'waiting', tone: 'waiting' },
  idle: { word: 'idle', tone: 'quiet' },
  pending: { word: 'starting', tone: 'quiet' },
  completed: { word: 'done', tone: 'done' },
  failed: { word: 'failed', tone: 'failed' },
  killed: { word: 'stopped', tone: 'failed' },
}

/** The agents as rows: the ones working or waiting first, then the newest of the rest, at most `max`.
 *  `sdd:investigator` shows as `investigator`; a status the view does not know shows as it is. */
export function agentRows(list: AgentInfoLike[], max = 6): AgentRow[] {
  const rows = list.map((a, i): AgentRow & { i: number } => {
    const t = AGENT_TONE[a.status] ?? { word: a.status, tone: 'quiet' as AgentTone }
    const text = (a.description || '').replace(/\s+/g, ' ').trim()
    return { i, id: a.id, name: a.type.replace(/^.*:/, ''), text: text.length > 80 ? `${text.slice(0, 79)}…` : text, word: t.word, tone: t.tone,
      isLive: t.tone === 'working' || t.tone === 'waiting' }
  })
  // the list is oldest first: among the finished, the newest stay
  const live = rows.filter(r => r.isLive)
  const rest = rows.filter(r => !r.isLive).reverse().slice(0, Math.max(max - live.length, 0))
  return [...live, ...rest].slice(0, Math.max(max, live.length)).map(({ i: _i, ...r }) => r)
}


// ---------------------------------------------------------------- picking a work item

function cutAt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The workspace's open work items, the ones waiting on the person first, then the newest id first. */
function openItems(snap: Pick<SddSnapshot, 'items'>): SddItem[] {
  const waits = (i: SddItem) => (i.progress?.status === 'waiting' ? 0 : 1)
  return [...snap.items].sort((a, b) => waits(a) - waits(b) || b.id - a.id)
}

/** One line for a work item: `92012 Author tags · Design · waiting on you`. */
function itemLine(flows: Record<string, SddFlow>, item: SddItem): string {
  const where = phaseLabel(flows[item.flow], item)
  return [`${item.id} ${item.title}`, where, item.progress ? statusWord(item) : ''].filter(Boolean).join(' · ')
}

/** The choices of the pane's work item dropdown: value is the id, label the line. `current` is the item the pane shows. */
export function itemOptions(snap: Pick<SddSnapshot, 'items' | 'flows'>, current?: SddItem, maxLabel = 90): { value: string; label: string }[] {
  // the item the pane shows may be a finished one, which is not among the open items: the list holds it last, so it shows
  const all = current && !snap.items.some(i => i.id === current.id) ? [...openItems(snap), current] : openItems(snap)
  return all.map(i => ({ value: String(i.id), label: cutAt(itemLine(snap.flows, i), maxLabel) }))
}

/** `/sdd `, `/sdd spec `, `/sdd:sdd bug `, `/sdd-view `: the place a work item id goes. */
const ID_PLACE = /^\s*\/(?:sdd(?::sdd)?(?:\s+(?:bug|spec|status|done|abandon|impact))?|sdd-view)\s+$/i

/** The rows the prompt box adds below its own while a work item id is typed after /sdd: the open items
 *  whose id starts with the token, or whose title holds it. Empty anywhere else in the prompt. */
export function itemSuggestions(snap: Pick<SddSnapshot, 'items' | 'flows'>, before: string, token: string, max = 8):
  { text: string; label: string; description: string }[] {
  if (!ID_PLACE.test(before) || !token) return []
  const t = token.toLowerCase()
  return openItems(snap)
    .filter(i => (/^\d+$/.test(t) ? String(i.id).startsWith(t) : i.title.toLowerCase().includes(t)))
    .slice(0, max)
    .map(i => ({ text: String(i.id), label: String(i.id), description: cutAt(itemLine(snap.flows, i).slice(String(i.id).length + 1), 80) }))
}


// ---------------------------------------------------------------- cost and context
// What a work item has cost, by stage. The session reports one running total ($.session.usage().cost); the
// view takes what it grew by over a turn and has `env.py cost` append it to the item's own folder, against the
// stage the item was in when the turn began (a stage that changes mid-turn is charged to the one it began in).
// `env.py view` reports the totals per stage, whichever chat or session spent them.

/** What one stage cost: dollars, turns, and the tokens by kind (a record from before tokens were kept has none). */
export type SpendRow = { usd: number; turns: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** Per stage key. */
export type Spend = Record<string, SpendRow>

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export function spendTotal(spend: Spend): number {
  return Object.values(spend).reduce((a, v) => a + v.usd, 0)
}

/** 0.004 -> `<$0.01`, 1.234 -> `$1.23`, 12.34 -> `$12.3`, 123.4 -> `$123`. */
export function moneyText(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (usd < 100) return `$${usd.toFixed(1)}`
  return `$${Math.round(usd)}`
}

export type ContextTone = 'ok' | 'warn' | 'high'

/** From 80 percent a context window is worth a word, from 90 it is nearly full. */
export function contextTone(percent: number | undefined): ContextTone {
  if (percent == null || !Number.isFinite(percent)) return 'ok'
  return percent >= 90 ? 'high' : percent >= 80 ? 'warn' : 'ok'
}

/** 950 -> `950`, 1234 -> `1.2k`, 45000 -> `45k`, 1234567 -> `1.2M`, 3.4e9 -> `3.4B`. */
export function tokenText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const one = (v: number, unit: string) => `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${unit}`
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return one(n / 1e3, 'k')
  if (n < 1e9) return one(n / 1e6, 'M')
  return one(n / 1e9, 'B')
}

/** The tokens of one stage's row, or of all the rows added up. */
export function spendTokens(rows: SpendRow | SpendRow[] | Spend): Tokens {
  const list = Array.isArray(rows) ? rows : 'usd' in rows && typeof rows.usd === 'number' ? [rows as SpendRow] : Object.values(rows as Spend)
  return list.reduce<Tokens>((t, r) => ({ input: t.input + (r.input ?? 0), output: t.output + (r.output ?? 0),
    cacheRead: t.cacheRead + (r.cacheRead ?? 0), cacheWrite: t.cacheWrite + (r.cacheWrite ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
}

/** `in 12k · out 3.4k · cache read 1.2M · cache write 80k`: the kinds with tokens, in that order. Null when none. */
export function tokensLine(t: Tokens): string | null {
  const parts = ([['in', t.input], ['out', t.output], ['cache read', t.cacheRead], ['cache write', t.cacheWrite]] as const)
    .filter(([, n]) => n > 0).map(([label, n]) => `${label} ${tokenText(n)}`)
  return parts.length ? parts.join(' · ') : null
}

/** The line for a stage: `$1.23 over 4 turns · in 12k · out 3k · cache read 1.2M · cache write 80k`. Null when the
 *  stage has cost nothing. */
export function spendLine(spend: Spend, key: string): string | null {
  const v = spend[key]
  const tokens = v ? tokensLine(spendTokens(v)) : null
  if (!v || !(v.usd > 0 || tokens)) return null
  const head = v.usd > 0 ? `${moneyText(v.usd)} over ${v.turns} turn${v.turns === 1 ? '' : 's'}` : `${v.turns} turn${v.turns === 1 ? '' : 's'}`
  return tokens ? `${head} · ${tokens}` : head
}
