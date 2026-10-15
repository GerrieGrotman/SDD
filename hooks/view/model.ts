// What the view shows, worked out from one env.py view snapshot. No $ here: plain functions.
import type { SddColors, SddFlow, SddItem, SddProgress, SddQuestion, SddStage } from '../../types'

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


// ---------------------------------------------------------------- the flow map
// The stages of a flow as one drawing: a snake of boxes four to a row, an arrow from each stage to the
// next, a diamond on a stage that holds a gate, and a dashed arrow back along `reworkTo`. It is an SVG
// string for the apps that draw one. It carries its own colours (boxes with ink on them), so it reads on a
// light and a dark theme, and it only shows: the stage rows below it stay the buttons.

export type FlowMap = { source: string; alt: string; width: number; height: number }

const MARK_WORD: Record<Mark, string> = { done: 'done', skipped: 'skipped', missed: 'never worked', active: 'working', waiting: 'waiting on you',
  blocked: 'blocked', abandoned: 'abandoned', next: 'next', later: '' }

const BOX = { cols: 4, w: 126, h: 46, gapX: 22, gapY: 44, pad: 14, lane: 14, gutter: 6 }
const FONT = '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif'

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** White or near-black, whichever reads on `color`. Not a hex colour: white. */
function ink(color: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(color)
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return lum > 0.4 ? '#14181d' : '#ffffff'
}

/** The box, the ink and the line of one mark. `later` is a quiet box, `next` has the work colour on its edge. */
function markStyle(mark: Mark, c: SddColors): { fill: string; stroke: string; ink: string; dash?: string; } {
  const quiet = '#2f3640'
  switch (mark) {
    case 'done': return { fill: c.done, stroke: c.done, ink: ink(c.done) }
    case 'skipped': return { fill: c.dim, stroke: c.dim, ink: ink(c.dim), dash: '4 3' }
    case 'missed': return { fill: c.revoked, stroke: c.revoked, ink: ink(c.revoked), dash: '4 3' }
    case 'active': return { fill: c.work, stroke: c.work, ink: ink(c.work) }
    case 'waiting': return { fill: c.now, stroke: c.now, ink: ink(c.now) }
    case 'blocked': return { fill: c.revoked, stroke: c.revoked, ink: ink(c.revoked) }
    case 'abandoned': return { fill: c.dim, stroke: c.dim, ink: ink(c.dim) }
    case 'next': return { fill: quiet, stroke: c.work, ink: '#ffffff' }
    case 'later': return { fill: '#39414b', stroke: c.line, ink: '#b4bec9' }
  }
}

/** Where stage `i` sits: boxes run left to right on the first row, right to left on the next, so the
 *  arrow between two rows is a short drop. */
function boxAt(i: number, count: number): { x: number; y: number; row: number } {
  const cols = Math.min(BOX.cols, count)
  const row = Math.floor(i / cols)
  const c = i % cols
  const col = row % 2 ? cols - 1 - c : c
  return { x: BOX.pad + col * (BOX.w + BOX.gapX), y: BOX.pad + row * (BOX.h + BOX.gapY), row }
}

/** The tooltip of one stage: where it stands, then each gate it holds and when the gate passed. */
function boxTip(flow: SddFlow, item: SddItem, row: StageRow, gates: string[]): string {
  const st = row.stage
  const lines = [`${st.key === st.label ? st.label : `${st.key} · ${st.label}`}: ${MARK_WORD[row.mark] || 'not reached yet'}`]
  if (st.conditional) lines.push('Runs only when there are questions to answer.')
  for (const g of gates) lines.push(item.gates?.[g] ? `Gate passed: ${g} (${when(item.gates[g])} UTC)` : `Gate open: ${g}`)
  if (st.reworkTo) lines.push(`A rejected review goes back to ${st.reworkTo}.`)
  return lines.join('\n')
}

export function flowMap(flow: SddFlow, item: SddItem, rows: StageRow[], derived: string[], colors: SddColors,
  pending: { gate: string; key: string } | null): FlowMap {
  const n = rows.length
  const cols = Math.min(BOX.cols, Math.max(n, 1))
  const rowCount = Math.max(Math.ceil(n / cols), 1)
  const width = BOX.pad * 2 + cols * BOX.w + (cols - 1) * BOX.gapX
  const height = BOX.pad + rowCount * BOX.h + (rowCount - 1) * BOX.gapY + BOX.lane * 2
  const isPhase = flow.stages.every(s => /^Phase\s+\d+$/i.test(s.key))
  const at = rows.map((_, i) => boxAt(i, n))
  const parts: string[] = []

  // arrows first, so a box covers the end of its own line
  const arrow = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${esc(color)}"/></marker>`
  parts.push(`<defs>${arrow('go', colors.line)}${arrow('gone', colors.done)}${arrow('back', colors.dim)}</defs>`)
  for (let i = 0; i + 1 < n; i++) {
    const a = at[i]
    const b = at[i + 1]
    const walked = rows[i].mark === 'done' || rows[i].mark === 'skipped'
    const color = walked ? colors.done : colors.line
    const head = walked ? 'gone' : 'go'
    if (a.row === b.row) {
      const dir = a.row % 2 ? -1 : 1
      const y = a.y + BOX.h / 2
      const x1 = dir === 1 ? a.x + BOX.w : a.x
      const x2 = dir === 1 ? b.x : b.x + BOX.w
      parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${esc(color)}" stroke-width="2" marker-end="url(#${head})"/>`)
    } else {
      const x = a.x + BOX.w / 2
      parts.push(`<line x1="${x}" y1="${a.y + BOX.h}" x2="${x}" y2="${b.y}" stroke="${esc(color)}" stroke-width="2" marker-end="url(#${head})"/>`)
    }
  }

  // the way back: down to the lane under the row, along it (by the left edge to an earlier row), up into the target
  rows.forEach((r, i) => {
    const to = r.stage.reworkTo ? flow.stages.findIndex(s => s.key === r.stage.reworkTo) : -1
    if (to < 0 || to >= i) return
    const a = at[i]
    const b = at[to]
    const sx = a.x + BOX.w / 2
    const tx = b.x + BOX.w / 2
    const laneA = a.y + BOX.h + BOX.lane
    const laneB = b.y + BOX.h + BOX.lane
    const path = a.row === b.row
      ? `M${sx},${a.y + BOX.h} V${laneA} H${tx} V${b.y + BOX.h + 1}`
      : `M${sx},${a.y + BOX.h} V${laneA} H${BOX.gutter} V${laneB} H${tx} V${b.y + BOX.h + 1}`
    parts.push(`<path d="${path}" fill="none" stroke="${esc(colors.dim)}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#back)"/>`)
    parts.push(`<text x="${tx + 14}" y="${(a.row === b.row ? laneA : laneB) - 4}" font-family="${FONT}" font-size="9" fill="${esc(colors.dim)}">${esc(`rework → ${flow.stages[to].key}`)}</text>`)
  })

  rows.forEach((r, i) => {
    const { x, y } = at[i]
    const st = markStyle(r.mark, colors)
    const gates = decidedGates(r.stage, derived)
    const done = gates.length > 0 && gates.every(g => item.gates?.[g])
    const waitsHere = pending?.key === r.stage.key
    const name = isPhase ? r.stage.key : r.stage.label
    const second = isPhase ? r.stage.label : MARK_WORD[r.mark]
    const here = r.mark === 'active' || r.mark === 'waiting' || r.mark === 'blocked'
    parts.push(`<g><title>${esc(boxTip(flow, item, r, gates))}</title>`)
    if (here) parts.push(`<rect x="${x - 4}" y="${y - 4}" width="${BOX.w + 8}" height="${BOX.h + 8}" rx="11" fill="none" stroke="${esc(st.stroke)}" stroke-width="2"/>`)
    parts.push(`<rect x="${x}" y="${y}" width="${BOX.w}" height="${BOX.h}" rx="8" fill="${esc(st.fill)}" stroke="${esc(st.stroke)}" stroke-width="2"${r.stage.conditional || st.dash ? ` stroke-dasharray="${st.dash ?? '4 3'}"` : ''}/>`)
    parts.push(`<text x="${x + 10}" y="${y + 19}" font-family="${FONT}" font-size="12" font-weight="600" fill="${esc(st.ink)}">${esc(`${GLYPH[r.mark]} ${cut(name, isPhase ? 9 : 14)}`)}</text>`)
    if (second) parts.push(`<text x="${x + 10}" y="${y + 35}" font-family="${FONT}" font-size="10" fill="${esc(st.ink)}" opacity="0.9">${esc(cut(second, 17))}</text>`)
    if (gates.length) {
      const cx = x + BOX.w - 12
      const cy = y + BOX.h - 12
      parts.push(`<path d="M${cx},${cy - 6} L${cx + 6},${cy} L${cx},${cy + 6} L${cx - 6},${cy} z" fill="${done ? esc(st.ink) : 'none'}" stroke="${esc(st.ink)}" stroke-width="${waitsHere ? 2.5 : 1.5}"/>`)
    }
    parts.push('</g>')
  })

  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  const alt = `${flow.label}, ${n} stages: ` + rows.map(r => `${r.stage.label}${MARK_WORD[r.mark] ? ` (${MARK_WORD[r.mark]})` : ''}`).join(', ') + '.'
  return { source, alt, width, height }
}
