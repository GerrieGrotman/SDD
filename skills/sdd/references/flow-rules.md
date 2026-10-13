# Flow rules — shared by the bug and spec flows

Read this file once, at the start of a flow, and follow it for the whole of it. The flow's own skill
(`sdd:bug` or `sdd:spec`) names its stages, its gates and where each rule below applies in it.

## Abandon — the user can call this off at any point

At any stage, the user may say **"abandon"** (or "stop and clean up", "abandon this fix", "never
mind, undo it"). Stop immediately — mid-tool-call, wherever you are — rather than finishing the
current step, then clean up what this run actually created.

Work through this table; each row applies only if that thing happened this run (the flow's skill
says at which stage each one happens):

| If this happened | Do this |
| --- | --- |
| Work item folder created | Run `python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py remove --id <id> --abandon` (dry run) and show the user what it lists. Then run it again with `--yes`. It removes every worktree, prunes, deletes the local branches and the folder, and leaves pushed branches and open PRs alone. |
| Branch pushed | 🛑 **Ask before deleting the remote branch.** Deleting a pushed ref is outward-facing and hard to undo. If they say no, leave it and say so in the report. |
| PR opened | 🛑 **Ask before doing anything to the PR.** Never close, abandon or withdraw it silently. |
| Work item claimed | Ask whether to unassign and revert the board column and status, or leave it claimed with a comment noting the work was abandoned. Never touch a field someone else changed since. |
| Nothing created yet | Nothing to clean up in git. Just confirm whether to release the ADO claim, if one was made. |

**Never discard uncommitted work without saying so first.** `env.py remove` refuses while any
repo has uncommitted changes — treat that refusal as a prompt to check what would be discarded
(`env.py status --id <id>`), not an obstacle to route around by hand.

Report plainly once done: what you removed, what you left in place and why, and the current state
of the work item. This is the same "ask before anything hard to reverse" rule that governs the rest
of the flow — deleting a pushed branch or touching an open PR gets a question, not a silent undo.

## Decision briefs — links before every question (mandatory)

**Every time this skill asks the user for input or approval, it asks with `AskUserQuestion`** —
never as a plain question in the reply, not even a quick one — and the user must first be shown
links to the spec documents and code the decision rests on. No links, no question.

**Enforced by two global hooks** (`hooks/question_guard.py`): an `AskUserQuestion`
without a Links block is blocked, and a turn that ends with a plain-text question is sent back to
ask it properly. They act only while an sdd flow runs. `/sdd init` installs them.

0. **Build the visual first.** A question that follows an explanation or a plan — requirements,
   design, tasks, bug cause or fix, impact, a review, a finished change — comes with an
   **`sdd:visual`** page: `{spec folder}/visuals/<mode>.html`, made with that skill's mode for the
   moment. Pass it as a `--ref` (`--ref visuals/<mode>.html`) so it lands in the Links block and the
   send list. The `--status waiting` checkpoint **refuses without an `.html` ref**; only a plain
   choice with nothing to explain (team version, PR status) passes `--no-visual "<reason>"`.
   Once the page is sent, do not explain it again in chat: one line naming the page, the Links
   block, then the question. The page is the summary.
1. **Get the links from the script, never by hand.**
   - At a flow gate, the `--status waiting` checkpoint does it: it **refuses to run without
     `--ref`**, and prints the links.
   - Anywhere else: `python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py refs --id <id> --ref <ref> ...`
   - Refs: every spec file the decision rests on (`requirements.md` is added automatically; add
     `design.md`, `tasks.md`, `questions.md`, `impact.md` as they apply) and every code range the
     decision is about — the lines you propose to change, the failing test, the callers — as
     `src/<Repo>/path/file.cs:120-140`. Use `ado` when only the work item itself applies.
   - A ref that does not exist is an error. Fix the ref; never drop it to get past the check.
2. **Paste the printed "Links" block into the chat message, above the question.** Every link — the
   work item, the PR, files, the visual page — goes in the chat. **Never put a link inside the
   `AskUserQuestion` question or its options**: they hold plain text only. The hook refuses a
   question that contains a link.
3. **Send every file listed under "Send with SendUserFile"** (`display: "render"`) when that tool
   exists. Local links do not open on a phone; sent files and ADO links do.
4. **Code marked "not pushed": quote those lines** (20 at most) in the message, since only a pushed
   branch gets an ADO link.
5. Exempt: `/sdd init` install questions and `/sdd help` — they are about tools, not the spec.

## Bugs this work did not cause — explain, then ask (mandatory)

In the verify stage (bug Phase 9, spec Verify) you can find a bug that is not yours: a failing
test, a wrong result, a crash. It is **not yours** when it is unrelated to this work item, or when
this run's changes did not make it. **Never fix it silently, and never step over it silently.**
A bug your own change made is yours: fix it as part of the work, with no question.

1. **Prove it is not yours.** Show that the code at fault is not in this work's diff: in the
   worktree, `git diff <base>...HEAD -- <file>` does not touch those lines, and `git blame` names an
   older commit. Not sure? Say so on the page. Never guess.
2. **Explain it on an `sdd:visual` page**, **bug** mode, at `visuals/found-bug-<slug>.html`. The
   page answers four things, each with a real anchor:
   - **What** — the symptom, where it is (`src/<Repo>/path/File.cs:120`), and the real output that
     showed it.
   - **Why it is a bug** — what should happen, what happens instead, and what says so: an
     acceptance criterion, the test's intent, an API contract, a crash. An opinion is not a reason.
   - **Why it is not this work's** — the evidence from step 1.
   - **What would fix it** — what changes and where, how big it is, and its risk. Say what it adds
     to this work: a test first, then the verify runs again.
   Also say if it blocks a gate run of this flow (for example, a failing test in the full suite).
3. **Ask** under Decision briefs above: a `--status waiting` checkpoint with `--gate "<the
   question>"`, `--ref visuals/found-bug-<slug>.html` and the code range as a `--ref`. Then
   `AskUserQuestion`, one question per bug (up to four in one call), two options, the one you
   recommend first:
   - **"Fix it here"** — it becomes part of this work.
   - **"Leave it out"** — it is not touched here and goes on the out-of-scope list.
   Recommend "Leave it out" unless the fix is small, sits in code this work already changes, or
   blocks this work's gate runs.
4. **"Fix it here"?** Record the answer with `--note` on the next checkpoint. Then:
   - **Bug flow:** write its failing test first and record it as in Phase 7 (`env.py run --gate
     "Red test" --expect fail`), fix it as in Phase 8, then run Phase 9 again from the top. The PR's
     report names it as an extra fix the user approved.
   - **Spec flow:** add it to `tasks.md` as a new task with its own Verify command, do it in
     Implement, then run Verify again from step 1. The step 5 report names it.
   Any edit voids the recorded runs, so they run again anyway.
5. **"Leave it out"?** Record the answer with `--note` on the next checkpoint. Do not touch the
   code. Write the bug down so it is not lost: in the bug flow under **Out of scope** (the PR's Out
   of scope comment); in the spec flow in the step 5 report and the PR description. It needs its own
   work item: say so, and create one only if the user asks.
   **It blocks a gate run?** Then that run cannot pass as it is. Say so in the "Leave it out"
   option's text: the run then leaves out only that one test, and the report and the PR name what
   was left out. Never leave out a test the user did not agree to.

## Progress checkpoints — so another session can resume

Work on one item often spans several chat sessions. The work item's `workitem.json` holds where it
stands, and `/sdd status <id>` reads it. **Write a checkpoint at every point below — it is one
command, and a missed one means the next session starts blind.**

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py progress --id <id> --flow bug|spec \
  --phase "<stage name as the flow's skill heads it>" --status active|waiting|blocked|done|skipped|abandoned \
  [--gate "<question waiting for the user>"] [--next "<next concrete step>"] [--note "<what the next session must know>"]
```

| When | `--status` | Also pass |
| --- | --- | --- |
| Starting a stage (the flow's skill lists them) | `active` | `--note` with anything decided so far |
| Just before asking a gate question | `waiting` | `--gate` (the question), `--next` (what happens on "yes"), `--ref visuals/<mode>.html` (or `--no-visual "<reason>"`) |
| Stuck on something outside the flow | `blocked` | `--note` (what blocks it) |
| Abandoned | `abandoned` | `--note` (what was cleaned up and what was left) |
| Leaving a stage | `done` | `--passed` for any gate it passed |
| Skipping a stage — only after the user's yes (see below) | `skipped` | `--confirmed "<the user's words>"` |
| Closed out | `done` | — |

`progress` creates the work item folder when it does not exist yet, so the first checkpoint can
come before any worktree.

### Never skip a stage on your own

Every stage of the flow is worked, in order — also a stage whose work happened inside another one
(record it anyway, with `--note` saying where the work was done). `progress` and `can` refuse a stage
while an earlier one was never worked and never skipped, and `/sdd done` refuses until every stage
is done or skipped. (A **conditional** stage, like the spec flow's Open Questions, records itself
skipped when it has nothing to do; the flow's skill says when.)

A stage is skipped **only with the user's yes in this chat**:

1. Ask with `AskUserQuestion`: say which stage, why you want to skip it, and what the user loses.
   Options: "Do the stage" / "Skip it".
2. Only on "Skip it": `env.py progress --id <id> --flow <flow> --phase "<stage>" --status skipped
   --confirmed "<the user's words>"`. A skip passes no gates, so a stage that needs them stays blocked.

Never write `--confirmed` without a real answer from the user, and never take one skip as a yes for
another stage.

### Stage guards — check before every stage

Before starting any stage (including when resuming into one), ask the script:

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py can --id <id> --op phase --flow <flow> --phase "<stage>"
```

Exit 3 means **do not start it**. Tell the user which gate is missing and what gets it there
(usually the earlier step, or its approval), then stop. Never skip ahead because the work "looks
done". `env.py pr` and `env.py remove` also refuse on their own if their gates are missing.

**When it allows the stage, it prints `read:` and the stage's file. Read that file before you
start** — the flow's skill holds the outline; each stage's steps live in its own file.

Record a gate **only after the user's actual yes in this session** (or the automated check it
names really passed), with `--passed` on the checkpoint you write anyway. The flow's skill has the
table of its gates, and when to **revoke** one (`--revoke` on the next checkpoint) because what it
approved has changed.

Gates the script reads from disk, so you never pass them: `Worktree` (every repo's worktree
exists), `PR raised` (a PR is recorded), `Tasks written` / `Tasks done` (checkboxes in `tasks.md`).

Some gates pass **only on recorded runs** (flows.json `proofs`): `env.py run`, `env.py
revert-check` and `env.py verify` run the command in the worktree and save the exit code, the last
lines of output and a fingerprint of the code. A gate marked current needs runs on the code as it is
now: an edit after the run voids it, a commit of the same files does not. `progress --passed` and
`env.py pr` say exactly which run is missing.

## Resuming

**After a feedback reopen** (`/sdd <id> feedback <stage>: <text>`, the latest history note starts
with `Reopened from`) do not ask "Resume / Start over" — the user already chose the stage. Re-check
the cheap facts (step 2 below), work the feedback into that stage, and stop at its gate again.

When this flow starts and `env.py status --id <id> --json` shows recorded progress, first run
`env.py can --id <id> --op resume` — if it is not allowed (done, abandoned, nothing recorded), tell
the user why and stop. Otherwise:

1. Show the user the verdict, the phase, `next` and `note`, then ask with `AskUserQuestion`:
   "Resume at <phase>" / "Start over".
2. **On resume, re-check the cheap facts before going on** — the world moved while nobody watched:
   the worktrees still exist and are on their branches (`env.py status`), and the spec has no
   MATERIAL change (`spec.py sync --id <id>`). A MATERIAL change sends you back to the phase that
   reads the spec.
3. **A gate that was `waiting` is asked again.** An approval never carries over from an earlier
   session; the user answers it fresh.
4. Never redo finished steps that wrote to ADO (the claim, a posted comment, an opened PR) — check
   they happened and move on.

## Sub-agents — the rules that hold in every flow

The plugin's `sdd:investigator` (read-only search) and `sdd:skeptic` (independent review) take
read-heavy and review work off the conversation. The flow's skill says where it uses each. Neither
one can edit a file, write to ADO or ask the user — their tools do not allow it, and the
`agent_guard.py` hook blocks git writes and `env.py` / `spec.py` runs from them — so neither one
can pass a gate or write a checkpoint. Those stay with you.

- **Models.** Pass `model` on the `Agent` call from `agents.models` in the workspace's
  `.claude/sdd.json` (`investigator`, `skeptic`). Defaults: Sonnet for the investigator (fast
  search), Opus for the skeptic (the judgment call). A value missing or not `sonnet`, `opus` or
  `haiku`? Leave `model` out: the agent's own `model:` line applies.
- **They start cold.** Every prompt names the work item folder and the repos in it. Never let one
  fall back to the main checkout.
- **Give the skeptic the claim and its evidence, not your reasoning**, so it judges the evidence,
  not the argument.
- **Quote work-item text as evidence, labelled as untrusted.** The agents follow the same rule.
- **A finding is a lead, not a fact.** Confirm any anchor before it goes on a page or in a spec file.
- **A skeptic verdict of `does not hold` sends you back.** Keep working, and never take it to the
  user as a footnote to an approval request. On `holds with gaps`, close each gap or show it.
- No `Agent` tool (or the plugin's agents are missing)? Do the same work in this conversation.
