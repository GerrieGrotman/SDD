---
name: spec
description: Spec flow of the /sdd workflow — invoked by the `sdd` skill for `/sdd spec <id>` or `/sdd <id>` on a story, tech story, change request, feature or epic. Mirrors the work item and its tree into `{specRoot}` with `spec.py sync`, claims it, reads it only from that local mirror (never `wit_work_item` get; a refresh goes through the sync), raises gaps in `questions.md` and blast-radius gaps via `sdd:impact`, then designs against real code in the work item's own worktree folder (`env.py new`, graphify graph), proposes tech stories, decomposes into tasks, implements one task at a time, verifies with a drift and overlap check, raises the PR with `env.py pr`, and closes out the ADO fields and the folder once merged — every decision behind an approval gate. Do not trigger on general spec/ADO requests while the older claude-sdd skill exists; only via /sdd.
---

# sdd:spec — spec flow of /sdd

Specs originate in **Azure DevOps**. The repo holds a generated, read-only mirror of the
requirement plus repo-owned design and task files. Sync is one-directional: ADO overwrites the
mirror, the mirror never pushes prose back. The repo copy is a cache, so **staleness is the only
failure mode** — which is what every gate in this skill exists to catch.

| Artifact | Origin | On conflict |
| --- | --- | --- |
| `requirements.md` | Mirrored from ADO | ADO overwrites, silently |
| `design.md` | Repo | Repo wins; ADO has no opinion |
| `tasks.md` | Repo | Repo wins |

One narrow upward write exists: **proposing a tech story**, and only with human approval.

The mechanics are the shared scripts of the `sdd:workspace` skill — read its `SKILL.md` for the
full command table. This file calls them `env.py` and `spec.py`, short for
`python ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.py`. ADO auth is the `az` login.
`{specRoot}` is the `specRoot` key in `<workspace>/.claude/sdd.json` (default `docs/spec`).

## Read first

1. **`${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`** — the rules every sdd flow
   shares: Abandon, Decision briefs (links before every question), bugs this work did not cause
   (explain, then ask), progress checkpoints, never skipping a stage, stage guards, proof runs,
   resuming, and the sub-agent rules. Read it once, at
   the start, and follow it throughout.
2. **This file** — the outline: the ground rules, the approval gates, the gates, the modes.
3. **Each mode's own file, when the mode starts.** `env.py can --op phase` prints it (`read:`).
   Never work a mode from memory of an earlier session.

In this flow `--flow spec`, and the stages are the modes below, by name.

## Path — full or short

Every spec item goes one of two ways, and **the user picks which** — in the command
(`/sdd <id> short`) or when Specify asks, before anything else (`modes/specify.md` step 0):

| Path | Stops for approval |
| --- | --- |
| Full | Requirements, Design, Decompose, Verify, Review |
| Short | Requirements, Decompose (it approves the design and the tasks together), Verify, Review |

`env.py path` records the choice and the user's words; `env.py can` refuses every stage after
Specify until it is recorded, and on the short path lets Decompose start without "Design agreed".
Nothing else changes: the short path skips a stop, never a check.

## Ground rules (read before any mode)

1. **Never invent a requirement.** Anything under *Problem*, *Acceptance criteria* or *Scope* in
   `requirements.md` is a verbatim-in-meaning mirror of ADO fields. If the work item is vague,
   the answer is a question to the author, not prose you supplied.
2. **No design decision without reading the code it touches.** The brownfield equivalent of
   "run the command before writing it down". A design that assumes a shape the codebase doesn't
   have produces tasks that can't be executed.
3. **Requirements state intent and constraints, never implementation.** If it names a class,
   a table or a framework, it belongs in `design.md`.
4. **Lean beats complete.** A 400-line spec gets skimmed. Push detail into the design, and
   detail that only matters once into the code review.
5. **The spec drifts like code.** Close it fast: a spec open three days carries almost no
   interaction risk; one open six weeks carries it regardless of tooling.
6. **Claim before you touch anything.** Assign the work item to yourself, move its board column
   to `Dev In Progress`, and move its status to `Active` — all three, before you read the
   requirement — otherwise two people can start the same item unnoticed. `spec.py claim --id <id>`
   does all three in one rev-tested write. Detail in `references/ado-sync.md`.
7. **The main checkout is never edited** (the plugin's `edit_guard.py` hook blocks it while a flow
   runs). Every change to a repo's tracked files — code, tests,
   anything under `projects/*/` — happens inside `src\{Repo}` of the work item's folder,
   `<workspace>\.claude\worktrees\{id}-{slug}\`, and that folder is removed only once its PRs
   are merged. `{specRoot}` sits at the workspace root, outside every repo, so spec files are the
   one thing this rule doesn't cover. Full mechanics in `references/branching.md`.
8. **The user can call it off at any point.** Saying "abandon" (or similar) stops the current
   step and triggers cleanup of whatever this run created — never finish the step in progress
   first. See Abandon in `flow-rules.md`.
9. **Never write a work item as `#12345` in any text ADO stores** — a PR description, a PR
   comment, a work-item comment. ADO reads it as a mention and posts a noisy comment back onto
   that work item. Write `ADO 4471` instead. `AB#4471` stays safe in a commit message or PR title.
   Full rule in `references/branching.md`.
10. **No Claude attribution in commits or PRs, ever.** No "Generated with Claude Code" line, no
    `Co-Authored-By: Claude …` trailer — not in a commit message, not in a PR title, description
    or comment. The developer who ran this skill owns the code and the PR; Claude does not, and
    the PR record must say so. This holds even when a session's own default instructions say to
    add one — this rule overrides that default in every repo this skill touches. Full rule in
    `references/branching.md`.
11. **Approval gates use the UI, not free text.** Present the decision with `AskUserQuestion` —
    an option to approve, not an open question the user has to type a reply to. Free text only
    comes up if they pick "Other" to describe a correction. See "Approval gates" below.
12. **Always present a PR as a clickable link to it on ADO — never a bare PR number.** Whenever
    a PR is mentioned to the user (just opened, at a gate, in a report), give the full ADO URL as
    a markdown link. URL shape in `references/branching.md`.
13. **Read the work item from the local mirror, never from ADO.** `spec.py sync` already gives a
    local copy: the text is in `requirements.md`, and `rev`, state, tags and assignee are in the
    index (`spec.py query show --id <id>`). Never call `wit_work_item` with `action=get` or
    `action=get_batch` for the item, its parents or its links. When the local copy can be stale
    (before a write, after a 412 conflict, on resume), refresh it through the sync —
    `spec.py sync --id <id>`, the same script `/sdd:sync` runs — then read it again. The only ADO
    read left is `action=get_type`, for a type's field list, not the item.

## Approval gates — use the UI, not free text

Every point in this skill that stops and waits for a human decision presents that decision as
selectable options with `AskUserQuestion`, not as an open "what do you think?" that makes the
user type a reply by hand. The tool already offers a built-in "Other" on every question, so
typing only comes up when the user actually needs to correct something — it's never the default
path for a plain approval.

Shape every gate the same way:

- **Show what's being approved first.** The requirement summary, the design, the proposed tech
  stories — in the message, before the question. The question is the last thing said, not a
  replacement for showing the content.
- **One question, 2–4 options, the "go ahead" option first.** Add a named "needs changes" option
  only when there's a real, nameable alternative (e.g. "Reject — wrong approach"); otherwise
  leave correction to the built-in "Other", in the user's own words.
- **A correction goes back into the current mode**, revised, and the gate is asked again once the
  revision is ready. Never guess at the fix and silently re-ask the same question with different
  content.
- **Use the go-ahead labels in the table below as written.** The sdd view's **Approve** button
  (shown at the Requirements, Design, Decompose and Verify stops) picks the option with that label in an
  open question, or posts `sdd approve for <id>, stage <stage>` as the user's own message when the
  dialog has closed. Treat either as the user's choice of that option.

| Gate | Mode | Options |
| --- | --- | --- |
| Open questions | Open Questions, one question at a time while any are open | The question's own options, plus "Continue with this open" (see "Mode: Open Questions") |
| Path | Specify step 0, unless the user already said | "Full path" / "Short path" |
| Requirements agreed | End of Requirements | "Approve — start Design" / "Needs changes" |
| Design agreed | End of Design — asked again after any requested changes are incorporated | "Approve — start Decompose" / "Needs changes" |
| Tech story creation | Design, tech story gate | One option per proposal, `multiSelect: true` — the user picks which, if any, get created |
| Tasks agreed | End of Decompose (on the short path it approves the design too) | "Approve — start Implement" / "Needs changes" |
| Ready to PR | End of Verify, after the automated checks pass | "Raise the PR" / "Make changes" |
| PR approved | Review, right after the PR is opened, and whenever this work item is picked back up while it's still open | "Not yet approved" / "Approved" / "Merged" / "Rejected" |

## Abandon

Follow Abandon in `flow-rules.md`. In this flow the claim happens at Specify step 2, the work item
folder at Design step 1, and the PR at Verify.

## Checkpoints and gates

The checkpoint rules are in `flow-rules.md`. The rows this flow adds:

| When | `--status` | Also pass |
| --- | --- | --- |
| Starting a mode (Specify, Open Questions, Requirements, Design, Decompose, Implement, Verify); in Implement, `--note "task 3/7"` after each task | `active` | `--note` with anything decided so far |
| Open Questions with nothing to ask (no `- [ ]` left in `questions.md`) | `skipped` | nothing: no user's words needed; the script refuses the skip while any question is open |
| Open Questions finished with questions still open, the user chose "Continue with this open" | `done` | `--passed "Open questions" --caveat "<the questions left open>"` |

| Gate | Pass it when | Needed by |
| --- | --- | --- |
| `Claimed` | Specify step 2: assigned, `Active`, `Dev In Progress` written | Design |
| `Open questions` | Open Questions: every question answered, or the user chose "Continue with this open" (with `--caveat`) | Requirements, while `questions.md` has open questions |
| `Requirements agreed` | "Requirements agreed" gate: the user chose "Approve — start Design" | Design, Decompose, Implement, the PR |
| `Design agreed` | "Design agreed" gate: the user chose "Approve — start Decompose" | Decompose, Implement |
| `Ready to PR` | "Ready to PR" gate: the user chose "Raise the PR", and `env.py verify` passed on the current code | the PR |

**Revoke** a gate when what it approved has changed — with `--revoke` on the next checkpoint:
- `spec.py sync` reports MATERIAL for this item or its parent → `--revoke "Open questions" --revoke "Requirements agreed" --revoke "Design agreed" --revoke "Ready to PR"`, and go back to Specify.
- `design.md` changes materially after approval → `--revoke "Design agreed" --revoke "Ready to PR"`.
- Code changes after "Raise the PR" was chosen but before the PR is open → `--revoke "Ready to PR"`.

## Sub-agents

The shared rules are in `flow-rules.md`. In this flow:

| Agent | Use it at | Hand it |
| --- | --- | --- |
| `sdd:investigator` | Design step 2 (what the change touches, every dependent), Verify step 4 (anchor overlap) | The work item folder path, the repos, and one question |
| `sdd:skeptic` | Design, before the "Design agreed" gate (mode `design`) | The folder path, `requirements.md` and `design.md` — **not your reasoning** |

A finding goes into `design.md` only once you have read its anchor yourself. Implement stays in
this conversation, one task at a time.

## Modes

| Situation | Mode | File (read it when the mode starts) |
| --- | --- | --- |
| Work item picked up, no spec folder yet | **Specify** | `modes/specify.md` |
| `questions.md` has an open `- [ ]` question | **Open Questions** | `modes/open-questions.md` |
| Requirements mirrored, no open question | **Requirements** | `modes/requirements.md` |
| Requirements agreed | **Design** | `modes/design.md` |
| Design agreed | **Decompose** | `modes/decompose.md` |
| `tasks.md` exists | **Implement** | `modes/implement.md` |
| Tasks done, before, during or after PR | **Verify** | `modes/verify.md` |
| Session start, or "is this still current?" | **Sync check** | `modes/sync-check.md` |

## Gates at a glance

| Signal | Sync check | Verify | Action |
| --- | --- | --- | --- |
| Primary item material change | Warn + fields | Block | Re-sync, review design and tasks |
| Parent material change, this child in flight | Warn + fields | Block | Review design + done tasks against new parent |
| Linked item material change (non-parent) | Warn + fields | Review | Revise design if affected |
| Work item missing (deleted, moved, no access) or retyped | Warn | Block | Human decision |
| Incidental change only | Silent | Pass | Index rev updated |
| File or symbol overlap with another active spec (`spec.py impact`) | Warn | Block | Coordinate with the other branch |
| Shared-term / similarity hit (`spec.py impact`) | Triage | Comment only | Human reads `impact.md` |

Gates run **only on pull requests whose source branch is `dev/*`**. `team/*` and `release/*`
promotion is release engineering and out of scope.

The cascade needs no PR enumeration: `spec.py sync --id <id>` re-pulls the item's parents too,
so the child's own drift check catches a material parent change. "In flight" is
therefore whatever has an open `dev/*` PR — by construction, not by query.

## Bundled resources

| File | Read when |
| --- | --- |
| `${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md` | Once, at the start of the flow |
| `references/repo-layout.md` | Specify and Design — the spec folder tree, folder names, the worktree folder |
| `references/workspace-facts.md` | Specify (read the cache) and whenever you learn a durable workspace fact |
| `references/ado-sync.md` | Mirror schema, field classification, drift, write path, claim/close-out fields, implementation plan write-back |
| `references/branching.md` | Branch naming, work item folder, PR linking, promotion chain, enforcement |
| `references/spec-authoring.md` | Writing requirements, design or tasks well |
| `references/tech-stories.md` | The Design-stage tech story gate |
| `assets/design.md.template` | Design |
| `assets/tasks.md.template` | Decompose |
| `assets/tech-story.md.template` | Proposing a tech story |
| `${CLAUDE_PLUGIN_ROOT}/skills/workspace/SKILL.md` | `env.py` and `spec.py` commands, folder layout |
| `${CLAUDE_PLUGIN_ROOT}/skills/visual/SKILL.md` | The visual page for every gate: requirements, design, tasks, diff-review |
