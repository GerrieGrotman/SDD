# sdd plugin — working on this repo

A Claude Code plugin: spec-driven development on Azure DevOps work items. The skills are read by
an agent at run time, the scripts do the mechanics, the hooks enforce the rules. `README.md` has
the user's view; this file is for working on the plugin itself.

## Versioning

- Bump the plugin version in `.claude-plugin/plugin.json` only when raising a PR, as part of that PR.
  Never bump it with an ordinary change or commit.

## Where things live

| Path | What |
| --- | --- |
| `skills/sdd/` | The `/sdd` router, `HELP.md`, and `references/flow-rules.md` — the rules both flows share (Abandon, Decision briefs, bugs this work did not cause, checkpoints, stage guards, proof runs, resuming, sub-agents). Change a shared rule there, once |
| `skills/bug/`, `skills/spec/` | Each flow: `SKILL.md` is the outline (rules, gates, stage index); each stage's steps are in `phases/NN-*.md` / `modes/*.md` |
| `skills/request/` | Ai Agent Request triage: report on a hand-over, ask spec or bug, route the work (`spec.py request` / `route`), then hand over to that flow. No stages of its own: `route.json` in the request's spec folder is its record |
| `skills/next/`, `sync/`, `impact/`, `harness/`, `visual/`, `workspace/` | The other skills. `visual/` is a fork of visual-explainer (MIT) |
| `scripts/flows.json` | **The source of truth for the flows**: stages, gates each stage needs and passes, stops, `doc` (the stage file `env.py can` prints), `proofs`, `paths`. Scripts, hooks and the view all read it |
| `scripts/env.py` | Work item folders, worktrees, progress, gates, stage guards, proofs, PRs |
| `scripts/spec.py` | The ADO mirror and index, impact, rev-tested ADO writes, `next`, metrics.json, Ai Agent Request `request` / `route` |
| `scripts/sddlib.py` | Shared helpers, `DEFAULTS` for `.claude/sdd.json`, config upgrade, the output style install |
| `scripts/adowrite.py`, `proof.py`, `nextpick.py`, `metrics.py` | ADO writes; recorded test runs; next-item rules; metrics.json — logic as plain functions, tested without ADO |
| `scripts/fakeado.py` | Offline ADO for tests and evals: on when `SDD_FAKE_ADO` names a JSON world file |
| `hooks/` | `question_guard.py`, `agent_guard.py`, `edit_guard.py`, and `register.tsx` + `view/model.ts` (the sdd view, a mod), `worktrees.tsx` + `view/worktrees.ts` (the `/sdd-worktrees` page, hung off `register.tsx` because a plugin names one hooks module) |
| `agents/` | `investigator` and `skeptic`, the read-only sub-agents |
| `evals/` | `claude plugin eval` cases; `_fixtures/workspace.py` builds each case's workspace |
| `repowatch/` | A second, standalone plugin (sdd depends on it, same marketplace): tracks many git repos and worktrees. `scripts/repowatch.py` does the git mechanics and writes `.claude/repowatch/state.json`; `hooks/register.tsx` draws the pane and status line from it, and runs a clean-up only after `plan`, a confirm and `apply` (which re-checks). Has its own `plugin.json` and version |
| `assets/output-styles/ELI5.md` | The output style installed globally (kept outside `output-styles/` on purpose) |

## Checks to run

```
python scripts/test_sdd.py
python scripts/test_proof.py         # needs git; real worktrees in temp folders
python scripts/test_fakeado.py       # the real commands against the offline ADO
python scripts/check_evals.py        # needs PyYAML; checks the eval cases, runs nothing
python hooks/test_question_guard.py
python hooks/test_agent_guard.py
python hooks/test_edit_guard.py
python repowatch/scripts/test_repowatch.py   # needs git; real repos in temp folders
claude plugin test repowatch         # also mounts and presses the pane (hooks/pane.test.ts)
claude plugin validate repowatch
claude plugin test .                 # the view and the Worktrees page; it also finds repowatch's tests, whose pane tests stand down (the plugin under test is sdd)
claude plugin validate .             # the author warning is expected
```

All of them should pass before a commit. Never run `claude plugin eval` yourself: it needs the user
to trust the plugin directory, and each case is a paid agent run. A full TypeScript check of
`register.tsx` fails here (the mod types in `.claude-plugin/types` are generated on a dev machine);
`model.ts` and `types/` check on their own.

## Rules for changes

- **Scripts are standard library only and must run on Python 3.9 and on Windows.** The users run
  PowerShell on Windows: no shell-only paths, no 3.10+ syntax (`match`, `X | Y` types, a quote in an
  f-string's `{}` that matches its own quotes).
- **Mechanics go in a script, judgement in a skill.** If a rule can be checked, the script enforces
  it (`env.py can`, `progress --passed`, `env.py pr`) rather than the skill text asking for it.
- **ADO writes only through `adowrite.py`** (`spec.py claim | handover | sprint | comment | route`): every
  patch is rev-tested. Never a `#<id>` in text ADO stores — it posts a mention; write `ADO <id>`.
- **Renaming or renumbering a stage** touches `flows.json` (key, `doc`, `reworkTo`), the stage file,
  the skills, `view.test.ts`, the tests, and old `workitem.json` records (see
  `sddlib.renumber_bug_phases` for how the bug phases were migrated on read).
- **New `sdd.json` keys** go in `sddlib.DEFAULTS` and the `load_config` merge; add them to
  `UPGRADE_KEYS` when a person should find them in the file to tune.
- **Skill text is for a tired reader**: short sentences, active voice, exact paths and commands.
  A skill's `SKILL.md` stays an outline; stage detail goes in the stage's own file.
- **The view never writes**: `register.tsx` reads `env.py view` and posts the user's messages.
