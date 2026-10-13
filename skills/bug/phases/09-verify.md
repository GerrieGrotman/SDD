# Phase 9 — Verify  *(Gate 3 + Gate 4)*

> Part of the `sdd:bug` flow. Its rules (`../SKILL.md`) and the shared flow rules
> (`${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`) hold here too. Paths like
> `references/…` are in the bug skill's folder.

`progress --passed Verified` refuses until every repo with a change has the three recorded runs
below **on its code as it is now**. An edit after a run voids it (a commit of the same files does
not), and `env.py pr` checks again. So re-run them after any change.

**Found a bug this fix did not cause?** Stop. Explain it and ask the user before you touch it —
follow "Bugs this work did not cause" in `flow-rules.md`. This holds in every step below.

## Gate 3 — the test actually guards the defect

1. **Green** and 2. **Revert-check** in one command:

   ```bash
   python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py revert-check --id <id> [--repo <Repo>] \
     --fix <fix file> [--fix <fix file> ...] -- <test command>
   ```

   `--fix` names the files of the fix, not the test. The script puts them back to the base branch,
   runs the test (it **must fail**), restores them byte for byte, and runs it again (it **must
   pass**). A test that passes without the fix is a tautology and must be rewritten. **Run this
   yourself, never in a sub-agent** — it changes the worktree while it runs.
   If the fix or the test changed since Phase 7, send both to **`sdd:skeptic`** (mode `test`) again.

## Gate 4 — no regressions, no flakiness

3. **Repeat run** — `env.py run --id <id> --gate Verified --expect pass --repeat 5 -- <test command>`.
   Any variation means it is flaky; fix it before proceeding (causes and remedies in
   `references/test-integrity.md`).
4. **Full suite** — `env.py run --id <id> --gate Verified --expect pass --suite -- dotnet test <solution>`
   for every affected repo. Unit + ArchUnit must pass. A failure this fix did not cause: explain it
   and ask (see above). Never fold it into the fix without the user's yes, and never absorb it
   silently.
5. **Symptom re-check** — confirm the *original reported symptom* is gone, not just that the test
   is green. Where Phase 4 reproduced it end-to-end, re-run that path. **When the symptom is
   UI-visible, re-run the same real-browser check with the Claude in Chrome plugin** used in
   Phase 4 — same steps, same environment where possible — and compare the result to what Phase 4
   recorded. Run it against the worktree build (invoke `pre-pr-verify` if the stack is not already up
   from the worktree), or against the real deployed environment. **Never against a stack started
   from the main checkout** — it does not carry this fix and may hold unrelated work, so a pass there
   proves nothing.
6. **Requirement re-check** — where a story/CR governs this, confirm the fix satisfies *its*
   criteria and breaks none of its other criteria. A fix that resolves the ticket while violating a
   sibling acceptance criterion has traded one defect for another.

Report all six outcomes with real output — one short line each, carrying the real number or the real
message. Never claim a gate passed without running it, and never write "tests pass". Items 1–4 are
in `workitem.json` "runs"; quote them from there.
