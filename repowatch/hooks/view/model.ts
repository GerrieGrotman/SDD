// Pure helpers for the repowatch pane: sorting, wording, paging. No engine calls, so view.test.ts can run them.
import type { RwForecast, RwPlan, RwRepo, RwState, RwSummary, RwUndo, RwWorktree, WorktreeClass } from '../../types'

/** What each flag means, in the order a person should care about it. */
export const FLAGS: Array<{ flag: string; label: string; urgent: boolean }> = [
  { flag: 'error', label: 'cannot read', urgent: true },
  { flag: 'conflicted', label: 'merge conflict', urgent: true },
  { flag: 'diverged', label: 'diverged', urgent: true },
  { flag: 'will-conflict', label: 'will conflict', urgent: true },
  { flag: 'dirty', label: 'uncommitted', urgent: false },
  { flag: 'behind', label: 'behind', urgent: false },
  { flag: 'unpushed', label: 'unpushed', urgent: false },
  { flag: 'detached', label: 'detached HEAD', urgent: false },
  { flag: 'no-upstream', label: 'no upstream', urgent: false },
  { flag: 'gone-branches', label: 'branches to prune', urgent: false },
  { flag: 'broken-worktree', label: 'broken worktree', urgent: true },
  { flag: 'removable-worktree', label: 'worktrees to remove', urgent: false },
  { flag: 'old-worktree', label: 'worktrees to review', urgent: false },
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
  if (s.conflicts) parts.push(`${s.conflicts} will conflict`)
  if (s.behind) parts.push(`${s.behind} behind`)
  if (s.dirty) parts.push(`${s.dirty} dirty`)
  if (s.unpushed) parts.push(`${s.unpushed} unpushed`)
  if (s.removable) parts.push(`${s.removable} worktree${s.removable === 1 ? '' : 's'} to remove`)
  if (s.toReview) parts.push(`${s.toReview} to review`)
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

// ---- worktrees

export type WtRow = { repo: string; wt: RwWorktree }

const CLASS_ORDER: WorktreeClass[] = ['safe', 'prune', 'review', 'keep', 'ok']
const CLASS_LABEL: Record<WorktreeClass, string> = { safe: 'safe to remove', prune: 'broken', review: 'review', keep: 'keep', ok: 'in use' }

export function classLabel(c: WorktreeClass): string {
  return CLASS_LABEL[c]
}

/** Every worktree of every repo, the ones to act on first. */
export function worktreeRows(state: RwState | null, hideInUse: boolean): WtRow[] {
  const rows: WtRow[] = []
  for (const r of Object.values(state?.repos ?? {})) for (const wt of r.worktrees ?? []) rows.push({ repo: r.name, wt })
  return rows
    .filter(x => !hideInUse || x.wt.class !== 'ok')
    .sort((a, b) => CLASS_ORDER.indexOf(a.wt.class) - CLASS_ORDER.indexOf(b.wt.class)
      || a.repo.localeCompare(b.repo) || (a.wt.branch ?? '').localeCompare(b.wt.branch ?? ''))
}

/** The rows a bulk clean-up may take: safe, and not an sdd work item's (sdd removes those). */
export function bulkRows(rows: WtRow[]): WtRow[] {
  return rows.filter(x => x.wt.class === 'safe' && x.wt.owner !== 'sdd')
}

/** The arguments of `repowatch.py plan|apply` for a row's button. Null = no button. */
export function actionArgs(row: WtRow): string[] | null {
  const { wt } = row
  if (wt.owner === 'sdd') return null
  if (wt.class === 'prune') return ['prune-worktrees', '--repo', row.repo]
  if (wt.class === 'safe' || wt.class === 'review') {
    return ['remove-worktree', '--repo', row.repo, '--path', wt.path, ...(wt.branch ? ['--delete-branch'] : [])]
  }
  return null
}

/** The same arguments from a plan, for `apply`. */
export function planArgs(plan: RwPlan): string[] {
  if (plan.action === 'undo') return ['undo', '--repo', plan.repo, '--id', plan.undoId ?? '']
  if (plan.action === 'prune-worktrees') return ['prune-worktrees', '--repo', plan.repo]
  if (plan.action === 'delete-branch') return ['delete-branch', '--repo', plan.repo, '--branch', plan.branch ?? '']
  return ['remove-worktree', '--repo', plan.repo, '--path', plan.path ?? '', ...(plan.steps.some(s => s[1] === 'branch') ? ['--delete-branch'] : [])]
}

/** One prune per repo, however many broken rows it has. */
export function dedupePrune(rows: WtRow[]): WtRow[] {
  const seen = new Set<string>()
  return rows.filter(x => {
    if (x.wt.class !== 'prune') return true
    if (seen.has(x.repo)) return false
    seen.add(x.repo)
    return true
  })
}

/** What the confirm panel says to do with a set of plans. */
export function planGist(plans: RwPlan[]): { run: RwPlan[]; skipped: RwPlan[]; review: number } {
  const run = plans.filter(p => p.level !== 'blocked')
  return { run, skipped: plans.filter(p => p.level === 'blocked'), review: run.filter(p => p.level === 'review').length }
}

export function stepText(step: string[]): string {
  return step.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

export function sddRemoveText(id: number | null | undefined): string {
  return `Remove the sdd environment for work item ${id ?? '?'}: run env.py remove --id ${id ?? '?'} and show me the dry run first.`
}

// ---- merge-conflict forecast, undo

/** "will conflict in a.cs, b.cs (+2 more)"; '' when there is nothing to say. */
export function forecastText(f: RwForecast | undefined): string {
  if (!f || f.state !== 'conflict') return ''
  const files = f.files ?? []
  const shown = files.slice(0, 3).join(', ')
  return `merging ${f.base} in would conflict${shown ? ` in ${shown}` : ''}${files.length > 3 ? ` (+${files.length - 3} more)` : ''}`
}

/** "3 behind origin/main, 1 ahead"; '' when the worktree has no base to measure against. */
export function baseText(w: RwWorktree): string {
  if (!w.baseRef || w.behindBase == null) return ''
  return `${w.behindBase} behind ${w.baseRef}, ${w.aheadBase ?? 0} ahead`
}

/** Branches whose forecast turned to conflict between two scans, as "repo · branch". */
export function newConflicts(before: RwState | null, after: RwState | null): string[] {
  if (!before || !after) return []
  const out: string[] = []
  for (const r of Object.values(after.repos)) {
    const was = before.repos[r.name]
    if (r.forecast?.state === 'conflict' && was && was.forecast?.state !== 'conflict') out.push(`${r.name} · ${r.branch ?? 'HEAD'}`)
    for (const w of r.worktrees ?? []) {
      if (w.forecast?.state !== 'conflict' || !was) continue
      const prior = (was.worktrees ?? []).find(x => x.path === w.path)
      if (prior && prior.forecast?.state !== 'conflict') out.push(`${r.name} · ${w.branch ?? '(detached)'}`)
    }
  }
  return out
}

export function conflictToast(before: RwState | null, after: RwState | null): string | null {
  const now = newConflicts(before, after)
  if (!now.length) return null
  return `Will now conflict: ${now.slice(0, 3).join(', ')}${now.length > 3 ? ` (+${now.length - 3} more)` : ''}`
}

/** What to ask Claude when a worktree's branch would conflict with its base. */
export function mergeAskText(row: WtRow): string {
  const w = row.wt
  const files = w.forecast?.files ?? []
  return `In the worktree ${w.path} (branch ${w.branch ?? 'HEAD'}), merge ${w.baseRef ?? 'the base branch'} in and resolve the conflicts${files.length ? ` in ${files.join(', ')}` : ''}. Show me the plan first, and do not push.`
}

export function undoArgs(u: RwUndo): string[] {
  return ['undo', '--repo', u.repo, '--id', u.id]
}

export function undoLabel(u: RwUndo): string {
  const what = u.action === 'delete-branch' ? 'deleted branch' : 'removed worktree'
  return `Undo: ${what} ${u.branch ?? u.path ?? ''} (${u.repo})`
}
