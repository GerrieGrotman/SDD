// Pure helpers for the Worktrees page: join the work items of the sdd snapshot to repowatch's live scan
// of their worktrees, order them, and word each line. No engine calls, so view.test.ts can run them.
import type { SddItem, SddLiveState, SddLiveWorktree } from '../../types'

export type WtLine = {
  item: SddItem
  repo: string
  branch: string
  base: string
  prId: number | null
  /** repowatch's scan of this worktree; null = it has not seen it. */
  live: SddLiveWorktree | null
  /** The repo's name in repowatch's scan when it has seen the worktree, else the work item's own name for it. */
  repoName: string
}

/** A path as a key: forward slashes, no trailing slash, and lower case when it starts with a drive letter. */
export function pathKey(p: string): string {
  const q = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(q) ? q.toLowerCase() : q
}

/** One line per repo of every work item that still has a folder, joined to the live worktree by path. */
export function joinWorktrees(items: SddItem[], live: SddLiveState | null): WtLine[] {
  const byPath = new Map<string, { w: SddLiveWorktree; repo: string }>()
  for (const [name, r] of Object.entries(live?.repos ?? {})) for (const w of r.worktrees ?? []) byPath.set(pathKey(w.path), { w, repo: name })
  const out: WtLine[] = []
  for (const item of items) {
    if (item.removed || !item.folder) continue
    for (const [repo, r] of Object.entries(item.repos ?? {})) {
      const seen = byPath.get(pathKey(`${item.folder}/${r.path}`))
      out.push({ item, repo, branch: r.branch, base: r.base, prId: r.pr?.id ?? null, live: seen?.w ?? null, repoName: seen?.repo ?? repo })
    }
  }
  return out
}

const CLEANUP = new Set(['safe', 'prune', 'review'])

/** Lines to clean up or that will conflict first, then work that waits on the person, then the rest by latest activity. */
export function sortLines(lines: WtLine[]): WtLine[] {
  const rank = (l: WtLine) => (l.live?.forecast?.state === 'conflict' || (l.live && CLEANUP.has(l.live.class)) ? 0 : l.item.progress?.status === 'waiting' ? 1 : 2)
  return [...lines].sort((a, b) => rank(a) - rank(b)
    || (b.item.progress?.at ?? '').localeCompare(a.item.progress?.at ?? '') || a.item.id - b.item.id || a.repo.localeCompare(b.repo))
}

/** Items in the order of their first line, with their lines: one block per work item. */
export function groupByItem(lines: WtLine[]): Array<{ item: SddItem; lines: WtLine[] }> {
  const blocks: Array<{ item: SddItem; lines: WtLine[] }> = []
  for (const l of lines) {
    const last = blocks.find(b => b.item.id === l.item.id)
    if (last) last.lines.push(l)
    else blocks.push({ item: l.item, lines: [l] })
  }
  return blocks
}

export function agoText(epochSeconds: number | undefined, nowSeconds: number): string {
  if (!epochSeconds) return 'no commits'
  const d = Math.max(0, nowSeconds - epochSeconds)
  if (d < 3600) return 'last commit just now'
  if (d < 86400 * 1.5) return `last commit ${Math.round(d / 3600)}h ago`
  return `last commit ${Math.round(d / 86400)}d ago`
}

/** What one worktree line says after its branch: base, PR, then the live facts. */
export function lineFacts(l: WtLine, nowSeconds: number): string[] {
  const facts = [`from ${l.base}`]
  if (l.prId != null) facts.push(`PR ${l.prId}`)
  const w = l.live
  if (!w) return [...facts, 'repowatch has not seen it']
  facts.push(w.dirty ? `${w.dirty} uncommitted` : 'clean')
  if (w.ahead || w.behind) facts.push(`+${w.ahead ?? 0}/-${w.behind ?? 0} upstream`)
  if (w.behindBase) facts.push(`${w.behindBase} behind ${w.baseRef ?? 'base'}`)
  facts.push(agoText(w.lastCommit, nowSeconds))
  return facts
}

/** The note after a line's facts when repowatch thinks the worktree can go or needs a look; '' otherwise. */
export function cleanupNote(l: WtLine): string {
  const w = l.live
  if (!w || !CLEANUP.has(w.class)) return ''
  const why = w.reasons[0] ?? ''
  return w.class === 'review' ? `to review: ${why}` : w.class === 'prune' ? `broken: ${why}` : `can be removed: ${why}`
}

/** A line's merge-conflict forecast: the files, or '' when it is clean or unknown. */
export function conflictNote(l: WtLine): string {
  const f = l.live?.forecast
  if (!f || f.state !== 'conflict') return ''
  const files = f.files ?? []
  return `merging ${f.base} in would conflict${files.length ? ` in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3} more)` : ''}` : ''}`
}

export function counts(lines: WtLine[]): { items: number; worktrees: number; cleanup: number; dirty: number; conflicts: number } {
  return {
    items: new Set(lines.map(l => l.item.id)).size,
    worktrees: lines.length,
    cleanup: lines.filter(l => l.live && CLEANUP.has(l.live.class)).length,
    dirty: lines.filter(l => l.live?.dirty).length,
    conflicts: lines.filter(l => l.live?.forecast?.state === 'conflict').length,
  }
}

/** The refs of a line's history: its branch, and what it is measured against (repowatch's base, else origin/<the recorded base>). */
export function historyRefs(l: WtLine): string[] {
  return [l.branch, l.live?.baseRef ?? `origin/${l.base}`]
}

/** The arguments for repowatch's `history` command: the repo, the refs and a title, as JSON so no name needs quoting. */
export function historyArgs(l: WtLine): string {
  const refs = historyRefs(l)
  return 'history ' + JSON.stringify({ repo: l.repoName, refs, title: `${l.item.id} · ${l.repoName} · ${refs[0]} against ${refs[1]}` })
}

/** The colour class of a worktree line: red for a conflict, green to clean up, amber to review or uncommitted, grey otherwise. */
export function lineTone(l: WtLine): 'conflict' | 'cleanup' | 'review' | 'ok' {
  const w = l.live
  if (w?.forecast?.state === 'conflict') return 'conflict'
  if (w && (w.class === 'safe')) return 'cleanup'
  if (w && (w.class === 'review' || w.class === 'prune' || w.dirty)) return 'review'
  return 'ok'
}

/** The word at the end of a list row: short, the colour carries the rest. */
export function lineWord(l: WtLine): string {
  const w = l.live
  if (!w) return 'not scanned'
  if (w.forecast?.state === 'conflict') return 'will conflict'
  if (w.class === 'safe') return 'to clean up'
  if (w.class === 'prune') return 'broken'
  if (w.class === 'review') return 'review'
  return w.dirty ? `${w.dirty} uncommitted` : 'clean'
}

/** The age of the last commit in a few characters: `now`, `5m`, `3h`, `9d`; `-` when unknown. */
export function ageShort(epochSeconds: number | undefined, nowSeconds: number): string {
  if (!epochSeconds) return '-'
  const d = Math.max(0, nowSeconds - epochSeconds)
  if (d < 90) return 'now'
  if (d < 3600 * 1.5) return `${Math.round(d / 60)}m`
  if (d < 86400 * 1.5) return `${Math.round(d / 3600)}h`
  return `${Math.round(d / 86400)}d`
}

/** The key of a line in the page's open-row state. */
export function lineKey(l: WtLine): string {
  return `${l.item.id}:${l.repo}`
}

/** The folder of a line on disk: the work item's folder and the repo's path in it. */
export function linePath(l: WtLine): string {
  return `${l.item.folder}/${l.item.repos?.[l.repo]?.path ?? ''}`.replace(/\/+$/, '')
}
