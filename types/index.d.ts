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

// ---------------------------------------------------------------- the bug manager (/sdd-bugs)

export type BugPerson = { name: string; email: string }

/** One bug or issue as scripts/bugs/Sync-Bugs.ps1 writes it into index.json. */
export type BugRecord = {
  id: number
  rev: number
  type: string
  title: string
  state: string
  reason: string
  project: string
  area: string
  iteration: string
  tags: string[]
  assigned: BugPerson | null
  severity: string
  priority: number | null
  /** Story points, else effort, else size. */
  effort: number | null
  boardColumn: string
  created: string
  changed: string
  createdBy: BugPerson | null
  url: string
  parent: number | null
  related: { name: string; id: number }[]
  commits: { sha: string; repo: string; url: string }[]
  prs: { id: number; repo: string; url: string; title: string; status: string }[]
  links: { name: string; url: string }[]
  /** The fields "bugs.extraFields" names. */
  extra: Record<string, unknown>
}

export type BugIndex = {
  version: number
  syncedAt: string
  org: string
  projects: string[]
  me: BugPerson | null
  count: number
  items: BugRecord[]
}

/** A rule of a category: every key given must hold (sdd.json "bugs.categories", scripts/bugs/defaults.json). */
export type BugCondition = {
  states?: string[]
  notStates?: string[]
  types?: string[]
  boardColumns?: string[]
  /** Any of these tags (case does not matter). */
  tags?: string[]
  allTags?: string[]
  /** Severity starts with any of these ("1" matches "1 - Critical"). */
  severity?: string[]
  priority?: number[]
  assigned?: 'me' | 'none' | 'anyone'
  areaUnder?: string[]
  iterationUnder?: string[]
  maxEffort?: number
  minEffort?: number
  titleMatches?: string
  hasPullRequest?: boolean
  hasCommits?: boolean
  olderThanDays?: number
  newerThanDays?: number
  /** A field of "bugs.extraFields" holding one of these values. */
  fields?: Record<string, Array<string | number>>
}

export type BugCategory = BugCondition & {
  id: string
  label: string
  icon?: string
  color?: string
  /** At least one of these must hold too. */
  any?: BugCondition[]
  /** One category for each tag that matches this pattern ({value} in the label is the tag). */
  eachTag?: string
  /** One category for each value of this field (a key of the record, or of "extraFields"). */
  eachField?: string
}

export type BugsConfig = {
  folder: string
  types: string[]
  query: { projects: string[]; excludeStates: string[]; areaPaths: string[]; iterationPaths: string[]; where: string; top: number }
  extraFields: string[]
  /** The dev team's file, from the workspace root: { "areaPath": "A; B\\*", "developers": ["Display Name", ...] }. */
  developersFile: string
  /** The states "Hide resolved and closed" hides. */
  doneStates: string[]
  states: Record<string, string[]>
  severities: string[]
  priorities: number[]
  categories: BugCategory[]
  analysis: { model: string; maxTokens: number; effort: string }
  me: string
  powershell: string
}

/** The dev team file: who is on the team, and which area paths are its own. */
export type BugTeam = {
  /** Display names or e-mails. */
  developers: string[]
  /** Area paths: `A\B` is that area only; `A\B\*` is that area and everything under it. An item outside them is never shown. */
  areas: string[]
}

/** The settings the settings panel edits: the `bugs` settings of .claude/sdd.json, and the dev team file. */
export type BugSettings = {
  bugs: BugsConfig
  /** developers.json "developers": display names or e-mails. */
  developers: string[]
  /** developers.json "areaPath", one area path to an entry. */
  areas: string[]
}

/** The settings panel's edits: `base` is what the files hold, `now` what the panel shows; nothing is written until Save. */
export type BugSettingsDraft = { base: BugSettings; now: BugSettings }

/** One staged change, kept in <bugs folder>/pending.json until it is saved or reverted. */
export type BugChange = {
  key: string
  id: number
  kind: 'field' | 'tagAdd' | 'tagRemove' | 'comment'
  field?: string
  value: string
  /** What the field held when the change was first staged. */
  was?: string
  label: string
  at: string
  /** Set by the last save that could not write it. */
  problem?: { kind: 'conflict' | 'error'; text: string; current?: string }
}

export type BugComment = { by: string; at: string; text: string }

export type BugDetail = { id: number; text: Record<string, string>; comments: BugComment[] }

export type BugEvidence = {
  id: number
  rev: number
  terms: string[]
  repos: string[]
  hits: { repo: string; path: string; line: number; text: string; term: string }[]
  history: { repo: string; path: string; commits: string[] }[]
  linked: { repo: string; commit: string; files: string[] }[]
  seconds: number
}

export type BugAnalysis = {
  id: number
  /** The item's revision and the evidence it was made from: a newer one shows it may be out of date. */
  key: string
  text: string
  model: string
  input: number
  output: number
  at: string
}

export type BugFilter = {
  category: string
  mine: boolean
  /** Hide the items in a "doneStates" state. */
  hideDone: boolean
  /** Only the dev team's items: assigned to a developer of the dev team file. */
  team: boolean
  text: string
  sort: 'priority' | 'severity' | 'changed' | 'created' | 'id'
  type: string
  state: string
  /** Only the items assigned to this person: `assigneeKey` of the person, or `UNASSIGNED`. Empty: everyone. */
  assignee: string
}

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
      /** The bug manager: the synced bugs and issues (index.json), or null while unread. */
      bugs: BugIndex | null
      /** Why the bug manager cannot show the list (no workspace, not synced, a script failed), or null. */
      bugsError: string | null
      /** The bug manager's settings: sdd.json "bugs" over scripts/bugs/defaults.json. */
      bugsCfg: BugsConfig | null
      /** The dev team of "bugs.developersFile", or null while that file is missing, unreadable or names nobody and no area. */
      bugsTeam: BugTeam | null
      /** The staged changes (pending.json). */
      bugsPending: BugChange[]
      bugsFilter: BugFilter
      /** The item opened in the list, or null. */
      bugsOpen: number | null
      /** The editor open on that item ('assign', 'area', 'iteration', 'tags', 'comment'), or null. */
      bugsEdit: string | null
      /** What runs now ('sync', 'save', 'detail', 'evidence', 'analysis'), or null. */
      bugsBusy: string | null
      /** The open item's text and comments, once read. */
      bugsDetail: BugDetail | null
      bugsEvidence: BugEvidence | null
      /** The probable cause of each item analysed, by id. */
      bugsAnalysis: Record<string, BugAnalysis>
      /** First row of the list shown. */
      bugsOffset: number
      /** The staged changes are listed in full. */
      bugsReview: boolean
      /** The items ticked for a change to all of them at once. */
      bugsPicked: number[]
      /** What the pane shows: the list, or the settings panel. */
      bugsView: 'list' | 'settings'
      /** The settings panel's edits, or null while it has none (the panel starts from the files). */
      bugsDraft: BugSettingsDraft | null
      /** The settings section open in the panel, and inside Categories the category open ('categories:quick-wins'), or null. */
      bugsSection: string | null
    }
  }
}
