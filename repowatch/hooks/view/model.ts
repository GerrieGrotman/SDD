// Pure helpers for the repowatch pane: sorting, wording, paging. No engine calls, so view.test.ts can run them.
import type { RwRepo, RwState, RwSummary } from '../../types'

/** What each flag means, in the order a person should care about it. */
export const FLAGS: Array<{ flag: string; label: string; urgent: boolean }> = [
  { flag: 'error', label: 'cannot read', urgent: true },
  { flag: 'conflicted', label: 'merge conflict', urgent: true },
  { flag: 'diverged', label: 'diverged', urgent: true },
  { flag: 'dirty', label: 'uncommitted', urgent: false },
  { flag: 'behind', label: 'behind', urgent: false },
  { flag: 'unpushed', label: 'unpushed', urgent: false },
  { flag: 'detached', label: 'detached HEAD', urgent: false },
  { flag: 'no-upstream', label: 'no upstream', urgent: false },
  { flag: 'gone-branches', label: 'branches to prune', urgent: false },
  { flag: 'broken-worktree', label: 'broken worktree', urgent: true },
  { flag: 'old-worktree', label: 'old worktree', urgent: false },
  { flag: 'fetch-failed', label: 'fetch failed', urgent: false },
  { flag: 'stale-fetch', label: 'not fetched lately', urgent: false },
]

const RANK = new Map(FLAGS.map((f, i) => [f.flag, i]))

/** A repo's weight for sorting: the most urgent flag it has (lower = first), 99 = nothing. */
export function rank(r: RwRepo): number {
  return r.flags.reduce((best, f) => Math.min(best, RANK.get(f) ?? 50), 99)
}

/** Needs a look, not counting a stale fetch alone (that is noise at scale). */
export function needsAttention(r: RwRepo): boolean {
  return r.flags.some(f => f !== 'stale-fetch')
}

export function sortRepos(repos: RwRepo[]): RwRepo[] {
  return [...repos].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function visibleRepos(state: RwState | null, onlyAttention: boolean): RwRepo[] {
  const all = Object.values(state?.repos ?? {})
  return sortRepos(onlyAttention ? all.filter(needsAttention) : all)
}

export function flagLabel(flag: string): string {
  return FLAGS.find(f => f.flag === flag)?.label ?? flag
}

export function isUrgent(flag: string): boolean {
  return FLAGS.find(f => f.flag === flag)?.urgent ?? false
}

/** The status line: empty when everything is fine, so the line stays clear. */
export function statusText(s: RwSummary | undefined): string | undefined {
  if (!s || s.repos === 0) return undefined
  const parts: string[] = []
  if (s.errors) parts.push(`${s.errors} unreadable`)
  if (s.behind) parts.push(`${s.behind} behind`)
  if (s.dirty) parts.push(`${s.dirty} dirty`)
  if (s.unpushed) parts.push(`${s.unpushed} unpushed`)
  if (s.oldWorktrees) parts.push(`${s.oldWorktrees} old worktree${s.oldWorktrees === 1 ? '' : 's'}`)
  return parts.length ? `repos ${s.repos} · ${parts.join(' · ')}` : `repos ${s.repos} · all clear`
}

export function ago(epochSeconds: number | null | undefined, nowSeconds: number): string {
  if (!epochSeconds) return 'never'
  const d = Math.max(0, nowSeconds - epochSeconds)
  if (d < 90) return 'just now'
  if (d < 3600 * 1.5) return `${Math.round(d / 60)}m ago`
  if (d < 86400 * 1.5) return `${Math.round(d / 3600)}h ago`
  return `${Math.round(d / 86400)}d ago`
}

/** `main +2/-1`, or the branch alone when level with its upstream. */
export function branchText(r: RwRepo): string {
  const where = r.detached ? '(detached)' : r.branch ?? '?'
  return r.ahead || r.behind ? `${where} +${r.ahead ?? 0}/-${r.behind ?? 0}` : where
}

export function page<T>(rows: T[], offset: number, size: number): { rows: T[]; from: number; to: number; total: number } {
  const total = rows.length
  const from = Math.min(Math.max(0, offset), Math.max(0, total - 1))
  const slice = rows.slice(from, from + Math.max(1, size))
  return { rows: slice, from: total ? from + 1 : 0, to: from + slice.length, total }
}
