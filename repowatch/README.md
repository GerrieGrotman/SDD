# repowatch

Keeps track of many git repos and their worktrees. Standalone; the sdd plugin depends on it, so it
installs with sdd.

- **Pane** (`/repowatch`): one row per repo, the ones that need attention first. Branch, ahead/behind,
  uncommitted files, stashes, worktrees, branches whose upstream is gone. Click a row for details.
- **Status line**: `repos 40 · 2 behind · 1 dirty · 1 old worktree`; clear when all is well.
- **Repos view**: coloured counts, then one line per repo (a colour dot, `repo · branch`, its worst flag as a word, the age of its last fetch). Press a line to open its path, details, gone branches (**Delete…**), 📋 and History.
- **Worktrees view** (`/repowatch worktrees`): every worktree of every repo, each classed from the evidence:
  The list is one line per worktree: a colour dot, `repo · branch`, a state word and its age, under coloured counts. Press a line to open its facts and buttons (📋 copy path, History, Remove…, Ask Claude to merge); one line is open at a time.

  | Class | Means | Button |
  | --- | --- | --- |
  | safe to remove | Clean, nothing only here, and merged into the default branch or its upstream branch was deleted | Remove… |
  | broken | git lists a folder that is gone | Prune |
  | review | Probably done, but a person should look: its upstream was deleted and commits are on no remote (a squash merge?), or nothing was committed for a long time | Review… |

  A squash merge leaves the commits on no remote, so git alone cannot tell. With `az login` and an ADO
  `origin`, `scan` asks ADO whether a completed pull request came from that branch with exactly this commit
  as its source; if so the worktree is **safe** and the reason names the PR. `adoLookup` (default on) and
  `adoLookupCacheSeconds` in `repowatch.json` control it.
  | keep | Uncommitted files, or commits that exist only here | none |
  | in use | Nothing says it is finished | none |

  A work item's worktree (under sdd's `worktreeRoot`) is labelled `sdd <id>`; sdd removes those with
  `env.py remove`, so the button there asks Claude to do that.
- **Merge-conflict forecast**: for each worktree, `git merge-tree` says whether merging its base in would
  conflict, and in which files, without touching a checkout. The base is the one sdd recorded for the
  work item (`workitem.json`), else the default branch. A repo whose branch and upstream diverged gets
  the same check. Results are cached by the two shas, so only a branch that moved is recomputed. A toast
  fires when a branch turns to "will conflict"; the row's button asks Claude to do the merge. Needs git
  2.38 or later; older git shows nothing.
- **Sync view** (`/repowatch sync`), one line per hop (a colour dot, `repo · from → to`, a word such as `2 to take`, `stopped`, `on origin`, `up to date`) under coloured counts; press a line to open its fixes and buttons (**Sync…**, **Finish…**, **Abort…**, **History**): for each repo with two or more `team/*` branches on origin, the branches
  sorted by version (`0.0.2` before `0.0.10`) and, for each hop to the next newer one, the commits the
  newer one lacks, grouped into fixes by ADO id (`AB#n`, `ADO n`, or `Related work items: #n`). A commit
  whose patch is already there under another sha counts as applied. The hop says whether merging the
  older branch in would conflict.

  - **Sync…** makes `sync/<older>-<newer>` (versions only, e.g. `sync/0.0.1-0.0.2`) from the newer branch
    in a worktree under `.claude/repowatch/sync/`, merges the older branch in, pushes the sync branch and
    opens an ADO pull request into the newer branch. **Nothing is ever pushed to the newer branch itself.**
    The plan and a confirm come first; a hop that will conflict needs the review confirm.
  - **On a conflict** the worktree is left as it is. **Ask Claude to resolve** fills the prompt for you to
    send; when the merge is committed, **Finish…** checks it is complete (nothing uncommitted, no conflict
    markers, the older branch really in) and pushes and opens the PR. **Abort…** throws the attempt away.
  - **Do not take…** marks one commit as not for the newer branch. A merge cannot leave a commit out, so that
    hop becomes a cherry-pick hop: the wanted commits are cherry-picked oldest first with `-x`. The decision is
    kept in `.claude/repowatch/sync.json`, with the reason you type in the confirm panel (empty gives
    "not needed on <branch>"). **Take again…** reverses it. A hop stays a cherry-pick hop
    while any commit is skipped, because a merge would bring the skipped ones back.
  - The PR needs `az login` and an Azure DevOps `origin`. If the PR cannot be opened the branch is still
    pushed, and the pane says so. A sync branch whose PR is still open blocks a second sync of that hop. Once
    that PR is merged the branch is stale: the next **Sync…** deletes it (it asks first) and uses the name again.

  `syncPattern`, `syncWindowDays` and `syncMaxFixes` in `repowatch.json` tune it; `repowatch.py sync` reads
  it by hand, and `plan|apply sync-hop|sync-finish|sync-abort|sync-skip|sync-unskip --repo NAME --hop OLDER:NEWER`
  does the actions.
- **History** (a **History** button on a repo, a worktree and a sync hop; a long subject is cut to the pane and the commit's author shows when it opens): the branch's history drawn the way
  `git log --graph` draws it, with the lanes in colour, `HEAD`, branch, remote and tag labels, and merge commits
  as `◆`. With a base (a worktree's base, the default branch, or the older team branch of a hop) each commit is
  coloured by where it is: green only on the branch, blue only on the base, grey on both, so the fork point and
  what is unmerged stand out. Press a commit id for its message and the files it changed. **Without base**,
  **First parent only** and **Show 40 more** change what is drawn; **‹ Back** returns to where you were. It only
  reads. `/repowatch history <repo> <branch> [<base>]` opens it directly (sdd's `/sdd-worktrees` page uses the same
  command). `repowatch.py graph --repo NAME --ref BRANCH [--ref BASE] [--limit N] [--first-parent]` and
  `show --repo NAME --sha SHA` do it by hand; refs that start with `-` are refused.
- **One worktree**: `/repowatch worktree <path>` (or `worktree {"path": "..."}`) opens the Worktrees list on that one worktree,
  in use or not, with a **Show all worktrees** button. sdd's spanner button on a work item's worktree uses it.
- **Background scan**: local facts every two minutes; every five minutes it also fetches the four repos
  fetched longest ago and reads the branch sync, so dozens of repos are covered without a stall. Nothing is
  pulled, merged or deleted. Every open session ticks, but one scan serves them all: a tick runs no git while
  the last scan is fresh or another session is scanning (`.claude/repowatch/scan.lock`). A repo whose branches
  did not move only has `git status` read again; everything is read again every 15 minutes, and after a fetch.
- **Manual only**: set `"autoSync": false` in `.claude/repowatch.json` and nothing is scanned, fetched or synced on
  its own. Press **Sync now** (at the top of every view) to scan every repo, fetch every repo and read the branch
  sync in one go; the pane says when auto sync is off. Set `"autoSync": true` (the default) to turn it back on.
  **Scan** and **Fetch a few** work in both modes.

## What it never does to a remote

- It never deletes a branch on a remote except a stale `sync/<older>-<newer>` branch (one whose pull request
  was merged), and only when you confirm. Every other deleting `git push` is refused in the code: `--delete`,
  `-d`, a `:branch` refspec, `--mirror` and `--prune` for any name that does not start with `sync/`.
- **Delete…** on a branch whose upstream is gone, **Remove…** with its branch, **Abort…** and **Undo** touch
  local branches only.
- It never pushes to a `team/*` branch. A sync pushes its own `sync/…` branch and opens a pull request.

## Clean-up is always a click, then a plan, then a confirm

A button shows the plan first: the git commands, why, the commits that exist only there (for a review),
and how to undo it. Nothing runs until you press Confirm. Then `apply` checks the live repo again, so a
worktree that became dirty since you looked is refused. Each run is written to
`.claude/repowatch/journal.jsonl` with the branch's sha. By hand:

```
python scripts/repowatch.py plan  remove-worktree --repo NAME --path P --delete-branch
python scripts/repowatch.py apply remove-worktree --repo NAME --path P --delete-branch [--allow-review]
python scripts/repowatch.py apply prune-worktrees --repo NAME
python scripts/repowatch.py apply delete-branch   --repo NAME --branch B
python scripts/repowatch.py apply undo            --repo NAME --id ID     # ids: status --json, "undoable"
```

Branches whose upstream was deleted show a **Delete…** button in the repo's details. The Worktrees view
shows **Undo:** for the newest clean-up that can be put back: it recreates the branch at its old sha and
the worktree folder (ignored files such as build output are not restored).

Repos come from `repos` in `.claude/repowatch.json`, else `repoDirs` in `.claude/sdd.json`, else every
folder up to two levels down that holds a `.git` folder. Other keys: `workers`, `fetchWorkers`,
`fetchBatch`, `fetchTimeout`, `staleFetchHours`, `staleWorktreeDays`, and for the background scan
`autoSync` (true), `scanEverySeconds` (120), `fullScanEverySeconds` (900), `fetchEverySeconds` (300).

By hand: `python scripts/repowatch.py scan [--fetch] [--only NAME]` and `status [--json]`. `scan --auto` is the
background tick: it does what is due and prints `status --json`.

Install: `/plugin install repowatch --marketplace ruadrauflessa/SDD` (it comes with sdd).

See `DESIGN.md` for what was decided and what is not built.
