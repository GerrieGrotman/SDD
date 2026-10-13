# Mode: Verify

> Part of the `sdd:spec` flow. Its rules (`../SKILL.md`) and the shared flow rules
> (`${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`) hold here too. Paths like
> `references/…` and `assets/…` are in the spec skill's folder.

**Found a bug this work did not cause?** Stop. Explain it and ask the user before you touch it —
follow "Bugs this work did not cause" in `flow-rules.md`. This holds in every step below.

1. **Run every task's Verify command:** `env.py verify --id <id>`. It runs each backticked command in
   its repo's worktree and records the results. A failure blocks the PR: `progress --passed "Ready to
   PR"` and `env.py pr` both refuse until every command passes **on the code as it is now** (an
   edit after the run voids it; a commit of the same files does not). Fix the code or the task, then
   run it again. The tasks it lists as "check by hand" go into step 2.
2. Walk the acceptance criteria one by one against observable behaviour, not against the code
   you wrote. Anything unmet is either an unfinished task or a requirement change.
3. **Drift check:** `spec.py sync --id <id>`. Any `MATERIAL` line for this item or its parent
   blocks the PR until it is reviewed against `design.md` and the done tasks.
4. **Overlap check:** `spec.py impact --id <id>`, then check the design's anchors against the
   candidates it lists for file and symbol overlap. With more than a few candidates, give the
   list and the anchors to **`sdd:investigator`** and ask for each overlap with its file:line.
5. Report what was built, what was skipped and why, and each bug this work did not cause with the
   user's answer; no silent scope changes — as an `sdd:visual`
   **diff-review** page (`visuals/diff-review.html`) per the worktree diff against its base branch.
6. **Stop and ask.** Implementation and the checks above are done — run the "Ready to PR" gate
   with `AskUserQuestion`: "Raise the PR" vs "Make changes". Never open a PR on the assumption
   that passing checks means go-ahead; only the user's answer does.
7. **"Make changes"?** Go back to Implement (or Decompose, if the fix is really a task-list
   problem), address it, then re-run step 6. Never guess at the fix and open the PR anyway.
8. **"Raise the PR"?** Write the description to `<folder>\pr-description.md`, then `env.py pr
   --id <id> --title "<title>" --description-file <folder>\pr-description.md` — it pushes each
   repo with commits ahead, opens its PR against the base branch and links the work item. Move the
   work item to the current sprint as you open it, `spec.py sprint --id <id>` — an item still
   sitting in an old sprint (or with none set) reads as work nobody is doing. Never write the work
   item as `#12345` anywhere in the PR text (`env.py pr` refuses it),
   and never add a Claude attribution line to the title, description or a comment — the
   developer owns the PR. `references/branching.md` has both rules and why.
9. Start **Review** at once: `env.py progress --id <id> --flow spec --phase Review --status waiting
   --gate "PR status: not yet approved / approved / merged / rejected" --ref ado --no-visual "PR status
   is a plain choice"`. Verify is done; the wait for the reviewers is Review's.
