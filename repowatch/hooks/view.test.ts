import { expect, test } from 'claude-code/testing'

import type { RwPlan, RwRepo, RwResult, RwSummary, RwSyncFix, RwSyncState, RwWorktree, WorktreeClass } from '../types'
import { actionArgs, ago, baseText, resolveAskText, resultLine, syncArgs, fixGlyph, fixLine, hopKey, hopLine, hopRows, branchText, conflictToast, forecastText, mergeAskText, newConflicts, undoLabel, bulkRows, dedupePrune, needsAttention, page, planArgs, planGist, sddRemoveText, sortRepos, statusText, stepText, visibleRepos, worktreeRows } from './view/model'

const repo = (name: string, flags: string[], extra: Partial<RwRepo> = {}): RwRepo => ({ name, path: `/ws/${name}`, scannedAt: 0, flags, ...extra })

test('repos sort by the most urgent flag, then by name', () => {
  const sorted = sortRepos([repo('z', []), repo('b', ['behind']), repo('a', ['dirty']), repo('c', ['conflicted'])])
  expect(sorted.map(r => r.name)).toEqual(['c', 'a', 'b', 'z'])
})

test('a stale fetch alone is not worth a look', () => {
  expect(needsAttention(repo('a', ['stale-fetch']))).toBe(false)
  expect(needsAttention(repo('a', ['stale-fetch', 'dirty']))).toBe(true)
})

test('the attention filter hides clean repos', () => {
  const state = { version: 1, generated: 0, repos: { a: repo('a', []), b: repo('b', ['behind']) } }
  expect(visibleRepos(state, true).map(r => r.name)).toEqual(['b'])
  expect(visibleRepos(state, false).map(r => r.name)).toEqual(['b', 'a'])
  expect(visibleRepos(null, true)).toEqual([])
})

test('the status line says what needs doing, and stays clear for no repos', () => {
  const s: RwSummary = { repos: 40, attention: 3, behind: 2, dirty: 1, unpushed: 0, worktrees: 5, removable: 2, toReview: 1, conflicts: 0, errors: 0 }
  expect(statusText(s)).toBe('repos 40 · 2 behind · 1 dirty · 2 worktrees to remove · 1 to review')
  expect(statusText({ ...s, behind: 0, dirty: 0, removable: 0, toReview: 0 })).toBe('repos 40 · all clear')
  expect(statusText({ ...s, repos: 0 })).toBe(undefined)
  expect(statusText(undefined)).toBe(undefined)
})

test('times and branches read plainly', () => {
  expect(ago(null, 1000)).toBe('never')
  expect(ago(1000 - 30, 1000)).toBe('just now')
  expect(ago(1000 - 7200, 1000)).toBe('2h ago')
  expect(ago(1000 - 86400 * 3, 1000)).toBe('3d ago')
  expect(branchText(repo('a', [], { branch: 'main' }))).toBe('main')
  expect(branchText(repo('a', [], { branch: 'main', ahead: 2, behind: 1 }))).toBe('main +2/-1')
  expect(branchText(repo('a', [], { detached: true }))).toBe('(detached)')
})

test('paging clamps to the rows there are', () => {
  const rows = [1, 2, 3, 4, 5]
  expect(page(rows, 0, 2)).toEqual({ rows: [1, 2], from: 1, to: 2, total: 5 })
  expect(page(rows, 4, 2)).toEqual({ rows: [5], from: 5, to: 5, total: 5 })
  expect(page(rows, 99, 2).rows).toEqual([5])
  expect(page([], 0, 2)).toEqual({ rows: [], from: 0, to: 0, total: 0 })
})

const wt = (cls: WorktreeClass, extra: Partial<RwWorktree> = {}): RwWorktree =>
  ({ path: `/w/${extra.branch ?? cls}`, branch: extra.branch ?? cls, head: 'abc', detached: false, locked: false, prunable: false, missing: false, class: cls, reasons: [], ...extra })

test('worktrees list the ones to act on first, and can hide those in use', () => {
  const state = { version: 1, generated: 0, repos: {
    b: { ...repo('b', []), worktrees: [wt('ok'), wt('safe', { branch: 'z' })] },
    a: { ...repo('a', []), worktrees: [wt('keep'), wt('review'), wt('safe', { branch: 'y' }), wt('prune')] },
  } }
  expect(worktreeRows(state, false).map(r => `${r.repo}:${r.wt.class}`)).toEqual(['a:safe', 'b:safe', 'a:prune', 'a:review', 'a:keep', 'b:ok'])
  expect(worktreeRows(state, true).some(r => r.wt.class === 'ok')).toBe(false)
  expect(worktreeRows(null, false)).toEqual([])
})

test('a row gets a button only when there is something safe to do, and sdd keeps its own', () => {
  expect(actionArgs({ repo: 'a', wt: wt('safe', { branch: 'f' }) })).toEqual(['remove-worktree', '--repo', 'a', '--path', '/w/f', '--delete-branch'])
  expect(actionArgs({ repo: 'a', wt: wt('review', { branch: 'f' }) })?.[0]).toBe('remove-worktree')
  expect(actionArgs({ repo: 'a', wt: wt('prune') })).toEqual(['prune-worktrees', '--repo', 'a'])
  expect(actionArgs({ repo: 'a', wt: wt('keep') })).toBe(null)
  expect(actionArgs({ repo: 'a', wt: wt('ok') })).toBe(null)
  expect(actionArgs({ repo: 'a', wt: wt('safe', { owner: 'sdd', workItem: 77 }) })).toBe(null)
  expect(bulkRows([{ repo: 'a', wt: wt('safe') }, { repo: 'a', wt: wt('safe', { owner: 'sdd' }) }, { repo: 'a', wt: wt('review') }]).length).toBe(1)
  expect(dedupePrune([{ repo: 'a', wt: wt('prune', { branch: '1' }) }, { repo: 'a', wt: wt('prune', { branch: '2' }) }, { repo: 'b', wt: wt('prune') }]).length).toBe(2)
})

test('apply gets the arguments its plan was made from', () => {
  const plan = (extra: Partial<RwPlan>): RwPlan => ({ action: 'remove-worktree', repo: 'a', path: '/w/f', branch: 'f', level: 'safe', blocked: [], reasons: [], atRisk: [], steps: [], restore: [], ...extra })
  expect(planArgs(plan({ steps: [['git', 'worktree', 'remove', '/w/f'], ['git', 'branch', '-D', 'f']] }))).toEqual(['remove-worktree', '--repo', 'a', '--path', '/w/f', '--delete-branch'])
  expect(planArgs(plan({ steps: [['git', 'worktree', 'remove', '/w/f']] }))).toEqual(['remove-worktree', '--repo', 'a', '--path', '/w/f'])
  expect(planArgs(plan({ action: 'prune-worktrees' }))).toEqual(['prune-worktrees', '--repo', 'a'])
  expect(planArgs(plan({ action: 'delete-branch' }))).toEqual(['delete-branch', '--repo', 'a', '--branch', 'f'])
})

test('the confirm panel runs what is still allowed and says what it skips', () => {
  const p = (level: RwPlan['level']): RwPlan => ({ action: 'remove-worktree', repo: 'a', path: '/x', branch: null, level, blocked: [], reasons: [], atRisk: [], steps: [], restore: [] })
  const g = planGist([p('safe'), p('review'), p('blocked')])
  expect([g.run.length, g.skipped.length, g.review]).toEqual([2, 1, 1])
  expect(stepText(['git', 'worktree', 'remove', '/a b/c'])).toBe('git worktree remove "/a b/c"')
  expect(sddRemoveText(77)).toContain('env.py remove --id 77')
})

test('a forecast reads as the files that would conflict', () => {
  expect(forecastText({ state: 'clean', base: 'origin/main' })).toBe('')
  expect(forecastText(undefined)).toBe('')
  expect(forecastText({ state: 'conflict', base: 'origin/main', files: ['a.cs', 'b.cs'] })).toBe('merging origin/main in would conflict in a.cs, b.cs')
  expect(forecastText({ state: 'conflict', base: 'origin/team/1', files: ['a', 'b', 'c', 'd', 'e'] })).toBe('merging origin/team/1 in would conflict in a, b, c (+2 more)')
  expect(baseText(wt('ok', { baseRef: 'origin/main', behindBase: 3, aheadBase: 1 }))).toBe('3 behind origin/main, 1 ahead')
  expect(baseText(wt('ok'))).toBe('')
  expect(statusText({ repos: 4, attention: 1, behind: 0, dirty: 0, unpushed: 0, worktrees: 1, removable: 0, toReview: 0, conflicts: 2, errors: 0 })).toBe('repos 4 · 2 will conflict')
})

test('a toast fires when a branch turns to conflict, not while it stays one', () => {
  const state = (cls: 'clean' | 'conflict') => ({ version: 1, generated: 0, repos: { a: { ...repo('a', []), worktrees: [
    wt('ok', { branch: 'f', path: '/w/f', forecast: { state: cls, base: 'origin/main', files: [] } })] } } })
  expect(newConflicts(state('clean'), state('conflict'))).toEqual(['a · f'])
  expect(newConflicts(state('conflict'), state('conflict'))).toEqual([])
  expect(newConflicts(null, state('conflict'))).toEqual([])
  expect(conflictToast(state('clean'), state('conflict'))).toBe('Will now conflict: a · f')
  expect(conflictToast(state('clean'), state('clean'))).toBe(null)
  const diverged = (cls: 'clean' | 'conflict') => ({ version: 1, generated: 0, repos: { a: { ...repo('a', []), branch: 'main', forecast: { state: cls, base: 'origin/main' } } } })
  expect(newConflicts(diverged('clean'), diverged('conflict'))).toEqual(['a · main'])
})

test('undo and the ask for a merge say what they do', () => {
  const plan: RwPlan = { action: 'undo', repo: 'a', path: null, branch: null, level: 'safe', blocked: [], reasons: [], atRisk: [], steps: [], restore: [], undoId: '17' }
  expect(planArgs(plan)).toEqual(['undo', '--repo', 'a', '--id', '17'])
  expect(undoLabel({ id: '17', at: 1, action: 'delete-branch', repo: 'a', path: null, branch: 'old' })).toBe('Undo: deleted branch old (a)')
  const row = { repo: 'a', wt: wt('ok', { branch: 'f', baseRef: 'origin/main', forecast: { state: 'conflict' as const, base: 'origin/main', files: ['x.cs'] } }) }
  expect(mergeAskText(row)).toContain('merge origin/main in and resolve the conflicts in x.cs')
})

const fix = (key: string, state: RwSyncFix['state'], extra: Partial<RwSyncFix> = {}): RwSyncFix =>
  ({ key, workItems: [], title: `fix ${key}`, state, commits: [{ sha: 'a', time: 0, author: 'x', subject: 's', state: state === 'partial' ? 'missing' : state === 'applied' ? 'applied' : state, workItems: [] }], ...extra })
const SYNC: RwSyncState = { generated: 1, summary: { repos: 2, hopsPending: 2, fixesPending: 3, conflictHops: 1 }, repos: {
  b: { branches: ['team/1', 'team/2'], hops: [{ from: 'team/1', to: 'team/2', missing: 2, skipped: 0, fixes: [fix('ADO 1', 'missing'), fix('ADO 2', 'missing')] }] },
  a: { branches: ['team/1', 'team/2', 'team/3'], hops: [
    { from: 'team/1', to: 'team/2', missing: 1, skipped: 1, fixes: [fix('ADO 9', 'missing'), fix('x', 'skipped')], forecast: { state: 'conflict', base: 'origin/team/1', files: ['a'] } },
    { from: 'team/2', to: 'team/3', missing: 0, skipped: 0, fixes: [] },
  ] },
} }

test('hops with fixes missing come first, conflicting ones before the rest', () => {
  expect(hopRows(SYNC, true).map(hopKey)).toEqual(['a:team/1', 'b:team/1'])
  expect(hopRows(SYNC, false).map(hopKey)).toEqual(['a:team/1', 'b:team/1', 'a:team/2'])
  expect(hopRows(undefined, true)).toEqual([])
})

test('a hop and a fix say what is still open', () => {
  expect(hopLine(SYNC.repos.b.hops[0])).toBe('2 commits in 2 fixes')
  expect(hopLine(SYNC.repos.a.hops[0])).toBe('1 commit in 1 fix, 1 skipped')
  expect(hopLine(SYNC.repos.a.hops[1])).toBe('up to date')
  expect(hopLine({ from: 'a', to: 'b', error: 'git cherry failed' })).toBe('git cherry failed')
  expect(fixGlyph(fix('k', 'partial'))).toBe('◐')
  expect(fixLine(fix('k', 'missing', { workItems: [4471, 4472], title: 'Fix the thing' }))).toBe('ADO 4471, 4472  Fix the thing')
  const two = fix('k', 'partial', { commits: [{ sha: 'a', time: 0, author: 'x', subject: 's', state: 'missing', workItems: [] }, { sha: 'b', time: 0, author: 'x', subject: 's', state: 'applied', workItems: [] }] })
  expect(fixLine(two)).toContain('(1 of 2 commits open)')
  expect(statusText({ repos: 4, attention: 0, behind: 0, dirty: 0, unpushed: 0, worktrees: 0, removable: 0, toReview: 0, conflicts: 0, errors: 0 }, SYNC.summary)).toBe('repos 4 · 2 to sync')
})

test('sync buttons ask for the right plan, and a plan applies with the same arguments', () => {
  const hop = { from: 'team/0.0.1', to: 'team/0.0.2' }
  expect(syncArgs('sync-hop', 'app', hop)).toEqual(['sync-hop', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2'])
  expect(syncArgs('sync-skip', 'app', hop, 'abc')).toEqual(['sync-skip', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2', '--sha', 'abc'])
  const plan = (extra: Partial<RwPlan>): RwPlan => ({ action: 'sync-hop', repo: 'app', path: null, branch: null, level: 'safe', blocked: [], reasons: [], atRisk: [], steps: [], restore: [], hop: ['team/0.0.1', 'team/0.0.2'], ...extra })
  expect(planArgs(plan({}))).toEqual(['sync-hop', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2'])
  expect(planArgs(plan({ action: 'sync-skip', decision: { sha: 'abc', subject: 's', reason: 'only for 0.0.1' } })))
    .toEqual(['sync-skip', '--repo', 'app', '--hop', 'team/0.0.1:team/0.0.2', '--sha', 'abc', '--reason', 'only for 0.0.1'])
})

test('what a sync did is told in one line, and a conflict says where to go', () => {
  const r = (extra: Partial<RwResult>): RwResult => ({ ok: true, done: [], plan: {} as RwPlan, ...extra })
  expect(resultLine(r({ state: 'pr', pr: { id: 7, url: 'u' }, branch: 'sync/1-2' }))).toBe('PR 7 opened for sync/1-2')
  expect(resultLine(r({ state: 'conflict', files: ['a', 'b'], worktree: '/w' }))).toBe('Conflicts in a, b: resolve them in /w')
  expect(resultLine(r({ ok: false, error: 'push failed' }))).toBe('push failed')
  const row = { repo: 'app', hop: { from: 'team/1', to: 'team/2', inProgress: { path: '/w', branch: 'sync/1-2', state: 'conflict' as const }, forecast: { state: 'conflict' as const, base: 'x', files: ['a.cs'] } } }
  expect(resolveAskText(row)).toContain('sync of team/1 into team/2 stopped on conflicts in a.cs')
  expect(resolveAskText(row)).toContain('Do not push')
  expect(actionArgs({ repo: 'a', wt: wt('safe', { owner: 'sync' }) })).toBe(null)
})
