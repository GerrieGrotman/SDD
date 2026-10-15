export type RwWorktree = {
  path: string
  branch: string | null
  head: string
  detached: boolean
  locked: boolean
  prunable: boolean
  missing: boolean
  dirty?: number
  ahead?: number
  behind?: number
  upstream?: string | null
  /** Epoch seconds of the newest commit. */
  lastCommit?: number
  /** safe: nothing is lost by removing it. review: probably done. keep: work only here. ok: in use. prune: folder gone. */
  class: WorktreeClass
  reasons: string[]
  /** Commits on no remote branch, and the newest few subjects. */
  unique?: number
  atRisk?: string[]
  merged?: boolean
  gone?: boolean
  /** The base it is measured against (sdd's recorded base, else the default branch), and how far apart they are. */
  baseRef?: string
  behindBase?: number
  aheadBase?: number
  forecast?: RwForecast
  /** 'sdd' when it is a work item's worktree (sdd removes those); 'sync' when a branch sync made it. */
  owner?: 'sdd' | 'sync'
  workItem?: number | null
}

/** Would merging the base branch in conflict? From `git merge-tree`, cached by the two shas. */
export type RwForecast = {
  state: 'clean' | 'conflict' | 'unavailable' | 'error'
  base: string
  files?: string[]
  error?: string
}

export type RwSyncCommit = {
  sha: string
  time: number
  author: string
  subject: string
  /** missing: the newer branch lacks it. applied: it has it (same sha or same patch). skipped: you marked it "do not take". */
  state: 'missing' | 'applied' | 'skipped'
  workItems: number[]
  reason?: string
  pr?: number
}

/** The commits of one ADO work item (else one PR, else one commit) that a hop has not carried over in full. */
export type RwSyncFix = {
  key: string
  workItems: number[]
  title: string
  state: 'missing' | 'partial' | 'skipped' | 'applied'
  commits: RwSyncCommit[]
}

/** From one team branch to the next newer one. */
export type RwSyncHop = {
  from: string
  to: string
  missing?: number
  applied?: number
  skipped?: number
  outsideWindow?: number
  fixes?: RwSyncFix[]
  truncated?: boolean
  /** merge, or cherry-pick once a commit was marked "do not take". */
  mode?: 'merge' | 'cherry-pick'
  /** Would merging `from` into `to` conflict? */
  forecast?: RwForecast
  /** A sync of this hop waits in a worktree: 'conflict' until the merge is resolved and committed, then 'ready'. */
  inProgress?: { path: string; branch: string; state: 'conflict' | 'ready' }
  /** The sync branch is on origin (its pull request is the next step). */
  pushed?: string
  error?: string
}

export type RwSyncState = {
  generated: number
  repos: Record<string, { branches: string[]; hops: RwSyncHop[] }>
  summary: { repos: number; hopsPending: number; fixesPending: number; conflictHops: number }
}

/** One line of `git log --graph`: a commit with its fields, or only the connecting lines of the drawing. */
export type RwGraphRow = {
  /** git's own lane drawing for the line: `* | `, `|\\`, `|/` ... */
  graph: string
  sha?: string
  parents?: string[]
  author?: string
  /** Epoch seconds. */
  time?: number
  refs?: Array<{ name: string; kind: 'head' | 'local' | 'remote' | 'tag' }>
  subject?: string
  merge?: boolean
  /** With a base: only on the branch, only on the base, or on both. */
  side?: 'branch' | 'base' | 'both'
}

/** The history the pane shows, and how to ask for it again. */
export type RwGraph = {
  repo: string
  title: string
  /** The branch first, then (optionally) its base. */
  refs: string[]
  withBase: boolean
  firstParent: boolean
  limit: number
  rows: RwGraphRow[]
  more: boolean
  /** The view the Back button returns to. */
  back: 'repos' | 'worktrees' | 'sync'
}

/** A finished clean-up that can be put back. */
export type RwUndo = { id: string; at: number; action: string; repo: string; path: string | null; branch: string | null }

export type WorktreeClass = 'safe' | 'review' | 'keep' | 'ok' | 'prune'

/** What an action would do, built from the live repo by `repowatch.py plan`. */
export type RwPlan = {
  action: 'remove-worktree' | 'prune-worktrees' | 'delete-branch' | 'undo' | SyncAction
  repo: string
  path: string | null
  branch: string | null
  level: 'safe' | 'review' | 'blocked'
  blocked: string[]
  reasons: string[]
  atRisk: string[]
  steps: string[][]
  restore: string[]
  /** With undo: the journal id it puts back. */
  undoId?: string
  /** With a sync action: the two branches, the commit a skip is about, and how the hop is done. */
  hop?: [string, string]
  decision?: { sha: string; subject: string; reason: string }
  mode?: 'merge' | 'cherry-pick'
  owner?: 'sdd' | 'sync'
  workItem?: number | null
}

export type SyncAction = 'sync-hop' | 'sync-finish' | 'sync-abort' | 'sync-skip' | 'sync-unskip'

export type RwResult = {
  ok: boolean
  error?: string
  done: string[][]
  plan: RwPlan
  /** With a sync action: pr = pull request opened, conflict = left for someone to resolve, pushed = pushed without a PR, ready. */
  state?: 'pr' | 'conflict' | 'pushed' | 'ready'
  pr?: { id: number; url: string }
  branch?: string
  worktree?: string
  files?: string[]
}

export type RwRepo = {
  name: string
  path: string
  scannedAt: number
  error?: string
  fetchError?: string
  branch?: string | null
  detached?: boolean
  upstream?: string | null
  ahead?: number
  behind?: number
  staged?: number
  unstaged?: number
  untracked?: number
  conflicted?: number
  dirty?: number
  defaultBranch?: string | null
  /** Epoch seconds; null = never fetched. */
  lastFetch?: number | null
  stashes?: number
  branches?: number
  goneBranches?: string[]
  /** Set when the branch and its upstream have diverged: would merging the upstream in conflict? */
  forecast?: RwForecast
  worktrees?: RwWorktree[]
  /** Words for what needs a person's eye; empty = nothing. */
  flags: string[]
}

export type RwSummary = {
  repos: number
  attention: number
  behind: number
  dirty: number
  unpushed: number
  worktrees: number
  /** Worktrees classed safe or prune. */
  removable: number
  /** Worktrees classed review. */
  toReview: number
  /** Worktrees and repos whose merge would conflict. */
  conflicts: number
  errors: number
}

export type RwState = {
  version: number
  generated: number
  root?: string
  summary?: RwSummary
  undoable?: RwUndo[]
  /** Branch sync, from `repowatch.py sync`; absent until it has run. */
  sync?: RwSyncState
  repos: Record<string, RwRepo>
}

declare module 'claude-code' {
  interface PluginState {
    repowatch: {
      state: RwState | null
      error: string | null
      /** What the last thing the person pressed said when it could not be done (the background refresh never clears it). */
      note: string | null
      /** Show only repos that need attention. */
      onlyAttention: boolean
      /** Path of the one worktree the Worktrees list shows, or null for all. */
      focus: string | null
      /** First row of the page shown. */
      offset: number
      /** The repo whose details are open, or null. */
      open: string | null
      /** A scan, fetch or clean-up is running. */
      busy: string | null
      /** What the pane lists: the repos, or every worktree. */
      view: 'repos' | 'worktrees' | 'sync' | 'graph'
      /** Plans waiting for the person's confirm; null = none. */
      plans: RwPlan[] | null
      /** The history graph being shown, or null. */
      graph: RwGraph | null
      /** The commit whose details are open in the graph, and what `show` said about it. */
      commit: { sha: string; text: string } | null
    }
  }
}
