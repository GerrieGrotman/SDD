# repowatch

Keeps track of many git repos and their worktrees. Standalone; the sdd plugin depends on it, so it
installs with sdd.

- **Pane** (`/repowatch`): one row per repo, the ones that need attention first. Branch, ahead/behind,
  uncommitted files, stashes, worktrees, branches whose upstream is gone. Click a row for details.
- **Status line**: `repos 40 · 2 behind · 1 dirty · 1 old worktree`; clear when all is well.
- **Background scan**: local facts every minute; every fifth scan also fetches the four repos fetched
  longest ago, so dozens of repos are covered without a stall. Nothing is pulled, merged or deleted.

Repos come from `repos` in `.claude/repowatch.json`, else `repoDirs` in `.claude/sdd.json`, else every
folder up to two levels down that holds a `.git` folder. Other keys: `workers`, `fetchWorkers`,
`fetchBatch`, `fetchTimeout`, `staleFetchHours`, `staleWorktreeDays`.

By hand: `python scripts/repowatch.py scan [--fetch] [--only NAME]` and `status [--json]`.

Planned: stale-worktree clean-up, merge-conflict forecast, backports along branch lineage. Every
action will show its plan and wait for a click.
