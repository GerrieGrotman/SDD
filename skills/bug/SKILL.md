---
name: bug
description: >-
  Bug/Issue flow of the /sdd workflow — invoked by the `sdd` skill for `/sdd bug <id>` or `/sdd <id>`
  on a Bug or Issue. Mirrors the Azure DevOps work item with `spec.py sync` (the flow reads it only from
  that local copy, never with `wit_work_item` get) and claims it first, asks which team version to
  base on, then creates the work item's folder with `scripts/env.py new` (a git
  worktree per repo plus a code graph) so every check runs against the real code, validates the bug
  against the linked User Story or Change Request mirrored by `spec.py sync` (a bug that contradicts
  an accepted requirement is not a bug), proves the root cause, gets explicit approval on a written
  problem/cause/fix summary BEFORE editing anything, writes a failing regression test, applies the
  fix, verifies red→green plus a revert-check and a flakiness run, stops for the user's manual
  verification, raises the PR with `env.py pr` (description holds only the change; report,
  verification, design notes and out-of-scope go in PR comments), and writes back Root Cause
  Details and Resolution (mandatory for Issue) with `Dev Completed` as the QA hand-over. "Abandon"
  at any point stops and cleans up with `env.py remove --abandon`. Do not trigger on a general
  'fix this bug' request while the older ado-bug-fix skill exists; only via /sdd.
---

> Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Files under this skill write it as `<plugin root>`.

# sdd:bug — ADO Bug / Issue Fix

The defect lifecycle for this workspace, from an Azure DevOps `Bug` or `Issue` to a merged-ready PR
with the work item written back. It exists because the failure modes of bug work are predictable —
fixing behaviour that a Change Request actually specified, fixing a symptom instead of a cause, a
"regression test" that would have passed before the fix, and a work item closed with no record of
why it broke — and each one has a gate below that catches it.

## Read first

1. **`${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`** — the rules every sdd flow
   shares: Abandon, Decision briefs (links before every question), bugs this work did not cause
   (explain, then ask), progress checkpoints, never skipping a stage, stage guards, proof runs,
   resuming, and the sub-agent rules. Read it once, at
   the start, and follow it throughout.
2. **This file** — the outline: the non-negotiables, the house style, the gates, the phases.
3. **Each phase's own file, when the phase starts.** `env.py can --op phase` prints it (`read:`).
   Never work a phase from memory of an earlier session.

In this flow `--flow bug`, and the stages are `Phase 1` … `Phase 15` (the names below).

## Non-negotiables

1. **Claim it before you study it.** Ownership is the first action, so two people never investigate
   the same defect (Phase 1). But **never take a work item away from someone else.** Handed several
   related items at once? Claim **every** one, not just the id named first (Phase 1.2).
2. **Pick the branch and create the work item folder before you investigate.** Every check that follows —
   is this really a bug, can it still be reproduced, where does it live — must run against the
   actual branch the fix will land on, not whatever the main checkout happens to have (Phase 2).
3. **No file edits or commits before approval.** The writes before the approval gate are claiming
   the work item in ADO (Phase 1.2) and creating the work item folder with `env.py new` (Phase 2) — both are
   prerequisites for investigating the right code, not the fix itself. Phases 3–5 read from that
   worktree but touch nothing in it. Phase 6 presents a written summary and stops.
4. **A bug that contradicts an accepted requirement is not a bug.** Validate against the linked
   story / change request before investing in a fix (Phase 3). Some tickets end here.
5. **Test before fix, always.** The regression test is written and observed *failing* before the
   fix exists. A test written after a fix proves nothing.
6. **A cause, not a symptom.** Never propose a fix you cannot trace to a specific line and
   mechanism. "Added a null check" is a symptom fix unless you can say why the value was null.
7. **Ask which team version to branch from.** Never infer it, default it, or reuse the last one — it
   sets the base commit, the branch name and the PR target, and the available versions differ per
   repo (Phase 2).
8. **All investigation, code work, and testing happens in the work item folder's worktrees**
   (`<workspace root>\.claude\worktrees\{id}-{slug}\src\{Repo}`), created at Phase 2 — never in the
   main checkout, and never by `git checkout` inside it. The plugin's `edit_guard.py` hook blocks
   an edit to a repo file in the main checkout while the flow runs. Do not trust the main
   checkout as a stand-in for anything: it can hold a different fix in progress, uncommitted edits,
   or simply the wrong commit, so a test run there proves nothing about this fix and can disturb
   someone else's work. This applies to a `dotnet test` run, a manual reproduction, and a full stack
   started with the workspace's own run script — every one of them must point at the worktree, not
   the main checkout. See `references/branch-and-pr.md`.
9. **`Issue` requires write-back.** `Custom.RootCauseDetails` and `Microsoft.VSTS.Common.Resolution`
   are mandatory for type `Issue`. Both fields also exist on `Bug` — fill them there too.
10. **Never PR the workspace root.** The root repo has no remote by design. All shareable work
    belongs to the submodule; see `references/branch-and-pr.md`.
11. **Plain English in everything a person reads.** The work item, the PR, the commit message and
    every report to the user follow the house style below — see `references/writing-style.md`.
12. **The user can call it off at any point.** An "abandon" command stops the current phase and
    triggers cleanup — see Abandon in `flow-rules.md`. Never finish the step in progress first.

## House style — write for a tired reader

Everything this skill writes for a person uses **ASD-STE100 Simplified Technical English** (STE: a
controlled-English standard written for maintenance manuals). Short sentences. Active voice. One
idea per sentence. Small words. Explain a technical word in brackets, once, right after you use it.

This matters most in ADO. The person who reported the defect is often not a developer. The QA person
who picks the item up from `Dev Completed` reads `Custom.RootCauseDetails` and
`Microsoft.VSTS.Common.Resolution`, and nothing else.

| Rule | Limit |
| --- | --- |
| Ideas | one per sentence |
| Sentence | 20 words for an instruction, 25 for a statement |
| Paragraph | 6 sentences, one topic |
| Voice | active — name who or what did it |
| Tense | present, or simple past |

**Exact strings stay exact.** Never simplify a file path, branch name, field reference name, error
code, test name or command. Simplify the prose around them, not the thing the reader must copy.

The full rules, the word-swap table, worked rewrites and the HTML rules for the two long-text fields
are in `references/writing-style.md`. Read it before Phase 6, 10, 12 and 13.

## Abandon

Follow Abandon in `flow-rules.md`. In this flow the claim happens at Phase 1.2, the work item
folder at Phase 2, the push at Phase 10 and the PR at Phase 12.

## Gates

| Gate | Pass it when | Needed by |
| --- | --- | --- |
| `Claimed` | Phase 1: assigned, `Active`, `Dev In Progress` written | Phase 2–6 |
| `Approval` | Phase 6: the user approved the problem / cause / fix summary | Phase 7–12, the PR |
| `Red test` | Phase 7: the new test failed for the right reason — a recorded `env.py run --expect fail` | Phase 8–9 |
| `Verified` | Phase 9: Gate 3 and Gate 4 both passed — recorded `revert-check`, `--repeat 5` and `--suite` runs on the current code | Phase 10–12, the PR |
| `Manual verification` | Phase 11: the user said it works — or explicitly chose to skip it (say so in `--note`) | Phase 12, the PR |

**Revoke** a gate when what it approved has changed — with `--revoke` on the next checkpoint:
- Phase 9 or 11 sends you back to Phase 5 (cause wrong or incomplete) → `--revoke Approval --revoke "Red test" --revoke Verified`.
- Any code change after Phase 9 → `--revoke Verified` (and `--revoke "Manual verification"` if Phase 11 had passed).

## Sub-agents

The shared rules are in `flow-rules.md`. In this flow:

| Agent | Use it at | Hand it |
| --- | --- | --- |
| `sdd:investigator` | Phase 4, Phase 5 (Gate 2 items 5 and 6) | The work item folder path, the symptom, and one question |
| `sdd:skeptic` | Phase 5 before Phase 6 (`cause`), Phase 7 and Gate 3 (`test`) | The folder path, the mode, and the claim with its evidence — **not your reasoning** |

- On the bug page, a finding becomes a fact only once you have read the anchor yourself.
- On a skeptic verdict of `holds with gaps`, close each gap or show it on the page under **Ruled
  out** or **Out of scope**.

## Phases

| Phase | What | File (read it when the phase starts) | |
| --- | --- | --- | --- |
| 1 | Load the work item, then claim it | `phases/01-load-and-claim.md` |  |
| 2 | Pick the branch, then create the worktree | `phases/02-branch-and-worktree.md` |  |
| 3 | Validate against the linked story / change request | `phases/03-validate.md` |  |
| 4 | Reproduce and locate | `phases/04-reproduce.md` |  |
| 5 | Prove the root cause | `phases/05-root-cause.md` |  |
| 6 | Approval gate | `phases/06-approval.md` | 🛑 stop |
| 7 | Failing regression test | `phases/07-red-test.md` |  |
| 8 | Apply the fix | `phases/08-fix.md` |  |
| 9 | Verify | `phases/09-verify.md` |  |
| 10 | Commit and push | `phases/10-commit-and-push.md` |  |
| 11 | Manual-verification gate | `phases/11-manual-verification.md` | 🛑 stop |
| 12 | Pull request | `phases/12-pull-request.md` |  |
| 13 | Write back to the work item | `phases/13-write-back.md` |  |
| 14 | Record what you learned about the workspace | `phases/14-workspace-facts.md` |  |
| 15 | PR review | `phases/15-pr-review.md` | 🛑 stop |

## Bundled references

| File | Read when |
| --- | --- |
| `references/requirement-alignment.md` | Phase 3 — link traversal, spec-by-type, verdict examples |
| `references/ado-fields.md` | Phase 1 and Phase 13 — field names, picklists, house-style examples |
| `references/branch-and-pr.md` | Phase 2, 10, 12 — work item folder, branch derivation, commits, PR template, cleanup |
| `references/test-integrity.md` | Phase 7 and 9 — test placement, red-green-revert, flakiness rules |
| `references/writing-style.md` | Phase 6, 10, 12, 13 — the plain-English rules, word swaps, rewrites |

## Companion skill

| Skill | Use it at |
| --- | --- |
| `pre-pr-verify` | Phase 11, **only when the user asks for it** — brings the stack up from this bug's worktrees, proves the worktree build is the one answering, and hands the app to the user for manual testing. The user tests; the agent waits. |

It is a **global** skill, so it is available in every workspace. It reads the same
`## Claude skills — workspace facts` block this skill writes at Phase 14, and derives what is missing.
