# repowatch

Keeps track of many git repos and their worktrees. Standalone; the sdd plugin depends on it, so it
installs with sdd.

- **Pane** (`/repowatch`): one row per repo, the ones that need attention first. Branch, ahead/behind,
  uncommitted files, stashes, worktrees, branches whose upstream is gone. Click a row for details.
- **Status line**: `repos 40 · 2 behind · 1 dirty · 1 old worktree`; clear when all is well.
- **Worktrees view** (`/repowatch worktrees`): every worktree of every repo, each classed from the evidence:

  | Class | Means | Button |
  | --- | --- | --- |
  | safe to remove | Clean, nothing only here, and merged into the default branch or its upstream branch was deleted | Remove… |
  | broken | git lists a folder that is gone | Prune |
  | review | Probably done, but a person should look: its upstream was deleted and commits are on no remote (a squash merge?), or nothing was committed for a long time | Review… |
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
- **Background scan**: local facts every minute; every fifth scan also fetches the four repos fetched
  longest ago, so dozens of repos are covered without a stall. Nothing is pulled, merged or deleted.

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
`fetchBatch`, `fetchTimeout`, `staleFetchHours`, `staleWorktreeDays`.

By hand: `python scripts/repowatch.py scan [--fetch] [--only NAME]` and `status [--json]`.

Install: `/plugin install repowatch --marketplace ruadrauflessa/SDD` (it comes with sdd).

Planned: branch sync along `team/*`. See `DESIGN.md`.
