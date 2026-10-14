import { expect, test } from 'claude-code/testing'

import type { RwRepo, RwSummary } from '../types'
import { ago, branchText, needsAttention, page, sortRepos, statusText, visibleRepos } from './view/model'

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
  const s: RwSummary = { repos: 40, attention: 3, behind: 2, dirty: 1, unpushed: 0, worktrees: 5, oldWorktrees: 1, errors: 0 }
  expect(statusText(s)).toBe('repos 40 · 2 behind · 1 dirty · 1 old worktree')
  expect(statusText({ ...s, behind: 0, dirty: 0, oldWorktrees: 0 })).toBe('repos 40 · all clear')
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
