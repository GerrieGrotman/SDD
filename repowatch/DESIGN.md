# repowatch design

What is built, and what is decided but not built yet. Update this when a decision changes.

## Built

- Step 1: `scripts/repowatch.py scan | status`, the pane, the status line.
- Step 2: worktree classes (safe / prune / review / keep / ok), `plan` and `apply` for `remove-worktree`,
  `prune-worktrees` and `delete-branch` with a journal, the Worktrees view with the confirm panel, and
  sdd's `/sdd-worktrees` page. See `README.md`.

Squash merges: git cannot see that a squash-merged branch is merged. Such a worktree is classed `review`
(its upstream is gone and its commits are on no remote), and the plan lists those commits. A later step
can ask ADO whether the PR merged and move it to `safe`.

## Decisions

- Standalone plugin; sdd lists it under `dependencies`.
- ADO only (PRs through `az`). A provider interface comes later if GitHub is wanted.
- Dozens of repos: cached `state.json`, round-robin fetch, capped parallelism, a triaged pane.
- Actions run only when the person clicks. Each shows its plan (the exact git commands, repos and
  branches), waits for a confirm, re-checks its preconditions, runs, and writes a journal entry to
  `.claude/repowatch/journal.jsonl` (branch name and sha, so a deleted branch can be recreated).
- The sdd view stays read-only (CLAUDE.md). Actions live in repowatch; the sdd Worktrees page links to them.

## Steps still to build

3. Merge-conflict forecast (`git merge-tree --write-tree`, cached by branch sha + base sha; needs git 2.38).
4. Branch sync, read-only: the matrix below.
5. Branch sync actions and the conflict hand-off to Claude.

## Branch sync (steps 4 and 5)

**Which branches.** Every `team/*` branch (`sync.pattern` in `repowatch.json`), sorted by version
number: `team/0.0.9` before `team/0.0.10`. A branch that is not `team/*` is not part of the sync;
sdd work item branches cut from `team/y` only get the ordinary "behind base" flag.

**Direction and hops.** Old to new, one hop at a time: `team/0.0.1` → `team/0.0.2` → `team/0.0.3`.
A fix reaches `team/0.0.3` by landing on `team/0.0.2` first. Each hop is its own PR.

**What is missing on a hop** (x to its next version y):
- `git rev-list y..x` gives the commits y lacks.
- `git cherry y x` marks the ones y already has under another sha (same patch-id), so they do not count.
- Commits are grouped by the ADO id in the message (`ADO 4471`) into fixes. The matrix lists fixes down,
  hops across. A cell is: applied, applied (same patch), missing, will conflict, or skipped.

**Merge is the default.** The hop makes `sync/<x>-<y>` from y (versions only: `team/0.0.1` to `team/0.0.2` is `sync/0.0.1-0.0.2`), merges x into it, pushes it,
and opens a PR into y (ADO). It never pushes to y. A merge that conflicts leaves the worktree in
place and hands over to Claude: the pane fills `/repowatch resolve <hop>` for the person to send.

**Cherry-pick is for the hop where a commit must not travel.** A merge cannot leave a commit out.
So when the person marks a commit on x "do not take to y", that hop switches to cherry-picking the
commits that are wanted, oldest first, with `-x` so each records its source sha.
- The excluded commits are stored in `.claude/repowatch/sync.json` with a reason, and stop showing as missing.
- The hop stays a cherry-pick hop from then on. A later merge of x into y would bring the excluded
  commits back. The pane says so when it offers the hop.
- Cherry-picked commits then travel on to the next hop as ordinary commits of y; the excluded ones do not.

**Not touched:** feature and work item worktrees. A clean one may be offered "merge base in" as a
separate action; a dirty one is only flagged.

**sdd tie-in, later:** a bug-flow PR that merges into `team/x` could register as a pending fix on its
hop. That would change `flows.json`, so it is not part of this plugin's first version.
