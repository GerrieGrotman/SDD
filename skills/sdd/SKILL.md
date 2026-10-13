---
name: sdd
description: 'Entry point for the spec-driven development workflows on Azure DevOps work items in a multi-repo workspace. `/sdd help` gives a quick tour; `/sdd init` checks and (per item, with permission) installs or configures everything the workflows need, including the workspace CLAUDE.md block. `/sdd <id>` reads the work item type and routes Bug/Issue to the bug flow and story/tech story/change request/feature/epic to the spec flow; `/sdd bug <id>`, `/sdd spec <id>`, `/sdd sync [<id>|all]`, `/sdd impact <id>` (or `/sdd impact all` for the whole spec, after a token-cost warning), `/sdd status <id>` reports where an item stands (so work started in one chat can resume in another), `/sdd harness <create|onboard|audit|maintain>` sets up and audits the Claude Code harness (CLAUDE.md, allowlists, hooks) of a repo or workspace, `/sdd done <id>` cleans up, `/sdd abandon <id>` stops an item, and `/sdd <id> feedback <stage>: <text>` (or the sdd view''s message "sdd feedback for <id>, stage <stage>: <text>") sends an item back to a stage with the user''s feedback, the view''s "sdd answer for <id>, stage <stage>: …" is the user''s answer to a gate question, and the view''s "sdd approve for <id>, stage <stage>" is the user''s go-ahead at a spec flow stop — each refuses and explains when the item''s state does not allow it. Use whenever the user types /sdd or asks to "sdd" a work item.'
---

# /sdd — one entry point for every sdd workflow

| Command | Skill it runs | What happens |
| --- | --- | --- |
| `/sdd help` | this skill | The tour guide below — no checks, no changes |
| `/sdd init` | this skill | Check every requirement; fix each missing one only after the user says yes |
| `/sdd next <epic or feature id> [version]` | `sdd:next` | Which item to take next under the dev's epic or feature: free items with their version, blocked ones judged, ranked by dev priority — the user picks |
| `/sdd <id>` | decided by type, see below | |
| `/sdd bug <id>` | `sdd:bug` | Claim, root cause, approval, failing test, fix, verify, PR |
| `/sdd spec <id>` | `sdd:spec` | Claim, mirror the spec, impact, design, tasks, implement, verify, PR |
| `/sdd sync <id>` / `/sdd sync` / `/sdd sync all` | `sdd:sync` | Mirror specs from ADO into the spec folder and index them |
| `/sdd impact <id>` | `sdd:impact` | Blast radius of one item over the synced specs, with gap questions |
| `/sdd impact all [<scope id>]` | `sdd:impact` | The same over the whole synced spec, or one epic/feature — deduplicated pairs, **token-cost warning first** |
| `/sdd harness <operation>` | `sdd:harness` | Create, onboard, audit or maintain the Claude Code harness — CLAUDE.md files, allowlists, hooks — of a repo or workspace |
| `/sdd status <id>` | this skill | Where the item stands: ADO state, recorded progress, spec files and tasks, repos, live PRs, and a one-line verdict |
| `/sdd done <id>` | this skill | Clean up once every PR is merged and the close-out is written to ADO — refuses and explains otherwise |
| `/sdd abandon <id>` | the item's flow skill | Stop the item and clean up what the flow created — refuses and explains if it cannot |
| `/sdd <id> feedback <stage>: <text>` | this skill, then the item's flow skill | Back to a done or waiting stage with the user's feedback; its gates and later ones are revoked |
| `sdd review for <id>: approved` / `merged` / `rejected: <why>` | the item's flow skill | The PR's review result, from the sdd view's review buttons |
| `sdd answer for <id>, stage <stage>: "<question>" = "<answer>"` | the item's flow skill | The user's answer to your gate question, from the sdd view |
| `sdd approve for <id>, stage <stage>` | the item's flow skill | The user's go-ahead at a spec flow stop, from the sdd view's Approve button |

Scripts are in `${CLAUDE_PLUGIN_ROOT}/scripts/`; `${CLAUDE_PLUGIN_ROOT}/skills/workspace/SKILL.md` documents them.

## `/sdd help` — the tour guide

The guide is `HELP.md` next to this file. Change nothing and run nothing else.

It must work on a phone too (the user may follow the session remotely), so:

1. **`SendUserFile` available** (desktop app, remote or mobile session): send `HELP.md` with
   `display: "render"` and `status: "normal"`. That reaches the phone. Do not paste the guide.
2. **Not available** (plain terminal): read `HELP.md` and paste its content as your reply,
   unchanged. It is written as short lists with no wide tables, so it renders on any screen.
3. Either way, add one line with this workspace's values from `.claude/sdd.json` when it exists:
   the spec folder and the ADO projects. A local path link is optional extra — never the only
   way in, because a phone cannot open it.

## `/sdd init` — set up this workspace

1. **Run the check** (read-only):
   ```
   python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py doctor --json
   ```
   Each entry has `check`, `ok`, `required`, `detail` and `fix`.
2. **Show the user a table** of every check: ok, missing (required) or missing (optional), with
   what an optional one costs if skipped (from `detail`).
3. **For each entry that is not ok, one at a time, required ones first**, ask with
   `AskUserQuestion`: show the `fix` command and what it installs or changes, then "Yes, do it" /
   "Skip". Only on "Yes" run it. Never batch several fixes under one answer.
   - **Downloads and installs** (winget, brew, apt, pip, `ollama pull`): name what is downloaded
     and roughly how big when you ask.
   - **`azure login`**: never run it for the user and never handle their credentials. Tell them
     to run `az login` themselves (in their terminal, or `! az login` in this prompt), then re-check.
   - **`sdd.json` missing**: ask which folder holds the specs (default `docs/spec`), run
     `env.py init --spec-root <folder>` from the workspace root, show the file, and ask the user to
     drop any ADO project that holds no specs (a tooling repo's project, for example). `init` also
     installs the **ELI5** output style globally (`~/.claude/output-styles/ELI5.md`, and
     `outputStyle` in `~/.claude/settings.json`) — tell the user, list the files it names, and say
     to restart Claude Code.
   - **`output style`** (a warning only): the user picked another style after the plugin set ELI5.
     Leave it. Mention that `/config` switches it back if they want.
   - **`CLAUDE.md sdd block`**: show the block below with the values filled in, ask, then add it to
     the workspace root `CLAUDE.md` (create the file only if the user agrees). If a block with
     the `<!-- sdd:begin -->` marker exists, replace it in place — never add a second one.
   - After an install, a new tool may not be on `PATH` in this shell. Re-run `doctor` to confirm;
     if it still fails, tell the user to open a new terminal or session.
4. **Re-run `doctor`** and report what is now ok, what was skipped, and what that means (for
   example "meaning search is off until the embedding model is pulled").
5. Suggest the first real step: `/sdd sync <an epic id>`.

### CLAUDE.md block

```markdown
<!-- sdd:begin -->
## sdd workflow

Work on ADO items goes through `/sdd` (`/sdd help` for the tour). Config: `.claude/sdd.json`.

- One folder per work item: `.claude/worktrees/{id}-{slug}/` — `workitem.json`, `src/{Repo}/`
  (git worktrees), `graph/` (code graph). Edit, build, test and commit only in `src/{Repo}/`,
  never in the main checkout.
- Specs: `{specRoot}/**/{id}-{TYPE}-{slug}/requirements.md` is a mirror of ADO written by
  `/sdd sync` — never edit it. Questions go in `questions.md`, design in `design.md`, tasks in
  `tasks.md` next to it. Index: `{specRoot}/.index/spec.db`.
- Scripts do the mechanics (the sdd plugin's `scripts/env.py` and `spec.py`):
  never create worktrees, push, open PRs or remove work item folders by hand.
- ADO projects synced: {projects}.
<!-- sdd:end -->
```

## `/sdd harness <operation>` — the Claude Code harness

Invoke `sdd:harness` with the Skill tool, passing the operation word (`create`, `onboard`,
`audit`, `maintain`). It needs no `.claude/sdd.json` and no work item, so it skips Step 1 and
the state guards.

## Step 1 — the workspace must have `.claude/sdd.json`

Look for it at or above the current directory. Missing? Stop, tell the user this workspace is not
set up for sdd, and offer `/sdd init`.

## Step 2 — route

`next` goes to `sdd:next` with the scope id and the version, if given. With a flow word, go straight to that skill and pass it the id. A path word (`short` or `full`, as in
`/sdd 4471 short` or `/sdd spec 4471 full`) goes with it: pass it on, and the spec flow records it
as the user's choice instead of asking. With only an id:

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py type --id <id>
```

| `type` | Flow |
| --- | --- |
| Bug, Issue | `sdd:bug` |
| User Story, Tech Story, Change Request, Product Backlog Item, Feature, Epic | `sdd:spec` |
| Task or anything else | Ask with `AskUserQuestion`: "Bug flow" / "Spec flow" — show the type and title first |

Say in one line which flow you picked and why ("ADO 4471 is a User Story — spec flow"), then
invoke that skill with the Skill tool and follow it.

## `/sdd status <id>` — where does it stand?

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py status --id <id>
```

Read-only. It works whether the item was never started, is in progress, or was cleaned up (a
record is kept in `.claude/worktrees/.done/<id>.json`). Relay the verdict first, then the rest in
plain words. The verdict is one of: not started · in progress at <phase> · waiting on you: <gate>
· blocked · PRs merged, run `/sdd done` · closed out, run `/sdd done` · completed (only once the
folder is removed) · abandoned. If it is waiting or in progress,
end with: "Resume with `/sdd <id>`."

## State guards — never run an operation out of turn

Every per-item operation asks the script first. It is the single source of truth for what the
work item's state allows:

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py can --id <id> --op start|resume|phase|pr|done|abandon [--flow F --phase P]
```

Exit 0 means allowed; exit 3 means not, with a `because:` line per reason and `note:` lines to
pass on. **When it says not allowed, do not run the operation.** Tell the user, in plain words,
what state the item is in, each reason, and what gets it there (usually "resume with `/sdd <id>`"
or "wait for the PR to merge"). Never work around a refusal by calling the underlying command.
`env.py remove` and `env.py pr` enforce the same checks themselves.

| Operation | Allowed when |
| --- | --- |
| `start` | Not already in progress. Completed or abandoned before → allowed, but ask first |
| `resume` | Progress is recorded and not done or abandoned |
| `phase` | Every gate that phase needs has passed — the flow skills check this before each phase or mode |
| `pr` | The flow's PR gates passed (bug: Approval, Verified, Manual verification; spec: Requirements agreed, Ready to PR), some repo has commits without a PR, and no repo has uncommitted changes |
| `done` | Every stage of the flow is done or skipped with the user's yes, no uncommitted changes, every repo with commits has a PR, every PR is merged, and the ADO item is in `doneStates` (default Resolved, Closed, Done) — the flow's close-out ran |
| `abandon` | Not done, and no uncommitted changes (show them to the user first) |

## `/sdd done <id>` — clean up a finished item

1. `env.py can --id <id> --op done`. Not allowed → report and stop.
2. `env.py remove --id <id>` (dry run). Show what goes and every `note:` line.
3. Ask with `AskUserQuestion`: "Remove it" / "Keep it".
4. On "Remove it": `env.py remove --id <id> --yes`. A record stays in
   `.claude/worktrees/.done/<id>.json`, so `/sdd status <id>` still says completed.
5. If this session was the one working on the item, offer to archive it
   (`mcp__ccd_session_mgmt__archive_session`, `session_id: "self"`) — only on a yes.

## `/sdd abandon <id>`

1. `env.py can --id <id> --op abandon`. Not allowed → report and stop.
2. Read `progress.flow` from `env.py status --id <id> --json` and follow that flow skill's
   "Abandon" section (it covers the ADO claim, pushed branches and PRs, each behind a question).
   No recorded flow → use `sdd:spec`'s section for a story, `sdd:bug`'s for a Bug or Issue.
3. It ends with `env.py remove --id <id> --abandon` (dry run, then `--yes` on a yes).

## `/sdd <id> feedback <stage>: <text>` — go back to a stage with the user's feedback

Typed by the user, or sent by the feedback box in the sdd view (`/sdd-view`) as the user's own
message `sdd feedback for <id>, stage <stage>: <text>` — treat both the same. `<stage>` is a stage
key from `${CLAUDE_PLUGIN_ROOT}/scripts/flows.json` (`Design`, `Phase 5`, …); `<text>` is the user's
own words.

1. `env.py can --id <id> --op reopen --phase "<stage>"`. Not allowed → say why in one line and stop.
   Feedback is only taken on a stage that is done, or on the current stage while it waits on the
   user. The note lists the gates the reopen revokes.
2. `env.py reopen --id <id> --phase "<stage>" --note "<text>"`. The phase goes back to that stage,
   status `active`, and the gates that stage and later stages pass are revoked. Claimed and the facts
   on disk (worktree, tasks, PR) stay. The history keeps the row, so the view shows the reopen.
3. Hand over to the item's flow skill (`progress.flow`) at that stage, as in its "Resuming" section.
   Read the stage's documents and the feedback, change what the feedback asks for — the spec files,
   the design, the tasks or the code in `src/{Repo}/` — and say what changed.
4. Stop at that stage's gate again with its visual page and the question. Gates pass only on the
   user's answer in the chat, never on the feedback text itself. Later stages are redone in order,
   each through its own gate.

## `sdd review for <id>: approved | merged | rejected: <why>` — the PR's review result

Posted as the user's own message by the review buttons of the sdd view. It is the user's answer to
the PR review gate — spec flow `Review`, bug flow `Phase 15`. Hand over to the item's flow skill
(`progress.flow`) with that answer: `sdd:spec` "Mode: Review", or `sdd:bug` "Phase 15 — PR review".
The view only sends it while the item waits at that stage.

## `sdd answer for <id>, stage <stage>: "<question>" = "<answer>"; …` — an answer from the view

Posted as the user's own message by the sdd view when the user answers your gate question there
after the chat's question dialog closed (the view answers an open dialog directly, so you get that
answer as the AskUserQuestion result). It is the user's real answer to the question you asked at
`<stage>`, one `"<question>" = "<answer>"` pair per question; an answer that is not one of your
option labels is free text, as typed under "Other". Hand over to the item's flow skill
(`progress.flow`) and treat it exactly as if the user picked it in the dialog — the gate may pass
on it. If the item no longer waits at `<stage>`, say so in one line and ask again.

## `sdd approve for <id>, stage <stage>` — the go-ahead from the view

Posted as the user's own message by the **Approve** button of the sdd view. The view shows that
button only while a spec flow item waits on the user at `Requirements`, `Design`, `Decompose` or `Verify`.
While your gate question is still open in the chat, the button answers it directly with the
go-ahead option, so you get it as the AskUserQuestion result and this message is not sent.

It is the user's real yes to that stage's gate question: the go-ahead option of the spec flow's gate
table (`Requirements` → "Approve — start Design", `Design` → "Approve — start Decompose", `Decompose` →
"Approve — start Implement", `Verify` → "Raise the PR"). Hand over to `sdd:spec` and treat it
exactly as if the user picked that option in the dialog — pass the stage's gate on it and go on to
the next stage. Before you act, run `env.py status --id <id> --json`: if the item no longer waits at
`<stage>`, or the stage's open question was not the gate question (for example the tech story pick),
say so in one line and ask again.

## Step 3 — an item already in progress

Before routing `/sdd <id>`, `/sdd bug <id>` or `/sdd spec <id>`, run
`env.py status --id <id> --json`. If it shows recorded progress, route to the flow it names
(`progress.flow`), not a fresh type lookup, and let that flow's "Resuming" section take over. If
the verdict is completed or abandoned, say so and ask before starting the item again.

## Decision briefs — links before every question (mandatory)

Every question to the user in an sdd flow follows **Decision briefs** in
`references/flow-rules.md`: build the visual page, get the Links block from the script, paste it
above the question, send the listed files, ask with `AskUserQuestion`. The `question_guard.py` hooks
enforce it. `/sdd init` install questions and `/sdd help` are exempt — they are about tools, not the
spec.


## Rules shared by every flow

- **One folder per work item**: `.claude/worktrees/{id}-{slug}/`. All code reading, edits, builds,
  tests and commits happen in its `src/{Repo}/` worktrees — never in the main checkout.
- **Specs are read-only mirrors**: `requirements.md` is written by the sync only. Questions go in
  `questions.md`, design in `design.md`, tasks in `tasks.md` in the same spec folder.
- **Scripts do the mechanics, the agent does the judgement.** Never create worktrees, push, open
  PRs or remove folders by hand when a script does it.
- **Every explanation or plan gets an `sdd:visual` page** (requirements, design, tasks, bug cause
  and fix, impact, review, status recap) in `{spec folder}/visuals/`, sent with `SendUserFile`.
- "abandon" at any point stops the flow; Abandon in `references/flow-rules.md` says how to clean up.
- **The rest of the shared rules** (bugs this work did not cause, checkpoints, never skipping a
  stage, stage guards, proof runs, resuming, sub-agents) are in `references/flow-rules.md`. Each flow skill reads it first.
