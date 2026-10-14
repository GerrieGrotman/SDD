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
  oldWorktrees: number
  errors: number
}

export type RwState = {
  version: number
  generated: number
  root?: string
  summary?: RwSummary
  repos: Record<string, RwRepo>
}

declare module 'claude-code' {
  interface PluginState {
    repowatch: {
      state: RwState | null
      error: string | null
      /** Show only repos that need attention. */
      onlyAttention: boolean
      /** First row of the page shown. */
      offset: number
      /** The repo whose details are open, or null. */
      open: string | null
      /** A scan or fetch is running. */
      busy: string | null
    }
  }
}
