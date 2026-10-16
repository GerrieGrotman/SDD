// The sdd view's contract: the snapshot `env.py view --json` prints, and the values the view keeps.

export type SddStatus = 'active' | 'waiting' | 'blocked' | 'done' | 'skipped' | 'abandoned'

export type SddProgress = {
  at: string
  flow: string
  phase: string
  status: SddStatus
  gate?: string
  next?: string
  note?: string
  refs?: string[]
  /** With status skipped: the user's own words agreeing to the skip. */
  confirmed?: string
  gates?: { passed: string[]; revoked: string[] }
  /** Open Questions finished with questions still open: what the person chose to leave open. */
  caveat?: string
  /** With caveat: how many questions were still open. */
  openQuestions?: number
}

export type SddRepo = {
  source?: string
  base: string
  version?: string
  branch: string
  path: string
  pr?: { id: number; url: string }
}

export type SddItem = {
  id: number
  type: string
  title: string
  state: string
  project: string
  flow: 'spec' | 'bug' | string
  slug: string
  created: string
  removed?: string
  repos: Record<string, SddRepo>
  gates: Record<string, string>
  progress: SddProgress | null
  folder: string | null
  spec: { folder: string; path: string; files: string[]; tasks_done?: number; tasks_total?: number; questions_open?: number; questions_total?: number } | null
  met: string[]
  url: string | null
  history?: SddProgress[]
  /** What happened to each stage the item went through (env.py stage_record). A stage not in it was never worked. */
  stages?: Record<string, SddStageRecord>
  /** Stages that take feedback now, each with the gates a reopen there revokes (env.py reopen_plan). */
  feedback?: Record<string, string[]>
  /** What the item has cost, per stage, in dollars and tokens (uncached input, output, cache read, cache write), from its cost.jsonl (env.py cost); the record keeps the totals once the folder is gone. */
  spend?: Record<string, { usd: number; turns: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
  /** The way through the flow the user chose (env.py path): 'full' or 'short' for the spec flow; null for
   *  the bug flow, which has one way, or while the spec flow's choice is still open. */
  path?: 'full' | 'short' | string | null
}

export type SddStageRecord = { at: string; status: 'worked' | 'done' | 'skipped'; confirmed?: string; doneAt?: string }

export type SddStage = { key: string; label: string; needs: string[]; passes: string[]; stop?: boolean; reworkTo?: string; conditional?: boolean; inferFromGates?: boolean }

/** A way through a flow (flows.json "paths"), e.g. the spec flow's full and short. */
export type SddPath = { label: string; dropNeeds?: Record<string, string[]> }

export type SddFlow = { label: string; prGates: string[]; stages: SddStage[]; paths?: { choose: string } & Record<string, SddPath | string> }

export type SddColors = {
  done: string; now: string; work: string; revoked: string; gate: string
  dim: string; line: string; hoverText: string
}

export type SddSnapshot = {
  root: string
  /** The view's colours: .claude/sdd.json "view.colors" over the defaults in sddlib.py. */
  colors?: Partial<SddColors>
  /** Open the view when a session starts in this workspace (.claude/sdd.json "view.autoOpen"). */
  autoOpen?: boolean
  specRoot: string
  flows: Record<string, SddFlow>
  derived: string[]
  items: SddItem[]
  done: SddItem[]
}

export type SddDoc = { name: string; text: string; isCut: boolean }

/** One question of an AskUserQuestion call, as the tool takes it. */
export type SddQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** The questions Claude last asked about this chat's work item with AskUserQuestion. */
export type SddAsk = {
  id: number
  at: string
  toolUseId: string
  questions: SddQuestion[]
  /** The dialog is still open in the chat: an answer from the view answers it. */
  isOpen: boolean
}

/** What the Worktrees page reads of repowatch's .claude/repowatch/state.json (the fields it uses). */
export type SddLiveWorktree = {
  path: string
  branch: string | null
  dirty?: number
  ahead?: number
  behind?: number
  /** Epoch seconds. */
  lastCommit?: number
  class: 'safe' | 'review' | 'keep' | 'ok' | 'prune'
  reasons: string[]
  unique?: number
  /** The base it is measured against, and how far apart they are. */
  baseRef?: string
  behindBase?: number
  aheadBase?: number
  /** Would merging the base in conflict? */
  forecast?: { state: 'clean' | 'conflict' | 'unavailable' | 'error'; base: string; files?: string[] }
}

export type SddLiveState = { generated: number; repos: Record<string, { worktrees?: SddLiveWorktree[] }> }

declare module 'claude-code' {
  interface PluginState {
    sdd: {
      snap: SddSnapshot | null
      error: string | null
      selected: number | null
      stage: string | null
      doc: SddDoc | null
      /** A folder given to /sdd-view for this session; null = the session's own folder. */
      workspace: string | null
      /** The stage whose feedback box is open (or review:<stage> for a rejected PR), or null. */
      feedback: string | null
      /** The gate whose story is open inside its stage ('gate:Design agreed'), or null. */
      gate: string | null
      /** The view opened by itself in this session already. */
      opened: boolean
      /** This chat's work item: the one it last ran /sdd or an sdd script for. */
      mine: number | null
      /** The item this chat took up with /sdd (or, with no /sdd, the first its scripts named): what each turn costs is charged to it. */
      home: number | null
      /** The questions Claude asked at the gate this chat's item waits on, or null. */
      asked: SddAsk | null
      /** The options picked in the view so far, per question text. */
      picks: Record<string, string[]>
      /** The Worktrees page: repowatch's scan of the worktrees, or null while unread. */
      wtLive: SddLiveState | null
      /** Why the Worktrees page cannot show the live facts, or null. */
      wtError: string | null
      /** First item of the Worktrees page shown. */
      wtOffset: number
      /** The worktree line opened on the Worktrees page (`<item id>:<repo>`), or null. */
      wtLine: string | null
    }
  }
}
